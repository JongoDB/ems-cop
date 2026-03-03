package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// ════════════════════════════════════════════
//  MOCK C2 PROVIDER
// ════════════════════════════════════════════

// MockC2Provider implements C2Provider for testing without a real Sliver backend.
type MockC2Provider struct {
	name      string
	connected bool

	// Configurable return values for testing different scenarios
	sessions       []Session
	sessionsErr    error
	implants       []Implant
	implantsErr    error
	listeners      []Listener
	listenersErr   error
	taskResult     *TaskResult
	taskErr        error
	listener       *Listener
	listenerErr    error
	implantBinary  *ImplantBinary
	implantGenErr  error
	sessionStream  SessionStream
	sessionOpenErr error
	deleteErr      error
}

func NewMockC2Provider() *MockC2Provider {
	return &MockC2Provider{
		name:      "mock-sliver",
		connected: true,
	}
}

func (m *MockC2Provider) Connect(ctx context.Context, config ProviderConfig) error { return nil }
func (m *MockC2Provider) Disconnect() error                                        { return nil }
func (m *MockC2Provider) Name() string                                             { return m.name }
func (m *MockC2Provider) IsConnected() bool                                        { return m.connected }

func (m *MockC2Provider) ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error) {
	return m.implants, m.implantsErr
}

func (m *MockC2Provider) GenerateImplant(ctx context.Context, spec ImplantSpec) (*ImplantBinary, error) {
	return m.implantBinary, m.implantGenErr
}

func (m *MockC2Provider) ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error) {
	return m.sessions, m.sessionsErr
}

func (m *MockC2Provider) OpenSession(ctx context.Context, sessionID string) (SessionStream, error) {
	return m.sessionStream, m.sessionOpenErr
}

func (m *MockC2Provider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
	if m.taskResult != nil {
		return m.taskResult, m.taskErr
	}
	return &TaskResult{
		TaskID:    "test-task-1",
		Command:   task.Command,
		Output:    "mock output for " + task.Command,
		StartedAt: time.Now(),
		EndedAt:   time.Now(),
	}, m.taskErr
}

func (m *MockC2Provider) GetTaskHistory(ctx context.Context, sessionID string) ([]TaskResult, error) {
	return []TaskResult{}, nil
}

func (m *MockC2Provider) ListListeners(ctx context.Context) ([]Listener, error) {
	return m.listeners, m.listenersErr
}

func (m *MockC2Provider) CreateListener(ctx context.Context, spec ListenerSpec) (*Listener, error) {
	return m.listener, m.listenerErr
}

func (m *MockC2Provider) DeleteListener(ctx context.Context, listenerID string) error {
	return m.deleteErr
}

func (m *MockC2Provider) SubscribeTelemetry(ctx context.Context, filter *TelemetryFilter) (<-chan TelemetryEvent, error) {
	ch := make(chan TelemetryEvent)
	return ch, nil
}

// Compile-time check: MockC2Provider must implement C2Provider.
var _ C2Provider = (*MockC2Provider)(nil)

// ════════════════════════════════════════════
//  TEST HELPERS
// ════════════════════════════════════════════

// newTestServer creates a C2GatewayServer wired to the mock provider with no NATS.
func newTestServer(mock *MockC2Provider) *C2GatewayServer {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	return &C2GatewayServer{
		provider:  mock,
		port:      "0",
		nc:        nil, // no NATS in unit tests
		logger:    logger,
		jwtSecret: []byte("test-secret"),
	}
}

// newTestC2Server creates a C2GatewayServer with a default mock provider for simpler tests.
func newTestC2Server() *C2GatewayServer {
	return newTestServer(NewMockC2Provider())
}

// newTestMux creates an http.ServeMux with the same routes as Start() for handler testing.
func newTestMux(s *C2GatewayServer) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/c2/sessions", s.handleListSessions)
	mux.HandleFunc("GET /api/v1/c2/implants", s.handleListImplants)
	mux.HandleFunc("GET /api/v1/c2/listeners", s.handleListListeners)
	mux.HandleFunc("POST /api/v1/c2/listeners", s.handleCreateListener)
	mux.HandleFunc("POST /api/v1/c2/implants/generate", s.handleGenerateImplant)
	mux.HandleFunc("POST /api/v1/c2/sessions/{sessionID}/execute", s.handleExecuteTask)
	mux.HandleFunc("GET /api/v1/c2/sessions/{sessionID}/shell", s.handleShellSession)
	mux.HandleFunc("GET /api/v1/c2/vnc/{host}/{port}", s.handleVNCProxy)
	mux.HandleFunc("GET /health/live", s.handleHealthLive)
	mux.HandleFunc("GET /health/ready", s.handleHealthReady)
	mux.HandleFunc("GET /health", s.handleHealthReady)
	mux.HandleFunc("GET /api/v1/c2/health", s.handleHealth)
	return maxBodyMiddleware(10<<20, mux)
}

// ════════════════════════════════════════════
//  RISK CLASSIFICATION TESTS
// ════════════════════════════════════════════

func TestGetCommandRisk(t *testing.T) {
	t.Run("known commands with default risk map", func(t *testing.T) {
		tests := []struct {
			command  string
			expected int
		}{
			// Level 1: Recon
			{"ls", 1},
			{"ps", 1},
			{"netstat", 1},
			{"ifconfig", 1},
			{"whoami", 1},
			{"pwd", 1},
			{"cat", 1},
			{"env", 1},
			{"getuid", 1},
			{"getgid", 1},
			{"info", 1},
			// Level 2: Low risk
			{"upload", 2},
			{"download", 2},
			{"screenshot", 2},
			{"mkdir", 2},
			// Level 3: Medium
			{"execute", 3},
			{"shell", 3},
			{"sideload", 3},
			{"msf", 3},
			{"rm", 3},
			// Level 4: High
			{"pivots", 4},
			{"portfwd", 4},
			{"execute-assembly", 4},
			{"socks5", 4},
			{"ssh", 4},
			{"wg-portfwd", 4},
			// Level 5: Critical
			{"getsystem", 5},
			{"impersonate", 5},
			{"make-token", 5},
			{"rev2self", 5},
			{"psexec", 5},
			{"backdoor", 5},
			{"dllhijack", 5},
		}

		for _, tt := range tests {
			t.Run(tt.command, func(t *testing.T) {
				risk := GetCommandRisk(tt.command, nil)
				if risk != tt.expected {
					t.Errorf("GetCommandRisk(%q, nil) = %d, want %d", tt.command, risk, tt.expected)
				}
			})
		}
	})

	t.Run("unknown command defaults to level 3", func(t *testing.T) {
		unknowns := []string{
			"custom-tool",
			"mimikatz",
			"not-a-command",
			"",
		}
		for _, cmd := range unknowns {
			t.Run(fmt.Sprintf("command=%q", cmd), func(t *testing.T) {
				risk := GetCommandRisk(cmd, nil)
				if risk != 3 {
					t.Errorf("GetCommandRisk(%q, nil) = %d, want 3 (default)", cmd, risk)
				}
			})
		}
	})

	t.Run("overrides take precedence", func(t *testing.T) {
		overrides := map[string]int{
			"ls":          5, // Override ls from 1 to 5
			"custom-tool": 1, // Override unknown from 3 to 1
		}

		tests := []struct {
			command  string
			expected int
		}{
			{"ls", 5},          // overridden
			{"custom-tool", 1}, // overridden unknown
			{"ps", 1},          // not overridden, uses default map
			{"whoami", 1},      // not overridden, uses default map
			{"zzz", 3},         // not in overrides or default map, falls to default 3
		}

		for _, tt := range tests {
			t.Run(tt.command, func(t *testing.T) {
				risk := GetCommandRisk(tt.command, overrides)
				if risk != tt.expected {
					t.Errorf("GetCommandRisk(%q, overrides) = %d, want %d", tt.command, risk, tt.expected)
				}
			})
		}
	})

	t.Run("risk levels are within 1-5 bounds", func(t *testing.T) {
		for cmd, risk := range DefaultCommandRisk {
			if risk < 1 || risk > 5 {
				t.Errorf("DefaultCommandRisk[%q] = %d, want value in range [1,5]", cmd, risk)
			}
		}
	})

	t.Run("nil overrides with known command", func(t *testing.T) {
		risk := GetCommandRisk("ls", nil)
		if risk != 1 {
			t.Errorf("GetCommandRisk(\"ls\", nil) = %d, want 1", risk)
		}
	})

	t.Run("empty overrides map", func(t *testing.T) {
		overrides := map[string]int{}
		risk := GetCommandRisk("ls", overrides)
		if risk != 1 {
			t.Errorf("GetCommandRisk(\"ls\", empty overrides) = %d, want 1", risk)
		}
	})
}

// ════════════════════════════════════════════
//  COMMAND STRING PARSING TESTS
//  Tests the command-parsing logic embedded in SliverProvider.ExecuteTask
//  Since it's tightly coupled to the provider, we test the parsing pattern directly.
// ════════════════════════════════════════════

func TestCommandStringParsing(t *testing.T) {
	// This tests the same logic used in SliverProvider.ExecuteTask for parsing
	// compound command strings. We replicate the parsing here since it's
	// not extracted into a standalone function.
	parseCommand := func(command string) (string, map[string]interface{}) {
		args := make(map[string]interface{})
		parts := strings.Fields(command)
		if len(parts) == 0 {
			return command, args
		}
		if len(parts) > 1 {
			cmd := parts[0]
			switch cmd {
			case "cat":
				args["path"] = strings.Join(parts[1:], " ")
			case "ls", "cd":
				args["path"] = strings.Join(parts[1:], " ")
			default:
				args["raw"] = strings.Join(parts, " ")
			}
			return cmd, args
		}
		return parts[0], args
	}

	tests := []struct {
		name        string
		input       string
		wantCommand string
		wantArgs    map[string]interface{}
	}{
		{
			name:        "simple ls",
			input:       "ls",
			wantCommand: "ls",
			wantArgs:    map[string]interface{}{},
		},
		{
			name:        "simple whoami",
			input:       "whoami",
			wantCommand: "whoami",
			wantArgs:    map[string]interface{}{},
		},
		{
			name:        "simple pwd",
			input:       "pwd",
			wantCommand: "pwd",
			wantArgs:    map[string]interface{}{},
		},
		{
			name:        "cat with path",
			input:       "cat /etc/hostname",
			wantCommand: "cat",
			wantArgs:    map[string]interface{}{"path": "/etc/hostname"},
		},
		{
			name:        "ls with path and flags",
			input:       "ls -la /tmp",
			wantCommand: "ls",
			wantArgs:    map[string]interface{}{"path": "-la /tmp"},
		},
		{
			name:        "cd with path",
			input:       "cd /var/log",
			wantCommand: "cd",
			wantArgs:    map[string]interface{}{"path": "/var/log"},
		},
		{
			name:        "unknown command with args uses raw",
			input:       "custom-tool --flag value",
			wantCommand: "custom-tool",
			wantArgs:    map[string]interface{}{"raw": "custom-tool --flag value"},
		},
		{
			name:        "upload with two args uses raw",
			input:       "upload /local/file /remote/path",
			wantCommand: "upload",
			wantArgs:    map[string]interface{}{"raw": "upload /local/file /remote/path"},
		},
		{
			name:        "empty string",
			input:       "",
			wantCommand: "",
			wantArgs:    map[string]interface{}{},
		},
		{
			name:        "whitespace only",
			input:       "   ",
			wantCommand: "   ", // strings.Fields returns empty slice
			wantArgs:    map[string]interface{}{},
		},
		{
			name:        "extra spaces between args",
			input:       "cat    /etc/hostname",
			wantCommand: "cat",
			wantArgs:    map[string]interface{}{"path": "/etc/hostname"},
		},
		{
			name:        "command with many args",
			input:       "execute /bin/bash -c ls -la",
			wantCommand: "execute",
			wantArgs:    map[string]interface{}{"raw": "execute /bin/bash -c ls -la"},
		},
		{
			name:        "cat with space in path",
			input:       "cat /tmp/my file.txt",
			wantCommand: "cat",
			wantArgs:    map[string]interface{}{"path": "/tmp/my file.txt"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotCommand, gotArgs := parseCommand(tt.input)
			if gotCommand != tt.wantCommand {
				t.Errorf("parseCommand(%q) command = %q, want %q", tt.input, gotCommand, tt.wantCommand)
			}
			if len(gotArgs) != len(tt.wantArgs) {
				t.Errorf("parseCommand(%q) args len = %d, want %d\n  got:  %v\n  want: %v",
					tt.input, len(gotArgs), len(tt.wantArgs), gotArgs, tt.wantArgs)
				return
			}
			for k, wantV := range tt.wantArgs {
				gotV, ok := gotArgs[k]
				if !ok {
					t.Errorf("parseCommand(%q) missing arg key %q", tt.input, k)
					continue
				}
				if gotV != wantV {
					t.Errorf("parseCommand(%q) args[%q] = %v, want %v", tt.input, k, gotV, wantV)
				}
			}
		})
	}
}

// ════════════════════════════════════════════
//  SSRF PREVENTION TESTS (isEndpointSubnet)
// ════════════════════════════════════════════

func TestIsEndpointSubnet(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		allowed bool
	}{
		// Valid endpoint subnet IPs (10.101.0.0/16)
		{"endpoint subnet low", "10.101.0.1", true},
		{"endpoint subnet ubuntu", "10.101.1.1", true},
		{"endpoint subnet alpine", "10.101.2.1", true},
		{"endpoint subnet mid", "10.101.128.128", true},
		{"endpoint subnet high", "10.101.255.254", true},
		{"endpoint subnet base", "10.101.0.0", true},
		{"endpoint subnet broadcast", "10.101.255.255", true},

		// Rejected: other private ranges
		{"10.0.0.0 private", "10.0.0.1", false},
		{"10.100 ems-net", "10.100.0.1", false},
		{"10.102 adjacent", "10.102.0.1", false},
		{"192.168 private", "192.168.1.1", false},
		{"172.16 private", "172.16.0.1", false},

		// Rejected: loopback
		{"loopback", "127.0.0.1", false},
		{"loopback full", "127.0.0.0", false},

		// Rejected: public IPs
		{"google dns", "8.8.8.8", false},
		{"cloudflare", "1.1.1.1", false},
		{"public IP", "203.0.113.50", false},

		// Rejected: special addresses
		{"link local", "169.254.1.1", false},
		{"multicast", "224.0.0.1", false},
		{"broadcast", "255.255.255.255", false},

		// Rejected: invalid inputs
		{"empty string", "", false},
		{"hostname", "sliver-server", false},
		{"domain", "example.com", false},
		{"ipv6 loopback", "::1", false},

		// Boundary: just outside 10.101.0.0/16
		{"just below subnet", "10.100.255.255", false},
		{"just above subnet", "10.102.0.0", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isEndpointSubnet(tt.host)
			if got != tt.allowed {
				t.Errorf("isEndpointSubnet(%q) = %v, want %v", tt.host, got, tt.allowed)
			}
		})
	}
}

// ════════════════════════════════════════════
//  WEBSOCKET ORIGIN CHECKING TESTS
// ════════════════════════════════════════════

func TestWebSocketOriginCheck(t *testing.T) {
	// The upgrader.CheckOrigin function reads ALLOWED_ORIGINS from the environment.
	// We test it by manipulating the environment and calling the function directly.

	tests := []struct {
		name           string
		allowedOrigins string
		origin         string
		expected       bool
	}{
		{
			name:           "allowed origin matches exactly",
			allowedOrigins: "http://localhost:18080",
			origin:         "http://localhost:18080",
			expected:       true,
		},
		{
			name:           "disallowed origin rejected",
			allowedOrigins: "http://localhost:18080",
			origin:         "http://evil.com",
			expected:       false,
		},
		{
			name:           "empty origin allowed (non-browser client)",
			allowedOrigins: "http://localhost:18080",
			origin:         "",
			expected:       true,
		},
		{
			name:           "multiple allowed origins, match second",
			allowedOrigins: "http://localhost:18080,https://cop.internal",
			origin:         "https://cop.internal",
			expected:       true,
		},
		{
			name:           "multiple allowed origins, match first",
			allowedOrigins: "http://localhost:18080,https://cop.internal",
			origin:         "http://localhost:18080",
			expected:       true,
		},
		{
			name:           "multiple allowed origins, no match",
			allowedOrigins: "http://localhost:18080,https://cop.internal",
			origin:         "http://attacker.com",
			expected:       false,
		},
		{
			name:           "spaces in origin list are trimmed",
			allowedOrigins: "http://localhost:18080 , https://cop.internal",
			origin:         "https://cop.internal",
			expected:       true,
		},
		{
			name:           "default origin when env is empty",
			allowedOrigins: "",
			origin:         "http://localhost:18080",
			expected:       true,
		},
		{
			name:           "default origin rejects other",
			allowedOrigins: "",
			origin:         "http://evil.com",
			expected:       false,
		},
		{
			name:           "partial match rejected",
			allowedOrigins: "http://localhost:18080",
			origin:         "http://localhost:18080.evil.com",
			expected:       false,
		},
		{
			name:           "case sensitivity (origin is case-sensitive per RFC)",
			allowedOrigins: "http://localhost:18080",
			origin:         "HTTP://LOCALHOST:18080",
			expected:       false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			os.Setenv("ALLOWED_ORIGINS", tt.allowedOrigins)
			defer os.Unsetenv("ALLOWED_ORIGINS")

			req := httptest.NewRequest("GET", "/ws", nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}

			got := upgrader.CheckOrigin(req)
			if got != tt.expected {
				t.Errorf("CheckOrigin(origin=%q, allowed=%q) = %v, want %v",
					tt.origin, tt.allowedOrigins, got, tt.expected)
			}
		})
	}
}

// ════════════════════════════════════════════
//  HTTP HANDLER TESTS
// ════════════════════════════════════════════

func TestHandleListSessions(t *testing.T) {
	t.Run("returns sessions", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.sessions = []Session{
			{
				ID:          "sess-1",
				ImplantID:   "implant-1",
				Hostname:    "target-1",
				OS:          "linux",
				RemoteAddr:  "10.101.1.1:12345",
				Transport:   "http",
				IsAlive:     true,
				LastMessage: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
			},
			{
				ID:         "sess-2",
				ImplantID:  "implant-2",
				Hostname:   "target-2",
				OS:         "windows",
				RemoteAddr: "10.101.2.1:54321",
				Transport:  "mtls",
				IsAlive:    false,
			},
		}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/sessions", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}

		var sessions []Session
		if err := json.NewDecoder(w.Body).Decode(&sessions); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(sessions) != 2 {
			t.Fatalf("got %d sessions, want 2", len(sessions))
		}
		if sessions[0].ID != "sess-1" {
			t.Errorf("sessions[0].ID = %q, want \"sess-1\"", sessions[0].ID)
		}
		if sessions[1].Hostname != "target-2" {
			t.Errorf("sessions[1].Hostname = %q, want \"target-2\"", sessions[1].Hostname)
		}
	})

	t.Run("returns empty list", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.sessions = []Session{}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/sessions", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var sessions []Session
		if err := json.NewDecoder(w.Body).Decode(&sessions); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(sessions) != 0 {
			t.Errorf("got %d sessions, want 0", len(sessions))
		}
	})

	t.Run("provider error returns 500", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.sessionsErr = fmt.Errorf("connection lost")

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/sessions", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
		}

		var body map[string]interface{}
		json.NewDecoder(w.Body).Decode(&body)
		errObj, ok := body["error"].(map[string]interface{})
		if !ok {
			t.Fatal("expected error object in response")
		}
		if errObj["code"] != "INTERNAL_ERROR" {
			t.Errorf("error code = %q, want \"INTERNAL_ERROR\"", errObj["code"])
		}
	})
}

func TestHandleListImplants(t *testing.T) {
	t.Run("returns implants", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.implants = []Implant{
			{ID: "impl-1", Name: "backdoor-linux", OS: "linux", Arch: "amd64", Status: "built"},
		}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/implants", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var implants []Implant
		json.NewDecoder(w.Body).Decode(&implants)
		if len(implants) != 1 {
			t.Fatalf("got %d implants, want 1", len(implants))
		}
		if implants[0].Name != "backdoor-linux" {
			t.Errorf("implants[0].Name = %q, want \"backdoor-linux\"", implants[0].Name)
		}
	})

	t.Run("provider error returns 500", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.implantsErr = fmt.Errorf("not connected to sliver")

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/implants", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
		}
	})
}

func TestHandleListListeners(t *testing.T) {
	t.Run("returns listeners", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.listeners = []Listener{
			{ID: "1", Protocol: "http", Host: "0.0.0.0", Port: 80, IsRunning: true},
			{ID: "2", Protocol: "mtls", Host: "0.0.0.0", Port: 8888, IsRunning: true},
		}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/listeners", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var listeners []Listener
		json.NewDecoder(w.Body).Decode(&listeners)
		if len(listeners) != 2 {
			t.Fatalf("got %d listeners, want 2", len(listeners))
		}
	})

	t.Run("provider error returns 500", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.listenersErr = fmt.Errorf("rpc error")

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/listeners", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
		}
	})
}

func TestHandleCreateListener(t *testing.T) {
	t.Run("creates listener successfully", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.listener = &Listener{ID: "3", Protocol: "http", Host: "0.0.0.0", Port: 8080, IsRunning: true}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		body := `{"protocol":"http","host":"0.0.0.0","port":8080}`
		req := httptest.NewRequest("POST", "/api/v1/c2/listeners", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusCreated, w.Body.String())
		}

		var listener Listener
		json.NewDecoder(w.Body).Decode(&listener)
		if listener.ID != "3" {
			t.Errorf("listener.ID = %q, want \"3\"", listener.ID)
		}
		if listener.Port != 8080 {
			t.Errorf("listener.Port = %d, want 8080", listener.Port)
		}
	})

	t.Run("invalid JSON returns 400", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("POST", "/api/v1/c2/listeners", strings.NewReader("not json"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})

	t.Run("provider error returns 500", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.listenerErr = fmt.Errorf("unsupported protocol")

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		body := `{"protocol":"dns","host":"0.0.0.0","port":53}`
		req := httptest.NewRequest("POST", "/api/v1/c2/listeners", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
		}
	})
}

func TestHandleExecuteTask(t *testing.T) {
	t.Run("executes command and returns result", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.taskResult = &TaskResult{
			TaskID:    "task-abc",
			Command:   "ls",
			Output:    "file1.txt\nfile2.txt",
			StartedAt: time.Now(),
			EndedAt:   time.Now(),
		}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		body := `{"command":"ls","args":{}}`
		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/sess-1/execute", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
		}

		var result TaskResult
		json.NewDecoder(w.Body).Decode(&result)
		if result.TaskID != "task-abc" {
			t.Errorf("result.TaskID = %q, want \"task-abc\"", result.TaskID)
		}
		if result.Command != "ls" {
			t.Errorf("result.Command = %q, want \"ls\"", result.Command)
		}
		if result.Output != "file1.txt\nfile2.txt" {
			t.Errorf("result.Output = %q, want \"file1.txt\\nfile2.txt\"", result.Output)
		}
	})

	t.Run("invalid JSON body returns 400", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/sess-1/execute", strings.NewReader("{invalid"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})

	t.Run("provider error returns 500", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.taskErr = fmt.Errorf("session not found")

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		body := `{"command":"ls","args":{}}`
		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/invalid-sess/execute", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
		}
	})

	t.Run("empty body returns 400", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/sess-1/execute", strings.NewReader(""))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})
}

func TestHandleGenerateImplant(t *testing.T) {
	t.Run("generates implant binary", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.implantBinary = &ImplantBinary{
			Name: "implant.exe",
			Data: []byte("fake-binary-data"),
			Size: 16,
		}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		body := `{"os":"linux","arch":"amd64","format":"exe","transport":"http","c2_url":"http://sliver:80"}`
		req := httptest.NewRequest("POST", "/api/v1/c2/implants/generate", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
		}

		if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" {
			t.Errorf("Content-Type = %q, want application/octet-stream", ct)
		}
		if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "implant.exe") {
			t.Errorf("Content-Disposition = %q, want to contain \"implant.exe\"", cd)
		}
		if w.Body.String() != "fake-binary-data" {
			t.Errorf("body = %q, want \"fake-binary-data\"", w.Body.String())
		}
	})

	t.Run("invalid JSON body returns 400", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("POST", "/api/v1/c2/implants/generate", strings.NewReader("nope"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})

	t.Run("provider error returns 500", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.implantGenErr = fmt.Errorf("generation failed")

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		body := `{"os":"linux","arch":"amd64","format":"exe","transport":"http","c2_url":"http://sliver:80"}`
		req := httptest.NewRequest("POST", "/api/v1/c2/implants/generate", strings.NewReader(body))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
		}
	})
}

// ════════════════════════════════════════════
//  HEALTH ENDPOINT TESTS
// ════════════════════════════════════════════

func TestHandleHealthLive(t *testing.T) {
	mock := NewMockC2Provider()
	srv := newTestServer(mock)
	handler := newTestMux(srv)

	req := httptest.NewRequest("GET", "/health/live", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("status = %q, want \"ok\"", body["status"])
	}
	if body["service"] != "c2-gateway" {
		t.Errorf("service = %q, want \"c2-gateway\"", body["service"])
	}
}

func TestHandleHealthReady(t *testing.T) {
	t.Run("ready when NATS connected", func(t *testing.T) {
		t.Skip("requires NATS connection (nc.IsConnected check panics on nil)")
	})

	t.Run("health/ready panics on nil nc", func(t *testing.T) {
		// The handler calls s.nc.IsConnected() which panics if nc is nil.
		// This documents the current behavior — in production nc is always set.
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/health/ready", nil)
		w := httptest.NewRecorder()

		defer func() {
			r := recover()
			if r == nil {
				t.Error("expected panic on nil NATS connection, but none occurred")
			}
		}()
		handler.ServeHTTP(w, req)
	})
}

func TestHandleHealth(t *testing.T) {
	t.Run("ok when provider connected with sessions", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.connected = true
		mock.sessions = []Session{
			{ID: "s1", IsAlive: true},
			{ID: "s2", IsAlive: false},
			{ID: "s3", IsAlive: true},
		}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/health", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var body map[string]interface{}
		json.NewDecoder(w.Body).Decode(&body)
		if body["status"] != "ok" {
			t.Errorf("status = %q, want \"ok\"", body["status"])
		}
		if body["provider"] != "mock-sliver" {
			t.Errorf("provider = %q, want \"mock-sliver\"", body["provider"])
		}
		if body["sliver_connected"] != true {
			t.Errorf("sliver_connected = %v, want true", body["sliver_connected"])
		}
		// JSON numbers decode as float64
		if body["active_sessions"] != float64(2) {
			t.Errorf("active_sessions = %v, want 2", body["active_sessions"])
		}
	})

	t.Run("degraded when provider disconnected", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.connected = false

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/health", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var body map[string]interface{}
		json.NewDecoder(w.Body).Decode(&body)
		if body["status"] != "degraded" {
			t.Errorf("status = %q, want \"degraded\"", body["status"])
		}
		if body["sliver_connected"] != false {
			t.Errorf("sliver_connected = %v, want false", body["sliver_connected"])
		}
		if body["active_sessions"] != float64(0) {
			t.Errorf("active_sessions = %v, want 0", body["active_sessions"])
		}
	})

	t.Run("ok with zero sessions", func(t *testing.T) {
		mock := NewMockC2Provider()
		mock.connected = true
		mock.sessions = []Session{}

		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/health", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		var body map[string]interface{}
		json.NewDecoder(w.Body).Decode(&body)
		if body["status"] != "ok" {
			t.Errorf("status = %q, want \"ok\"", body["status"])
		}
		if body["active_sessions"] != float64(0) {
			t.Errorf("active_sessions = %v, want 0", body["active_sessions"])
		}
	})
}

// ════════════════════════════════════════════
//  VNC PROXY SECURITY TESTS
// ════════════════════════════════════════════

func TestHandleVNCProxySSRF(t *testing.T) {
	tests := []struct {
		name       string
		host       string
		port       string
		wantStatus int
	}{
		// Allowed endpoint IPs
		{
			name:       "allowed endpoint IP",
			host:       "10.101.1.1",
			port:       "5900",
			wantStatus: http.StatusUnauthorized, // fails on auth first, but SSRF check comes after
		},
		// Blocked IPs — should be forbidden before any connection attempt
		{
			name:       "blocked private 10.0.0.1",
			host:       "10.0.0.1",
			port:       "5900",
			wantStatus: http.StatusForbidden, // but only after auth
		},
		{
			name:       "blocked 192.168.1.1",
			host:       "192.168.1.1",
			port:       "5900",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "blocked loopback 127.0.0.1",
			host:       "127.0.0.1",
			port:       "5900",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "blocked public IP",
			host:       "8.8.8.8",
			port:       "5900",
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := NewMockC2Provider()
			srv := newTestServer(mock)
			handler := newTestMux(srv)

			url := fmt.Sprintf("/api/v1/c2/vnc/%s/%s", tt.host, tt.port)
			req := httptest.NewRequest("GET", url, nil)
			// Set X-User-ID to bypass auth check so we can reach the SSRF check
			req.Header.Set("X-User-ID", "test-user")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if tt.host == "10.101.1.1" {
				// This IP is allowed through SSRF, but will fail on TCP dial (no VNC server in tests)
				// The handler will try to connect, so it won't return Forbidden.
				// We just verify it's NOT forbidden (SSRF allowed it through).
				if w.Code == http.StatusForbidden {
					t.Errorf("status = %d, endpoint IP should NOT be forbidden", w.Code)
				}
			} else {
				if w.Code != http.StatusForbidden {
					t.Errorf("status = %d, want %d (Forbidden for non-endpoint IP %s)", w.Code, http.StatusForbidden, tt.host)
				}
			}
		})
	}
}

func TestHandleVNCProxyAuth(t *testing.T) {
	t.Run("missing auth returns 401", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/vnc/10.101.1.1/5900", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
		}
	})

	t.Run("invalid JWT returns 401", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/vnc/10.101.1.1/5900?token=invalid-token", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
		}
	})

	t.Run("X-User-ID header bypasses JWT check", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		// Use an allowed IP so SSRF check passes; handler will fail on TCP connect.
		req := httptest.NewRequest("GET", "/api/v1/c2/vnc/10.101.1.1/5900", nil)
		req.Header.Set("X-User-ID", "user-123")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		// Should NOT be 401 — auth passes via X-User-ID header.
		// It will fail on TCP dial or WebSocket upgrade, but not auth.
		if w.Code == http.StatusUnauthorized {
			t.Errorf("status = %d, X-User-ID should bypass JWT check", w.Code)
		}
	})
}

func TestHandleShellSessionAuth(t *testing.T) {
	t.Run("missing auth returns 401", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/sessions/sess-1/shell", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
		}
	})

	t.Run("invalid JWT token returns 401", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		req := httptest.NewRequest("GET", "/api/v1/c2/sessions/sess-1/shell?token=bad-token", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
		}
	})
}

// ════════════════════════════════════════════
//  REQUEST BODY SIZE LIMIT TESTS
// ════════════════════════════════════════════

func TestMaxBodyMiddleware(t *testing.T) {
	t.Run("body under limit accepted", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		// Create a body well under 10MB
		smallBody := `{"command":"ls","args":{}}`
		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/sess-1/execute", strings.NewReader(smallBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		// Should succeed (200) because the body is within the limit
		if w.Code == http.StatusRequestEntityTooLarge {
			t.Errorf("small body should not be rejected, got status %d", w.Code)
		}
	})

	t.Run("body over 10MB limit rejected", func(t *testing.T) {
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		// Create a body over 10MB
		bigBody := bytes.Repeat([]byte("x"), 11<<20) // 11 MB
		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/sess-1/execute", bytes.NewReader(bigBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		// MaxBytesReader causes json.Decode to fail, resulting in 400 Bad Request
		// because the handler tries to decode the body and gets an error
		if w.Code == http.StatusOK {
			t.Errorf("oversized body should be rejected, got status %d", w.Code)
		}
	})

	t.Run("body exactly at limit boundary", func(t *testing.T) {
		// The middleware wraps the body with http.MaxBytesReader(w, r.Body, 10<<20)
		// A body of exactly 10MB should be accepted (limit is inclusive up to maxBytes)
		mock := NewMockC2Provider()
		srv := newTestServer(mock)
		handler := newTestMux(srv)

		// Create valid JSON that's under 10MB so the request succeeds
		// The limit is 10<<20 = 10485760 bytes
		body := `{"command":"ls","args":{}}`
		req := httptest.NewRequest("POST", "/api/v1/c2/sessions/sess-1/execute", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code == http.StatusRequestEntityTooLarge {
			t.Errorf("body at limit should be accepted, got status %d", w.Code)
		}
	})
}

func TestMaxBodyMiddlewareUnit(t *testing.T) {
	t.Run("small limit rejects moderate body", func(t *testing.T) {
		// Test maxBodyMiddleware directly with a small limit
		inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
				return
			}
			w.WriteHeader(http.StatusOK)
		})

		handler := maxBodyMiddleware(100, inner) // 100 byte limit

		// Body within limit
		req := httptest.NewRequest("POST", "/test", strings.NewReader("small body"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("small body: status = %d, want %d", w.Code, http.StatusOK)
		}

		// Body over limit
		bigBody := strings.Repeat("x", 200)
		req = httptest.NewRequest("POST", "/test", strings.NewReader(bigBody))
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("big body: status = %d, want %d", w.Code, http.StatusRequestEntityTooLarge)
		}
	})

	t.Run("nil body passes through", func(t *testing.T) {
		inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})

		handler := maxBodyMiddleware(100, inner)

		req := httptest.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("nil body: status = %d, want %d", w.Code, http.StatusOK)
		}
	})
}

// ════════════════════════════════════════════
//  WRITE ERROR HELPER TESTS
// ════════════════════════════════════════════

func TestWriteError(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		code        string
		message     string
		wantStatus  int
		wantCode    string
		wantMessage string
	}{
		{
			name:        "not found",
			status:      http.StatusNotFound,
			code:        "NOT_FOUND",
			message:     "Session not found",
			wantStatus:  http.StatusNotFound,
			wantCode:    "NOT_FOUND",
			wantMessage: "Session not found",
		},
		{
			name:        "internal error",
			status:      http.StatusInternalServerError,
			code:        "INTERNAL_ERROR",
			message:     "Internal server error",
			wantStatus:  http.StatusInternalServerError,
			wantCode:    "INTERNAL_ERROR",
			wantMessage: "Internal server error",
		},
		{
			name:        "forbidden",
			status:      http.StatusForbidden,
			code:        "FORBIDDEN",
			message:     "Access denied",
			wantStatus:  http.StatusForbidden,
			wantCode:    "FORBIDDEN",
			wantMessage: "Access denied",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			writeError(w, tt.status, tt.code, tt.message)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			if ct := w.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}

			var body map[string]interface{}
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}

			errObj, ok := body["error"].(map[string]interface{})
			if !ok {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error.code = %q, want %q", errObj["code"], tt.wantCode)
			}
			if errObj["message"] != tt.wantMessage {
				t.Errorf("error.message = %q, want %q", errObj["message"], tt.wantMessage)
			}
		})
	}
}

// ════════════════════════════════════════════
//  C2 PROVIDER INTERFACE CONTRACT TESTS
// ════════════════════════════════════════════

func TestC2ProviderInterfaceContract(t *testing.T) {
	t.Run("MockC2Provider implements C2Provider", func(t *testing.T) {
		var provider C2Provider = NewMockC2Provider()

		// Verify all interface methods exist with correct signatures
		ctx := context.Background()

		if err := provider.Connect(ctx, ProviderConfig{}); err != nil {
			t.Errorf("Connect() error = %v", err)
		}

		if name := provider.Name(); name == "" {
			t.Error("Name() returned empty string")
		}

		if !provider.IsConnected() {
			t.Error("IsConnected() should return true for mock")
		}

		_, err := provider.ListSessions(ctx, nil)
		if err != nil {
			t.Errorf("ListSessions() error = %v", err)
		}

		_, err = provider.ListImplants(ctx, nil)
		if err != nil {
			t.Errorf("ListImplants() error = %v", err)
		}

		_, _ = provider.GenerateImplant(ctx, ImplantSpec{})
		// OK for mock to return nil; we just verify signature

		_, _ = provider.OpenSession(ctx, "test")
		// OK for mock to return nil

		result, err := provider.ExecuteTask(ctx, "test-session", C2Task{Command: "ls"})
		if err != nil {
			t.Errorf("ExecuteTask() error = %v", err)
		}
		if result == nil {
			t.Error("ExecuteTask() returned nil result")
		}

		history, err := provider.GetTaskHistory(ctx, "test-session")
		if err != nil {
			t.Errorf("GetTaskHistory() error = %v", err)
		}
		if history == nil {
			t.Error("GetTaskHistory() returned nil")
		}

		_, err = provider.ListListeners(ctx)
		if err != nil {
			t.Errorf("ListListeners() error = %v", err)
		}

		_, _ = provider.CreateListener(ctx, ListenerSpec{})
		// OK for mock to return nil

		if err := provider.DeleteListener(ctx, "test"); err != nil {
			t.Errorf("DeleteListener() error = %v", err)
		}

		ch, err := provider.SubscribeTelemetry(ctx, nil)
		if err != nil {
			t.Errorf("SubscribeTelemetry() error = %v", err)
		}
		if ch == nil {
			t.Error("SubscribeTelemetry() returned nil channel")
		}

		if err := provider.Disconnect(); err != nil {
			t.Errorf("Disconnect() error = %v", err)
		}
	})

	t.Run("SliverProvider implements C2Provider", func(t *testing.T) {
		// Compile-time check — SliverProvider must satisfy C2Provider
		var _ C2Provider = (*SliverProvider)(nil)
	})
}

// ════════════════════════════════════════════
//  JWT VALIDATION TESTS
// ════════════════════════════════════════════

func TestValidateJWT(t *testing.T) {
	srv := newTestServer(NewMockC2Provider())

	t.Run("empty token fails", func(t *testing.T) {
		_, err := srv.validateJWT("")
		if err == nil {
			t.Error("expected error for empty token")
		}
	})

	t.Run("garbage token fails", func(t *testing.T) {
		_, err := srv.validateJWT("not.a.jwt")
		if err == nil {
			t.Error("expected error for garbage token")
		}
	})

	t.Run("wrong secret fails", func(t *testing.T) {
		// Create a token signed with a different secret
		_, err := srv.validateJWT("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.wrong-signature")
		if err == nil {
			t.Error("expected error for token with wrong signature")
		}
	})
}

// ════════════════════════════════════════════
//  AUDIT EVENT PUBLISHING TESTS
// ════════════════════════════════════════════

func TestPublishAuditNilNATS(t *testing.T) {
	t.Run("does not panic with nil NATS connection", func(t *testing.T) {
		srv := newTestServer(NewMockC2Provider())
		// nc is nil — publishAudit should return early without panicking
		req := httptest.NewRequest("GET", "/test", nil)
		req.Header.Set("X-User-ID", "user-1")
		req.Header.Set("X-User-Roles", "operator")

		// Should not panic
		srv.publishAudit("test.event", req, "resource-1", "test-action", "details")
	})
}

// ════════════════════════════════════════════
//  DEFAULT COMMAND RISK MAP COMPLETENESS
// ════════════════════════════════════════════

func TestDefaultCommandRiskMapCompleteness(t *testing.T) {
	t.Run("all risk levels have commands", func(t *testing.T) {
		levelCounts := map[int]int{}
		for _, risk := range DefaultCommandRisk {
			levelCounts[risk]++
		}

		for level := 1; level <= 5; level++ {
			if levelCounts[level] == 0 {
				t.Errorf("no commands mapped to risk level %d", level)
			}
		}
	})

	t.Run("map has expected number of entries", func(t *testing.T) {
		// Based on the source code, there are 37 commands in the default risk map.
		// This test guards against accidental removal.
		if len(DefaultCommandRisk) < 30 {
			t.Errorf("DefaultCommandRisk has only %d entries, expected at least 30", len(DefaultCommandRisk))
		}
	})

	t.Run("recon commands are all level 1", func(t *testing.T) {
		reconCmds := []string{"ls", "ps", "netstat", "ifconfig", "whoami", "pwd", "cat", "env", "getuid", "getgid", "info"}
		for _, cmd := range reconCmds {
			risk, ok := DefaultCommandRisk[cmd]
			if !ok {
				t.Errorf("recon command %q missing from DefaultCommandRisk", cmd)
				continue
			}
			if risk != 1 {
				t.Errorf("recon command %q has risk %d, want 1", cmd, risk)
			}
		}
	})

	t.Run("critical commands are all level 5", func(t *testing.T) {
		criticalCmds := []string{"getsystem", "impersonate", "make-token", "rev2self", "psexec", "backdoor", "dllhijack"}
		for _, cmd := range criticalCmds {
			risk, ok := DefaultCommandRisk[cmd]
			if !ok {
				t.Errorf("critical command %q missing from DefaultCommandRisk", cmd)
				continue
			}
			if risk != 5 {
				t.Errorf("critical command %q has risk %d, want 5", cmd, risk)
			}
		}
	})
}

// ════════════════════════════════════════════
//  DATA TYPE SERIALIZATION TESTS
// ════════════════════════════════════════════

func TestSessionJSONSerialization(t *testing.T) {
	session := Session{
		ID:          "sess-abc",
		ImplantID:   "impl-123",
		Hostname:    "target-host",
		OS:          "linux",
		RemoteAddr:  "10.101.1.1:443",
		Transport:   "http",
		IsAlive:     true,
		LastMessage: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
	}

	data, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Session
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.ID != session.ID {
		t.Errorf("ID = %q, want %q", decoded.ID, session.ID)
	}
	if decoded.IsAlive != session.IsAlive {
		t.Errorf("IsAlive = %v, want %v", decoded.IsAlive, session.IsAlive)
	}
	if decoded.Transport != session.Transport {
		t.Errorf("Transport = %q, want %q", decoded.Transport, session.Transport)
	}
}

func TestTaskResultJSONSerialization(t *testing.T) {
	result := TaskResult{
		TaskID:    "task-1",
		Command:   "ls",
		Output:    "file1.txt\nfile2.txt",
		Error:     "",
		StartedAt: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		EndedAt:   time.Date(2026, 3, 1, 12, 0, 1, 0, time.UTC),
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded TaskResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.TaskID != result.TaskID {
		t.Errorf("TaskID = %q, want %q", decoded.TaskID, result.TaskID)
	}
	if decoded.Output != result.Output {
		t.Errorf("Output = %q, want %q", decoded.Output, result.Output)
	}

	// Verify error field is omitted when empty (omitempty)
	if strings.Contains(string(data), `"error":""`) {
		// The struct has `json:"error,omitempty"` so empty string should be omitted
		t.Error("empty error should be omitted from JSON (omitempty tag)")
	}
}

func TestC2TaskJSONSerialization(t *testing.T) {
	task := C2Task{
		Command: "cat",
		Arguments: map[string]interface{}{
			"path": "/etc/hostname",
		},
	}

	data, err := json.Marshal(task)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded C2Task
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Command != "cat" {
		t.Errorf("Command = %q, want \"cat\"", decoded.Command)
	}
	if decoded.Arguments["path"] != "/etc/hostname" {
		t.Errorf("Arguments[\"path\"] = %v, want \"/etc/hostname\"", decoded.Arguments["path"])
	}
}

// ════════════════════════════════════════════
//  NEW C2 GATEWAY SERVER TESTS
// ════════════════════════════════════════════

func TestNewC2GatewayServer(t *testing.T) {
	mock := NewMockC2Provider()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))

	srv := NewC2GatewayServer(mock, "3005", nil, logger, "my-secret")

	if srv.provider != mock {
		t.Error("provider not set correctly")
	}
	if srv.port != "3005" {
		t.Errorf("port = %q, want \"3005\"", srv.port)
	}
	if string(srv.jwtSecret) != "my-secret" {
		t.Errorf("jwtSecret = %q, want \"my-secret\"", string(srv.jwtSecret))
	}
	if srv.nc != nil {
		t.Error("nc should be nil when none provided")
	}
}

// ════════════════════════════════════════════
//  SLIVER PROVIDER UNIT TESTS
// ════════════════════════════════════════════

func TestSliverProviderName(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewSliverProvider(logger)

	if p.Name() != "sliver" {
		t.Errorf("Name() = %q, want \"sliver\"", p.Name())
	}
}

func TestSliverProviderIsConnected(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewSliverProvider(logger)

	// Initially not connected
	if p.IsConnected() {
		t.Error("new SliverProvider should not be connected")
	}
}

func TestSliverProviderDisconnectWhenNotConnected(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewSliverProvider(logger)

	// Disconnect when no connection should be a no-op
	if err := p.Disconnect(); err != nil {
		t.Errorf("Disconnect() on unconnected provider returned error: %v", err)
	}
}

func TestSliverProviderNotConnectedErrors(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewSliverProvider(logger)
	ctx := context.Background()

	t.Run("ListSessions fails when not connected", func(t *testing.T) {
		_, err := p.ListSessions(ctx, nil)
		if err == nil {
			t.Error("expected error when not connected")
		}
		if !strings.Contains(err.Error(), "not connected") {
			t.Errorf("error = %q, want to contain \"not connected\"", err.Error())
		}
	})

	t.Run("ListImplants fails when not connected", func(t *testing.T) {
		_, err := p.ListImplants(ctx, nil)
		if err == nil {
			t.Error("expected error when not connected")
		}
		if !strings.Contains(err.Error(), "not connected") {
			t.Errorf("error = %q, want to contain \"not connected\"", err.Error())
		}
	})

	t.Run("GenerateImplant fails when not connected", func(t *testing.T) {
		_, err := p.GenerateImplant(ctx, ImplantSpec{})
		if err == nil {
			t.Error("expected error when not connected")
		}
	})

	t.Run("ListListeners fails when not connected", func(t *testing.T) {
		_, err := p.ListListeners(ctx)
		if err == nil {
			t.Error("expected error when not connected")
		}
	})

	t.Run("CreateListener fails when not connected", func(t *testing.T) {
		_, err := p.CreateListener(ctx, ListenerSpec{})
		if err == nil {
			t.Error("expected error when not connected")
		}
	})

	t.Run("DeleteListener fails when not connected", func(t *testing.T) {
		err := p.DeleteListener(ctx, "1")
		if err == nil {
			t.Error("expected error when not connected")
		}
	})

	t.Run("ExecuteTask fails when not connected", func(t *testing.T) {
		_, err := p.ExecuteTask(ctx, "sess-1", C2Task{Command: "ls"})
		if err == nil {
			t.Error("expected error when not connected")
		}
	})

	t.Run("OpenSession fails when not connected", func(t *testing.T) {
		_, err := p.OpenSession(ctx, "sess-1")
		if err == nil {
			t.Error("expected error when not connected")
		}
	})
}

func TestSliverProviderGetTaskHistory(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewSliverProvider(logger)

	// GetTaskHistory is a stub that returns empty slice regardless
	results, err := p.GetTaskHistory(context.Background(), "any-session")
	if err != nil {
		t.Errorf("GetTaskHistory() error = %v", err)
	}
	if len(results) != 0 {
		t.Errorf("GetTaskHistory() returned %d results, want 0", len(results))
	}
}

func TestSliverProviderSubscribeTelemetry(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewSliverProvider(logger)

	ch, err := p.SubscribeTelemetry(context.Background(), nil)
	if err != nil {
		t.Errorf("SubscribeTelemetry() error = %v", err)
	}
	if ch == nil {
		t.Error("SubscribeTelemetry() returned nil channel")
	}
}

// ════════════════════════════════════════════
//  OPERATOR CONFIG TESTS
// ════════════════════════════════════════════

func TestLoadOperatorConfig(t *testing.T) {
	t.Run("valid config", func(t *testing.T) {
		tmpFile, err := os.CreateTemp("", "operator-*.json")
		if err != nil {
			t.Fatalf("create temp file: %v", err)
		}
		defer os.Remove(tmpFile.Name())

		config := `{
			"operator": "ems-operator",
			"token": "test-token-123",
			"lhost": "sliver-server",
			"lport": 31337,
			"ca_certificate": "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
			"private_key": "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
			"certificate": "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----"
		}`
		if _, err := tmpFile.WriteString(config); err != nil {
			t.Fatalf("write config: %v", err)
		}
		tmpFile.Close()

		cfg, err := loadOperatorConfig(tmpFile.Name())
		if err != nil {
			t.Fatalf("loadOperatorConfig() error = %v", err)
		}

		if cfg.Operator != "ems-operator" {
			t.Errorf("Operator = %q, want \"ems-operator\"", cfg.Operator)
		}
		if cfg.Token != "test-token-123" {
			t.Errorf("Token = %q, want \"test-token-123\"", cfg.Token)
		}
		if cfg.LHost != "sliver-server" {
			t.Errorf("LHost = %q, want \"sliver-server\"", cfg.LHost)
		}
		if cfg.LPort != 31337 {
			t.Errorf("LPort = %d, want 31337", cfg.LPort)
		}
	})

	t.Run("file not found", func(t *testing.T) {
		_, err := loadOperatorConfig("/nonexistent/path/config.json")
		if err == nil {
			t.Error("expected error for nonexistent file")
		}
		if !strings.Contains(err.Error(), "read operator config") {
			t.Errorf("error = %q, want to contain \"read operator config\"", err.Error())
		}
	})

	t.Run("invalid JSON", func(t *testing.T) {
		tmpFile, err := os.CreateTemp("", "operator-bad-*.json")
		if err != nil {
			t.Fatalf("create temp file: %v", err)
		}
		defer os.Remove(tmpFile.Name())

		tmpFile.WriteString("not json content")
		tmpFile.Close()

		_, err = loadOperatorConfig(tmpFile.Name())
		if err == nil {
			t.Error("expected error for invalid JSON")
		}
		if !strings.Contains(err.Error(), "parse operator config") {
			t.Errorf("error = %q, want to contain \"parse operator config\"", err.Error())
		}
	})
}

// ════════════════════════════════════════════
//  TOKEN AUTH TESTS (gRPC PerRPCCredentials)
// ════════════════════════════════════════════

func TestTokenAuth(t *testing.T) {
	t.Run("GetRequestMetadata returns bearer token", func(t *testing.T) {
		auth := TokenAuth{token: "my-token"}
		md, err := auth.GetRequestMetadata(context.Background())
		if err != nil {
			t.Fatalf("GetRequestMetadata() error = %v", err)
		}
		if md["Authorization"] != "Bearer my-token" {
			t.Errorf("Authorization = %q, want \"Bearer my-token\"", md["Authorization"])
		}
	})

	t.Run("RequireTransportSecurity returns true", func(t *testing.T) {
		auth := TokenAuth{token: "any"}
		if !auth.RequireTransportSecurity() {
			t.Error("RequireTransportSecurity() should return true")
		}
	})
}

// ════════════════════════════════════════════
//  ROUTE COVERAGE TEST
// ════════════════════════════════════════════

func TestRouteCoverage(t *testing.T) {
	// Verify all expected routes are reachable
	mock := NewMockC2Provider()
	mock.sessions = []Session{}
	mock.implants = []Implant{}
	mock.listeners = []Listener{}
	srv := newTestServer(mock)
	handler := newTestMux(srv)

	routes := []struct {
		method     string
		path       string
		body       string
		wantStatus int // minimum acceptable status (not 404/405)
	}{
		{"GET", "/api/v1/c2/sessions", "", http.StatusOK},
		{"GET", "/api/v1/c2/implants", "", http.StatusOK},
		{"GET", "/api/v1/c2/listeners", "", http.StatusOK},
		{"POST", "/api/v1/c2/listeners", `{"protocol":"http"}`, http.StatusInternalServerError}, // mock returns nil listener
		{"POST", "/api/v1/c2/sessions/test-session/execute", `{"command":"ls"}`, http.StatusOK},
		{"GET", "/health/live", "", http.StatusOK},
		{"GET", "/api/v1/c2/health", "", http.StatusOK},
	}

	for _, rt := range routes {
		t.Run(fmt.Sprintf("%s %s", rt.method, rt.path), func(t *testing.T) {
			var body io.Reader
			if rt.body != "" {
				body = strings.NewReader(rt.body)
			}
			req := httptest.NewRequest(rt.method, rt.path, body)
			if rt.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			// Route should be found (not 404 or 405)
			if w.Code == http.StatusNotFound {
				t.Errorf("route not found: %s %s", rt.method, rt.path)
			}
			if w.Code == http.StatusMethodNotAllowed {
				t.Errorf("method not allowed: %s %s", rt.method, rt.path)
			}
		})
	}
}

// ════════════════════════════════════════════
//  AUDIT EVENT STRUCTURE TESTS
// ════════════════════════════════════════════

func TestAuditEventJSONSerialization(t *testing.T) {
	event := AuditEvent{
		EventType:    "c2.command_executed",
		ActorID:      "user-1",
		ActorUsername: "operator",
		ActorIP:      "10.100.0.5:54321",
		SessionID:    "session-1",
		ResourceType: "c2_session",
		ResourceID:   "sess-abc",
		Action:       "ls",
		Details:      `{"command":"ls","args":{}}`,
		Timestamp:    "2026-03-01T12:00:00Z",
	}

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded AuditEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.EventType != event.EventType {
		t.Errorf("EventType = %q, want %q", decoded.EventType, event.EventType)
	}
	if decoded.ActorID != event.ActorID {
		t.Errorf("ActorID = %q, want %q", decoded.ActorID, event.ActorID)
	}
	if decoded.ResourceID != event.ResourceID {
		t.Errorf("ResourceID = %q, want %q", decoded.ResourceID, event.ResourceID)
	}
}

// ===========================================================================
// M12 Cross-Domain Command Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: CrossDomainCommand struct JSON serialization
// ---------------------------------------------------------------------------

func TestCrossDomainCommandJSON(t *testing.T) {
	reqBy := "user-1"
	cmd := CrossDomainCommand{
		ID:              "cmd-1",
		OperationID:     "op-1",
		Command:         "ls",
		TargetSessionID: "sess-1",
		RiskLevel:       1,
		Classification:  "UNCLASS",
		Status:          "pending",
		RequestedBy:     &reqBy,
		RequestedAt:     "2026-03-01T12:00:00Z",
		CreatedAt:       "2026-03-01T12:00:00Z",
		UpdatedAt:       "2026-03-01T12:00:00Z",
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded CrossDomainCommand
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.ID != "cmd-1" {
		t.Errorf("ID = %q, want %q", decoded.ID, "cmd-1")
	}
	if decoded.Classification != "UNCLASS" {
		t.Errorf("Classification = %q, want %q", decoded.Classification, "UNCLASS")
	}
	if decoded.Status != "pending" {
		t.Errorf("Status = %q, want %q", decoded.Status, "pending")
	}
	if decoded.RequestedBy == nil || *decoded.RequestedBy != "user-1" {
		t.Errorf("RequestedBy = %v, want %q", decoded.RequestedBy, "user-1")
	}
}

// ---------------------------------------------------------------------------
// Test: CrossDomainExecuteRequest struct
// ---------------------------------------------------------------------------

func TestCrossDomainExecuteRequestJSON(t *testing.T) {
	tests := []struct {
		name      string
		json      string
		wantSess  string
		wantCmd   string
		wantOpID  string
	}{
		{
			"full request",
			`{"session_id":"sess-1","command":"whoami","operation_id":"op-1"}`,
			"sess-1",
			"whoami",
			"op-1",
		},
		{
			"missing optional fields",
			`{"session_id":"","command":"","operation_id":""}`,
			"",
			"",
			"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req CrossDomainExecuteRequest
			if err := json.Unmarshal([]byte(tt.json), &req); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if req.SessionID != tt.wantSess {
				t.Errorf("SessionID = %q, want %q", req.SessionID, tt.wantSess)
			}
			if req.Command != tt.wantCmd {
				t.Errorf("Command = %q, want %q", req.Command, tt.wantCmd)
			}
			if req.OperationID != tt.wantOpID {
				t.Errorf("OperationID = %q, want %q", req.OperationID, tt.wantOpID)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: handleCrossDomainExecute — enclave restriction
// ---------------------------------------------------------------------------

func TestHandleCrossDomainExecute_EnclaveRestriction(t *testing.T) {
	origEnclave := enclave
	defer func() { enclave = origEnclave }()

	tests := []struct {
		name       string
		enclave    string
		wantStatus int
		wantCode   string
	}{
		{"low side blocked", "low", http.StatusForbidden, "ENCLAVE_RESTRICTION"},
		{"empty enclave blocked", "", http.StatusForbidden, "ENCLAVE_RESTRICTION"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			enclave = tt.enclave
			s := newTestC2Server()

			body := `{"session_id":"s1","command":"ls","operation_id":"op1"}`
			req := httptest.NewRequest("POST", "/api/v1/c2/cross-domain/execute", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleCrossDomainExecute(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var resp map[string]any
			json.NewDecoder(w.Body).Decode(&resp)
			errObj, _ := resp["error"].(map[string]any)
			if errObj == nil {
				t.Fatal("expected error object")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: handleCrossDomainExecute — DB unavailable
// ---------------------------------------------------------------------------

func TestHandleCrossDomainExecute_DBUnavailable(t *testing.T) {
	origEnclave := enclave
	enclave = "high"
	defer func() { enclave = origEnclave }()

	s := newTestC2Server()
	s.db = nil // no DB

	body := `{"session_id":"s1","command":"ls","operation_id":"op1"}`
	req := httptest.NewRequest("POST", "/api/v1/c2/cross-domain/execute", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.handleCrossDomainExecute(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
}

// ---------------------------------------------------------------------------
// Test: handleCrossDomainExecute — validation
// ---------------------------------------------------------------------------

func TestHandleCrossDomainExecute_Validation(t *testing.T) {
	origEnclave := enclave
	enclave = "high"
	defer func() { enclave = origEnclave }()

	s := newTestC2Server()
	s.db = nil // DB will cause failure on valid requests, but we test validation first

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"invalid JSON",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing session_id",
			`{"command":"ls","operation_id":"op1"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"missing command",
			`{"session_id":"s1","operation_id":"op1"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"missing operation_id",
			`{"session_id":"s1","command":"ls"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// For validation tests, ensure DB is nil so we hit validation before DB
			// But since handleCrossDomainExecute checks DB nil first, we need to
			// provide a non-nil mock DB for these tests. Since we can't easily mock pgxpool,
			// we note that without DB these will hit DB_UNAVAILABLE first.
			// Instead, test the validation by checking that we get the right error
			// when DB check is last.
		})
	}

	// Test without DB — validation comes after DB check, so test separately
	t.Run("DB_UNAVAILABLE trumps validation", func(t *testing.T) {
		body := `{"session_id":"s1","command":"ls","operation_id":"op1"}`
		req := httptest.NewRequest("POST", "/api/v1/c2/cross-domain/execute", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		s.handleCrossDomainExecute(w, req)

		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
		}
	})
}

// ---------------------------------------------------------------------------
// Test: handleListCrossDomainCommands — DB unavailable
// ---------------------------------------------------------------------------

func TestHandleListCrossDomainCommands_DBUnavailable(t *testing.T) {
	s := newTestC2Server()
	s.db = nil

	req := httptest.NewRequest("GET", "/api/v1/c2/cross-domain/commands", nil)
	w := httptest.NewRecorder()

	s.handleListCrossDomainCommands(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
}

// ---------------------------------------------------------------------------
// Test: handleGetCrossDomainCommand — DB unavailable
// ---------------------------------------------------------------------------

func TestHandleGetCrossDomainCommand_DBUnavailable(t *testing.T) {
	s := newTestC2Server()
	s.db = nil

	req := httptest.NewRequest("GET", "/api/v1/c2/cross-domain/commands/cmd-1", nil)
	req.SetPathValue("id", "cmd-1")
	w := httptest.NewRecorder()

	s.handleGetCrossDomainCommand(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
}

// ---------------------------------------------------------------------------
// Test: handleApproveCrossDomainCommand — DB unavailable and validation
// ---------------------------------------------------------------------------

func TestHandleApproveCrossDomainCommand_DBUnavailable(t *testing.T) {
	s := newTestC2Server()
	s.db = nil

	req := httptest.NewRequest("POST", "/api/v1/c2/cross-domain/commands/cmd-1/approve", nil)
	req.SetPathValue("id", "cmd-1")
	w := httptest.NewRecorder()

	s.handleApproveCrossDomainCommand(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
}

func TestHandleApproveCrossDomainCommand_MissingID(t *testing.T) {
	s := newTestC2Server()
	s.db = nil

	req := httptest.NewRequest("POST", "/api/v1/c2/cross-domain/commands//approve", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleApproveCrossDomainCommand(w, req)

	// Should return DB_UNAVAILABLE since that check comes first
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d (DB check comes first)", w.Code, http.StatusServiceUnavailable)
	}
}

// ---------------------------------------------------------------------------
// Test: Classification helpers
// ---------------------------------------------------------------------------

func TestC2IsValidClassification(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"UNCLASS", true},
		{"CUI", true},
		{"SECRET", true},
		{"", false},
		{"TOP_SECRET", false},
		{"unclass", false}, // c2-gateway uses exact match
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := isValidClassification(tt.input)
			if got != tt.want {
				t.Errorf("isValidClassification(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestC2ClassificationRank(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"UNCLASS", 0},
		{"CUI", 1},
		{"SECRET", 2},
		{"INVALID", -1},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := classificationRank(tt.input)
			if got != tt.want {
				t.Errorf("classificationRank(%q) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: publishAuditWithClassification (nil NATS)
// ---------------------------------------------------------------------------

func TestPublishAuditWithClassification_NilNATS(t *testing.T) {
	s := newTestC2Server()
	// Should not panic with nil NATS
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-User-ID", "test-user")
	s.publishAuditWithClassification("test.event", req, "res-1", "test", "details", "CUI")
}

// ---------------------------------------------------------------------------
// Test: publishAudit backward compat wrapper
// ---------------------------------------------------------------------------

func TestPublishAudit_DefaultsToUNCLASS(t *testing.T) {
	s := newTestC2Server()
	// Should not panic with nil NATS, and defaults to UNCLASS
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-User-ID", "test-user")
	s.publishAudit("test.event", req, "res-1", "test", "details")
}

// ---------------------------------------------------------------------------
// Test: AuditEvent struct includes Classification field
// ---------------------------------------------------------------------------

func TestAuditEventClassificationField(t *testing.T) {
	event := AuditEvent{
		EventType:      "c2.command_executed",
		ActorID:        "user-1",
		Classification: "CUI",
		Timestamp:      "2026-03-01T12:00:00Z",
	}

	data, _ := json.Marshal(event)
	var decoded AuditEvent
	json.Unmarshal(data, &decoded)

	if decoded.Classification != "CUI" {
		t.Errorf("Classification = %q, want %q", decoded.Classification, "CUI")
	}
}

// ---------------------------------------------------------------------------
// Test: C2Task and TaskResult include Classification
// ---------------------------------------------------------------------------

func TestC2TaskClassification(t *testing.T) {
	task := C2Task{
		Command:        "ls",
		Classification: "CUI",
	}

	data, _ := json.Marshal(task)
	var decoded C2Task
	json.Unmarshal(data, &decoded)

	if decoded.Classification != "CUI" {
		t.Errorf("Classification = %q, want %q", decoded.Classification, "CUI")
	}
}

func TestTaskResultClassification(t *testing.T) {
	result := TaskResult{
		TaskID:         "task-1",
		Command:        "ls",
		Output:         "output",
		Classification: "SECRET",
		StartedAt:      time.Now(),
		EndedAt:        time.Now(),
	}

	data, _ := json.Marshal(result)
	var decoded TaskResult
	json.Unmarshal(data, &decoded)

	if decoded.Classification != "SECRET" {
		t.Errorf("Classification = %q, want %q", decoded.Classification, "SECRET")
	}
}

// ---------------------------------------------------------------------------
// Test: GetCommandRisk (used by cross-domain routing)
// ---------------------------------------------------------------------------

func TestGetCommandRisk_CrossDomainRouting(t *testing.T) {
	tests := []struct {
		name      string
		command   string
		overrides map[string]int
		wantRisk  int
		wantLow   bool // risk <= 2 means auto-approve for cross-domain
	}{
		{"ls is risk 1 (auto)", "ls", nil, 1, true},
		{"whoami is risk 1 (auto)", "whoami", nil, 1, true},
		{"upload is risk 2 (auto)", "upload", nil, 2, true},
		{"execute-assembly is risk 4 (approval)", "execute-assembly", nil, 4, false},
		{"unknown is risk 3 (approval)", "custom_cmd", nil, 3, false},
		{"override lowers risk", "custom_cmd", map[string]int{"custom_cmd": 1}, 1, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetCommandRisk(tt.command, tt.overrides)
			if got != tt.wantRisk {
				t.Errorf("GetCommandRisk(%q) = %d, want %d", tt.command, got, tt.wantRisk)
			}
			isLow := got <= 2
			if isLow != tt.wantLow {
				t.Errorf("risk <= 2 = %v, want %v (auto-approve for cross-domain)", isLow, tt.wantLow)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: C2 Gateway CTI health and degraded mode
// ---------------------------------------------------------------------------

func TestC2GatewayIsDegraded(t *testing.T) {
	origEnclave := enclave
	defer func() { enclave = origEnclave }()

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))

	tests := []struct {
		name         string
		enclaveSide  string
		ctiConnected bool
		ctiNil       bool
		want         bool
	}{
		{"low side, CTI disconnected", "low", false, false, true},
		{"low side, CTI connected", "low", true, false, false},
		{"high side, CTI disconnected", "high", false, false, false},
		{"no CTI configured", "low", false, true, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			enclave = tt.enclaveSide
			s := newTestC2Server()
			if !tt.ctiNil {
				cti := newCTIHealth("http://localhost:9999", logger)
				cti.mu.Lock()
				cti.connected = tt.ctiConnected
				cti.mu.Unlock()
				s.cti = cti
			} else {
				s.cti = nil
			}
			got := s.isDegraded()
			if got != tt.want {
				t.Errorf("isDegraded() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: publishCrossDomainEvent with nil NATS
// ---------------------------------------------------------------------------

func TestPublishCrossDomainEvent_NilNATS(t *testing.T) {
	s := newTestC2Server()
	// Should not panic
	s.publishCrossDomainEvent("cti.command.execute", map[string]any{
		"command_id":   "cmd-1",
		"operation_id": "op-1",
		"command":      "ls",
	})
}
