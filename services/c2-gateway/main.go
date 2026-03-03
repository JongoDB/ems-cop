// EMS-COP C2 Gateway Service
// Bridges EMS to Sliver C2 (and future C2 backends) via a provider interface
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"strconv"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	jwtv5 "github.com/golang-jwt/jwt/v5"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/rpcpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

// ════════════════════════════════════════════
//  C2 PROVIDER INTERFACE
//  Implement this for each C2 backend (Sliver, Mythic, Havoc, etc.)
// ════════════════════════════════════════════

type C2Provider interface {
	// Connection
	Connect(ctx context.Context, config ProviderConfig) error
	Disconnect() error
	Name() string
	IsConnected() bool

	// Implants
	ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error)
	GenerateImplant(ctx context.Context, spec ImplantSpec) (*ImplantBinary, error)

	// Sessions
	ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error)
	OpenSession(ctx context.Context, sessionID string) (SessionStream, error)

	// Tasks
	ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error)
	GetTaskHistory(ctx context.Context, sessionID string) ([]TaskResult, error)

	// Listeners
	ListListeners(ctx context.Context) ([]Listener, error)
	CreateListener(ctx context.Context, spec ListenerSpec) (*Listener, error)
	DeleteListener(ctx context.Context, listenerID string) error

	// Telemetry
	SubscribeTelemetry(ctx context.Context, filter *TelemetryFilter) (<-chan TelemetryEvent, error)
}

// ════════════════════════════════════════════
//  COMMON DATA TYPES (C2-agnostic)
// ════════════════════════════════════════════

type ProviderConfig struct {
	Host           string            `json:"host"`
	Port           int               `json:"port"`
	CertPath       string            `json:"cert_path"`
	OperatorConfig string            `json:"operator_config"`
	Options        map[string]string `json:"options"`
}

type Implant struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	OS          string    `json:"os"`
	Arch        string    `json:"arch"`
	Transport   string    `json:"transport"`
	ActiveC2    string    `json:"active_c2"`
	LastCheckin time.Time `json:"last_checkin"`
	PID         int       `json:"pid"`
	ProcessName string    `json:"process_name"`
	Hostname    string    `json:"hostname"`
	RemoteAddr  string    `json:"remote_addr"`
	Status      string    `json:"status"` // "active", "dormant", "dead"
}

type ImplantFilter struct {
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
	Status   string `json:"status,omitempty"`
	Hostname string `json:"hostname,omitempty"`
}

type ImplantSpec struct {
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	Format      string `json:"format"`    // "exe", "shared", "service", "shellcode"
	Transport   string `json:"transport"` // "mtls", "http", "https", "dns", "wg"
	C2URL       string `json:"c2_url"`
	SkipSymbols bool   `json:"skip_symbols"`
}

type ImplantBinary struct {
	Name string `json:"name"`
	Data []byte `json:"-"`
	Size int64  `json:"size"`
}

type Session struct {
	ID          string    `json:"id"`
	ImplantID   string    `json:"implant_id"`
	Hostname    string    `json:"hostname"`
	OS          string    `json:"os"`
	RemoteAddr  string    `json:"remote_addr"`
	Transport   string    `json:"transport"`
	IsAlive     bool      `json:"is_alive"`
	LastMessage time.Time `json:"last_message"`
}

type SessionFilter struct {
	IsAlive  *bool  `json:"is_alive,omitempty"`
	Hostname string `json:"hostname,omitempty"`
}

type SessionStream interface {
	Send(input string) error
	Recv() (string, error)
	Close() error
}

type C2Task struct {
	Command        string                 `json:"command"`
	Arguments      map[string]interface{} `json:"args"`
	Classification string                 `json:"classification"`
}

type TaskResult struct {
	TaskID         string    `json:"task_id"`
	Command        string    `json:"command"`
	Output         string    `json:"output"`
	Error          string    `json:"error,omitempty"`
	Classification string    `json:"classification"`
	StartedAt      time.Time `json:"started_at"`
	EndedAt        time.Time `json:"ended_at"`
}

type Listener struct {
	ID        string `json:"id"`
	Protocol  string `json:"protocol"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	IsRunning bool   `json:"is_running"`
}

type ListenerSpec struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

type TelemetryFilter struct {
	ImplantID  string   `json:"implant_id,omitempty"`
	EventTypes []string `json:"event_types,omitempty"`
}

type TelemetryEvent struct {
	Timestamp time.Time              `json:"timestamp"`
	EventType string                 `json:"event_type"`
	ImplantID string                 `json:"implant_id"`
	Data      map[string]interface{} `json:"data"`
}

// ════════════════════════════════════════════
//  RISK CLASSIFICATION
// ════════════════════════════════════════════

// CommandRiskLevel maps C2 commands to risk levels for approval routing
// These are the defaults — users can override per-operation
var DefaultCommandRisk = map[string]int{
	// Level 1: Recon (auto-approve)
	"ls": 1, "ps": 1, "netstat": 1, "ifconfig": 1, "whoami": 1, "pwd": 1,
	"cat": 1, "env": 1, "getuid": 1, "getgid": 1, "info": 1,

	// Level 2: Low risk (auto-approve with notification)
	"upload": 2, "download": 2, "screenshot": 2, "mkdir": 2,

	// Level 3: Medium (E3 approval)
	"execute": 3, "shell": 3, "sideload": 3, "msf": 3, "rm": 3,

	// Level 4: High (E3 + E2 approval)
	"pivots": 4, "portfwd": 4, "execute-assembly": 4, "socks5": 4,
	"ssh": 4, "wg-portfwd": 4,

	// Level 5: Critical (full chain)
	"getsystem": 5, "impersonate": 5, "make-token": 5, "rev2self": 5,
	"psexec": 5, "backdoor": 5, "dllhijack": 5,
}

func GetCommandRisk(command string, overrides map[string]int) int {
	if overrides != nil {
		if risk, ok := overrides[command]; ok {
			return risk
		}
	}
	if risk, ok := DefaultCommandRisk[command]; ok {
		return risk
	}
	return 3 // default to medium if unknown
}

// ════════════════════════════════════════════
//  OPERATOR CONFIG (Sliver mTLS)
// ════════════════════════════════════════════

type OperatorConfig struct {
	Operator      string `json:"operator"`
	Token         string `json:"token"`
	LHost         string `json:"lhost"`
	LPort         int    `json:"lport"`
	CACertificate string `json:"ca_certificate"`
	PrivateKey    string `json:"private_key"`
	Certificate   string `json:"certificate"`
}

// TokenAuth implements grpc.PerRPCCredentials for Sliver operator token auth
type TokenAuth struct {
	token string
}

func (t TokenAuth) GetRequestMetadata(ctx context.Context, uri ...string) (map[string]string, error) {
	return map[string]string{
		"Authorization": "Bearer " + t.token,
	}, nil
}

func (t TokenAuth) RequireTransportSecurity() bool {
	return true
}

func loadOperatorConfig(path string) (*OperatorConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read operator config: %w", err)
	}
	var cfg OperatorConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse operator config: %w", err)
	}
	return &cfg, nil
}

func (c *OperatorConfig) TLSConfig() (*tls.Config, error) {
	certPEM := []byte(c.Certificate)
	keyPEM := []byte(c.PrivateKey)
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse client cert: %w", err)
	}

	caCertPool := x509.NewCertPool()
	caCertPool.AppendCertsFromPEM([]byte(c.CACertificate))

	return &tls.Config{
		RootCAs:            caCertPool,
		Certificates:       []tls.Certificate{cert},
		InsecureSkipVerify: true, // Sliver uses self-signed certs
	}, nil
}

// ════════════════════════════════════════════
//  AUDIT EVENT PUBLISHING (NATS)
// ════════════════════════════════════════════

type AuditEvent struct {
	EventType      string `json:"event_type"`
	ActorID        string `json:"actor_id"`
	ActorUsername   string `json:"actor_username"`
	ActorIP        string `json:"actor_ip"`
	SessionID      string `json:"session_id"`
	ResourceType   string `json:"resource_type"`
	ResourceID     string `json:"resource_id"`
	Action         string `json:"action"`
	Details        string `json:"details"`
	Classification string `json:"classification"`
	Timestamp      string `json:"timestamp"`
}

func (s *C2GatewayServer) validateJWT(tokenStr string) (string, error) {
	token, err := jwtv5.Parse(tokenStr, func(t *jwtv5.Token) (any, error) {
		if _, ok := t.Method.(*jwtv5.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return "", fmt.Errorf("parse token: %w", err)
	}
	sub, err := token.Claims.GetSubject()
	if err != nil || sub == "" {
		return "", fmt.Errorf("missing subject claim")
	}
	return sub, nil
}

func (s *C2GatewayServer) publishAuditWithClassification(eventType string, r *http.Request, resourceID, action, details, classification string) {
	if s.nc == nil {
		return
	}
	if classification == "" {
		classification = "UNCLASS"
	}
	event := AuditEvent{
		EventType:      eventType,
		ActorID:        r.Header.Get("X-User-ID"),
		ActorUsername:   r.Header.Get("X-User-ID"),
		ActorIP:        r.RemoteAddr,
		ResourceType:   "c2_session",
		ResourceID:     resourceID,
		Action:         action,
		Details:        details,
		Classification: classification,
		Timestamp:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	data, _ := json.Marshal(event)
	if err := s.nc.Publish(eventType, data); err != nil {
		s.logger.Error("failed to publish audit event", "event", eventType, "error", err)
	}
}

// publishAudit is a backward-compatible wrapper that defaults classification to "UNCLASS".
func (s *C2GatewayServer) publishAudit(eventType string, r *http.Request, resourceID, action, details string) {
	s.publishAuditWithClassification(eventType, r, resourceID, action, details, "UNCLASS")
}

// hasRole checks if a comma-separated roles header contains an exact match
// for any of the allowed roles (prevents substring matching vulnerabilities).
func hasRole(rolesHeader string, allowed ...string) bool {
	for _, r := range strings.Split(rolesHeader, ",") {
		trimmed := strings.TrimSpace(r)
		for _, a := range allowed {
			if trimmed == a {
				return true
			}
		}
	}
	return false
}

// Classification helpers

var enclave = func() string {
	if v := os.Getenv("ENCLAVE"); v != "" {
		return v
	}
	return ""
}()

func isValidClassification(c string) bool {
	return c == "UNCLASS" || c == "CUI" || c == "SECRET"
}

func classificationRank(c string) int {
	switch c {
	case "UNCLASS":
		return 0
	case "CUI":
		return 1
	case "SECRET":
		return 2
	default:
		return -1
	}
}

// ════════════════════════════════════════════
//  HTTP HANDLERS (REST API wrapping the C2 Provider)
// ════════════════════════════════════════════

// CrossDomainCommand represents a command queued for cross-domain execution.
type CrossDomainCommand struct {
	ID              string  `json:"id"`
	OperationID     string  `json:"operation_id"`
	Command         string  `json:"command"`
	TargetSessionID string  `json:"target_session_id"`
	RiskLevel       int     `json:"risk_level"`
	Classification  string  `json:"classification"`
	Status          string  `json:"status"`
	RequestedBy     *string `json:"requested_by,omitempty"`
	RequestedAt     string  `json:"requested_at"`
	ApprovedBy      *string `json:"approved_by,omitempty"`
	ApprovedAt      *string `json:"approved_at,omitempty"`
	ExecutedAt      *string `json:"executed_at,omitempty"`
	Result          any     `json:"result,omitempty"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type CrossDomainExecuteRequest struct {
	SessionID      string `json:"session_id"`
	Command        string `json:"command"`
	OperationID    string `json:"operation_id"`
	Classification string `json:"classification"`
}

type C2GatewayServer struct {
	provider   C2Provider
	registry   *ProviderRegistry
	port       string
	nc         *nats.Conn
	db         *pgxpool.Pool
	logger     *slog.Logger
	jwtSecret  []byte
	httpServer *http.Server
	cti        *ctiHealth
}

// ---------------------------------------------------------------------------
// CTI Health Checker
// ---------------------------------------------------------------------------

type ctiHealth struct {
	mu        sync.RWMutex
	connected bool
	lastCheck time.Time
	relayURL  string
	logger    *slog.Logger
	client    *http.Client
}

func newCTIHealth(relayURL string, logger *slog.Logger) *ctiHealth {
	return &ctiHealth{
		relayURL:  relayURL,
		logger:    logger,
		connected: true,
		client:    &http.Client{Timeout: 5 * time.Second},
	}
}

func (c *ctiHealth) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

func (c *ctiHealth) LastCheck() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.lastCheck
}

func (c *ctiHealth) Start(ctx context.Context) {
	if c.relayURL == "" {
		c.logger.Info("CTI relay URL not configured, single-enclave mode")
		return
	}
	c.logger.Info("starting CTI health checker", "relay_url", c.relayURL)
	c.check()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.check()
			}
		}
	}()
}

func (c *ctiHealth) check() {
	resp, err := c.client.Get(c.relayURL + "/health")
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastCheck = time.Now()
	if err != nil {
		if c.connected {
			c.logger.Warn("CTI relay health check failed", "error", err)
		}
		c.connected = false
		return
	}
	resp.Body.Close()
	wasConnected := c.connected
	c.connected = resp.StatusCode >= 200 && resp.StatusCode < 300
	if !wasConnected && c.connected {
		c.logger.Info("CTI relay connection restored")
	} else if wasConnected && !c.connected {
		c.logger.Warn("CTI relay health check returned non-OK status", "status", resp.StatusCode)
	}
}

func (s *C2GatewayServer) isDegraded() bool {
	return enclave == "low" && s.cti != nil && !s.cti.IsConnected()
}

func NewC2GatewayServer(provider C2Provider, port string, nc *nats.Conn, logger *slog.Logger, jwtSecret string) *C2GatewayServer {
	return &C2GatewayServer{provider: provider, port: port, nc: nc, logger: logger, jwtSecret: []byte(jwtSecret)}
}

// resolveProvider returns the provider for a request. If a ?provider=name query
// param is set, the registry is consulted. Otherwise the default provider is
// returned.
func (s *C2GatewayServer) resolveProvider(r *http.Request) (C2Provider, error) {
	name := r.URL.Query().Get("provider")
	if name == "" {
		return s.provider, nil
	}
	if s.registry == nil {
		return nil, fmt.Errorf("provider registry not initialised")
	}
	p := s.registry.Get(name)
	if p == nil {
		return nil, fmt.Errorf("provider %q not found", name)
	}
	return p, nil
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func (s *C2GatewayServer) Start() error {
	mux := http.NewServeMux()

	// Session endpoints
	mux.HandleFunc("GET /api/v1/c2/sessions", s.handleListSessions)
	mux.HandleFunc("GET /api/v1/c2/implants", s.handleListImplants)
	mux.HandleFunc("GET /api/v1/c2/listeners", s.handleListListeners)
	mux.HandleFunc("POST /api/v1/c2/listeners", s.handleCreateListener)
	mux.HandleFunc("POST /api/v1/c2/implants/generate", s.handleGenerateImplant)

	// Task execution (goes through approval check)
	mux.HandleFunc("POST /api/v1/c2/sessions/{sessionID}/execute", s.handleExecuteTask)

	// WebSocket for interactive shell sessions
	mux.HandleFunc("GET /api/v1/c2/sessions/{sessionID}/shell", s.handleShellSession)

	// VNC WebSocket proxy for noVNC
	mux.HandleFunc("GET /api/v1/c2/vnc/{host}/{port}", s.handleVNCProxy)

	// Provider registry management
	mux.HandleFunc("GET /api/v1/c2/providers", s.handleListProviders)
	mux.HandleFunc("POST /api/v1/c2/providers", s.handleRegisterProvider)
	mux.HandleFunc("DELETE /api/v1/c2/providers/{name}", s.handleRemoveProvider)
	mux.HandleFunc("GET /api/v1/c2/providers/{name}/status", s.handleProviderStatus)

	// Cross-domain command execution (M12)
	mux.HandleFunc("POST /api/v1/c2/cross-domain/execute", s.handleCrossDomainExecute)
	mux.HandleFunc("GET /api/v1/c2/cross-domain/commands", s.handleListCrossDomainCommands)
	mux.HandleFunc("GET /api/v1/c2/cross-domain/commands/{id}", s.handleGetCrossDomainCommand)
	mux.HandleFunc("POST /api/v1/c2/cross-domain/commands/{id}/approve", s.handleApproveCrossDomainCommand)

	// Containment actions (DCO/SOC M13)
	mux.HandleFunc("POST /api/v1/c2/containment/execute", s.handleExecuteContainment)
	mux.HandleFunc("GET /api/v1/c2/containment/actions", s.handleListContainmentActions)
	mux.HandleFunc("GET /api/v1/c2/containment/actions/{id}", s.handleGetContainmentAction)
	mux.HandleFunc("POST /api/v1/c2/containment/actions/{id}/rollback", s.handleRollbackContainmentAction)

	// Health check
	mux.HandleFunc("GET /health/live", s.handleHealthLive)
	mux.HandleFunc("GET /health/ready", s.handleHealthReady)
	mux.HandleFunc("GET /health", s.handleHealthReady)
	mux.HandleFunc("GET /api/v1/c2/health", s.handleHealth)
	mux.HandleFunc("GET /api/v1/c2/cti-status", s.handleCTIStatus)

	handler := maxBodyMiddleware(10<<20, mux) // 10 MB (implant generation payloads)

	s.httpServer = &http.Server{
		Addr:         ":" + s.port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.logger.Info("c2-gateway starting", "port", s.port, "provider", s.provider.Name())
	return s.httpServer.ListenAndServe()
}

func (s *C2GatewayServer) handleListSessions(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolveProvider(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	sessions, err := p.ListSessions(r.Context(), nil)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleListSessions", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

func (s *C2GatewayServer) handleListImplants(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolveProvider(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	implants, err := p.ListImplants(r.Context(), nil)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleListImplants", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(implants)
}

func (s *C2GatewayServer) handleListListeners(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolveProvider(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	listeners, err := p.ListListeners(r.Context())
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleListListeners", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(listeners)
}

func (s *C2GatewayServer) handleCreateListener(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolveProvider(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	var spec ListenerSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	listener, err := p.CreateListener(r.Context(), spec)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleCreateListener", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(listener)
}

func (s *C2GatewayServer) handleGenerateImplant(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolveProvider(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	var spec ImplantSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	binary, err := p.GenerateImplant(r.Context(), spec)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleGenerateImplant", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	s.publishAudit("c2.implant_generated", r, spec.Transport, "generate_implant",
		fmt.Sprintf("os=%s arch=%s transport=%s format=%s", spec.OS, spec.Arch, spec.Transport, spec.Format))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", binary.Name))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(binary.Data)))
	w.Write(binary.Data)
}

func (s *C2GatewayServer) handleCTIStatus(w http.ResponseWriter, r *http.Request) {
	ctiConnected := true
	degraded := false
	if s.cti != nil {
		ctiConnected = s.cti.IsConnected()
		degraded = s.isDegraded()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"cti_connected": ctiConnected,
		"enclave":       enclave,
		"degraded":      degraded,
	})
}

func (s *C2GatewayServer) handleExecuteTask(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolveProvider(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	sessionID := r.PathValue("sessionID")

	var task C2Task
	if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Default and validate classification
	if task.Classification == "" {
		task.Classification = "UNCLASS"
	}
	if !isValidClassification(task.Classification) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "classification must be UNCLASS, CUI, or SECRET")
		return
	}
	// Enclave enforcement: block SECRET on low side
	if enclave == "low" && task.Classification == "SECRET" {
		writeError(w, http.StatusForbidden, "ENCLAVE_RESTRICTION", "Cannot execute SECRET tasks on low-side enclave")
		return
	}

	// Check risk level and approval status
	riskLevel := GetCommandRisk(task.Command, nil)

	// Degraded mode: block risk 3+ commands on low side
	if s.isDegraded() && riskLevel >= 3 {
		writeError(w, http.StatusServiceUnavailable, "DEGRADED_MODE",
			"CTI link unavailable — risk 3+ commands blocked on low side")
		return
	}

	// TODO: Check against ticket service for approval if riskLevel > auto-approve threshold
	s.logger.Info("executing task", "session", sessionID, "command", task.Command, "risk_level", riskLevel, "classification", task.Classification)

	result, err := p.ExecuteTask(r.Context(), sessionID, task)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleExecuteTask", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}

	// Propagate classification to result
	result.Classification = task.Classification

	// Publish audit event with classification
	detailsJSON, _ := json.Marshal(task)
	s.publishAuditWithClassification("c2.command_executed", r, sessionID, task.Command, string(detailsJSON), task.Classification)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Classification", task.Classification)
	json.NewEncoder(w).Encode(result)
}

// WebSocket upgrader for shell sessions
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		allowed := os.Getenv("ALLOWED_ORIGINS")
		if allowed == "" {
			allowed = "http://localhost:18080"
		}
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // Non-browser clients (curl, etc.) don't send Origin
		}
		for _, o := range strings.Split(allowed, ",") {
			if strings.TrimSpace(o) == origin {
				return true
			}
		}
		return false
	},
}

func (s *C2GatewayServer) handleShellSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionID")

	// Auth check: ForwardAuth sets X-User-ID, or validate JWT from query param (WebSocket)
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		tokenStr := r.URL.Query().Get("token")
		if tokenStr == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		sub, err := s.validateJWT(tokenStr)
		if err != nil {
			s.logger.Error("shell auth failed", "error", err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		userID = sub
	}

	// Upgrade to WebSocket
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("websocket upgrade failed", "error", err)
		return
	}
	defer ws.Close()

	// Resolve provider (shell also supports ?provider= query param)
	p, pErr := s.resolveProvider(r)
	if pErr != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("Error: "+pErr.Error()))
		return
	}

	// Open shell session on C2 backend
	stream, err := p.OpenSession(r.Context(), sessionID)
	if err != nil {
		s.logger.Error("failed to open shell session", "session", sessionID, "error", err)
		ws.WriteMessage(websocket.TextMessage, []byte("Error: "+err.Error()))
		return
	}
	defer stream.Close()

	// Publish session opened
	s.publishAudit("c2.session_opened", r, sessionID, "shell_open", "")

	// Read from Sliver -> write to WebSocket
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			output, err := stream.Recv()
			if err != nil {
				if err != io.EOF {
					s.logger.Error("shell recv error", "error", err)
				}
				return
			}
			if err := ws.WriteMessage(websocket.TextMessage, []byte(output)); err != nil {
				return
			}
		}
	}()

	// Read from WebSocket -> write to Sliver
	go func() {
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if err := stream.Send(string(msg)); err != nil {
				return
			}
		}
	}()

	<-done

	// Publish session closed
	s.publishAudit("c2.session_closed", r, sessionID, "shell_close", "")
}

func (s *C2GatewayServer) handleHealthLive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "c2-gateway"})
}

func (s *C2GatewayServer) handleHealthReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	status := http.StatusOK
	overall := "ok"

	if !s.nc.IsConnected() {
		checks["nats"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["nats"] = "ok"
	}

	resp := map[string]any{"status": overall, "service": "c2-gateway", "checks": checks}
	if s.cti != nil {
		resp["cti_connected"] = s.cti.IsConnected()
		resp["degraded"] = s.isDegraded()
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(resp)
}

func (s *C2GatewayServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	status := "ok"
	sliverConnected := s.provider.IsConnected()
	if !sliverConnected {
		status = "degraded"
	}

	activeSessions := 0
	if sliverConnected {
		if sessions, err := s.provider.ListSessions(r.Context(), nil); err == nil {
			for _, sess := range sessions {
				if sess.IsAlive {
					activeSessions++
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           status,
		"provider":         s.provider.Name(),
		"sliver_connected": sliverConnected,
		"active_sessions":  activeSessions,
		"time":             time.Now().UTC(),
	})
}

// ════════════════════════════════════════════
//  PROVIDER REGISTRY HANDLERS
// ════════════════════════════════════════════

// handleListProviders — GET /api/v1/c2/providers
func (s *C2GatewayServer) handleListProviders(w http.ResponseWriter, r *http.Request) {
	if s.registry == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Provider registry not initialised")
		return
	}
	providers := s.registry.List()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"providers": providers,
	})
}

// handleRegisterProvider — POST /api/v1/c2/providers
func (s *C2GatewayServer) handleRegisterProvider(w http.ResponseWriter, r *http.Request) {
	// FINDING-03: Only admins may manage C2 providers
	roles := r.Header.Get("X-User-Roles")
	if !hasRole(roles, "admin") {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Admin role required to manage C2 providers")
		return
	}

	if s.registry == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Provider registry not initialised")
		return
	}

	// Use request-specific struct to accept auth_config from JSON input
	// (RegistryProviderConfig has json:"-" on AuthConfig to prevent output leakage)
	var req struct {
		Name       string            `json:"name"`
		Type       string            `json:"type"`
		Host       string            `json:"host"`
		Port       int               `json:"port"`
		AuthConfig map[string]string `json:"auth_config"`
		AuthType   string            `json:"auth_type"`
		Mode       string            `json:"mode"`
		Enabled    bool              `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}
	if req.Name == "" || req.Type == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name and type are required")
		return
	}
	cfg := RegistryProviderConfig{
		Name:       req.Name,
		Type:       req.Type,
		Host:       req.Host,
		Port:       req.Port,
		AuthConfig: req.AuthConfig,
		AuthType:   req.AuthType,
		Mode:       req.Mode,
		Enabled:    req.Enabled,
	}

	// FINDING-04: Block SSRF via provider host validation
	host := cfg.Host
	if cfg.Mode == "external" && host != "" {
		blockedHosts := []string{"localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "metadata.google.internal"}
		hostLower := strings.ToLower(host)
		for _, blocked := range blockedHosts {
			if hostLower == blocked {
				writeError(w, http.StatusBadRequest, "INVALID_HOST", "Host address not allowed")
				return
			}
		}
		// Block internal Docker service names
		internalServices := []string{"auth-service", "workflow-engine", "ticket-service", "dashboard-service",
			"audit-service", "notification-service", "endpoint-service", "ws-relay", "frontend",
			"postgres", "redis", "nats", "clickhouse", "minio", "traefik"}
		for _, svc := range internalServices {
			if hostLower == svc {
				writeError(w, http.StatusBadRequest, "INVALID_HOST", "Internal service addresses not allowed")
				return
			}
		}
		// Block ems-net (10.100.0.0/16) -- only endpoint-net (10.101.0.0/16) should be reachable
		ip := net.ParseIP(host)
		if ip != nil {
			emsNet := net.IPNet{IP: net.ParseIP("10.100.0.0"), Mask: net.CIDRMask(16, 32)}
			metadataNet := net.IPNet{IP: net.ParseIP("169.254.0.0"), Mask: net.CIDRMask(16, 32)}
			loopbackNet := net.IPNet{IP: net.ParseIP("127.0.0.0"), Mask: net.CIDRMask(8, 32)}
			if emsNet.Contains(ip) || metadataNet.Contains(ip) || loopbackNet.Contains(ip) {
				writeError(w, http.StatusBadRequest, "INVALID_HOST", "Host address not allowed")
				return
			}
		}
	}

	provider, err := CreateProviderByType(cfg.Type, s.logger)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}

	s.registry.Register(cfg.Name, provider, cfg)

	// Attempt to connect if enabled
	if cfg.Enabled {
		provCfg := ProviderConfig{
			Host:    cfg.Host,
			Port:    cfg.Port,
			Options: cfg.AuthConfig,
		}
		if err := provider.Connect(r.Context(), provCfg); err != nil {
			s.logger.Warn("provider registered but connection failed", "name", cfg.Name, "error", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{
				"name":      cfg.Name,
				"type":      cfg.Type,
				"connected": false,
				"error":     err.Error(),
			})
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"name":      cfg.Name,
		"type":      cfg.Type,
		"connected": provider.IsConnected(),
	})
}

// handleRemoveProvider — DELETE /api/v1/c2/providers/{name}
func (s *C2GatewayServer) handleRemoveProvider(w http.ResponseWriter, r *http.Request) {
	// FINDING-03: Only admins may manage C2 providers
	roles := r.Header.Get("X-User-Roles")
	if !hasRole(roles, "admin") {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Admin role required to manage C2 providers")
		return
	}

	if s.registry == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Provider registry not initialised")
		return
	}

	name := r.PathValue("name")
	if err := s.registry.Remove(name); err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"removed": name,
	})
}

// handleProviderStatus — GET /api/v1/c2/providers/{name}/status
func (s *C2GatewayServer) handleProviderStatus(w http.ResponseWriter, r *http.Request) {
	if s.registry == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Provider registry not initialised")
		return
	}

	name := r.PathValue("name")
	p := s.registry.Get(name)
	if p == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", fmt.Sprintf("provider %q not found", name))
		return
	}
	cfg, _ := s.registry.GetConfig(name)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"name":      name,
		"type":      cfg.Type,
		"mode":      cfg.Mode,
		"enabled":   cfg.Enabled,
		"connected": p.IsConnected(),
	})
}

// ════════════════════════════════════════════
//  CROSS-DOMAIN COMMAND HANDLERS
// ════════════════════════════════════════════

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// handleCrossDomainExecute submits a command for cross-domain execution (high side only).
func (s *C2GatewayServer) handleCrossDomainExecute(w http.ResponseWriter, r *http.Request) {
	// Cross-domain execution is only available on the high side
	if enclave != "high" {
		writeError(w, http.StatusForbidden, "ENCLAVE_RESTRICTION",
			"Cross-domain command execution is only available on the high-side enclave")
		return
	}

	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for cross-domain commands")
		return
	}

	var req CrossDomainExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.SessionID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "session_id is required")
		return
	}
	if req.Command == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "command is required")
		return
	}
	if req.OperationID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "operation_id is required")
		return
	}

	// Default and validate classification
	if req.Classification == "" {
		req.Classification = "UNCLASS"
	}
	if !isValidClassification(req.Classification) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "classification must be UNCLASS, CUI, or SECRET")
		return
	}

	userID := r.Header.Get("X-User-ID")
	riskLevel := GetCommandRisk(req.Command, nil)

	ctx := r.Context()

	if riskLevel <= 2 {
		// Risk 1-2: auto-approve, publish directly for CTI relay
		var cmdID string
		err := s.db.QueryRow(ctx,
			`INSERT INTO cross_domain_commands
				(operation_id, command, target_session_id, risk_level, status, requested_by)
			 VALUES ($1, $2, $3, $4, 'queued_cti', $5)
			 RETURNING id`,
			req.OperationID, req.Command, req.SessionID, riskLevel, userID).Scan(&cmdID)
		if err != nil {
			s.logger.Error("failed to insert cross-domain command", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create command")
			return
		}

		// Publish for CTI relay to forward to low side
		s.publishCrossDomainEvent("cti.command.execute", map[string]any{
			"command_id":        cmdID,
			"operation_id":      req.OperationID,
			"session_id":        req.SessionID,
			"command":           req.Command,
			"risk_level":        riskLevel,
			"classification":    req.Classification,
			"requested_by":      userID,
		})

		s.logger.Info("cross-domain command auto-approved",
			"command_id", cmdID, "risk_level", riskLevel, "command", req.Command)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{
			"command_id": cmdID,
			"status":     "queued_cti",
			"risk_level": riskLevel,
			"message":    "Command auto-approved and queued for CTI relay",
		})
	} else {
		// Risk 3+: requires approval
		var cmdID string
		err := s.db.QueryRow(ctx,
			`INSERT INTO cross_domain_commands
				(operation_id, command, target_session_id, risk_level, status, requested_by)
			 VALUES ($1, $2, $3, $4, 'pending', $5)
			 RETURNING id`,
			req.OperationID, req.Command, req.SessionID, riskLevel, userID).Scan(&cmdID)
		if err != nil {
			s.logger.Error("failed to insert cross-domain command", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create command")
			return
		}

		// Publish pending event
		s.publishCrossDomainEvent("cti.command.pending", map[string]any{
			"command_id":     cmdID,
			"operation_id":   req.OperationID,
			"session_id":     req.SessionID,
			"command":        req.Command,
			"risk_level":     riskLevel,
			"requested_by":   userID,
		})

		s.logger.Info("cross-domain command pending approval",
			"command_id", cmdID, "risk_level", riskLevel, "command", req.Command)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{
			"command_id": cmdID,
			"status":     "pending",
			"risk_level": riskLevel,
			"message":    "Command queued for supervisor approval",
		})
	}
}

// handleListCrossDomainCommands lists cross-domain commands with optional filters.
func (s *C2GatewayServer) handleListCrossDomainCommands(w http.ResponseWriter, r *http.Request) {
	// Cross-domain commands are only available on the high side
	if enclave != "high" && enclave != "" {
		writeError(w, http.StatusForbidden, "ENCLAVE_RESTRICTED", "cross-domain commands only available on high side")
		return
	}

	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for cross-domain commands")
		return
	}

	ctx := r.Context()
	statusFilter := r.URL.Query().Get("status")
	operationFilter := r.URL.Query().Get("operation_id")

	page := 1
	limit := 20
	if p := r.URL.Query().Get("page"); p != "" {
		if v, err := strconv.Atoi(p); err == nil && v > 0 {
			page = v
		}
	}
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 && v <= 100 {
			limit = v
		}
	}
	offset := (page - 1) * limit

	conditions := []string{}
	args := []any{}
	argIdx := 1

	if statusFilter != "" {
		conditions = append(conditions, fmt.Sprintf("status = $%d", argIdx))
		args = append(args, statusFilter)
		argIdx++
	}
	if operationFilter != "" {
		conditions = append(conditions, fmt.Sprintf("operation_id = $%d", argIdx))
		args = append(args, operationFilter)
		argIdx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	var total int
	_ = s.db.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM cross_domain_commands %s", where), args...).Scan(&total)

	args = append(args, limit, offset)
	q := fmt.Sprintf(
		`SELECT id, operation_id, command, target_session_id, risk_level, classification,
				status, requested_by, requested_at, approved_by, approved_at, executed_at,
				result, created_at, updated_at
		 FROM cross_domain_commands %s
		 ORDER BY created_at DESC
		 LIMIT $%d OFFSET $%d`, where, argIdx, argIdx+1)

	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		s.logger.Error("failed to list cross-domain commands", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to list commands")
		return
	}
	defer rows.Close()

	var commands []CrossDomainCommand
	for rows.Next() {
		cmd, err := scanCrossDomainCommand(rows)
		if err != nil {
			s.logger.Error("failed to scan cross-domain command", "error", err)
			continue
		}
		commands = append(commands, cmd)
	}
	if commands == nil {
		commands = []CrossDomainCommand{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"data":       commands,
		"pagination": map[string]int{"page": page, "limit": limit, "total": total},
	})
}

// handleGetCrossDomainCommand returns a single cross-domain command.
func (s *C2GatewayServer) handleGetCrossDomainCommand(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for cross-domain commands")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	row := s.db.QueryRow(r.Context(),
		`SELECT id, operation_id, command, target_session_id, risk_level, classification,
				status, requested_by, requested_at, approved_by, approved_at, executed_at,
				result, created_at, updated_at
		 FROM cross_domain_commands WHERE id = $1`, id)

	cmd, err := scanCrossDomainCommand(row)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Command not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cmd)
}

// handleApproveCrossDomainCommand approves a pending cross-domain command.
func (s *C2GatewayServer) handleApproveCrossDomainCommand(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for cross-domain commands")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Check supervisor role
	roles := r.Header.Get("X-User-Roles")
	if !hasRole(roles, "admin", "supervisor", "e2", "e3") {
		writeError(w, http.StatusForbidden, "FORBIDDEN",
			"Supervisor or admin role required to approve cross-domain commands")
		return
	}

	approverID := r.Header.Get("X-User-ID")
	ctx := r.Context()

	// Check current status and prevent self-approval
	var currentStatus string
	var requestedBy *string
	err := s.db.QueryRow(ctx,
		`SELECT status, requested_by FROM cross_domain_commands WHERE id = $1`, id).
		Scan(&currentStatus, &requestedBy)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Command not found")
		return
	}
	if currentStatus != "pending" {
		writeError(w, http.StatusConflict, "INVALID_STATE",
			fmt.Sprintf("Command is already %s", currentStatus))
		return
	}
	if requestedBy != nil && *requestedBy == approverID {
		writeError(w, http.StatusForbidden, "SELF_APPROVAL",
			"Cannot approve own cross-domain command")
		return
	}

	// Update to queued_cti
	_, err = s.db.Exec(ctx,
		`UPDATE cross_domain_commands
		 SET status = 'queued_cti', approved_by = $2, approved_at = NOW()
		 WHERE id = $1`,
		id, approverID)
	if err != nil {
		s.logger.Error("failed to approve cross-domain command", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to approve command")
		return
	}

	// Fetch the command details to publish
	var cmd struct {
		OperationID     string
		Command         string
		TargetSessionID string
		RiskLevel       int
		Classification  string
	}
	_ = s.db.QueryRow(ctx,
		`SELECT operation_id, command, target_session_id, risk_level, classification
		 FROM cross_domain_commands WHERE id = $1`, id).
		Scan(&cmd.OperationID, &cmd.Command, &cmd.TargetSessionID, &cmd.RiskLevel, &cmd.Classification)

	// Publish for CTI relay
	s.publishCrossDomainEvent("cti.command.execute", map[string]any{
		"command_id":     id,
		"operation_id":   cmd.OperationID,
		"session_id":     cmd.TargetSessionID,
		"command":        cmd.Command,
		"risk_level":     cmd.RiskLevel,
		"classification": cmd.Classification,
		"approved_by":    approverID,
	})

	s.logger.Info("cross-domain command approved",
		"command_id", id, "approved_by", approverID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"command_id": id,
		"status":     "queued_cti",
	})
}

// publishCrossDomainEvent publishes a cross-domain event to NATS.
func (s *C2GatewayServer) publishCrossDomainEvent(subject string, data map[string]any) {
	if s.nc == nil {
		return
	}
	data["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	payload, err := json.Marshal(data)
	if err != nil {
		s.logger.Error("failed to marshal cross-domain event", "subject", subject, "error", err)
		return
	}
	if err := s.nc.Publish(subject, payload); err != nil {
		s.logger.Error("failed to publish cross-domain event", "subject", subject, "error", err)
	}
}

// startCommandRelay subscribes to relayed commands on the low side and executes them.
func (s *C2GatewayServer) startCommandRelay(ctx context.Context) {
	if enclave != "low" || s.nc == nil {
		return // only low side listens for cross-domain commands
	}

	s.logger.Info("starting cross-domain command relay listener")

	_, err := s.nc.Subscribe("cti.relayed.cti.command.execute", func(msg *nats.Msg) {
		var cmdReq struct {
			CommandID   string `json:"command_id"`
			OperationID string `json:"operation_id"`
			SessionID   string `json:"session_id"`
			Command     string `json:"command"`
			RiskLevel   int    `json:"risk_level"`
			Classification string `json:"classification"`
		}
		if err := json.Unmarshal(msg.Data, &cmdReq); err != nil {
			s.logger.Error("failed to parse relayed command", "error", err)
			return
		}

		s.logger.Info("received cross-domain command for execution",
			"command_id", cmdReq.CommandID,
			"session_id", cmdReq.SessionID,
			"command", cmdReq.Command,
		)

		// Execute via the C2 provider
		task := C2Task{
			Command:        cmdReq.Command,
			Classification: cmdReq.Classification,
		}

		result, err := s.provider.ExecuteTask(ctx, cmdReq.SessionID, task)

		// Build result payload
		resultData := map[string]any{
			"command_id":   cmdReq.CommandID,
			"operation_id": cmdReq.OperationID,
			"session_id":   cmdReq.SessionID,
			"command":      cmdReq.Command,
			"timestamp":    time.Now().UTC().Format(time.RFC3339Nano),
		}

		if err != nil {
			resultData["status"] = "failed"
			resultData["error"] = err.Error()
			s.logger.Error("cross-domain command execution failed",
				"command_id", cmdReq.CommandID, "error", err)
		} else {
			resultData["status"] = "completed"
			resultData["output"] = result.Output
			if result.Error != "" {
				resultData["error"] = result.Error
			}
			resultData["started_at"] = result.StartedAt.Format(time.RFC3339)
			resultData["ended_at"] = result.EndedAt.Format(time.RFC3339)
			s.logger.Info("cross-domain command executed successfully",
				"command_id", cmdReq.CommandID, "command", cmdReq.Command)
		}

		// Publish result back for CTI relay to forward to high side
		payload, _ := json.Marshal(resultData)
		if pubErr := s.nc.Publish("cti.command.result", payload); pubErr != nil {
			s.logger.Error("failed to publish command result", "error", pubErr,
				"command_id", cmdReq.CommandID)
		}
	})

	if err != nil {
		s.logger.Error("failed to subscribe to relayed commands", "error", err)
	} else {
		s.logger.Info("subscribed to cti.relayed.cti.command.execute")
	}
}

// startResultListener subscribes to command results on the high side.
func (s *C2GatewayServer) startResultListener(ctx context.Context) {
	if enclave != "high" || s.nc == nil || s.db == nil {
		return
	}

	s.logger.Info("starting cross-domain command result listener")

	_, err := s.nc.Subscribe("cti.relayed.cti.command.result", func(msg *nats.Msg) {
		var result struct {
			CommandID string `json:"command_id"`
			Status    string `json:"status"`
			Output    string `json:"output"`
			Error     string `json:"error"`
		}
		if err := json.Unmarshal(msg.Data, &result); err != nil {
			s.logger.Error("failed to parse command result", "error", err)
			return
		}

		if result.CommandID == "" {
			return
		}

		// Update the cross_domain_commands table
		dbStatus := "completed"
		if result.Status == "failed" {
			dbStatus = "failed"
		}

		resultJSON, _ := json.Marshal(map[string]string{
			"output": result.Output,
			"error":  result.Error,
		})

		_, err := s.db.Exec(context.Background(),
			`UPDATE cross_domain_commands
			 SET status = $2, executed_at = NOW(), result = $3
			 WHERE id = $1`,
			result.CommandID, dbStatus, resultJSON)
		if err != nil {
			s.logger.Error("failed to update command result", "error", err,
				"command_id", result.CommandID)
			return
		}

		s.logger.Info("cross-domain command result received",
			"command_id", result.CommandID, "status", dbStatus)
	})

	if err != nil {
		s.logger.Error("failed to subscribe to command results", "error", err)
	} else {
		s.logger.Info("subscribed to cti.relayed.cti.command.result")
	}
}

// scanCrossDomainCommand scans a cross-domain command row from the database.
func scanCrossDomainCommand(scanner interface{ Scan(dest ...any) error }) (CrossDomainCommand, error) {
	var cmd CrossDomainCommand
	var requestedAt, createdAt, updatedAt time.Time
	var approvedAt, executedAt *time.Time
	var resultBytes []byte

	err := scanner.Scan(
		&cmd.ID, &cmd.OperationID, &cmd.Command, &cmd.TargetSessionID,
		&cmd.RiskLevel, &cmd.Classification, &cmd.Status,
		&cmd.RequestedBy, &requestedAt,
		&cmd.ApprovedBy, &approvedAt, &executedAt,
		&resultBytes, &createdAt, &updatedAt,
	)
	if err != nil {
		return cmd, err
	}

	cmd.RequestedAt = requestedAt.UTC().Format(time.RFC3339)
	cmd.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	cmd.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	if approvedAt != nil {
		s := approvedAt.UTC().Format(time.RFC3339)
		cmd.ApprovedAt = &s
	}
	if executedAt != nil {
		s := executedAt.UTC().Format(time.RFC3339)
		cmd.ExecutedAt = &s
	}
	if len(resultBytes) > 0 {
		var r any
		if err := json.Unmarshal(resultBytes, &r); err == nil {
			cmd.Result = r
		}
	}

	return cmd, nil
}

// ════════════════════════════════════════════
//  VNC WEBSOCKET PROXY
//  Relays binary WebSocket frames ↔ raw TCP (noVNC RFB protocol)
// ════════════════════════════════════════════

// isEndpointSubnet validates that the host is within the endpoint network (10.101.0.0/16)
func isEndpointSubnet(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	_, epNet, _ := net.ParseCIDR("10.101.0.0/16")
	return epNet.Contains(ip)
}

func (s *C2GatewayServer) handleVNCProxy(w http.ResponseWriter, r *http.Request) {
	host := r.PathValue("host")
	vncPort := r.PathValue("port")

	// Validate VNC port range (5900-5999 only)
	portNum, err := strconv.Atoi(vncPort)
	if err != nil || portNum < 5900 || portNum > 5999 {
		writeError(w, http.StatusBadRequest, "INVALID_PORT", "VNC port must be between 5900 and 5999")
		return
	}

	// Auth: X-User-ID header or JWT query param (WebSocket can't use ForwardAuth)
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		tokenStr := r.URL.Query().Get("token")
		if tokenStr == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		sub, err := s.validateJWT(tokenStr)
		if err != nil {
			s.logger.Error("vnc auth failed", "error", err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		userID = sub
	}

	// SSRF prevention: only allow connections to endpoint subnet
	if !isEndpointSubnet(host) {
		s.logger.Warn("vnc proxy blocked: host not in endpoint subnet", "host", host, "user", userID)
		http.Error(w, "Forbidden: target not in endpoint subnet", http.StatusForbidden)
		return
	}

	target := fmt.Sprintf("%s:%s", host, vncPort)
	s.logger.Info("vnc proxy connecting", "target", target, "user", userID)

	// Dial the VNC server via raw TCP
	tcpConn, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		s.logger.Error("VNC connection failed", "target", target, "error", err)
		writeError(w, http.StatusBadGateway, "VNC_ERROR", "Failed to connect to remote desktop")
		return
	}
	defer tcpConn.Close()

	// Upgrade to WebSocket
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("vnc websocket upgrade failed", "error", err)
		return
	}
	defer ws.Close()

	s.publishAudit("c2.vnc_opened", r, host, "vnc_connect", fmt.Sprintf("target=%s user=%s", target, userID))

	// Bidirectional relay: WebSocket binary ↔ TCP
	done := make(chan struct{})

	// TCP → WebSocket
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := tcpConn.Read(buf)
			if err != nil {
				return
			}
			if err := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket → TCP
	go func() {
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				tcpConn.Close()
				return
			}
			if _, err := tcpConn.Write(msg); err != nil {
				return
			}
		}
	}()

	<-done
	s.publishAudit("c2.vnc_closed", r, host, "vnc_disconnect", fmt.Sprintf("target=%s user=%s", target, userID))
}

// ════════════════════════════════════════════
//  SLIVER PROVIDER (implements C2Provider)
// ════════════════════════════════════════════

// SliverProvider implements the C2Provider interface for Sliver C2
// Uses Sliver's gRPC API via the official protobuf definitions
type SliverProvider struct {
	config    ProviderConfig
	conn      *grpc.ClientConn
	rpc       rpcpb.SliverRPCClient
	mu        sync.RWMutex
	connected bool
	logger    *slog.Logger
}

func NewSliverProvider(logger *slog.Logger) *SliverProvider {
	return &SliverProvider{logger: logger}
}

func (p *SliverProvider) Name() string { return "sliver" }

func (p *SliverProvider) IsConnected() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.connected
}

func (p *SliverProvider) Connect(ctx context.Context, config ProviderConfig) error {
	p.config = config

	opConfig, err := loadOperatorConfig(config.OperatorConfig)
	if err != nil {
		return fmt.Errorf("load operator config: %w", err)
	}

	tlsConfig, err := opConfig.TLSConfig()
	if err != nil {
		return fmt.Errorf("build TLS config: %w", err)
	}

	target := fmt.Sprintf("%s:%d", config.Host, config.Port)
	p.logger.Info("connecting to sliver", "target", target, "operator", opConfig.Operator)

	conn, err := grpc.DialContext(ctx, target,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
		grpc.WithPerRPCCredentials(TokenAuth{token: opConfig.Token}),
	)
	if err != nil {
		return fmt.Errorf("grpc dial: %w", err)
	}

	p.mu.Lock()
	p.conn = conn
	p.rpc = rpcpb.NewSliverRPCClient(conn)
	p.connected = true
	p.mu.Unlock()

	p.logger.Info("connected to sliver", "target", target)
	return nil
}

func (p *SliverProvider) Disconnect() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn != nil {
		p.connected = false
		return p.conn.Close()
	}
	return nil
}

// ── ListSessions ────────────────────────────

func (p *SliverProvider) ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}
	resp, err := p.rpc.GetSessions(ctx, &commonpb.Empty{})
	if err != nil {
		return nil, fmt.Errorf("get sessions: %w", err)
	}

	sessions := make([]Session, 0, len(resp.GetSessions()))
	for _, s := range resp.GetSessions() {
		sessions = append(sessions, Session{
			ID:          s.GetID(),
			ImplantID:   s.GetName(),
			Hostname:    s.GetHostname(),
			OS:          s.GetOS(),
			RemoteAddr:  s.GetRemoteAddress(),
			Transport:   s.GetTransport(),
			IsAlive:     !s.GetIsDead(),
			LastMessage: time.Unix(s.GetLastCheckin(), 0),
		})
	}
	return sessions, nil
}

// ── ListImplants ────────────────────────────

func (p *SliverProvider) ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}

	// Get implant builds
	builds, err := p.rpc.ImplantBuilds(ctx, &commonpb.Empty{})
	if err != nil {
		return nil, fmt.Errorf("get implant builds: %w", err)
	}

	var implants []Implant
	for name, build := range builds.GetConfigs() {
		transport := ""
		if c2s := build.GetC2(); len(c2s) > 0 {
			transport = c2s[0].GetURL()
		}
		implants = append(implants, Implant{
			ID:        build.GetID(),
			Name:      name,
			OS:        build.GetGOOS(),
			Arch:      build.GetGOARCH(),
			Transport: transport,
			Status:    "built",
		})
	}

	// Get beacons (async implants)
	beacons, err := p.rpc.GetBeacons(ctx, &commonpb.Empty{})
	if err != nil {
		p.logger.Warn("failed to get beacons", "error", err)
	} else {
		for _, b := range beacons.GetBeacons() {
			implants = append(implants, Implant{
				ID:          b.GetID(),
				Name:        b.GetName(),
				OS:          b.GetOS(),
				Arch:        b.GetArch(),
				Transport:   b.GetTransport(),
				Hostname:    b.GetHostname(),
				RemoteAddr:  b.GetRemoteAddress(),
				LastCheckin: time.Unix(b.GetLastCheckin(), 0),
				Status:      "active",
			})
		}
	}

	return implants, nil
}

func (p *SliverProvider) GenerateImplant(ctx context.Context, spec ImplantSpec) (*ImplantBinary, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}

	goos := spec.OS
	if goos == "" {
		goos = "linux"
	}
	goarch := spec.Arch
	if goarch == "" {
		goarch = "amd64"
	}

	c2URL := spec.C2URL
	if c2URL == "" {
		return nil, fmt.Errorf("c2_url is required (e.g. mtls://sliver-server:8888)")
	}

	var format clientpb.OutputFormat
	switch strings.ToLower(spec.Format) {
	case "shared", "shared_lib":
		format = clientpb.OutputFormat_SHARED_LIB
	case "shellcode":
		format = clientpb.OutputFormat_SHELLCODE
	case "service":
		format = clientpb.OutputFormat_SERVICE
	default:
		format = clientpb.OutputFormat_EXECUTABLE
	}

	config := &clientpb.ImplantConfig{
		GOOS:             goos,
		GOARCH:           goarch,
		Format:           format,
		ObfuscateSymbols: !spec.SkipSymbols,
		C2: []*clientpb.ImplantC2{
			{Priority: 0, URL: c2URL},
		},
	}

	resp, err := p.rpc.Generate(ctx, &clientpb.GenerateReq{Config: config})
	if err != nil {
		return nil, fmt.Errorf("generate implant: %w", err)
	}

	file := resp.GetFile()
	if file == nil {
		return nil, fmt.Errorf("generate returned empty file")
	}

	return &ImplantBinary{
		Name: file.GetName(),
		Data: file.GetData(),
		Size: int64(len(file.GetData())),
	}, nil
}

// ── ListListeners ───────────────────────────

func (p *SliverProvider) ListListeners(ctx context.Context) ([]Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}
	jobs, err := p.rpc.GetJobs(ctx, &commonpb.Empty{})
	if err != nil {
		return nil, fmt.Errorf("get jobs: %w", err)
	}

	listeners := make([]Listener, 0, len(jobs.GetActive()))
	for _, j := range jobs.GetActive() {
		host := j.GetName()
		if domains := j.GetDomains(); len(domains) > 0 {
			host = domains[0]
		}
		listeners = append(listeners, Listener{
			ID:        fmt.Sprintf("%d", j.GetID()),
			Protocol:  j.GetName(),
			Host:      host,
			Port:      int(j.GetPort()),
			IsRunning: true,
		})
	}
	return listeners, nil
}

func (p *SliverProvider) CreateListener(ctx context.Context, spec ListenerSpec) (*Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}

	host := spec.Host
	if host == "" {
		host = "0.0.0.0"
	}

	switch strings.ToLower(spec.Protocol) {
	case "mtls":
		port := spec.Port
		if port == 0 {
			port = 8888
		}
		resp, err := p.rpc.StartMTLSListener(ctx, &clientpb.MTLSListenerReq{
			Host:       host,
			Port:       uint32(port),
			Persistent: false,
		})
		if err != nil {
			return nil, fmt.Errorf("start mtls listener: %w", err)
		}
		return &Listener{
			ID:        fmt.Sprintf("%d", resp.GetJobID()),
			Protocol:  "mtls",
			Host:      host,
			Port:      port,
			IsRunning: true,
		}, nil

	case "http":
		port := spec.Port
		if port == 0 {
			port = 80
		}
		resp, err := p.rpc.StartHTTPListener(ctx, &clientpb.HTTPListenerReq{
			Host: host,
			Port: uint32(port),
		})
		if err != nil {
			return nil, fmt.Errorf("start http listener: %w", err)
		}
		return &Listener{
			ID:        fmt.Sprintf("%d", resp.GetJobID()),
			Protocol:  "http",
			Host:      host,
			Port:      port,
			IsRunning: true,
		}, nil

	case "https":
		port := spec.Port
		if port == 0 {
			port = 443
		}
		resp, err := p.rpc.StartHTTPSListener(ctx, &clientpb.HTTPListenerReq{
			Host: host,
			Port: uint32(port),
		})
		if err != nil {
			return nil, fmt.Errorf("start https listener: %w", err)
		}
		return &Listener{
			ID:        fmt.Sprintf("%d", resp.GetJobID()),
			Protocol:  "https",
			Host:      host,
			Port:      port,
			IsRunning: true,
		}, nil

	default:
		return nil, fmt.Errorf("unsupported listener protocol: %s", spec.Protocol)
	}
}

func (p *SliverProvider) DeleteListener(ctx context.Context, listenerID string) error {
	if !p.IsConnected() {
		return fmt.Errorf("not connected to sliver")
	}
	var id uint32
	if _, err := fmt.Sscanf(listenerID, "%d", &id); err != nil {
		return fmt.Errorf("invalid listener ID: %w", err)
	}
	resp, err := p.rpc.KillJob(ctx, &clientpb.KillJobReq{ID: id})
	if err != nil {
		return fmt.Errorf("kill job: %w", err)
	}
	if !resp.GetSuccess() {
		return fmt.Errorf("failed to kill job %d", id)
	}
	return nil
}

// ── ExecuteTask ─────────────────────────────

func (p *SliverProvider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}

	started := time.Now()
	req := &commonpb.Request{SessionID: sessionID, Timeout: 120}

	var output string
	var taskErr string

	// Parse compound command strings like "cat /etc/hostname" into command + args
	if task.Arguments == nil {
		task.Arguments = make(map[string]interface{})
	}
	parts := strings.Fields(task.Command)
	if len(parts) > 1 {
		task.Command = parts[0]
		// Auto-populate args from the command string for known commands
		switch parts[0] {
		case "cat":
			if _, ok := task.Arguments["path"]; !ok {
				task.Arguments["path"] = strings.Join(parts[1:], " ")
			}
		case "ls", "cd":
			if _, ok := task.Arguments["path"]; !ok {
				task.Arguments["path"] = strings.Join(parts[1:], " ")
			}
		default:
			// For unknown commands or commands with args, rejoin as the full command
			// so the execute handler can run it as a shell command
			if _, ok := task.Arguments["raw"]; !ok {
				task.Arguments["raw"] = strings.Join(parts, " ")
			}
		}
	}

	switch task.Command {
	case "ls":
		path, _ := task.Arguments["path"].(string)
		if path == "" {
			path = "."
		}
		resp, err := p.rpc.Ls(ctx, &sliverpb.LsReq{Path: path, Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = formatLsOutput(resp)
		}

	case "ps":
		resp, err := p.rpc.Ps(ctx, &sliverpb.PsReq{Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = formatPsOutput(resp)
		}

	case "pwd":
		resp, err := p.rpc.Pwd(ctx, &sliverpb.PwdReq{Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = resp.GetPath()
		}

	case "whoami":
		// Try GetEnv first, fall back to Execute("whoami")
		resp, err := p.rpc.GetEnv(ctx, &sliverpb.EnvReq{Name: "USER", Request: req})
		if err == nil && resp.GetResponse() != nil && resp.GetResponse().GetErr() == "" {
			for _, v := range resp.GetVariables() {
				if v.GetKey() == "USER" && v.GetValue() != "" {
					output = v.GetValue()
					break
				}
			}
		}
		if output == "" {
			// Fallback: execute whoami command
			execResp, execErr := p.rpc.Execute(ctx, &sliverpb.ExecuteReq{
				Path:    "/usr/bin/whoami",
				Args:    []string{},
				Output:  true,
				Request: req,
			})
			if execErr != nil {
				taskErr = execErr.Error()
			} else if execResp.GetResponse() != nil && execResp.GetResponse().GetErr() != "" {
				taskErr = execResp.GetResponse().GetErr()
			} else {
				output = strings.TrimSpace(string(execResp.GetStdout()))
				if output == "" {
					output = strings.TrimSpace(string(execResp.GetStderr()))
				}
			}
		}

	case "ifconfig":
		resp, err := p.rpc.Ifconfig(ctx, &sliverpb.IfconfigReq{Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = formatIfconfigOutput(resp)
		}

	case "netstat":
		resp, err := p.rpc.Netstat(ctx, &sliverpb.NetstatReq{Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = formatNetstatOutput(resp)
		}

	case "execute":
		path, _ := task.Arguments["path"].(string)
		args, _ := task.Arguments["args"].([]interface{})
		var strArgs []string
		for _, a := range args {
			if s, ok := a.(string); ok {
				strArgs = append(strArgs, s)
			}
		}
		resp, err := p.rpc.Execute(ctx, &sliverpb.ExecuteReq{
			Path:    path,
			Args:    strArgs,
			Output:  true,
			Request: req,
		})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = string(resp.GetStdout())
			if stderr := string(resp.GetStderr()); len(stderr) > 0 {
				output += "\nSTDERR:\n" + stderr
			}
		}

	case "cat":
		path, _ := task.Arguments["path"].(string)
		resp, err := p.rpc.Download(ctx, &sliverpb.DownloadReq{Path: path, Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			data := resp.GetData()
			// Sliver returns file data as nested gzip (outer encoding + inner tar.gz)
			// Decompress all gzip layers first
			for i := 0; i < 5 && len(data) > 2 && data[0] == 0x1f && data[1] == 0x8b; i++ {
				gz, gzErr := gzip.NewReader(bytes.NewReader(data))
				if gzErr != nil {
					break
				}
				decompressed, readErr := io.ReadAll(gz)
				gz.Close()
				if readErr != nil || len(decompressed) == 0 {
					break
				}
				data = decompressed
			}
			// Check if result is a tar archive — extract the target file
			if len(data) > 512 {
				tr := tar.NewReader(bytes.NewReader(data))
				baseName := ""
				if idx := strings.LastIndex(path, "/"); idx >= 0 {
					baseName = path[idx+1:]
				}
				var best []byte
				for {
					hdr, tarErr := tr.Next()
					if tarErr != nil {
						break
					}
					if hdr.Typeflag == tar.TypeDir {
						continue
					}
					fileBytes, _ := io.ReadAll(tr)
					// Prefer entry matching the requested filename
					if baseName != "" && strings.HasSuffix(hdr.Name, baseName) {
						best = fileBytes
						break
					}
					best = fileBytes // fallback: use last regular file
				}
				if len(best) > 0 {
					data = best
				}
			}
			output = string(data)
		}

	case "upload":
		path, _ := task.Arguments["path"].(string)
		dataStr, _ := task.Arguments["data"].(string)
		resp, err := p.rpc.Upload(ctx, &sliverpb.UploadReq{
			Path:    path,
			Data:    []byte(dataStr),
			Request: req,
		})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = fmt.Sprintf("Uploaded %d bytes to %s", len(dataStr), resp.GetPath())
		}

	case "download":
		path, _ := task.Arguments["path"].(string)
		resp, err := p.rpc.Download(ctx, &sliverpb.DownloadReq{Path: path, Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = fmt.Sprintf("Downloaded %d bytes from %s", len(resp.GetData()), path)
		}

	case "screenshot":
		resp, err := p.rpc.Screenshot(ctx, &sliverpb.ScreenshotReq{Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			output = fmt.Sprintf("data:image/png;base64,%s", base64.StdEncoding.EncodeToString(resp.GetData()))
		}

	default:
		// Generic command execution — run via shell
		fullCmd := task.Command
		if raw, ok := task.Arguments["raw"].(string); ok {
			fullCmd = raw
		}
		resp, err := p.rpc.Execute(ctx, &sliverpb.ExecuteReq{
			Path:    "/bin/sh",
			Args:    []string{"-c", fullCmd},
			Output:  true,
			Request: req,
		})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			stdout := string(resp.GetStdout())
			stderr := string(resp.GetStderr())
			if stdout != "" {
				output = stdout
			}
			if stderr != "" {
				if output != "" {
					output += "\n"
				}
				output += stderr
			}
			if output == "" {
				output = "(no output)"
			}
		}
	}

	return &TaskResult{
		TaskID:    fmt.Sprintf("%d", time.Now().UnixNano()),
		Command:   task.Command,
		Output:    output,
		Error:     taskErr,
		StartedAt: started,
		EndedAt:   time.Now(),
	}, nil
}

func (p *SliverProvider) GetTaskHistory(ctx context.Context, sessionID string) ([]TaskResult, error) {
	return []TaskResult{}, nil
}

// ── Output formatters ───────────────────────

func formatLsOutput(resp *sliverpb.Ls) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Directory: %s\n\n", resp.GetPath()))
	for _, f := range resp.GetFiles() {
		mode := "f"
		if f.GetIsDir() {
			mode = "d"
		}
		sb.WriteString(fmt.Sprintf("%s %10d  %s\n", mode, f.GetSize(), f.GetName()))
	}
	return sb.String()
}

func formatPsOutput(resp *sliverpb.Ps) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%-8s %-8s %-20s %s\n", "PID", "PPID", "OWNER", "EXECUTABLE"))
	for _, p := range resp.GetProcesses() {
		sb.WriteString(fmt.Sprintf("%-8d %-8d %-20s %s\n", p.GetPid(), p.GetPpid(), p.GetOwner(), p.GetExecutable()))
	}
	return sb.String()
}

func formatIfconfigOutput(resp *sliverpb.Ifconfig) string {
	var sb strings.Builder
	for _, iface := range resp.GetNetInterfaces() {
		sb.WriteString(fmt.Sprintf("%s:\n", iface.GetName()))
		for _, addr := range iface.GetIPAddresses() {
			sb.WriteString(fmt.Sprintf("  %s\n", addr))
		}
		sb.WriteString(fmt.Sprintf("  MAC: %s\n\n", iface.GetMAC()))
	}
	return sb.String()
}

func formatNetstatOutput(resp *sliverpb.Netstat) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%-8s %-25s %-25s %-10s\n", "PROTO", "LOCAL", "REMOTE", "STATE"))
	for _, e := range resp.GetEntries() {
		localAddr := e.GetLocalAddr()
		remoteAddr := e.GetRemoteAddr()
		local := fmt.Sprintf("%s:%d", localAddr.GetIp(), localAddr.GetPort())
		remote := fmt.Sprintf("%s:%d", remoteAddr.GetIp(), remoteAddr.GetPort())
		sb.WriteString(fmt.Sprintf("%-8s %-25s %-25s %-10s\n", e.GetProtocol(), local, remote, e.GetSkState()))
	}
	return sb.String()
}

// ── OpenSession (interactive shell) ─────────

// SliverSessionStream wraps a Sliver tunnel for the SessionStream interface
type SliverSessionStream struct {
	tunnelID  uint64
	sessionID string
	rpc       rpcpb.SliverRPCClient
	stream    rpcpb.SliverRPC_TunnelDataClient
	cancel    context.CancelFunc
}

func (s *SliverSessionStream) Send(input string) error {
	return s.stream.Send(&sliverpb.TunnelData{
		TunnelID:  s.tunnelID,
		SessionID: s.sessionID,
		Data:      []byte(input),
	})
}

func (s *SliverSessionStream) Recv() (string, error) {
	data, err := s.stream.Recv()
	if err != nil {
		return "", err
	}
	return string(data.GetData()), nil
}

func (s *SliverSessionStream) Close() error {
	s.cancel()
	return s.stream.CloseSend()
}

func (p *SliverProvider) OpenSession(ctx context.Context, sessionID string) (SessionStream, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}

	// Create a bidirectional tunnel data stream first
	streamCtx, cancel := context.WithCancel(context.Background())
	stream, err := p.rpc.TunnelData(streamCtx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("open tunnel stream: %w", err)
	}

	// Pre-allocate a tunnel on the server
	tunnel, err := p.rpc.CreateTunnel(ctx, &sliverpb.Tunnel{
		SessionID: sessionID,
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create tunnel: %w", err)
	}
	tunnelID := tunnel.GetTunnelID()

	// Register this stream with the tunnel
	if err := stream.Send(&sliverpb.TunnelData{
		TunnelID:  tunnelID,
		SessionID: sessionID,
	}); err != nil {
		cancel()
		return nil, fmt.Errorf("register tunnel: %w", err)
	}

	// Now open the shell using the pre-allocated tunnel
	req := &commonpb.Request{SessionID: sessionID, Timeout: 0}
	shell, err := p.rpc.Shell(ctx, &sliverpb.ShellReq{
		Path:      "/bin/sh",
		EnablePTY: true,
		TunnelID:  tunnelID,
		Request:   req,
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("open shell: %w", err)
	}
	if shell.GetResponse() != nil && shell.GetResponse().GetErr() != "" {
		cancel()
		return nil, fmt.Errorf("shell error: %s", shell.GetResponse().GetErr())
	}

	return &SliverSessionStream{
		tunnelID:  tunnelID,
		sessionID: sessionID,
		rpc:       p.rpc,
		stream:    stream,
		cancel:    cancel,
	}, nil
}

// ── Telemetry (stub) ────────────────────────

func (p *SliverProvider) SubscribeTelemetry(ctx context.Context, filter *TelemetryFilter) (<-chan TelemetryEvent, error) {
	ch := make(chan TelemetryEvent)
	return ch, nil
}

// ════════════════════════════════════════════
//  CONTAINMENT ACTIONS (DCO/SOC M13)
// ════════════════════════════════════════════

type ContainmentAction struct {
	ID                   string  `json:"id"`
	ActionType           string  `json:"action_type"`
	Target               map[string]any `json:"target"`
	IncidentTicketID     string  `json:"incident_ticket_id"`
	PlaybookExecutionID  *string `json:"playbook_execution_id"`
	Status               string  `json:"status"`
	Result               map[string]any `json:"result"`
	ExecutedBy           string  `json:"executed_by"`
	CreatedAt            string  `json:"created_at"`
	UpdatedAt            string  `json:"updated_at"`
}

type ExecuteContainmentRequest struct {
	ActionType          string         `json:"action_type"`
	Target              map[string]any `json:"target"`
	IncidentTicketID    string         `json:"incident_ticket_id"`
	PlaybookExecutionID string         `json:"playbook_execution_id"`
}

var validContainmentActions = map[string]bool{
	"isolate_host":     true,
	"kill_process":     true,
	"block_ip":         true,
	"disable_account":  true,
	"quarantine_file":  true,
}

func (s *C2GatewayServer) handleExecuteContainment(w http.ResponseWriter, r *http.Request) {
	// RBAC: Only authorized roles may execute containment actions
	roles := r.Header.Get("X-User-Roles")
	if !hasRole(roles, "operator", "analyst", "admin", "e3_tactical", "mission_commander") {
		writeError(w, http.StatusForbidden, "INSUFFICIENT_ROLE",
			"Containment actions require operator, analyst, or admin role")
		return
	}

	// Enclave check: C2 actions are low-side only
	if enclave == "high" {
		writeError(w, http.StatusForbidden, "ENCLAVE_RESTRICTION",
			"Containment actions can only be executed on the low-side enclave")
		return
	}

	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for containment actions")
		return
	}

	var req ExecuteContainmentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}

	if !validContainmentActions[req.ActionType] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			"action_type must be one of: isolate_host, kill_process, block_ip, disable_account, quarantine_file")
		return
	}

	if req.Target == nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "target is required")
		return
	}

	if req.IncidentTicketID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "incident_ticket_id is required")
		return
	}

	// Validate target has appropriate fields for action type
	if err := validateContainmentTarget(req.ActionType, req.Target); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
		return
	}

	userID := r.Header.Get("X-User-ID")

	ctx := r.Context()
	targetBytes, _ := json.Marshal(req.Target)

	var playbookExecID *string
	if req.PlaybookExecutionID != "" {
		playbookExecID = &req.PlaybookExecutionID
	}

	// Insert with status 'executing'
	var actionID string
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(ctx,
		`INSERT INTO containment_actions (action_type, target, incident_ticket_id, playbook_execution_id, status, executed_by)
		 VALUES ($1, $2, $3, $4, 'executing', $5)
		 RETURNING id, created_at, updated_at`,
		req.ActionType, targetBytes, req.IncidentTicketID, playbookExecID, userID).
		Scan(&actionID, &createdAt, &updatedAt)
	if err != nil {
		s.logger.Error("failed to insert containment action", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create containment action")
		return
	}

	// Execute the containment action (mock implementation)
	result, execErr := s.executeContainmentAction(req.ActionType, req.Target)

	var finalStatus string
	if execErr != nil {
		finalStatus = "failed"
		result["error"] = execErr.Error()
	} else {
		finalStatus = "completed"
	}

	resultBytes, _ := json.Marshal(result)

	// Update status and result
	_, _ = s.db.Exec(ctx,
		`UPDATE containment_actions SET status = $1, result = $2, updated_at = NOW() WHERE id = $3`,
		finalStatus, resultBytes, actionID)

	// Publish event
	s.publishCrossDomainEvent("dco.containment_executed", map[string]any{
		"action_id":           actionID,
		"action_type":         req.ActionType,
		"target":              req.Target,
		"incident_ticket_id":  req.IncidentTicketID,
		"status":              finalStatus,
		"executed_by":         userID,
	})

	action := ContainmentAction{
		ID:                  actionID,
		ActionType:          req.ActionType,
		Target:              req.Target,
		IncidentTicketID:    req.IncidentTicketID,
		PlaybookExecutionID: playbookExecID,
		Status:              finalStatus,
		Result:              result,
		ExecutedBy:          userID,
		CreatedAt:           createdAt.UTC().Format(time.RFC3339),
		UpdatedAt:           time.Now().UTC().Format(time.RFC3339),
	}

	status := http.StatusOK
	if finalStatus == "failed" {
		status = http.StatusInternalServerError
	}

	w.Header().Set("X-Classification", "UNCLASS")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(action)
}

func validateContainmentTarget(actionType string, target map[string]any) error {
	hostname, _ := target["hostname"].(string)

	switch actionType {
	case "isolate_host":
		if hostname == "" {
			return fmt.Errorf("target.hostname is required for isolate_host")
		}
	case "kill_process":
		process, _ := target["process"].(string)
		if hostname == "" || process == "" {
			return fmt.Errorf("target.hostname and target.process are required for kill_process")
		}
	case "block_ip":
		ip, _ := target["ip"].(string)
		if ip == "" {
			return fmt.Errorf("target.ip is required for block_ip")
		}
	case "disable_account":
		username, _ := target["username"].(string)
		if username == "" {
			return fmt.Errorf("target.username is required for disable_account")
		}
	case "quarantine_file":
		if hostname == "" {
			return fmt.Errorf("target.hostname is required for quarantine_file")
		}
	}
	return nil
}

func (s *C2GatewayServer) executeContainmentAction(actionType string, target map[string]any) (map[string]any, error) {
	hostname, _ := target["hostname"].(string)
	sessionID, _ := target["session_id"].(string)
	process, _ := target["process"].(string)
	ip, _ := target["ip"].(string)
	username, _ := target["username"].(string)

	result := map[string]any{"action_type": actionType}

	switch actionType {
	case "isolate_host":
		s.logger.Info("Executing host isolation", "hostname", hostname, "session_id", sessionID)
		result["message"] = fmt.Sprintf("Host isolation executed on %s via session %s", hostname, sessionID)
	case "kill_process":
		s.logger.Info("Killing process", "process", process, "hostname", hostname)
		result["message"] = fmt.Sprintf("Process %s killed on %s", process, hostname)
	case "block_ip":
		s.logger.Info("Blocking IP", "ip", ip, "hostname", hostname)
		result["message"] = fmt.Sprintf("IP %s blocked on %s", ip, hostname)
	case "disable_account":
		s.logger.Info("Disabling account", "username", username, "hostname", hostname)
		result["message"] = fmt.Sprintf("Account %s disabled on %s", username, hostname)
	case "quarantine_file":
		s.logger.Info("Quarantining file", "hostname", hostname)
		result["message"] = fmt.Sprintf("File quarantined on %s", hostname)
	}

	return result, nil
}

func (s *C2GatewayServer) handleListContainmentActions(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for containment actions")
		return
	}

	ctx := r.Context()
	incidentFilter := r.URL.Query().Get("incident_ticket_id")
	actionTypeFilter := r.URL.Query().Get("action_type")
	statusFilter := r.URL.Query().Get("status")

	page := 1
	limit := 20
	if p := r.URL.Query().Get("page"); p != "" {
		if v, err := strconv.Atoi(p); err == nil && v > 0 {
			page = v
		}
	}
	if l := r.URL.Query().Get("page_size"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 && v <= 100 {
			limit = v
		}
	}
	offset := (page - 1) * limit

	conditions := []string{}
	args := []any{}
	argIdx := 1

	if incidentFilter != "" {
		conditions = append(conditions, fmt.Sprintf("incident_ticket_id = $%d", argIdx))
		args = append(args, incidentFilter)
		argIdx++
	}
	if actionTypeFilter != "" {
		conditions = append(conditions, fmt.Sprintf("action_type = $%d", argIdx))
		args = append(args, actionTypeFilter)
		argIdx++
	}
	if statusFilter != "" {
		conditions = append(conditions, fmt.Sprintf("status = $%d", argIdx))
		args = append(args, statusFilter)
		argIdx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	var total int
	_ = s.db.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM containment_actions %s", where), args...).Scan(&total)

	args = append(args, limit, offset)
	q := fmt.Sprintf(
		`SELECT id, action_type, target, incident_ticket_id, playbook_execution_id, status, result, executed_by, created_at, updated_at
		 FROM containment_actions %s
		 ORDER BY created_at DESC
		 LIMIT $%d OFFSET $%d`, where, argIdx, argIdx+1)

	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		s.logger.Error("failed to list containment actions", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to list containment actions")
		return
	}
	defer rows.Close()

	var actions []ContainmentAction
	for rows.Next() {
		a, err := scanContainmentAction(rows)
		if err != nil {
			s.logger.Error("failed to scan containment action", "error", err)
			continue
		}
		actions = append(actions, a)
	}
	if actions == nil {
		actions = []ContainmentAction{}
	}

	w.Header().Set("X-Classification", "UNCLASS")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"data":       actions,
		"pagination": map[string]int{"page": page, "limit": limit, "total": total},
	})
}

func scanContainmentAction(scanner interface{ Scan(dest ...any) error }) (ContainmentAction, error) {
	var a ContainmentAction
	var targetBytes, resultBytes []byte
	var createdAt, updatedAt time.Time

	err := scanner.Scan(&a.ID, &a.ActionType, &targetBytes, &a.IncidentTicketID,
		&a.PlaybookExecutionID, &a.Status, &resultBytes, &a.ExecutedBy, &createdAt, &updatedAt)
	if err != nil {
		return a, err
	}

	a.Target = map[string]any{}
	if len(targetBytes) > 0 {
		_ = json.Unmarshal(targetBytes, &a.Target)
	}
	a.Result = map[string]any{}
	if len(resultBytes) > 0 {
		_ = json.Unmarshal(resultBytes, &a.Result)
	}
	a.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	a.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return a, nil
}

func (s *C2GatewayServer) handleGetContainmentAction(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for containment actions")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	row := s.db.QueryRow(r.Context(),
		`SELECT id, action_type, target, incident_ticket_id, playbook_execution_id, status, result, executed_by, created_at, updated_at
		 FROM containment_actions WHERE id = $1`, id)

	a, err := scanContainmentAction(row)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Containment action not found")
		return
	}

	w.Header().Set("X-Classification", "UNCLASS")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(a)
}

func (s *C2GatewayServer) handleRollbackContainmentAction(w http.ResponseWriter, r *http.Request) {
	// RBAC: Only authorized roles may rollback containment actions
	roles := r.Header.Get("X-User-Roles")
	if !hasRole(roles, "operator", "analyst", "admin", "e3_tactical", "mission_commander") {
		writeError(w, http.StatusForbidden, "INSUFFICIENT_ROLE",
			"Containment actions require operator, analyst, or admin role")
		return
	}

	if s.db == nil {
		writeError(w, http.StatusServiceUnavailable, "DB_UNAVAILABLE",
			"Database not available for containment actions")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	ctx := r.Context()

	// Check current status
	var currentStatus string
	err := s.db.QueryRow(ctx,
		`SELECT status FROM containment_actions WHERE id = $1`, id).Scan(&currentStatus)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Containment action not found")
		return
	}

	if currentStatus != "completed" {
		writeError(w, http.StatusConflict, "INVALID_STATE",
			fmt.Sprintf("Only completed actions can be rolled back (current status: %s)", currentStatus))
		return
	}

	// Update to rolled_back
	_, err = s.db.Exec(ctx,
		`UPDATE containment_actions SET status = 'rolled_back', updated_at = NOW() WHERE id = $1`, id)
	if err != nil {
		s.logger.Error("failed to rollback containment action", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to rollback action")
		return
	}

	userID := r.Header.Get("X-User-ID")

	// Publish event
	s.publishCrossDomainEvent("dco.containment_rolled_back", map[string]any{
		"action_id":   id,
		"rolled_back_by": userID,
	})

	w.Header().Set("X-Classification", "UNCLASS")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"id":     id,
		"status": "rolled_back",
	})
}

// ════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════

func maxBodyMiddleware(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := os.Getenv("SERVICE_PORT")
	if port == "" {
		port = "3005"
	}

	// NATS connection
	natsURL := os.Getenv("NATS_URL")
	if natsURL == "" {
		natsURL = "nats://localhost:4222"
	}
	nc, err := nats.Connect(natsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		logger.Error("failed to connect to nats", "error", err)
		os.Exit(1)
	}
	defer nc.Close()
	logger.Info("connected to nats", "url", natsURL)

	// Initialize Sliver provider
	provider := NewSliverProvider(logger)

	sliverHost := os.Getenv("SLIVER_GRPC_HOST")
	if sliverHost == "" {
		sliverHost = "sliver-server"
	}
	sliverPort := 31337

	providerConfig := ProviderConfig{
		Host:           sliverHost,
		Port:           sliverPort,
		OperatorConfig: os.Getenv("SLIVER_OPERATOR_CONFIG"),
	}

	// Try connecting — if it fails, retry in background
	if err := provider.Connect(context.Background(), providerConfig); err != nil {
		logger.Warn("initial sliver connection failed, will retry", "error", err)
		go func() {
			for {
				time.Sleep(10 * time.Second)
				if provider.IsConnected() {
					return
				}
				if err := provider.Connect(context.Background(), providerConfig); err != nil {
					logger.Warn("sliver reconnect failed", "error", err)
				} else {
					logger.Info("sliver reconnected successfully")
					return
				}
			}
		}()
	}

	// PostgreSQL connection (for cross-domain command queue)
	pgURL := fmt.Sprintf("postgres://%s:%s@%s:%s/%s",
		getEnv("POSTGRES_USER", "ems_user"),
		getEnv("POSTGRES_PASSWORD", "ems_password"),
		getEnv("POSTGRES_HOST", "localhost"),
		getEnv("POSTGRES_PORT", "5432"),
		getEnv("POSTGRES_DB", "ems_cop"))

	pgConfig, pgErr := pgxpool.ParseConfig(pgURL)
	var db *pgxpool.Pool
	if pgErr != nil {
		logger.Warn("failed to parse pg config, cross-domain commands disabled", "error", pgErr)
	} else {
		pgConfig.MaxConns = int32(envOrInt("PG_MAX_CONNS", 5))
		pgConfig.MinConns = int32(envOrInt("PG_MIN_CONNS", 1))
		pgConfig.MaxConnLifetime = time.Duration(envOrInt("PG_CONN_MAX_LIFETIME_MINS", 30)) * time.Minute
		pgConfig.MaxConnIdleTime = 5 * time.Minute

		pool, poolErr := pgxpool.NewWithConfig(context.Background(), pgConfig)
		if poolErr != nil {
			logger.Warn("pg connect failed, cross-domain commands disabled", "error", poolErr)
		} else {
			if err := pool.Ping(context.Background()); err != nil {
				logger.Warn("pg ping failed, cross-domain commands disabled", "error", err)
				pool.Close()
			} else {
				db = pool
				logger.Info("connected to postgres for cross-domain commands")
			}
		}
	}
	if db != nil {
		defer db.Close()
	}

	// Start HTTP server
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		jwtSecret = "ems_jwt_secret_change_me_in_production"
	}
	server := NewC2GatewayServer(provider, port, nc, logger, jwtSecret)
	server.db = db

	// CTI health checker
	ctx, ctxCancel := context.WithCancel(context.Background())
	ctiRelayURL := os.Getenv("CTI_RELAY_URL")
	if ctiRelayURL != "" {
		server.cti = newCTIHealth(ctiRelayURL, logger)
		server.cti.Start(ctx)
	}

	// Initialise provider registry and register the default Sliver provider
	registry := NewProviderRegistry(logger)
	registry.Register("sliver", provider, RegistryProviderConfig{
		Name:    "sliver",
		Type:    "sliver",
		Host:    sliverHost,
		Port:    sliverPort,
		Mode:    "docker",
		Enabled: true,
	})
	server.registry = registry

	// Start cross-domain command relay (low side) or result listener (high side)
	server.startCommandRelay(ctx)
	server.startResultListener(ctx)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		ctxCancel() // stop CTI health checker
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if server.httpServer != nil {
			server.httpServer.Shutdown(shutdownCtx)
		}
		registry.DisconnectAll()
		nc.Close()
	}()

	logger.Info("c2-gateway starting", "port", port)
	if err := server.Start(); err != nil && err != http.ErrServerClosed {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}
