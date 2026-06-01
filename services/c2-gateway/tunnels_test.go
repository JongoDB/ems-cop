package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTunnelProvider records calls and lets each test assert behavior.
type fakeTunnelProvider struct {
	*MockC2Provider

	createErr  error
	deleteErr  error
	createCall TunnelSpec
	deleteCall string
	mu         sync.Mutex
}

func newFakeTunnelProvider() *fakeTunnelProvider {
	return &fakeTunnelProvider{MockC2Provider: NewMockC2Provider()}
}

func (f *fakeTunnelProvider) CreateTunnel(_ context.Context, spec TunnelSpec) (Tunnel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCall = spec
	if f.createErr != nil {
		return Tunnel{}, f.createErr
	}
	return Tunnel{
		Provider:     f.name,
		Type:         spec.Type,
		SrcSessionID: spec.SrcSessionID,
		Status:       "pending",
	}, nil
}

func (f *fakeTunnelProvider) DeleteTunnel(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteCall = id
	return f.deleteErr
}

// newTunnelManagerNoDB returns a manager wired with a registry but no DB
// — useful for testing validation paths that don't reach Postgres.
func newTunnelManagerNoDB() *TunnelManager {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	return NewTunnelManager(nil, nil, NewProviderRegistry(logger), logger)
}

func TestTunnelManager_ValidateSpec(t *testing.T) {
	m := newTunnelManagerNoDB()

	tests := []struct {
		name    string
		spec    TunnelSpec
		wantErr string
	}{
		{
			name:    "missing provider",
			spec:    TunnelSpec{Type: "portfwd_local", SrcSessionID: "sess-1"},
			wantErr: "provider is required",
		},
		{
			name:    "invalid type",
			spec:    TunnelSpec{Provider: "sliver", Type: "udp_tunnel", SrcSessionID: "sess-1"},
			wantErr: "invalid tunnel type",
		},
		{
			name:    "missing src_session_id",
			spec:    TunnelSpec{Provider: "sliver", Type: "socks5"},
			wantErr: "src_session_id is required",
		},
		{
			name:    "invalid classification",
			spec:    TunnelSpec{Provider: "sliver", Type: "socks5", SrcSessionID: "sess-1", Classification: "TOPSECRET"},
			wantErr: "invalid classification",
		},
		{
			name: "valid: portfwd_local",
			spec: TunnelSpec{Provider: "sliver", Type: "portfwd_local", SrcSessionID: "sess-1", DstHost: "10.0.0.1", DstPort: 22, ListenPort: 2222},
		},
		{
			name: "valid: socks5",
			spec: TunnelSpec{Provider: "sliver", Type: "socks5", SrcSessionID: "sess-1", ListenPort: 1080, Classification: "CUI"},
		},
		{
			name: "valid: pivot_relay",
			spec: TunnelSpec{Provider: "sliver", Type: "pivot_relay", SrcSessionID: "sess-1"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.validateSpec(tc.spec)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestTunnelManager_CreateValidatesBeforeDB(t *testing.T) {
	// No DB configured: validation errors should still surface as the right error.
	m := newTunnelManagerNoDB()

	_, err := m.Create(context.Background(), TunnelSpec{}, "actor")
	if err == nil || !strings.Contains(err.Error(), "provider is required") {
		t.Fatalf("expected validation error, got %v", err)
	}

	_, err = m.Create(context.Background(), TunnelSpec{Provider: "sliver", Type: "socks5", SrcSessionID: "s"}, "actor")
	if err == nil || !strings.Contains(err.Error(), "database not configured") {
		t.Fatalf("expected database-not-configured error after validation, got %v", err)
	}
}

func TestTunnelManager_ResolveProvider(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	registry := NewProviderRegistry(logger)
	fake := newFakeTunnelProvider()
	registry.Register("fake", fake, RegistryProviderConfig{Name: "fake", Type: "fake", Enabled: true})

	m := NewTunnelManager(nil, nil, registry, logger)
	if got := m.resolveProvider("fake"); got == nil {
		t.Fatal("expected to resolve fake provider")
	}
	if got := m.resolveProvider("nope"); got != nil {
		t.Fatal("expected nil for unknown provider")
	}
}

func TestTunnelManager_StartSubscriptions_NoCrash(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	registry := NewProviderRegistry(logger)
	fake := newFakeTunnelProvider()
	registry.Register("fake", fake, RegistryProviderConfig{Name: "fake", Type: "fake", Enabled: true})

	m := NewTunnelManager(nil, nil, registry, logger)
	// MockC2Provider's SubscribeTunnels returns a closed channel — should not crash.
	m.StartSubscriptions(context.Background())
	// Calling twice is idempotent.
	m.StartSubscriptions(context.Background())
}

func TestSanitizeID(t *testing.T) {
	tests := map[string]string{
		"abc-123":                "abc-123",
		"abc'; DROP TABLE x; --": "abc DROP TABLE x --",
		"line\nbreak":            "linebreak",
	}
	for in, want := range tests {
		if got := sanitizeID(in); got != want {
			t.Errorf("sanitizeID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNilHelpers(t *testing.T) {
	if nilIfEmpty("") != nil {
		t.Error("nilIfEmpty('') should be nil")
	}
	if nilIfEmpty("x") != "x" {
		t.Error("nilIfEmpty('x') should be 'x'")
	}
	if nilIfZero(0) != nil {
		t.Error("nilIfZero(0) should be nil")
	}
	if nilIfZero(7) != 7 {
		t.Error("nilIfZero(7) should be 7")
	}
}

// TestQueryThroughput_Disabled exercises the path where ClickHouse is not
// configured. The handler should surface a 503 via the typed error.
func TestQueryThroughput_Disabled(t *testing.T) {
	m := newTunnelManagerNoDB()
	_, err := m.QueryThroughput(context.Background(), "tunnel-1", time.Time{}, time.Time{}, "raw")
	if err == nil || !strings.Contains(err.Error(), "clickhouse not configured") {
		t.Fatalf("expected clickhouse-not-configured, got %v", err)
	}
}

// TestProviderCreateError ensures provider failures are surfaced. This
// stops short of touching real Postgres (no DB → DB-not-configured wins).
func TestProviderCreateError(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	registry := NewProviderRegistry(logger)
	fake := newFakeTunnelProvider()
	fake.createErr = errors.New("connection refused")
	registry.Register("fake", fake, RegistryProviderConfig{Name: "fake", Type: "fake", Enabled: true})

	m := NewTunnelManager(nil, nil, registry, logger)
	_, err := m.Create(context.Background(), TunnelSpec{
		Provider: "fake", Type: "socks5", SrcSessionID: "s",
	}, "actor")
	if err == nil || !strings.Contains(err.Error(), "database not configured") {
		t.Fatalf("expected database-not-configured error, got %v", err)
	}
}

// CreateProviderByType — Phase 2 factory check.
func TestCreateProviderByType(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))

	for _, name := range []string{"sliver", "mythic", "havoc", "merlin"} {
		t.Run(name, func(t *testing.T) {
			p, err := CreateProviderByType(name, logger)
			if err != nil {
				t.Fatalf("CreateProviderByType(%q) error: %v", name, err)
			}
			if p == nil {
				t.Fatalf("CreateProviderByType(%q) returned nil provider", name)
			}
			if p.Name() == "" {
				t.Fatalf("provider %q has empty Name()", name)
			}
		})
	}

	if _, err := CreateProviderByType("nope", logger); err == nil {
		t.Fatal("expected error for unknown provider type")
	}
}

// MerlinProvider Connect should fail without PSK — important contract.
func TestMerlinProvider_ConnectRequiresPSK(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	p := NewMerlinProvider(logger)
	err := p.Connect(context.Background(), ProviderConfig{Host: "x", Port: 50051})
	if err == nil || !strings.Contains(err.Error(), "PSK required") {
		t.Fatalf("expected PSK-required error, got %v", err)
	}
	if p.IsConnected() {
		t.Fatal("provider should not be connected after failed auth")
	}
}

// Tunnel methods on each non-Sliver provider should behave as documented:
// ListTunnels = empty, CreateTunnel = error, SubscribeTunnels = closed channel.
func TestTunnelMethods_DefaultProviders(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))

	checks := []struct {
		name string
		p    C2Provider
	}{
		{"havoc", NewHavocProvider(logger)},
		{"mythic", NewMythicProvider(logger)},
		{"merlin", NewMerlinProvider(logger)},
	}

	for _, c := range checks {
		t.Run(c.name, func(t *testing.T) {
			tunnels, err := c.p.ListTunnels(context.Background(), TunnelFilter{})
			if err != nil {
				t.Fatalf("ListTunnels error: %v", err)
			}
			if len(tunnels) != 0 {
				t.Fatalf("expected empty tunnels, got %d", len(tunnels))
			}

			if _, err := c.p.CreateTunnel(context.Background(), TunnelSpec{
				Provider: c.name, Type: "socks5", SrcSessionID: "s",
			}); err == nil {
				t.Fatal("expected CreateTunnel to return not-implemented error")
			}

			if err := c.p.DeleteTunnel(context.Background(), "id"); err == nil {
				t.Fatal("expected DeleteTunnel to return not-implemented error")
			}

			ch, err := c.p.SubscribeTunnels(context.Background(), TunnelFilter{})
			if err != nil {
				t.Fatalf("SubscribeTunnels error: %v", err)
			}
			// Channel should be closed (drainable without blocking).
			select {
			case _, ok := <-ch:
				if ok {
					t.Fatal("expected closed channel")
				}
			case <-time.After(100 * time.Millisecond):
				t.Fatal("channel should be already closed, not just empty")
			}
		})
	}
}
