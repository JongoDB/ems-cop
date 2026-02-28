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

	"github.com/bishopfox/sliver/protobuf/clientpb"
	jwtv5 "github.com/golang-jwt/jwt/v5"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/rpcpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"github.com/gorilla/websocket"
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
	Command   string                 `json:"command"`
	Arguments map[string]interface{} `json:"args"`
}

type TaskResult struct {
	TaskID    string    `json:"task_id"`
	Command   string    `json:"command"`
	Output    string    `json:"output"`
	Error     string    `json:"error,omitempty"`
	StartedAt time.Time `json:"started_at"`
	EndedAt   time.Time `json:"ended_at"`
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
	EventType    string `json:"event_type"`
	ActorID      string `json:"actor_id"`
	ActorUsername string `json:"actor_username"`
	ActorIP      string `json:"actor_ip"`
	SessionID    string `json:"session_id"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Action       string `json:"action"`
	Details      string `json:"details"`
	Timestamp    string `json:"timestamp"`
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

func (s *C2GatewayServer) publishAudit(eventType string, r *http.Request, resourceID, action, details string) {
	if s.nc == nil {
		return
	}
	event := AuditEvent{
		EventType:    eventType,
		ActorID:      r.Header.Get("X-User-ID"),
		ActorUsername: r.Header.Get("X-User-Roles"),
		ActorIP:      r.RemoteAddr,
		ResourceType: "c2_session",
		ResourceID:   resourceID,
		Action:       action,
		Details:      details,
		Timestamp:    time.Now().UTC().Format(time.RFC3339Nano),
	}
	data, _ := json.Marshal(event)
	if err := s.nc.Publish(eventType, data); err != nil {
		s.logger.Error("failed to publish audit event", "event", eventType, "error", err)
	}
}

// ════════════════════════════════════════════
//  HTTP HANDLERS (REST API wrapping the C2 Provider)
// ════════════════════════════════════════════

type C2GatewayServer struct {
	provider   C2Provider
	port       string
	nc         *nats.Conn
	logger     *slog.Logger
	jwtSecret  []byte
	httpServer *http.Server
}

func NewC2GatewayServer(provider C2Provider, port string, nc *nats.Conn, logger *slog.Logger, jwtSecret string) *C2GatewayServer {
	return &C2GatewayServer{provider: provider, port: port, nc: nc, logger: logger, jwtSecret: []byte(jwtSecret)}
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

	// Health check
	mux.HandleFunc("GET /health/live", s.handleHealthLive)
	mux.HandleFunc("GET /health/ready", s.handleHealthReady)
	mux.HandleFunc("GET /health", s.handleHealthReady)
	mux.HandleFunc("GET /api/v1/c2/health", s.handleHealth)

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
	sessions, err := s.provider.ListSessions(r.Context(), nil)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleListSessions", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

func (s *C2GatewayServer) handleListImplants(w http.ResponseWriter, r *http.Request) {
	implants, err := s.provider.ListImplants(r.Context(), nil)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleListImplants", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(implants)
}

func (s *C2GatewayServer) handleListListeners(w http.ResponseWriter, r *http.Request) {
	listeners, err := s.provider.ListListeners(r.Context())
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleListListeners", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(listeners)
}

func (s *C2GatewayServer) handleCreateListener(w http.ResponseWriter, r *http.Request) {
	var spec ListenerSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	listener, err := s.provider.CreateListener(r.Context(), spec)
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
	var spec ImplantSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	binary, err := s.provider.GenerateImplant(r.Context(), spec)
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

func (s *C2GatewayServer) handleExecuteTask(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionID")

	var task C2Task
	if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Check risk level and approval status
	riskLevel := GetCommandRisk(task.Command, nil)

	// TODO: Check against ticket service for approval if riskLevel > auto-approve threshold
	s.logger.Info("executing task", "session", sessionID, "command", task.Command, "risk_level", riskLevel)

	result, err := s.provider.ExecuteTask(r.Context(), sessionID, task)
	if err != nil {
		s.logger.Error("handler failed", "handler", "handleExecuteTask", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
		return
	}

	// Publish audit event
	detailsJSON, _ := json.Marshal(task)
	s.publishAudit("c2.command_executed", r, sessionID, task.Command, string(detailsJSON))

	w.Header().Set("Content-Type", "application/json")
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

	// Open shell session on Sliver
	stream, err := s.provider.OpenSession(r.Context(), sessionID)
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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"status": overall, "service": "c2-gateway", "checks": checks})
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

	// Start HTTP server
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		jwtSecret = "ems_jwt_secret_change_me_in_production"
	}
	server := NewC2GatewayServer(provider, port, nc, logger, jwtSecret)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if server.httpServer != nil {
			server.httpServer.Shutdown(shutdownCtx)
		}
		provider.Disconnect()
		nc.Close()
	}()

	logger.Info("c2-gateway starting", "port", port)
	if err := server.Start(); err != nil && err != http.ErrServerClosed {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}
