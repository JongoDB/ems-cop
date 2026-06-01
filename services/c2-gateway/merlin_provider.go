// EMS-COP C2 Gateway — Merlin C2 Provider
// Implements the C2Provider interface for the Merlin C2 framework.
//
// Merlin v2 exposes a gRPC API by default (port 50051) and a REST/HTTPS
// listener for agents. Auth is performed via a pre-shared key (PSK) which
// the operator submits to /auth/login to obtain a session token that is
// then passed as a bearer credential on subsequent calls.
//
// NOTE: this provider focuses on getting the registration plumbing in
// place. The RPC bodies (ListSessions / ExecuteTask / etc) are
// intentionally STUBBED with TODOs; they return empty slices or
// not-implemented errors so the gateway can boot with MERLIN_ENABLED=true
// without crashing. Wiring real Merlin RPCs is tracked separately.
//
// Required env (read by initSecondaryProviders in main.go):
//   MERLIN_ENABLED=true
//   MERLIN_HOST            (e.g. "merlin-server")
//   MERLIN_PORT            (default "50051")
//   MERLIN_PSK             (shared secret used to obtain a session token)
//   MERLIN_TLS_INSECURE    (default "true" — Merlin commonly uses self-signed certs)
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Compile-time interface check.
var _ C2Provider = (*MerlinProvider)(nil)

// MerlinProvider implements C2Provider for the Merlin C2 framework.
type MerlinProvider struct {
	name      string
	apiURL    string // e.g. "https://merlin-server:50051"
	psk       string
	token     string
	connected bool
	client    *http.Client
	mu        sync.RWMutex
	logger    *slog.Logger
}

// NewMerlinProvider returns an unconnected MerlinProvider.
func NewMerlinProvider(logger *slog.Logger) *MerlinProvider {
	return &MerlinProvider{
		name:   "merlin",
		logger: logger,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (p *MerlinProvider) Name() string { return p.name }

func (p *MerlinProvider) IsConnected() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.connected
}

// ────────────────────────────────────────────
// Connection
// ────────────────────────────────────────────

func (p *MerlinProvider) Connect(ctx context.Context, config ProviderConfig) error {
	scheme := "https"
	if v, ok := config.Options["scheme"]; ok {
		scheme = v
	}
	port := config.Port
	if port == 0 {
		port = 50051
	}
	p.apiURL = fmt.Sprintf("%s://%s:%d", scheme, config.Host, port)

	p.psk = config.Options["psk"]
	if p.psk == "" {
		return fmt.Errorf("merlin: PSK required in Options[\"psk\"]")
	}

	insecure := true
	if v, ok := config.Options["tls_insecure"]; ok {
		insecure = v != "false" && v != "0"
	}
	p.client = &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: insecure},
		},
	}

	token, err := p.authenticate(ctx)
	if err != nil {
		return fmt.Errorf("merlin auth: %w", err)
	}

	p.mu.Lock()
	p.token = token
	p.connected = true
	p.mu.Unlock()

	p.logger.Info("connected to merlin", "url", p.apiURL)
	return nil
}

func (p *MerlinProvider) Disconnect() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.token = ""
	p.connected = false
	p.logger.Info("disconnected from merlin")
	return nil
}

// authenticate POSTs the PSK to /auth/login and returns a session token.
//
// TODO: this matches the documented Merlin v2 REST gateway. For deployments
// using gRPC directly, swap to merlin_pb.AuthService/Login.
func (p *MerlinProvider) authenticate(ctx context.Context) (string, error) {
	body, _ := json.Marshal(map[string]string{"psk": p.psk})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.apiURL+"/auth/login", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("login request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("login failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Token string `json:"token"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode login response: %w", err)
	}
	if result.Token == "" {
		return "", fmt.Errorf("no token in login response")
	}
	return result.Token, nil
}

// ────────────────────────────────────────────
// Sessions / Implants / Listeners / Tasks — STUBS
// ────────────────────────────────────────────
//
// The following methods return empty slices or not-implemented errors so
// that the gateway can register Merlin without crashing. Replace each
// stub with the corresponding Merlin gRPC/REST call when the schema is
// firmed up.

func (p *MerlinProvider) ListSessions(_ context.Context, _ *SessionFilter) ([]Session, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to merlin")
	}
	// TODO: call AgentService/List or GET /agents
	return []Session{}, nil
}

func (p *MerlinProvider) ListImplants(_ context.Context, _ *ImplantFilter) ([]Implant, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to merlin")
	}
	// TODO: call PayloadService/List or GET /payloads
	return []Implant{}, nil
}

func (p *MerlinProvider) GenerateImplant(_ context.Context, _ ImplantSpec) (*ImplantBinary, error) {
	return nil, errors.New("merlin: GenerateImplant not yet implemented")
}

func (p *MerlinProvider) ListListeners(_ context.Context) ([]Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to merlin")
	}
	// TODO: call ListenerService/List or GET /listeners
	return []Listener{}, nil
}

func (p *MerlinProvider) CreateListener(_ context.Context, _ ListenerSpec) (*Listener, error) {
	return nil, errors.New("merlin: CreateListener not yet implemented")
}

func (p *MerlinProvider) DeleteListener(_ context.Context, _ string) error {
	return errors.New("merlin: DeleteListener not yet implemented")
}

func (p *MerlinProvider) ExecuteTask(_ context.Context, _ string, _ C2Task) (*TaskResult, error) {
	return nil, errors.New("merlin: ExecuteTask not yet implemented")
}

func (p *MerlinProvider) GetTaskHistory(_ context.Context, _ string) ([]TaskResult, error) {
	return []TaskResult{}, nil
}

func (p *MerlinProvider) OpenSession(_ context.Context, _ string) (SessionStream, error) {
	return nil, errors.New("merlin: interactive shell sessions not yet implemented — use ExecuteTask")
}

func (p *MerlinProvider) SubscribeTelemetry(_ context.Context, _ *TelemetryFilter) (<-chan TelemetryEvent, error) {
	ch := make(chan TelemetryEvent)
	close(ch)
	return ch, nil
}

// ────────────────────────────────────────────
// Tunnels — not yet implemented for Merlin
// ────────────────────────────────────────────

func (p *MerlinProvider) ListTunnels(_ context.Context, _ TunnelFilter) ([]Tunnel, error) {
	return []Tunnel{}, nil
}

func (p *MerlinProvider) CreateTunnel(_ context.Context, _ TunnelSpec) (Tunnel, error) {
	return Tunnel{}, errors.New("tunnels not yet implemented for merlin")
}

func (p *MerlinProvider) DeleteTunnel(_ context.Context, _ string) error {
	return errors.New("tunnels not yet implemented for merlin")
}

func (p *MerlinProvider) SubscribeTunnels(_ context.Context, _ TunnelFilter) (<-chan TunnelEvent, error) {
	ch := make(chan TunnelEvent)
	close(ch)
	return ch, nil
}
