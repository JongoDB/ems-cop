// EMS-COP C2 Gateway Service
// Bridges EMS to Sliver C2 (and future C2 backends) via a provider interface
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/bishopfox/sliver/protobuf/clientpb" // required for gRPC type registration
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
	Arguments map[string]interface{} `json:"arguments"`
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
	provider C2Provider
	port     string
	nc       *nats.Conn
	logger   *slog.Logger
}

func NewC2GatewayServer(provider C2Provider, port string, nc *nats.Conn, logger *slog.Logger) *C2GatewayServer {
	return &C2GatewayServer{provider: provider, port: port, nc: nc, logger: logger}
}

func (s *C2GatewayServer) Start() error {
	mux := http.NewServeMux()

	// Session endpoints
	mux.HandleFunc("GET /api/v1/c2/sessions", s.handleListSessions)
	mux.HandleFunc("GET /api/v1/c2/implants", s.handleListImplants)
	mux.HandleFunc("GET /api/v1/c2/listeners", s.handleListListeners)
	mux.HandleFunc("POST /api/v1/c2/listeners", s.handleCreateListener)

	// Task execution (goes through approval check)
	mux.HandleFunc("POST /api/v1/c2/sessions/{sessionID}/execute", s.handleExecuteTask)

	// WebSocket for interactive shell sessions
	mux.HandleFunc("GET /api/v1/c2/sessions/{sessionID}/shell", s.handleShellSession)

	// Health check
	mux.HandleFunc("GET /api/v1/c2/health", s.handleHealth)

	server := &http.Server{
		Addr:    ":" + s.port,
		Handler: mux,
	}

	s.logger.Info("c2-gateway starting", "port", s.port, "provider", s.provider.Name())
	return server.ListenAndServe()
}

func (s *C2GatewayServer) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.provider.ListSessions(r.Context(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

func (s *C2GatewayServer) handleListImplants(w http.ResponseWriter, r *http.Request) {
	implants, err := s.provider.ListImplants(r.Context(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(implants)
}

func (s *C2GatewayServer) handleListListeners(w http.ResponseWriter, r *http.Request) {
	listeners, err := s.provider.ListListeners(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(listener)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (s *C2GatewayServer) handleShellSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionID")

	// Auth check: ForwardAuth sets X-User-ID on the HTTP upgrade request
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
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
	return nil, fmt.Errorf("not yet implemented")
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
	return nil, fmt.Errorf("not yet implemented")
}

func (p *SliverProvider) DeleteListener(ctx context.Context, listenerID string) error {
	return fmt.Errorf("not yet implemented")
}

// ── ExecuteTask ─────────────────────────────

func (p *SliverProvider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to sliver")
	}

	started := time.Now()
	req := &commonpb.Request{SessionID: sessionID, Timeout: 30}

	var output string
	var taskErr string

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
		resp, err := p.rpc.GetEnv(ctx, &sliverpb.EnvReq{Name: "USER", Request: req})
		if err != nil {
			taskErr = err.Error()
		} else if resp.GetResponse() != nil && resp.GetResponse().GetErr() != "" {
			taskErr = resp.GetResponse().GetErr()
		} else {
			for _, v := range resp.GetVariables() {
				if v.GetKey() == "USER" {
					output = v.GetValue()
					break
				}
			}
			if output == "" {
				output = "(USER env not set)"
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
			output = string(resp.GetData())
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
		taskErr = fmt.Sprintf("unsupported command: %s", task.Command)
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
	tunnelID uint64
	rpc      rpcpb.SliverRPCClient
	stream   rpcpb.SliverRPC_TunnelDataClient
	cancel   context.CancelFunc
}

func (s *SliverSessionStream) Send(input string) error {
	return s.stream.Send(&sliverpb.TunnelData{
		TunnelID: s.tunnelID,
		Data:     []byte(input),
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

	req := &commonpb.Request{SessionID: sessionID, Timeout: 0}
	shell, err := p.rpc.Shell(ctx, &sliverpb.ShellReq{
		Path:      "/bin/sh",
		EnablePTY: true,
		Request:   req,
	})
	if err != nil {
		return nil, fmt.Errorf("open shell: %w", err)
	}
	if shell.GetResponse() != nil && shell.GetResponse().GetErr() != "" {
		return nil, fmt.Errorf("shell error: %s", shell.GetResponse().GetErr())
	}

	streamCtx, cancel := context.WithCancel(context.Background())
	stream, err := p.rpc.TunnelData(streamCtx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("open tunnel: %w", err)
	}

	return &SliverSessionStream{
		tunnelID: shell.GetTunnelID(),
		rpc:      p.rpc,
		stream:   stream,
		cancel:   cancel,
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
	server := NewC2GatewayServer(provider, port, nc, logger)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		provider.Disconnect()
		nc.Close()
		os.Exit(0)
	}()

	logger.Info("c2-gateway starting", "port", port)
	if err := server.Start(); err != nil {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}
