// EMS-COP C2 Gateway — Provider Registry
// Manages multiple C2 backend connections with per-operation provider selection
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
)

// RegistryProviderConfig extends ProviderConfig with registry-specific metadata.
// The embedded ProviderConfig carries host/port/cert/options used by Connect().
type RegistryProviderConfig struct {
	Name       string            `json:"name"`
	Type       string            `json:"type"` // "sliver", "mythic", "havoc"
	Host       string            `json:"host"`
	Port       int               `json:"port"`
	AuthConfig map[string]string `json:"-"`         // never serialize credentials
	AuthType   string            `json:"auth_type"` // "operator_config", "username_password", "api_key", etc.
	Mode       string            `json:"mode"`      // "docker" or "external"
	Enabled    bool              `json:"enabled"`
}

// SafeConfig returns a sanitised representation of the provider config
// that intentionally omits credential material from AuthConfig.
func (c RegistryProviderConfig) SafeConfig() map[string]any {
	return map[string]any{
		"name":      c.Name,
		"type":      c.Type,
		"host":      c.Host,
		"port":      c.Port,
		"mode":      c.Mode,
		"enabled":   c.Enabled,
		"auth_type": c.AuthType,
		// auth_config intentionally omitted
	}
}

// ProviderStatus summarises a registered provider for the REST API.
type ProviderStatus struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Mode      string `json:"mode"`
	Enabled   bool   `json:"enabled"`
	Connected bool   `json:"connected"`
}

// ProviderRegistry manages multiple C2 backend connections.
// It is safe for concurrent use.
type ProviderRegistry struct {
	providers map[string]C2Provider
	configs   map[string]RegistryProviderConfig
	mu        sync.RWMutex
	logger    *slog.Logger
}

// NewProviderRegistry creates an empty registry.
func NewProviderRegistry(logger *slog.Logger) *ProviderRegistry {
	return &ProviderRegistry{
		providers: make(map[string]C2Provider),
		configs:   make(map[string]RegistryProviderConfig),
		logger:    logger,
	}
}

// Register adds a provider under the given name.
// If a provider with the same name already exists it is replaced (the old one
// is disconnected first).
func (r *ProviderRegistry) Register(name string, provider C2Provider, cfg RegistryProviderConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if old, exists := r.providers[name]; exists {
		r.logger.Info("replacing existing provider", "name", name)
		_ = old.Disconnect()
	}

	r.providers[name] = provider
	r.configs[name] = cfg
	r.logger.Info("provider registered", "name", name, "type", cfg.Type, "mode", cfg.Mode)
}

// Get returns the provider registered under name, or nil.
func (r *ProviderRegistry) Get(name string) C2Provider {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.providers[name]
}

// GetConfig returns the registry config for the named provider, if any.
func (r *ProviderRegistry) GetConfig(name string) (RegistryProviderConfig, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	cfg, ok := r.configs[name]
	return cfg, ok
}

// List returns status information for every registered provider.
func (r *ProviderRegistry) List() []ProviderStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]ProviderStatus, 0, len(r.providers))
	for name, p := range r.providers {
		cfg := r.configs[name]
		out = append(out, ProviderStatus{
			Name:      name,
			Type:      cfg.Type,
			Mode:      cfg.Mode,
			Enabled:   cfg.Enabled,
			Connected: p.IsConnected(),
		})
	}
	return out
}

// Remove disconnects and de-registers a provider. Returns an error if the name
// is not found.
func (r *ProviderRegistry) Remove(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	p, ok := r.providers[name]
	if !ok {
		return fmt.Errorf("provider %q not found", name)
	}
	if err := p.Disconnect(); err != nil {
		r.logger.Warn("error disconnecting provider during removal", "name", name, "error", err)
	}
	delete(r.providers, name)
	delete(r.configs, name)
	r.logger.Info("provider removed", "name", name)
	return nil
}

// ConnectAll attempts to connect every enabled provider that is not yet
// connected. Errors are logged but do not stop other providers from connecting.
func (r *ProviderRegistry) ConnectAll(ctx context.Context) {
	r.mu.RLock()
	names := make([]string, 0, len(r.providers))
	for n := range r.providers {
		names = append(names, n)
	}
	r.mu.RUnlock()

	for _, name := range names {
		r.mu.RLock()
		p := r.providers[name]
		cfg := r.configs[name]
		r.mu.RUnlock()

		if !cfg.Enabled {
			r.logger.Info("skipping disabled provider", "name", name)
			continue
		}
		if p.IsConnected() {
			continue
		}

		provCfg := ProviderConfig{
			Host:    cfg.Host,
			Port:    cfg.Port,
			Options: cfg.AuthConfig,
		}

		r.logger.Info("connecting provider", "name", name, "type", cfg.Type)
		if err := p.Connect(ctx, provCfg); err != nil {
			r.logger.Error("failed to connect provider", "name", name, "error", err)
		} else {
			r.logger.Info("provider connected", "name", name)
		}
	}
}

// DisconnectAll gracefully disconnects every registered provider.
func (r *ProviderRegistry) DisconnectAll() {
	r.mu.RLock()
	names := make([]string, 0, len(r.providers))
	for n := range r.providers {
		names = append(names, n)
	}
	r.mu.RUnlock()

	for _, name := range names {
		r.mu.RLock()
		p := r.providers[name]
		r.mu.RUnlock()

		r.logger.Info("disconnecting provider", "name", name)
		if err := p.Disconnect(); err != nil {
			r.logger.Warn("error disconnecting provider", "name", name, "error", err)
		}
	}
}

// CreateProviderByType is a factory that instantiates the correct provider
// struct for the given type string ("sliver", "mythic", "havoc").
func CreateProviderByType(providerType string, logger *slog.Logger) (C2Provider, error) {
	switch providerType {
	case "sliver":
		return NewSliverProvider(logger), nil
	case "mythic":
		return NewMythicProvider(logger), nil
	case "havoc":
		return NewHavocProvider(logger), nil
	default:
		return nil, fmt.Errorf("unknown provider type: %s", providerType)
	}
}

// MarshalRegistryConfig serialises the config to JSON (for persistence / API).
func MarshalRegistryConfig(cfg RegistryProviderConfig) ([]byte, error) {
	return json.Marshal(cfg)
}
