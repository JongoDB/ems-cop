// EMS-COP C2 Gateway — Havoc C2 Provider
// Implements the C2Provider interface for Havoc C2 Framework.
//
// Havoc exposes a REST API (default port 40056) for managing demons (agents),
// listeners, and tasks.
//
// API surface used:
//   POST /api/login                → authenticate, obtain token
//   GET  /api/demons               → list active agents
//   POST /api/demons/{id}/command  → queue task on agent
//   GET  /api/listeners            → list listeners
//   POST /api/listeners            → create listener
//   DELETE /api/listeners/{id}     → remove listener
//
// Reference: https://havocframework.com/docs/
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Compile-time interface check.
var _ C2Provider = (*HavocProvider)(nil)

// HavocProvider implements C2Provider for Havoc C2 Framework.
type HavocProvider struct {
	name      string
	apiURL    string // e.g. "https://havoc-server:40056"
	username  string
	password  string
	token     string
	connected bool
	client    *http.Client
	mu        sync.RWMutex
	logger    *slog.Logger
}

// NewHavocProvider returns an uninitialised HavocProvider.
func NewHavocProvider(logger *slog.Logger) *HavocProvider {
	return &HavocProvider{
		name:   "havoc",
		logger: logger,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (p *HavocProvider) Name() string { return p.name }

func (p *HavocProvider) IsConnected() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.connected
}

// ────────────────────────────────────────────
// Connection
// ────────────────────────────────────────────

func (p *HavocProvider) Connect(ctx context.Context, config ProviderConfig) error {
	scheme := "https"
	if v, ok := config.Options["scheme"]; ok {
		scheme = v
	}
	port := config.Port
	if port == 0 {
		port = 40056
	}
	p.apiURL = fmt.Sprintf("%s://%s:%d", scheme, config.Host, port)

	p.username = config.Options["username"]
	p.password = config.Options["password"]

	if p.username == "" || p.password == "" {
		return fmt.Errorf("havoc: username and password required in Options")
	}

	token, err := p.authenticate(ctx)
	if err != nil {
		return fmt.Errorf("havoc auth: %w", err)
	}

	p.mu.Lock()
	p.token = token
	p.connected = true
	p.mu.Unlock()

	p.logger.Info("connected to havoc", "url", p.apiURL, "user", p.username)
	return nil
}

func (p *HavocProvider) Disconnect() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.token = ""
	p.connected = false
	p.logger.Info("disconnected from havoc")
	return nil
}

// authenticate performs POST /api/login and returns a session token.
func (p *HavocProvider) authenticate(ctx context.Context) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"username": p.username,
		"password": p.password,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.apiURL+"/api/login", bytes.NewReader(body))
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
// HTTP helpers
// ────────────────────────────────────────────

// doRequest performs an authenticated HTTP request against the Havoc API.
func (p *HavocProvider) doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	p.mu.RLock()
	token := p.token
	apiURL := p.apiURL
	p.mu.RUnlock()

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, apiURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		p.mu.Lock()
		p.connected = false
		p.mu.Unlock()
		return nil, fmt.Errorf("havoc: authentication expired (401)")
	}

	return resp, nil
}

// readJSON reads and decodes a JSON response body, closing the body afterward.
func readJSON(resp *http.Response, v interface{}) error {
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("request failed (status %d): %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// ────────────────────────────────────────────
// Sessions (Havoc "demons")
// ────────────────────────────────────────────

func (p *HavocProvider) ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	resp, err := p.doRequest(ctx, http.MethodGet, "/api/demons", nil)
	if err != nil {
		return nil, fmt.Errorf("list demons: %w", err)
	}

	var data struct {
		Demons []struct {
			DemonID    string `json:"demon_id"`
			InternalIP string `json:"internal_ip"`
			ExternalIP string `json:"external_ip"`
			Hostname   string `json:"hostname"`
			Username   string `json:"username"`
			OS         string `json:"os"`
			OSVersion  string `json:"os_version"`
			OSArch     string `json:"os_arch"`
			ProcessID  int    `json:"process_id"`
			ProcessName string `json:"process_name"`
			LastSeen   string `json:"last_seen"`
			Alive      bool   `json:"alive"`
			Listener   string `json:"listener"`
		} `json:"demons"`
	}
	if err := readJSON(resp, &data); err != nil {
		return nil, fmt.Errorf("parse demons: %w", err)
	}

	sessions := make([]Session, 0, len(data.Demons))
	for _, d := range data.Demons {
		lastMsg, _ := time.Parse(time.RFC3339Nano, d.LastSeen)
		remoteAddr := d.ExternalIP
		if remoteAddr == "" {
			remoteAddr = d.InternalIP
		}

		sess := Session{
			ID:          d.DemonID,
			ImplantID:   d.DemonID,
			Hostname:    d.Hostname,
			OS:          d.OS,
			RemoteAddr:  remoteAddr,
			Transport:   d.Listener,
			IsAlive:     d.Alive,
			LastMessage: lastMsg,
		}

		if filter != nil {
			if filter.Hostname != "" && sess.Hostname != filter.Hostname {
				continue
			}
			if filter.IsAlive != nil && sess.IsAlive != *filter.IsAlive {
				continue
			}
		}
		sessions = append(sessions, sess)
	}
	return sessions, nil
}

// ────────────────────────────────────────────
// Implants (Havoc payloads)
// ────────────────────────────────────────────

func (p *HavocProvider) ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	resp, err := p.doRequest(ctx, http.MethodGet, "/api/payloads", nil)
	if err != nil {
		return nil, fmt.Errorf("list payloads: %w", err)
	}

	var data struct {
		Payloads []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			OS        string `json:"os"`
			Arch      string `json:"arch"`
			Format    string `json:"format"`
			Listener  string `json:"listener"`
			CreatedAt string `json:"created_at"`
		} `json:"payloads"`
	}
	if err := readJSON(resp, &data); err != nil {
		return nil, fmt.Errorf("parse payloads: %w", err)
	}

	implants := make([]Implant, 0, len(data.Payloads))
	for _, pl := range data.Payloads {
		impl := Implant{
			ID:        pl.ID,
			Name:      pl.Name,
			OS:        pl.OS,
			Arch:      pl.Arch,
			Transport: pl.Listener,
			Status:    "built",
		}
		if filter != nil {
			if filter.OS != "" && impl.OS != filter.OS {
				continue
			}
			if filter.Arch != "" && impl.Arch != filter.Arch {
				continue
			}
			if filter.Status != "" && impl.Status != filter.Status {
				continue
			}
		}
		implants = append(implants, impl)
	}
	return implants, nil
}

func (p *HavocProvider) GenerateImplant(ctx context.Context, spec ImplantSpec) (*ImplantBinary, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	// Havoc generates "Demon" payloads via the REST API.
	genReq := map[string]interface{}{
		"os":       spec.OS,
		"arch":     spec.Arch,
		"format":   spec.Format,
		"listener": spec.Transport,
		"options": map[string]interface{}{
			"sleep":  5,
			"jitter": 30,
		},
	}

	resp, err := p.doRequest(ctx, http.MethodPost, "/api/payloads/generate", genReq)
	if err != nil {
		return nil, fmt.Errorf("generate payload: %w", err)
	}
	defer resp.Body.Close()

	// Havoc returns the binary directly in the response body for successful builds,
	// or a JSON error.
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") {
		// Probably an error response
		var errResp struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return nil, fmt.Errorf("havoc generate error: %s", errResp.Error)
		}
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read payload body: %w", err)
	}

	name := fmt.Sprintf("demon_%s_%s.%s", spec.OS, spec.Arch, spec.Format)
	if spec.Format == "exe" || spec.Format == "" {
		name = fmt.Sprintf("demon_%s_%s.exe", spec.OS, spec.Arch)
	}

	return &ImplantBinary{
		Name: name,
		Data: data,
		Size: int64(len(data)),
	}, nil
}

// ────────────────────────────────────────────
// Listeners
// ────────────────────────────────────────────

func (p *HavocProvider) ListListeners(ctx context.Context) ([]Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	resp, err := p.doRequest(ctx, http.MethodGet, "/api/listeners", nil)
	if err != nil {
		return nil, fmt.Errorf("list listeners: %w", err)
	}

	var data struct {
		Listeners []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Protocol string `json:"protocol"` // "http", "https", "smb", "tcp"
			Host     string `json:"host"`
			Port     int    `json:"port"`
			Status   string `json:"status"` // "running", "stopped"
		} `json:"listeners"`
	}
	if err := readJSON(resp, &data); err != nil {
		return nil, fmt.Errorf("parse listeners: %w", err)
	}

	listeners := make([]Listener, 0, len(data.Listeners))
	for _, l := range data.Listeners {
		listeners = append(listeners, Listener{
			ID:        l.ID,
			Protocol:  l.Protocol,
			Host:      l.Host,
			Port:      l.Port,
			IsRunning: l.Status == "running",
		})
	}
	return listeners, nil
}

func (p *HavocProvider) CreateListener(ctx context.Context, spec ListenerSpec) (*Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	protocol := spec.Protocol
	if protocol == "" {
		protocol = "https"
	}
	host := spec.Host
	if host == "" {
		host = "0.0.0.0"
	}
	port := spec.Port
	if port == 0 {
		port = 443
	}

	reqBody := map[string]interface{}{
		"name":     fmt.Sprintf("%s-%d", protocol, port),
		"protocol": protocol,
		"host":     host,
		"port":     port,
	}

	resp, err := p.doRequest(ctx, http.MethodPost, "/api/listeners", reqBody)
	if err != nil {
		return nil, fmt.Errorf("create listener: %w", err)
	}

	var data struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Error  string `json:"error"`
		Status string `json:"status"`
	}
	if err := readJSON(resp, &data); err != nil {
		return nil, fmt.Errorf("parse create listener response: %w", err)
	}
	if data.Error != "" {
		return nil, fmt.Errorf("havoc create listener error: %s", data.Error)
	}

	return &Listener{
		ID:        data.ID,
		Protocol:  protocol,
		Host:      host,
		Port:      port,
		IsRunning: true,
	}, nil
}

func (p *HavocProvider) DeleteListener(ctx context.Context, listenerID string) error {
	if !p.IsConnected() {
		return fmt.Errorf("not connected to havoc")
	}

	resp, err := p.doRequest(ctx, http.MethodDelete, "/api/listeners/"+listenerID, nil)
	if err != nil {
		return fmt.Errorf("delete listener: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("delete listener failed (status %d): %s", resp.StatusCode, string(body))
	}
	return nil
}

// ────────────────────────────────────────────
// Tasks (Havoc commands)
// ────────────────────────────────────────────

func (p *HavocProvider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	started := time.Now()

	// Build arguments string from task args
	argsStr := ""
	if task.Arguments != nil {
		if raw, ok := task.Arguments["raw"].(string); ok {
			argsStr = raw
		} else if path, ok := task.Arguments["path"].(string); ok {
			argsStr = path
		}
	}

	cmdReq := map[string]interface{}{
		"command":   task.Command,
		"arguments": argsStr,
	}

	resp, err := p.doRequest(ctx, http.MethodPost, fmt.Sprintf("/api/demons/%s/command", sessionID), cmdReq)
	if err != nil {
		return nil, fmt.Errorf("execute command: %w", err)
	}

	var cmdResp struct {
		TaskID string `json:"task_id"`
		Error  string `json:"error"`
	}
	if err := readJSON(resp, &cmdResp); err != nil {
		return nil, fmt.Errorf("parse command response: %w", err)
	}
	if cmdResp.Error != "" {
		return &TaskResult{
			TaskID:    cmdResp.TaskID,
			Command:   task.Command,
			Error:     cmdResp.Error,
			StartedAt: started,
			EndedAt:   time.Now(),
		}, nil
	}

	taskID := cmdResp.TaskID
	p.logger.Info("havoc task created", "task_id", taskID, "command", task.Command, "demon", sessionID)

	// Poll for task output (up to 120s)
	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return &TaskResult{
				TaskID:    taskID,
				Command:   task.Command,
				Error:     "context cancelled",
				StartedAt: started,
				EndedAt:   time.Now(),
			}, ctx.Err()
		case <-time.After(2 * time.Second):
		}

		pollResp, pollErr := p.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/demons/%s/tasks/%s", sessionID, taskID), nil)
		if pollErr != nil {
			continue
		}

		var pollData struct {
			TaskID    string `json:"task_id"`
			Status    string `json:"status"` // "pending", "running", "completed", "error"
			Output    string `json:"output"`
			Error     string `json:"error"`
			Completed bool   `json:"completed"`
		}
		if err := readJSON(pollResp, &pollData); err != nil {
			continue
		}

		if pollData.Completed || pollData.Status == "completed" || pollData.Status == "error" {
			return &TaskResult{
				TaskID:    taskID,
				Command:   task.Command,
				Output:    pollData.Output,
				Error:     pollData.Error,
				StartedAt: started,
				EndedAt:   time.Now(),
			}, nil
		}
	}

	return &TaskResult{
		TaskID:    taskID,
		Command:   task.Command,
		Error:     "task timed out waiting for output",
		StartedAt: started,
		EndedAt:   time.Now(),
	}, nil
}

func (p *HavocProvider) GetTaskHistory(ctx context.Context, sessionID string) ([]TaskResult, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to havoc")
	}

	resp, err := p.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/demons/%s/tasks", sessionID), nil)
	if err != nil {
		return nil, fmt.Errorf("get task history: %w", err)
	}

	var data struct {
		Tasks []struct {
			TaskID    string `json:"task_id"`
			Command   string `json:"command"`
			Output    string `json:"output"`
			Error     string `json:"error"`
			Status    string `json:"status"`
			CreatedAt string `json:"created_at"`
		} `json:"tasks"`
	}
	if err := readJSON(resp, &data); err != nil {
		return nil, fmt.Errorf("parse task history: %w", err)
	}

	results := make([]TaskResult, 0, len(data.Tasks))
	for _, t := range data.Tasks {
		ts, _ := time.Parse(time.RFC3339Nano, t.CreatedAt)
		results = append(results, TaskResult{
			TaskID:    t.TaskID,
			Command:   t.Command,
			Output:    t.Output,
			Error:     t.Error,
			StartedAt: ts,
			EndedAt:   ts,
		})
	}
	return results, nil
}

// ────────────────────────────────────────────
// OpenSession — Havoc interactive shell
// ────────────────────────────────────────────

// OpenSession returns an error because Havoc's Demon agent does not support
// bidirectional interactive shell tunnelling via the REST API. Commands should
// be issued through ExecuteTask with the "shell" command.
func (p *HavocProvider) OpenSession(_ context.Context, _ string) (SessionStream, error) {
	return nil, fmt.Errorf("havoc: interactive shell sessions are not supported via REST API — use ExecuteTask with the 'shell' command instead")
}

// ────────────────────────────────────────────
// Telemetry — not yet implemented
// ────────────────────────────────────────────

func (p *HavocProvider) SubscribeTelemetry(_ context.Context, _ *TelemetryFilter) (<-chan TelemetryEvent, error) {
	ch := make(chan TelemetryEvent)
	// Havoc telemetry subscription via WebSocket events is possible but not
	// implemented yet. Return an open (but empty) channel.
	return ch, nil
}
