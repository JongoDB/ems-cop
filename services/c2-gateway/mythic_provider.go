// EMS-COP C2 Gateway — Mythic C2 Provider
// Implements the C2Provider interface for Mythic C2 Framework.
//
// Mythic exposes a Hasura GraphQL API (default port 7443) and a REST auth
// endpoint. This provider uses plain net/http with JSON payloads — no external
// GraphQL client dependency.
//
// API surface used:
//   POST /auth                      → authenticate, obtain JWT
//   POST /graphql (Hasura)          → query callbacks, payloads, tasks, C2 profiles
//
// Reference: https://docs.mythic-c2.net/
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Compile-time interface check.
var _ C2Provider = (*MythicProvider)(nil)

// MythicProvider implements C2Provider for Mythic C2 Framework.
type MythicProvider struct {
	name      string
	apiURL    string // e.g. "https://mythic-server:7443"
	username  string
	password  string
	token     string
	connected bool
	client    *http.Client
	mu        sync.RWMutex
	logger    *slog.Logger
}

// NewMythicProvider returns an uninitialised MythicProvider.
func NewMythicProvider(logger *slog.Logger) *MythicProvider {
	return &MythicProvider{
		name:   "mythic",
		logger: logger,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (p *MythicProvider) Name() string { return p.name }

func (p *MythicProvider) IsConnected() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.connected
}

// ────────────────────────────────────────────
// Connection
// ────────────────────────────────────────────

func (p *MythicProvider) Connect(ctx context.Context, config ProviderConfig) error {
	scheme := "https"
	if v, ok := config.Options["scheme"]; ok {
		scheme = v
	}
	port := config.Port
	if port == 0 {
		port = 7443
	}
	p.apiURL = fmt.Sprintf("%s://%s:%d", scheme, config.Host, port)

	p.username = config.Options["username"]
	p.password = config.Options["password"]

	if p.username == "" || p.password == "" {
		return fmt.Errorf("mythic: username and password required in Options")
	}

	token, err := p.authenticate(ctx)
	if err != nil {
		return fmt.Errorf("mythic auth: %w", err)
	}

	p.mu.Lock()
	p.token = token
	p.connected = true
	p.mu.Unlock()

	p.logger.Info("connected to mythic", "url", p.apiURL, "user", p.username)
	return nil
}

func (p *MythicProvider) Disconnect() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.token = ""
	p.connected = false
	p.logger.Info("disconnected from mythic")
	return nil
}

// authenticate performs POST /auth and returns the access token.
func (p *MythicProvider) authenticate(ctx context.Context) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"username": p.username,
		"password": p.password,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.apiURL+"/auth", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build auth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("auth request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("auth failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Status      string `json:"status"`
		AccessToken string `json:"access_token"`
		User        struct {
			ID int `json:"user_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode auth response: %w", err)
	}
	if result.AccessToken == "" {
		return "", fmt.Errorf("no access_token in auth response")
	}
	return result.AccessToken, nil
}

// ────────────────────────────────────────────
// GraphQL helpers
// ────────────────────────────────────────────

type graphQLRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables,omitempty"`
}

type graphQLResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors,omitempty"`
}

func (p *MythicProvider) graphql(ctx context.Context, gql graphQLRequest) (*graphQLResponse, error) {
	p.mu.RLock()
	token := p.token
	apiURL := p.apiURL
	p.mu.RUnlock()

	body, _ := json.Marshal(gql)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/graphql", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build graphql request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("graphql request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		p.mu.Lock()
		p.connected = false
		p.mu.Unlock()
		return nil, fmt.Errorf("mythic: authentication expired (401)")
	}

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("graphql failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var gqlResp graphQLResponse
	if err := json.NewDecoder(resp.Body).Decode(&gqlResp); err != nil {
		return nil, fmt.Errorf("decode graphql response: %w", err)
	}
	if len(gqlResp.Errors) > 0 {
		return nil, fmt.Errorf("graphql error: %s", gqlResp.Errors[0].Message)
	}
	return &gqlResp, nil
}

// ────────────────────────────────────────────
// Sessions (Mythic "callbacks")
// ────────────────────────────────────────────

func (p *MythicProvider) ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	query := `query ListCallbacks {
		callback(where: {active: {_eq: true}}, order_by: {id: desc}) {
			agent_callback_id
			host
			user
			ip
			os
			pid
			integrity_level
			last_checkin
			description
			payload {
				uuid
				payload_type {
					name
				}
			}
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{Query: query})
	if err != nil {
		return nil, fmt.Errorf("list callbacks: %w", err)
	}

	var data struct {
		Callback []struct {
			AgentCallbackID string `json:"agent_callback_id"`
			Host            string `json:"host"`
			User            string `json:"user"`
			IP              string `json:"ip"`
			OS              string `json:"os"`
			PID             int    `json:"pid"`
			IntegrityLevel  int    `json:"integrity_level"`
			LastCheckin     string `json:"last_checkin"`
			Description     string `json:"description"`
			Payload         struct {
				UUID        string `json:"uuid"`
				PayloadType struct {
					Name string `json:"name"`
				} `json:"payload_type"`
			} `json:"payload"`
		} `json:"callback"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("parse callbacks: %w", err)
	}

	sessions := make([]Session, 0, len(data.Callback))
	for _, cb := range data.Callback {
		lastMsg, _ := time.Parse(time.RFC3339Nano, cb.LastCheckin)
		sess := Session{
			ID:          cb.AgentCallbackID,
			ImplantID:   cb.Payload.UUID,
			Hostname:    cb.Host,
			OS:          cb.OS,
			RemoteAddr:  cb.IP,
			Transport:   cb.Payload.PayloadType.Name,
			IsAlive:     true, // query already filters active
			LastMessage: lastMsg,
		}
		if filter != nil {
			if filter.Hostname != "" && sess.Hostname != filter.Hostname {
				continue
			}
		}
		sessions = append(sessions, sess)
	}
	return sessions, nil
}

// ────────────────────────────────────────────
// Implants (Mythic "payloads")
// ────────────────────────────────────────────

func (p *MythicProvider) ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	query := `query ListPayloads {
		payload(where: {deleted: {_eq: false}}, order_by: {id: desc}) {
			uuid
			os
			description
			build_phase
			payload_type {
				name
			}
			filemetum {
				filename_text
				total_chunks
			}
			callbacks_aggregate {
				aggregate {
					count
				}
			}
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{Query: query})
	if err != nil {
		return nil, fmt.Errorf("list payloads: %w", err)
	}

	var data struct {
		Payload []struct {
			UUID        string `json:"uuid"`
			OS          string `json:"os"`
			Description string `json:"description"`
			BuildPhase  string `json:"build_phase"`
			PayloadType struct {
				Name string `json:"name"`
			} `json:"payload_type"`
			Filemetum struct {
				FilenameText string `json:"filename_text"`
				TotalChunks  int    `json:"total_chunks"`
			} `json:"filemetum"`
			CallbacksAggregate struct {
				Aggregate struct {
					Count int `json:"count"`
				} `json:"aggregate"`
			} `json:"callbacks_aggregate"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("parse payloads: %w", err)
	}

	implants := make([]Implant, 0, len(data.Payload))
	for _, pl := range data.Payload {
		status := "built"
		if pl.BuildPhase == "building" {
			status = "building"
		}
		if pl.CallbacksAggregate.Aggregate.Count > 0 {
			status = "active"
		}

		impl := Implant{
			ID:        pl.UUID,
			Name:      pl.Filemetum.FilenameText,
			OS:        pl.OS,
			Transport: pl.PayloadType.Name,
			Status:    status,
		}

		if filter != nil {
			if filter.OS != "" && impl.OS != filter.OS {
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

func (p *MythicProvider) GenerateImplant(ctx context.Context, spec ImplantSpec) (*ImplantBinary, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	// Mythic implant generation is a multi-step process:
	// 1. Create payload via GraphQL mutation
	// 2. Poll until build completes
	// 3. Download via REST
	// For now, create the payload build request.

	payloadType := spec.Transport
	if payloadType == "" {
		payloadType = "apollo" // default Mythic agent
	}

	mutation := `mutation CreatePayload($os: String!, $payloadType: String!, $description: String!) {
		createPayload(
			os: $os,
			payload_type: $payloadType,
			description: $description,
			c2_profiles: [],
			build_parameters: [],
			commands: [],
			filename: ""
		) {
			status
			error
			uuid
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{
		Query: mutation,
		Variables: map[string]any{
			"os":          spec.OS,
			"payloadType": payloadType,
			"description": fmt.Sprintf("EMS-COP generated: %s/%s %s", spec.OS, spec.Arch, spec.Format),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create payload: %w", err)
	}

	var data struct {
		CreatePayload struct {
			Status string `json:"status"`
			Error  string `json:"error"`
			UUID   string `json:"uuid"`
		} `json:"createPayload"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("parse create payload response: %w", err)
	}
	if data.CreatePayload.Error != "" {
		return nil, fmt.Errorf("mythic create payload error: %s", data.CreatePayload.Error)
	}

	payloadUUID := data.CreatePayload.UUID
	p.logger.Info("mythic payload build started", "uuid", payloadUUID)

	// Poll for build completion (up to 120s)
	pollQuery := `query GetPayload($uuid: String!) {
		payload(where: {uuid: {_eq: $uuid}}) {
			uuid
			build_phase
			filemetum {
				filename_text
				total_chunks
			}
		}
	}`

	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}

		pollResp, pollErr := p.graphql(ctx, graphQLRequest{
			Query:     pollQuery,
			Variables: map[string]any{"uuid": payloadUUID},
		})
		if pollErr != nil {
			continue
		}

		var pollData struct {
			Payload []struct {
				UUID       string `json:"uuid"`
				BuildPhase string `json:"build_phase"`
				Filemetum  struct {
					FilenameText string `json:"filename_text"`
					TotalChunks  int    `json:"total_chunks"`
				} `json:"filemetum"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(pollResp.Data, &pollData); err != nil {
			continue
		}
		if len(pollData.Payload) == 0 {
			continue
		}

		pl := pollData.Payload[0]
		if pl.BuildPhase == "success" {
			// Download the payload binary via REST
			binary, dlErr := p.downloadPayload(ctx, payloadUUID)
			if dlErr != nil {
				return nil, fmt.Errorf("download payload: %w", dlErr)
			}
			binary.Name = pl.Filemetum.FilenameText
			return binary, nil
		}
		if pl.BuildPhase == "error" {
			return nil, fmt.Errorf("mythic payload build failed for uuid %s", payloadUUID)
		}
	}

	return nil, fmt.Errorf("mythic payload build timed out for uuid %s", payloadUUID)
}

// downloadPayload fetches the built binary from Mythic's REST API.
func (p *MythicProvider) downloadPayload(ctx context.Context, uuid string) (*ImplantBinary, error) {
	p.mu.RLock()
	token := p.token
	apiURL := p.apiURL
	p.mu.RUnlock()

	dlURL := fmt.Sprintf("%s/api/v1.4/payloads/download/%s", apiURL, uuid)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dlURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("download failed (status %d): %s", resp.StatusCode, string(body))
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read payload body: %w", err)
	}

	return &ImplantBinary{
		Data: data,
		Size: int64(len(data)),
	}, nil
}

// ────────────────────────────────────────────
// Listeners (Mythic "C2 Profiles")
// ────────────────────────────────────────────

func (p *MythicProvider) ListListeners(ctx context.Context) ([]Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	query := `query ListC2Profiles {
		c2profile(order_by: {name: asc}) {
			id
			name
			is_p2p
			running
			description
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{Query: query})
	if err != nil {
		return nil, fmt.Errorf("list c2 profiles: %w", err)
	}

	var data struct {
		C2Profile []struct {
			ID          int    `json:"id"`
			Name        string `json:"name"`
			IsP2P       bool   `json:"is_p2p"`
			Running     bool   `json:"running"`
			Description string `json:"description"`
		} `json:"c2profile"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("parse c2 profiles: %w", err)
	}

	listeners := make([]Listener, 0, len(data.C2Profile))
	for _, cp := range data.C2Profile {
		protocol := cp.Name
		if cp.IsP2P {
			protocol = "p2p-" + cp.Name
		}
		listeners = append(listeners, Listener{
			ID:        fmt.Sprintf("%d", cp.ID),
			Protocol:  protocol,
			IsRunning: cp.Running,
		})
	}
	return listeners, nil
}

func (p *MythicProvider) CreateListener(ctx context.Context, spec ListenerSpec) (*Listener, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	// Mythic C2 profiles are started/stopped, not created dynamically in the same
	// way as Sliver listeners. Use the start_c2profile mutation.
	mutation := `mutation StartC2Profile($name: String!) {
		startC2Profile(c2_profile_name: $name) {
			status
			error
		}
	}`

	profileName := spec.Protocol
	if profileName == "" {
		profileName = "http"
	}

	resp, err := p.graphql(ctx, graphQLRequest{
		Query:     mutation,
		Variables: map[string]any{"name": profileName},
	})
	if err != nil {
		return nil, fmt.Errorf("start c2 profile: %w", err)
	}

	var data struct {
		StartC2Profile struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		} `json:"startC2Profile"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("parse start c2 profile response: %w", err)
	}
	if data.StartC2Profile.Error != "" {
		return nil, fmt.Errorf("mythic start profile error: %s", data.StartC2Profile.Error)
	}

	return &Listener{
		ID:        profileName,
		Protocol:  profileName,
		Host:      spec.Host,
		Port:      spec.Port,
		IsRunning: true,
	}, nil
}

func (p *MythicProvider) DeleteListener(ctx context.Context, listenerID string) error {
	if !p.IsConnected() {
		return fmt.Errorf("not connected to mythic")
	}

	mutation := `mutation StopC2Profile($name: String!) {
		stopC2Profile(c2_profile_name: $name) {
			status
			error
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{
		Query:     mutation,
		Variables: map[string]any{"name": listenerID},
	})
	if err != nil {
		return fmt.Errorf("stop c2 profile: %w", err)
	}

	var data struct {
		StopC2Profile struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		} `json:"stopC2Profile"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return fmt.Errorf("parse stop c2 profile response: %w", err)
	}
	if data.StopC2Profile.Error != "" {
		return fmt.Errorf("mythic stop profile error: %s", data.StopC2Profile.Error)
	}

	return nil
}

// ────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────

func (p *MythicProvider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	started := time.Now()

	// Build task parameters JSON from arguments
	paramsJSON := "{}"
	if task.Arguments != nil && len(task.Arguments) > 0 {
		b, _ := json.Marshal(task.Arguments)
		paramsJSON = string(b)
	}

	// Create a task via GraphQL mutation
	mutation := `mutation CreateTask($callbackId: String!, $command: String!, $params: String!) {
		createTask(
			callback_id: $callbackId,
			command: $command,
			params: $params
		) {
			status
			error
			id
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{
		Query: mutation,
		Variables: map[string]any{
			"callbackId": sessionID,
			"command":    task.Command,
			"params":     paramsJSON,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create task: %w", err)
	}

	var createData struct {
		CreateTask struct {
			Status string `json:"status"`
			Error  string `json:"error"`
			ID     int    `json:"id"`
		} `json:"createTask"`
	}
	if err := json.Unmarshal(resp.Data, &createData); err != nil {
		return nil, fmt.Errorf("parse create task response: %w", err)
	}
	if createData.CreateTask.Error != "" {
		return &TaskResult{
			TaskID:    fmt.Sprintf("%d", createData.CreateTask.ID),
			Command:   task.Command,
			Error:     createData.CreateTask.Error,
			StartedAt: started,
			EndedAt:   time.Now(),
		}, nil
	}

	taskID := createData.CreateTask.ID
	p.logger.Info("mythic task created", "task_id", taskID, "command", task.Command, "callback", sessionID)

	// Poll for task output (up to 120s)
	outputQuery := `query GetTaskOutput($taskId: Int!) {
		task_by_pk(id: $taskId) {
			id
			status
			completed
			responses(order_by: {id: asc}) {
				response_text
			}
		}
	}`

	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return &TaskResult{
				TaskID:    fmt.Sprintf("%d", taskID),
				Command:   task.Command,
				Error:     "context cancelled",
				StartedAt: started,
				EndedAt:   time.Now(),
			}, ctx.Err()
		case <-time.After(2 * time.Second):
		}

		pollResp, pollErr := p.graphql(ctx, graphQLRequest{
			Query:     outputQuery,
			Variables: map[string]any{"taskId": taskID},
		})
		if pollErr != nil {
			continue
		}

		var pollData struct {
			TaskByPk struct {
				ID        int    `json:"id"`
				Status    string `json:"status"`
				Completed bool   `json:"completed"`
				Responses []struct {
					ResponseText string `json:"response_text"`
				} `json:"responses"`
			} `json:"task_by_pk"`
		}
		if err := json.Unmarshal(pollResp.Data, &pollData); err != nil {
			continue
		}

		if pollData.TaskByPk.Completed || pollData.TaskByPk.Status == "completed" || pollData.TaskByPk.Status == "error" {
			var output string
			for _, r := range pollData.TaskByPk.Responses {
				if output != "" {
					output += "\n"
				}
				output += r.ResponseText
			}

			taskErr := ""
			if pollData.TaskByPk.Status == "error" {
				taskErr = "task failed"
				if output != "" {
					taskErr = output
					output = ""
				}
			}

			return &TaskResult{
				TaskID:    fmt.Sprintf("%d", taskID),
				Command:   task.Command,
				Output:    output,
				Error:     taskErr,
				StartedAt: started,
				EndedAt:   time.Now(),
			}, nil
		}
	}

	return &TaskResult{
		TaskID:    fmt.Sprintf("%d", taskID),
		Command:   task.Command,
		Error:     "task timed out waiting for output",
		StartedAt: started,
		EndedAt:   time.Now(),
	}, nil
}

func (p *MythicProvider) GetTaskHistory(ctx context.Context, sessionID string) ([]TaskResult, error) {
	if !p.IsConnected() {
		return nil, fmt.Errorf("not connected to mythic")
	}

	query := `query GetTaskHistory($callbackId: String!) {
		task(where: {callback: {agent_callback_id: {_eq: $callbackId}}}, order_by: {id: desc}, limit: 50) {
			id
			command_name
			original_params
			status
			completed
			timestamp
			responses(order_by: {id: asc}) {
				response_text
			}
		}
	}`

	resp, err := p.graphql(ctx, graphQLRequest{
		Query:     query,
		Variables: map[string]any{"callbackId": sessionID},
	})
	if err != nil {
		return nil, fmt.Errorf("get task history: %w", err)
	}

	var data struct {
		Task []struct {
			ID             int    `json:"id"`
			CommandName    string `json:"command_name"`
			OriginalParams string `json:"original_params"`
			Status         string `json:"status"`
			Completed      bool   `json:"completed"`
			Timestamp      string `json:"timestamp"`
			Responses      []struct {
				ResponseText string `json:"response_text"`
			} `json:"responses"`
		} `json:"task"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("parse task history: %w", err)
	}

	results := make([]TaskResult, 0, len(data.Task))
	for _, t := range data.Task {
		var output string
		for _, r := range t.Responses {
			if output != "" {
				output += "\n"
			}
			output += r.ResponseText
		}
		ts, _ := time.Parse(time.RFC3339Nano, t.Timestamp)
		taskErr := ""
		if t.Status == "error" {
			taskErr = output
			output = ""
		}
		results = append(results, TaskResult{
			TaskID:    fmt.Sprintf("%d", t.ID),
			Command:   t.CommandName,
			Output:    output,
			Error:     taskErr,
			StartedAt: ts,
			EndedAt:   ts,
		})
	}
	return results, nil
}

// ────────────────────────────────────────────
// OpenSession — Mythic does not support interactive PTY
// ────────────────────────────────────────────

func (p *MythicProvider) OpenSession(_ context.Context, _ string) (SessionStream, error) {
	return nil, fmt.Errorf("mythic: interactive shell sessions are not supported — use ExecuteTask with the 'shell' command instead")
}

// ────────────────────────────────────────────
// Telemetry — not yet implemented
// ────────────────────────────────────────────

func (p *MythicProvider) SubscribeTelemetry(_ context.Context, _ *TelemetryFilter) (<-chan TelemetryEvent, error) {
	ch := make(chan TelemetryEvent)
	// Mythic telemetry subscription via WebSocket/eventing is possible but not
	// implemented yet. Return an open (but empty) channel.
	return ch, nil
}
