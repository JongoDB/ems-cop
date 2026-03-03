package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"
)

// nifiIDPattern validates NiFi process group IDs (UUID format: 8-4-4-4-12).
var nifiIDPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// validateNiFiID checks that a NiFi resource ID matches the expected UUID format
// to prevent path injection attacks.
func validateNiFiID(id string) error {
	if !nifiIDPattern.MatchString(id) {
		return fmt.Errorf("invalid NiFi resource ID: must be UUID format (36-char hex with dashes)")
	}
	return nil
}

// ---------------------------------------------------------------------------
// NiFi REST API Client
// ---------------------------------------------------------------------------

// NiFiClient wraps the Apache NiFi REST API for flow management, provenance
// queries, and system diagnostics.
type NiFiClient struct {
	baseURL  string
	username string
	password string
	token    string    // JWT from NiFi /access/token
	tokenExp time.Time // when the current token expires
	client   *http.Client
	logger   *slog.Logger
	mu       sync.Mutex // protects token refresh
}

// NewNiFiClient creates a NiFi REST API client. The client authenticates
// lazily on the first request and refreshes its token automatically.
func NewNiFiClient(baseURL, username, password string, logger *slog.Logger) *NiFiClient {
	return &NiFiClient{
		baseURL:  baseURL,
		username: username,
		password: password,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		logger: logger,
	}
}

// ---------------------------------------------------------------------------
// NiFi API Types
// ---------------------------------------------------------------------------

// ProcessGroup represents a NiFi process group.
type ProcessGroup struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	RunningCount int    `json:"runningCount"`
	StoppedCount int    `json:"stoppedCount"`
	Status       string `json:"status"` // "RUNNING", "STOPPED"
}

// PGStatus holds the status metrics for a process group.
type PGStatus struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FlowFilesIn   int64  `json:"flowFilesIn"`
	FlowFilesOut  int64  `json:"flowFilesOut"`
	BytesIn       int64  `json:"bytesIn"`
	BytesOut      int64  `json:"bytesOut"`
	ActiveThreads int    `json:"activeThreadCount"`
	QueuedCount   int64  `json:"queuedCount"`
	QueuedBytes   int64  `json:"queuedContentSize"`
}

// ProvenanceQuery defines a request to query NiFi's data provenance.
type ProvenanceQuery struct {
	MaxResults  int               `json:"maxResults"`
	StartDate   string            `json:"startDate,omitempty"`
	EndDate     string            `json:"endDate,omitempty"`
	SearchTerms map[string]string `json:"searchTerms,omitempty"`
}

// ProvenanceResults contains the results of a provenance query.
type ProvenanceResults struct {
	ID       string            `json:"id"`
	Finished bool              `json:"finished"`
	Total    int               `json:"total"`
	Events   []ProvenanceEvent `json:"provenanceEvents"`
}

// ProvenanceEvent represents a single provenance event in NiFi.
type ProvenanceEvent struct {
	ID            string            `json:"id"`
	EventType     string            `json:"eventType"`
	Timestamp     string            `json:"timestamp"`
	ComponentID   string            `json:"componentId"`
	ComponentName string            `json:"componentName"`
	ComponentType string            `json:"componentType"`
	FlowFileUUID  string            `json:"flowFileUuid"`
	FileSize      int64             `json:"fileSize"`
	Attributes    map[string]string `json:"attributes"`
}

// SystemDiagnostics contains NiFi system health information.
type SystemDiagnostics struct {
	TotalThreads int    `json:"totalThreads"`
	HeapUsed     string `json:"usedHeap"`
	HeapMax      string `json:"maxHeap"`
	Uptime       string `json:"uptime"`
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// authenticate obtains a JWT token from NiFi's /access/token endpoint.
func (c *NiFiClient) authenticate() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.authenticateLocked()
}

// authenticateLocked performs the actual authentication. Caller must hold c.mu.
func (c *NiFiClient) authenticateLocked() error {
	form := url.Values{}
	form.Set("username", c.username)
	form.Set("password", c.password)

	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/access/token", bytes.NewBufferString(form.Encode()))
	if err != nil {
		return fmt.Errorf("build auth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("nifi auth request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("nifi auth failed: status %d, body %s", resp.StatusCode, string(body))
	}

	// NiFi returns the token as the raw response body text
	token := string(body)
	if token == "" {
		return fmt.Errorf("nifi auth returned empty token")
	}

	c.token = token
	// NiFi tokens typically expire in 12 hours; refresh proactively at 11h.
	c.tokenExp = time.Now().Add(11 * time.Hour)

	c.logger.Info("nifi authenticated successfully")
	return nil
}

// ensureToken refreshes the NiFi JWT if it has expired or is about to.
func (c *NiFiClient) ensureToken() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.token != "" && time.Now().Before(c.tokenExp) {
		return nil
	}
	return c.authenticateLocked()
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// doRequest performs an authenticated HTTP request against the NiFi API.
func (c *NiFiClient) doRequest(method, path string, body any) (*http.Response, error) {
	if err := c.ensureToken(); err != nil {
		return nil, fmt.Errorf("ensure token: %w", err)
	}

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}

	c.mu.Lock()
	req.Header.Set("Authorization", "Bearer "+c.token)
	c.mu.Unlock()

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	return c.client.Do(req)
}

// readJSON performs a request and decodes the JSON response into dest.
func (c *NiFiClient) readJSON(method, path string, body any, dest any) error {
	resp, err := c.doRequest(method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("nifi api %s %s: status %d, body %s", method, path, resp.StatusCode, string(respBody))
	}

	if dest != nil {
		if err := json.NewDecoder(resp.Body).Decode(dest); err != nil {
			return fmt.Errorf("decode response %s %s: %w", method, path, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Flow Management
// ---------------------------------------------------------------------------

// nifiFlowPGResponse is the NiFi API response for flow/process-groups/{id}.
type nifiFlowPGResponse struct {
	ProcessGroupFlow struct {
		ID   string `json:"id"`
		Flow struct {
			ProcessGroups []struct {
				ID        string `json:"id"`
				Component struct {
					ID           string `json:"id"`
					Name         string `json:"name"`
					RunningCount int    `json:"runningCount"`
					StoppedCount int    `json:"stoppedCount"`
				} `json:"component"`
				RunningCount int `json:"runningCount"`
				StoppedCount int `json:"stoppedCount"`
			} `json:"processGroups"`
		} `json:"flow"`
	} `json:"processGroupFlow"`
}

// nifiPGEntityResponse is the NiFi API response for process-groups/{id}.
type nifiPGEntityResponse struct {
	ID        string `json:"id"`
	Component struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"component"`
	RunningCount int `json:"runningCount"`
	StoppedCount int `json:"stoppedCount"`
	Status       struct {
		RunningCount int `json:"runningCount"`
		StoppedCount int `json:"stoppedCount"`
	} `json:"status"`
}

// nifiPGStatusResponse is the NiFi API response for flow/process-groups/{id}/status.
type nifiPGStatusResponse struct {
	ProcessGroupStatus struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		AggregateSnapshot struct {
			FlowFilesIn        int64  `json:"flowFilesIn"`
			FlowFilesOut       int64  `json:"flowFilesOut"`
			BytesIn            int64  `json:"bytesIn"`
			BytesOut           int64  `json:"bytesOut"`
			ActiveThreadCount  int    `json:"activeThreadCount"`
			Queued             string `json:"queued"`
			QueuedCount        int64
			QueuedContentSize  int64
		} `json:"aggregateSnapshot"`
	} `json:"processGroupStatus"`
}

// GetRootProcessGroup returns the root process group.
func (c *NiFiClient) GetRootProcessGroup() (*ProcessGroup, error) {
	var resp nifiFlowPGResponse
	if err := c.readJSON(http.MethodGet, "/flow/process-groups/root", nil, &resp); err != nil {
		return nil, fmt.Errorf("get root process group: %w", err)
	}

	pg := &ProcessGroup{
		ID:   resp.ProcessGroupFlow.ID,
		Name: "root",
	}

	// Aggregate counts from child process groups
	for _, child := range resp.ProcessGroupFlow.Flow.ProcessGroups {
		pg.RunningCount += child.RunningCount
		pg.StoppedCount += child.StoppedCount
	}

	if pg.StoppedCount == 0 && pg.RunningCount > 0 {
		pg.Status = "RUNNING"
	} else if pg.RunningCount == 0 {
		pg.Status = "STOPPED"
	} else {
		pg.Status = "RUNNING"
	}

	return pg, nil
}

// GetProcessGroup returns details for a specific process group.
func (c *NiFiClient) GetProcessGroup(id string) (*ProcessGroup, error) {
	if err := validateNiFiID(id); err != nil {
		return nil, err
	}
	var resp nifiPGEntityResponse
	if err := c.readJSON(http.MethodGet, "/process-groups/"+id, nil, &resp); err != nil {
		return nil, fmt.Errorf("get process group %s: %w", id, err)
	}

	pg := &ProcessGroup{
		ID:           resp.Component.ID,
		Name:         resp.Component.Name,
		RunningCount: resp.RunningCount,
		StoppedCount: resp.StoppedCount,
	}

	if pg.StoppedCount == 0 && pg.RunningCount > 0 {
		pg.Status = "RUNNING"
	} else if pg.RunningCount == 0 {
		pg.Status = "STOPPED"
	} else {
		pg.Status = "RUNNING"
	}

	return pg, nil
}

// StartProcessGroup sets a process group to RUNNING state.
func (c *NiFiClient) StartProcessGroup(id string) error {
	if err := validateNiFiID(id); err != nil {
		return err
	}
	body := map[string]any{
		"id":    id,
		"state": "RUNNING",
	}
	return c.readJSON(http.MethodPut, "/flow/process-groups/"+id, body, nil)
}

// StopProcessGroup sets a process group to STOPPED state.
func (c *NiFiClient) StopProcessGroup(id string) error {
	if err := validateNiFiID(id); err != nil {
		return err
	}
	body := map[string]any{
		"id":    id,
		"state": "STOPPED",
	}
	return c.readJSON(http.MethodPut, "/flow/process-groups/"+id, body, nil)
}

// GetProcessGroupStatus returns runtime status metrics for a process group.
func (c *NiFiClient) GetProcessGroupStatus(id string) (*PGStatus, error) {
	if err := validateNiFiID(id); err != nil {
		return nil, err
	}
	var resp nifiPGStatusResponse
	if err := c.readJSON(http.MethodGet, "/flow/process-groups/"+id+"/status", nil, &resp); err != nil {
		return nil, fmt.Errorf("get pg status %s: %w", id, err)
	}

	snap := resp.ProcessGroupStatus.AggregateSnapshot
	return &PGStatus{
		ID:            resp.ProcessGroupStatus.ID,
		Name:          resp.ProcessGroupStatus.Name,
		FlowFilesIn:   snap.FlowFilesIn,
		FlowFilesOut:  snap.FlowFilesOut,
		BytesIn:       snap.BytesIn,
		BytesOut:      snap.BytesOut,
		ActiveThreads: snap.ActiveThreadCount,
		QueuedCount:   snap.QueuedCount,
		QueuedBytes:   snap.QueuedContentSize,
	}, nil
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

// nifiProvenanceSubmitResponse wraps NiFi's POST /provenance response.
type nifiProvenanceSubmitResponse struct {
	Provenance struct {
		ID       string `json:"id"`
		Finished bool   `json:"finished"`
	} `json:"provenance"`
}

// nifiProvenanceResultsResponse wraps NiFi's GET /provenance/{id} response.
type nifiProvenanceResultsResponse struct {
	Provenance struct {
		ID       string `json:"id"`
		Finished bool   `json:"finished"`
		Results  struct {
			ProvenanceEvents []struct {
				ID            string            `json:"id"`
				EventType     string            `json:"eventType"`
				EventTime     string            `json:"eventTime"`
				ComponentID   string            `json:"componentId"`
				ComponentName string            `json:"componentName"`
				ComponentType string            `json:"componentType"`
				FlowFileUUID  string            `json:"flowFileUuid"`
				FileSize      string            `json:"fileSize"`
				FileSizeBytes int64             `json:"fileSizeBytes"`
				Attributes    []nifiAttribute   `json:"attributes"`
			} `json:"provenanceEvents"`
			TotalCount int `json:"totalCount"`
			Total      string `json:"total"`
		} `json:"results"`
	} `json:"provenance"`
}

type nifiAttribute struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// SubmitProvenanceQuery submits a provenance query and returns the query ID.
func (c *NiFiClient) SubmitProvenanceQuery(query ProvenanceQuery) (string, error) {
	body := map[string]any{
		"provenance": map[string]any{
			"request": map[string]any{
				"maxResults":  query.MaxResults,
				"startDate":   query.StartDate,
				"endDate":     query.EndDate,
				"searchTerms": query.SearchTerms,
			},
		},
	}

	var resp nifiProvenanceSubmitResponse
	if err := c.readJSON(http.MethodPost, "/provenance", body, &resp); err != nil {
		return "", fmt.Errorf("submit provenance query: %w", err)
	}

	return resp.Provenance.ID, nil
}

// GetProvenanceResults retrieves provenance query results by query ID.
func (c *NiFiClient) GetProvenanceResults(queryID string) (*ProvenanceResults, error) {
	var resp nifiProvenanceResultsResponse
	if err := c.readJSON(http.MethodGet, "/provenance/"+queryID, nil, &resp); err != nil {
		return nil, fmt.Errorf("get provenance results %s: %w", queryID, err)
	}

	results := &ProvenanceResults{
		ID:       resp.Provenance.ID,
		Finished: resp.Provenance.Finished,
		Total:    resp.Provenance.Results.TotalCount,
	}

	for _, e := range resp.Provenance.Results.ProvenanceEvents {
		attrs := make(map[string]string, len(e.Attributes))
		for _, a := range e.Attributes {
			attrs[a.Name] = a.Value
		}

		results.Events = append(results.Events, ProvenanceEvent{
			ID:            e.ID,
			EventType:     e.EventType,
			Timestamp:     e.EventTime,
			ComponentID:   e.ComponentID,
			ComponentName: e.ComponentName,
			ComponentType: e.ComponentType,
			FlowFileUUID:  e.FlowFileUUID,
			FileSize:      e.FileSizeBytes,
			Attributes:    attrs,
		})
	}

	return results, nil
}

// DeleteProvenanceQuery removes a completed provenance query from NiFi.
func (c *NiFiClient) DeleteProvenanceQuery(queryID string) error {
	resp, err := c.doRequest(http.MethodDelete, "/provenance/"+queryID, nil)
	if err != nil {
		return fmt.Errorf("delete provenance query %s: %w", queryID, err)
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("delete provenance %s: status %d", queryID, resp.StatusCode)
	}
	return nil
}

// ---------------------------------------------------------------------------
// System Diagnostics
// ---------------------------------------------------------------------------

// nifiSystemDiagResponse wraps NiFi's GET /system-diagnostics response.
type nifiSystemDiagResponse struct {
	SystemDiagnostics struct {
		AggregateSnapshot struct {
			TotalThreads          int    `json:"totalThreads"`
			UsedHeap              string `json:"usedHeap"`
			MaxHeap               string `json:"maxHeap"`
			Uptime                string `json:"uptime"`
		} `json:"aggregateSnapshot"`
	} `json:"systemDiagnostics"`
}

// GetSystemDiagnostics returns NiFi system diagnostics.
func (c *NiFiClient) GetSystemDiagnostics() (*SystemDiagnostics, error) {
	var resp nifiSystemDiagResponse
	if err := c.readJSON(http.MethodGet, "/system-diagnostics", nil, &resp); err != nil {
		return nil, fmt.Errorf("get system diagnostics: %w", err)
	}

	snap := resp.SystemDiagnostics.AggregateSnapshot
	return &SystemDiagnostics{
		TotalThreads: snap.TotalThreads,
		HeapUsed:     snap.UsedHeap,
		HeapMax:      snap.MaxHeap,
		Uptime:       snap.Uptime,
	}, nil
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

// IsHealthy returns true if NiFi is reachable and we have a valid token.
func (c *NiFiClient) IsHealthy() bool {
	if err := c.ensureToken(); err != nil {
		return false
	}

	resp, err := c.doRequest(http.MethodGet, "/flow/status", nil)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
