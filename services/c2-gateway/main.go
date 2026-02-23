// EMS-COP C2 Gateway Service
// Bridges EMS to Sliver C2 (and future C2 backends) via a provider interface
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
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
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Format    string `json:"format"` // "exe", "shared", "service", "shellcode"
	Transport string `json:"transport"` // "mtls", "http", "https", "dns", "wg"
	C2URL     string `json:"c2_url"`
	SkipSymbols bool `json:"skip_symbols"`
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
	Command   string            `json:"command"`
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
	ImplantID  string `json:"implant_id,omitempty"`
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
//  HTTP HANDLERS (REST API wrapping the C2 Provider)
// ════════════════════════════════════════════

type C2GatewayServer struct {
	provider C2Provider
	port     string
}

func NewC2GatewayServer(provider C2Provider, port string) *C2GatewayServer {
	return &C2GatewayServer{provider: provider, port: port}
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

	log.Printf("[C2 Gateway] Starting on :%s (provider: %s)", s.port, s.provider.Name())
	return server.ListenAndServe()
}

func (s *C2GatewayServer) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.provider.ListSessions(r.Context(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(sessions)
}

func (s *C2GatewayServer) handleListImplants(w http.ResponseWriter, r *http.Request) {
	implants, err := s.provider.ListImplants(r.Context(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(implants)
}

func (s *C2GatewayServer) handleListListeners(w http.ResponseWriter, r *http.Request) {
	listeners, err := s.provider.ListListeners(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
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
	// For now, log the risk level
	log.Printf("[C2 Gateway] Task: session=%s command=%s risk=%d", sessionID, task.Command, riskLevel)

	// TODO: Publish audit event to NATS
	// nats.Publish("audit.c2.execute", auditEvent)

	result, err := s.provider.ExecuteTask(r.Context(), sessionID, task)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(result)
}

func (s *C2GatewayServer) handleShellSession(w http.ResponseWriter, r *http.Request) {
	// TODO: Upgrade to WebSocket, proxy to C2 provider's session stream
	// This will use gorilla/websocket or nhooyr/websocket
	// The terminal widget (xterm.js) connects here
	http.Error(w, "WebSocket shell — not yet implemented", http.StatusNotImplemented)
}

func (s *C2GatewayServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "ok",
		"provider": s.provider.Name(),
		"time":     time.Now().UTC(),
	})
}

// ════════════════════════════════════════════
//  SLIVER PROVIDER (implements C2Provider)
// ════════════════════════════════════════════

// SliverProvider implements the C2Provider interface for Sliver C2
// Uses Sliver's gRPC API via the official protobuf definitions
type SliverProvider struct {
	config ProviderConfig
	// conn   *grpc.ClientConn       // TODO: Sliver gRPC connection
	// client sliverpb.SliverRPCClient // TODO: Sliver RPC client
}

func NewSliverProvider() *SliverProvider {
	return &SliverProvider{}
}

func (p *SliverProvider) Name() string { return "sliver" }

func (p *SliverProvider) Connect(ctx context.Context, config ProviderConfig) error {
	p.config = config
	log.Printf("[Sliver] Connecting to %s:%d", config.Host, config.Port)
	// TODO: Load operator config, establish mTLS gRPC connection
	// clientConfig, err := assets.ReadOperatorConfig(config.OperatorConfig)
	// p.conn, err = transport.MTLSConnect(clientConfig)
	// p.client = sliverpb.NewSliverRPCClient(p.conn)
	return nil
}

func (p *SliverProvider) Disconnect() error {
	// TODO: p.conn.Close()
	return nil
}

func (p *SliverProvider) ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error) {
	// TODO: p.client.GetImplants(ctx, &commonpb.Empty{})
	// Convert Sliver protobuf to EMS common types
	return []Implant{}, nil
}

func (p *SliverProvider) GenerateImplant(ctx context.Context, spec ImplantSpec) (*ImplantBinary, error) {
	// TODO: p.client.Generate(ctx, &clientpb.GenerateReq{...})
	return nil, fmt.Errorf("not yet implemented")
}

func (p *SliverProvider) ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error) {
	// TODO: p.client.GetSessions(ctx, &commonpb.Empty{})
	return []Session{}, nil
}

func (p *SliverProvider) OpenSession(ctx context.Context, sessionID string) (SessionStream, error) {
	// TODO: Open interactive session stream
	return nil, fmt.Errorf("not yet implemented")
}

func (p *SliverProvider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
	// TODO: Route to appropriate Sliver RPC based on task.Command
	// e.g., task.Command == "ls" → p.client.Ls(ctx, &sliverpb.LsReq{...})
	return &TaskResult{
		Command:   task.Command,
		Output:    "TODO: Execute via Sliver gRPC",
		StartedAt: time.Now(),
		EndedAt:   time.Now(),
	}, nil
}

func (p *SliverProvider) GetTaskHistory(ctx context.Context, sessionID string) ([]TaskResult, error) {
	return []TaskResult{}, nil
}

func (p *SliverProvider) ListListeners(ctx context.Context) ([]Listener, error) {
	// TODO: p.client.GetJobs(ctx, &commonpb.Empty{})
	return []Listener{}, nil
}

func (p *SliverProvider) CreateListener(ctx context.Context, spec ListenerSpec) (*Listener, error) {
	// TODO: p.client.StartHTTPListener / StartMTLSListener / etc.
	return nil, fmt.Errorf("not yet implemented")
}

func (p *SliverProvider) DeleteListener(ctx context.Context, listenerID string) error {
	return fmt.Errorf("not yet implemented")
}

func (p *SliverProvider) SubscribeTelemetry(ctx context.Context, filter *TelemetryFilter) (<-chan TelemetryEvent, error) {
	// TODO: p.client.Events(ctx, &commonpb.Empty{})
	ch := make(chan TelemetryEvent)
	return ch, nil
}

// ════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════

func main() {
	port := os.Getenv("SERVICE_PORT")
	if port == "" {
		port = "3005"
	}

	// Initialize Sliver provider
	provider := NewSliverProvider()

	sliverHost := os.Getenv("SLIVER_GRPC_HOST")
	if sliverHost == "" {
		sliverHost = "sliver-server"
	}
	sliverPort := 31337

	err := provider.Connect(context.Background(), ProviderConfig{
		Host:           sliverHost,
		Port:           sliverPort,
		OperatorConfig: os.Getenv("SLIVER_OPERATOR_CONFIG"),
	})
	if err != nil {
		log.Printf("[C2 Gateway] Warning: Could not connect to Sliver: %v (will retry)", err)
	}

	// Start HTTP server
	server := NewC2GatewayServer(provider, port)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("[C2 Gateway] Shutting down...")
		provider.Disconnect()
		os.Exit(0)
	}()

	if err := server.Start(); err != nil {
		log.Fatalf("[C2 Gateway] Failed to start: %v", err)
	}
}
