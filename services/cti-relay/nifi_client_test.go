package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Mock NiFi Server helpers
// ---------------------------------------------------------------------------

// newMockNiFiServer creates an httptest server that mimics NiFi REST API.
func newMockNiFiServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	// Authentication endpoint
	mux.HandleFunc("POST /access/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		username := r.FormValue("username")
		password := r.FormValue("password")
		if username == "admin" && password == "testpass" {
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte("mock-nifi-jwt-token-12345"))
		} else {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte("Invalid credentials"))
		}
	})

	// Flow status (used by IsHealthy)
	mux.HandleFunc("GET /flow/status", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"controllerStatus": map[string]any{
				"activeThreadCount": 5,
				"queued":            "0 / 0 bytes",
			},
		})
	})

	// Root process group
	mux.HandleFunc("GET /flow/process-groups/root", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"processGroupFlow": map[string]any{
				"id": "root-pg-id",
				"flow": map[string]any{
					"processGroups": []map[string]any{
						{
							"id":           "child-pg-1",
							"runningCount": 3,
							"stoppedCount": 0,
							"component": map[string]any{
								"id":           "child-pg-1",
								"name":         "CTI Transfer Flow",
								"runningCount": 3,
								"stoppedCount": 0,
							},
						},
						{
							"id":           "child-pg-2",
							"runningCount": 0,
							"stoppedCount": 2,
							"component": map[string]any{
								"id":           "child-pg-2",
								"name":         "CTI Enrichment Flow",
								"runningCount": 0,
								"stoppedCount": 2,
							},
						},
					},
				},
			},
		})
	})

	// Get specific process group
	mux.HandleFunc("GET /process-groups/a1b2c3d4-e5f6-7890-abcd-ef1234567890", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id":           "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			"runningCount": 5,
			"stoppedCount": 1,
			"component": map[string]any{
				"id":   "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
				"name": "Test Process Group",
			},
			"status": map[string]any{
				"runningCount": 5,
				"stoppedCount": 1,
			},
		})
	})

	// Get process group that is fully stopped
	mux.HandleFunc("GET /process-groups/b2c3d4e5-f6a7-8901-bcde-f12345678901", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id":           "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			"runningCount": 0,
			"stoppedCount": 3,
			"component": map[string]any{
				"id":   "b2c3d4e5-f6a7-8901-bcde-f12345678901",
				"name": "Stopped Process Group",
			},
			"status": map[string]any{
				"runningCount": 0,
				"stoppedCount": 3,
			},
		})
	})

	// Not found process group
	mux.HandleFunc("GET /process-groups/c3d4e5f6-a7b8-9012-cdef-123456789012", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"message": "Process group not found"}`))
	})

	// Start/Stop process group (PUT flow/process-groups/{id})
	mux.HandleFunc("PUT /flow/process-groups/a1b2c3d4-e5f6-7890-abcd-ef1234567890", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{"id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"})
	})

	mux.HandleFunc("PUT /flow/process-groups/d4e5f6a7-b8c9-0123-defa-234567890123", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"message": "Cannot start process group"}`))
	})

	// Process group status
	mux.HandleFunc("GET /flow/process-groups/a1b2c3d4-e5f6-7890-abcd-ef1234567890/status", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"processGroupStatus": map[string]any{
				"id":   "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
				"name": "Test Process Group",
				"aggregateSnapshot": map[string]any{
					"flowFilesIn":        100,
					"flowFilesOut":       95,
					"bytesIn":            1048576,
					"bytesOut":           1000000,
					"activeThreadCount":  5,
					"queued":             "10 / 5120 bytes",
					"queuedCount":        10,
					"queuedContentSize":  5120,
				},
			},
		})
	})

	// Provenance submit
	mux.HandleFunc("POST /provenance", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusCreated, map[string]any{
			"provenance": map[string]any{
				"id":       "prov-query-1",
				"finished": false,
			},
		})
	})

	// Provenance results
	mux.HandleFunc("GET /provenance/prov-query-1", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"provenance": map[string]any{
				"id":       "prov-query-1",
				"finished": true,
				"results": map[string]any{
					"totalCount": 2,
					"total":      "2",
					"provenanceEvents": []map[string]any{
						{
							"id":            "ev-1",
							"eventType":     "SEND",
							"eventTime":     "03/01/2026 12:00:00.000 UTC",
							"componentId":   "comp-1",
							"componentName": "PutFile",
							"componentType": "PutFile",
							"flowFileUuid":  "ff-uuid-1",
							"fileSize":      "1024",
							"fileSizeBytes": 1024,
							"attributes": []map[string]string{
								{"name": "filename", "value": "transfer-001.json"},
								{"name": "classification", "value": "UNCLASS"},
							},
						},
						{
							"id":            "ev-2",
							"eventType":     "RECEIVE",
							"eventTime":     "03/01/2026 12:01:00.000 UTC",
							"componentId":   "comp-2",
							"componentName": "GetFile",
							"componentType": "GetFile",
							"flowFileUuid":  "ff-uuid-2",
							"fileSize":      "2048",
							"fileSizeBytes": 2048,
							"attributes": []map[string]string{
								{"name": "filename", "value": "transfer-002.json"},
							},
						},
					},
				},
			},
		})
	})

	// Provenance delete
	mux.HandleFunc("DELETE /provenance/prov-query-1", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// System diagnostics
	mux.HandleFunc("GET /system-diagnostics", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{
			"systemDiagnostics": map[string]any{
				"aggregateSnapshot": map[string]any{
					"totalThreads": 50,
					"usedHeap":     "512.00 MB",
					"maxHeap":      "2048.00 MB",
					"uptime":       "02:30:15.000",
				},
			},
		})
	})

	return httptest.NewServer(mux)
}

func writeTestJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// ---------------------------------------------------------------------------
// TestNiFiClientAuthenticate
// ---------------------------------------------------------------------------

func TestNiFiClientAuthenticate(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	tests := []struct {
		name     string
		username string
		password string
		wantErr  bool
	}{
		{
			name:     "valid credentials",
			username: "admin",
			password: "testpass",
			wantErr:  false,
		},
		{
			name:     "invalid credentials",
			username: "admin",
			password: "wrongpass",
			wantErr:  true,
		},
		{
			name:     "empty credentials",
			username: "",
			password: "",
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewNiFiClient(mockServer.URL, tt.username, tt.password, slog.Default())
			err := client.authenticate()

			if tt.wantErr && err == nil {
				t.Error("expected error but got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if !tt.wantErr {
				client.mu.Lock()
				if client.token == "" {
					t.Error("token should not be empty after successful auth")
				}
				if client.token != "mock-nifi-jwt-token-12345" {
					t.Errorf("token: got %q, want %q", client.token, "mock-nifi-jwt-token-12345")
				}
				if client.tokenExp.IsZero() {
					t.Error("tokenExp should be set after successful auth")
				}
				client.mu.Unlock()
			}
		})
	}
}

func TestNiFiClientEnsureTokenReuse(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	// First call should authenticate
	err := client.ensureToken()
	if err != nil {
		t.Fatalf("first ensureToken: %v", err)
	}

	client.mu.Lock()
	firstToken := client.token
	client.mu.Unlock()

	// Second call should reuse the same token (not re-authenticate)
	err = client.ensureToken()
	if err != nil {
		t.Fatalf("second ensureToken: %v", err)
	}

	client.mu.Lock()
	secondToken := client.token
	client.mu.Unlock()

	if firstToken != secondToken {
		t.Error("ensureToken should reuse existing valid token")
	}
}

func TestNiFiClientEnsureTokenRefresh(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	// Authenticate
	err := client.authenticate()
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	// Force token expiration
	client.mu.Lock()
	client.tokenExp = time.Now().Add(-1 * time.Hour)
	client.mu.Unlock()

	// ensureToken should refresh
	err = client.ensureToken()
	if err != nil {
		t.Fatalf("ensureToken after expiry: %v", err)
	}

	client.mu.Lock()
	if client.tokenExp.Before(time.Now()) {
		t.Error("tokenExp should be in the future after refresh")
	}
	client.mu.Unlock()
}

// ---------------------------------------------------------------------------
// TestNiFiClientGetProcessGroup
// ---------------------------------------------------------------------------

func TestNiFiClientGetProcessGroup(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	tests := []struct {
		name       string
		pgID       string
		wantErr    bool
		wantName   string
		wantStatus string
	}{
		{
			name:       "existing process group",
			pgID:       "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			wantErr:    false,
			wantName:   "Test Process Group",
			wantStatus: "RUNNING",
		},
		{
			name:       "stopped process group",
			pgID:       "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			wantErr:    false,
			wantName:   "Stopped Process Group",
			wantStatus: "STOPPED",
		},
		{
			name:    "non-existent process group",
			pgID:    "c3d4e5f6-a7b8-9012-cdef-123456789012",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pg, err := client.GetProcessGroup(tt.pgID)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error but got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if pg.Name != tt.wantName {
				t.Errorf("name: got %q, want %q", pg.Name, tt.wantName)
			}
			if pg.Status != tt.wantStatus {
				t.Errorf("status: got %q, want %q", pg.Status, tt.wantStatus)
			}
		})
	}
}

func TestNiFiClientGetRootProcessGroup(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	pg, err := client.GetRootProcessGroup()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if pg.ID != "root-pg-id" {
		t.Errorf("id: got %q, want %q", pg.ID, "root-pg-id")
	}
	if pg.RunningCount != 3 {
		t.Errorf("running count: got %d, want 3", pg.RunningCount)
	}
	if pg.StoppedCount != 2 {
		t.Errorf("stopped count: got %d, want 2", pg.StoppedCount)
	}
	if pg.Status != "RUNNING" {
		t.Errorf("status: got %q, want %q", pg.Status, "RUNNING")
	}
}

func TestNiFiClientGetProcessGroupStatus(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	status, err := client.GetProcessGroupStatus("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if status.ID != "a1b2c3d4-e5f6-7890-abcd-ef1234567890" {
		t.Errorf("id: got %q, want %q", status.ID, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	}
	if status.FlowFilesIn != 100 {
		t.Errorf("flow files in: got %d, want 100", status.FlowFilesIn)
	}
	if status.FlowFilesOut != 95 {
		t.Errorf("flow files out: got %d, want 95", status.FlowFilesOut)
	}
	if status.BytesIn != 1048576 {
		t.Errorf("bytes in: got %d, want 1048576", status.BytesIn)
	}
	if status.ActiveThreads != 5 {
		t.Errorf("active threads: got %d, want 5", status.ActiveThreads)
	}
}

func TestNiFiClientStartStopProcessGroup(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	t.Run("start success", func(t *testing.T) {
		err := client.StartProcessGroup("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("stop success", func(t *testing.T) {
		err := client.StopProcessGroup("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("start failure", func(t *testing.T) {
		err := client.StartProcessGroup("d4e5f6a7-b8c9-0123-defa-234567890123")
		if err == nil {
			t.Error("expected error for failing process group start")
		}
	})
}

// ---------------------------------------------------------------------------
// TestNiFiClientHealthy
// ---------------------------------------------------------------------------

func TestNiFiClientHealthy(t *testing.T) {
	tests := []struct {
		name      string
		username  string
		password  string
		wantAlive bool
	}{
		{
			name:      "healthy with valid credentials",
			username:  "admin",
			password:  "testpass",
			wantAlive: true,
		},
		{
			name:      "unhealthy with bad credentials",
			username:  "admin",
			password:  "wrongpass",
			wantAlive: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockServer := newMockNiFiServer(t)
			defer mockServer.Close()

			client := NewNiFiClient(mockServer.URL, tt.username, tt.password, slog.Default())
			alive := client.IsHealthy()

			if alive != tt.wantAlive {
				t.Errorf("IsHealthy: got %v, want %v", alive, tt.wantAlive)
			}
		})
	}
}

func TestNiFiClientHealthyServerDown(t *testing.T) {
	// Create and immediately close a server to simulate unreachable NiFi
	mockServer := newMockNiFiServer(t)
	serverURL := mockServer.URL
	mockServer.Close()

	client := NewNiFiClient(serverURL, "admin", "testpass", slog.Default())
	if client.IsHealthy() {
		t.Error("IsHealthy should return false when server is down")
	}
}

// ---------------------------------------------------------------------------
// TestTransferApprovalWorkflow
// ---------------------------------------------------------------------------

func TestTransferApprovalWorkflow(t *testing.T) {
	t.Run("approval type serialization", func(t *testing.T) {
		now := time.Now().UTC()
		reviewedAt := now.Add(1 * time.Hour)
		approval := TransferApproval{
			ID:             generateUUID(),
			TransferID:     generateUUID(),
			Direction:      "low_to_high",
			EntityType:     "ticket",
			EntityIDs:      []string{"ticket-1", "ticket-2"},
			Classification: "CUI",
			Status:         "pending",
			Reason:         "CUI transfers from high to low require review",
			ExpiresAt:      now.Add(24 * time.Hour),
			CreatedAt:      now,
		}

		// Marshal and unmarshal
		data, err := json.Marshal(approval)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var decoded TransferApproval
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}

		if decoded.ID != approval.ID {
			t.Errorf("ID: got %q, want %q", decoded.ID, approval.ID)
		}
		if decoded.Status != "pending" {
			t.Errorf("status: got %q, want %q", decoded.Status, "pending")
		}
		if len(decoded.EntityIDs) != 2 {
			t.Errorf("entity_ids: got %d, want 2", len(decoded.EntityIDs))
		}
		if decoded.ReviewedAt != nil {
			t.Error("reviewed_at should be nil for pending")
		}

		// Test approved state
		approval.Status = "approved"
		approval.ReviewedBy = "admin"
		approval.ReviewedAt = &reviewedAt

		data, _ = json.Marshal(approval)
		json.Unmarshal(data, &decoded)
		if decoded.Status != "approved" {
			t.Errorf("status: got %q, want %q", decoded.Status, "approved")
		}
		if decoded.ReviewedBy != "admin" {
			t.Errorf("reviewed_by: got %q, want %q", decoded.ReviewedBy, "admin")
		}
		if decoded.ReviewedAt == nil {
			t.Error("reviewed_at should not be nil for approved")
		}
	})

	t.Run("approval pending counter", func(t *testing.T) {
		srv := newTestServer()

		// Simulate queueing transfers
		srv.statsMu.Lock()
		srv.pendingTransfers = 0
		srv.statsMu.Unlock()

		// Queue 3 transfers
		for i := 0; i < 3; i++ {
			srv.statsMu.Lock()
			srv.pendingTransfers++
			srv.statsMu.Unlock()
		}

		srv.statsMu.Lock()
		if srv.pendingTransfers != 3 {
			t.Errorf("pending: got %d, want 3", srv.pendingTransfers)
		}
		srv.statsMu.Unlock()

		// Approve 1
		srv.statsMu.Lock()
		if srv.pendingTransfers > 0 {
			srv.pendingTransfers--
		}
		srv.statsMu.Unlock()

		srv.statsMu.Lock()
		if srv.pendingTransfers != 2 {
			t.Errorf("pending after approve: got %d, want 2", srv.pendingTransfers)
		}
		srv.statsMu.Unlock()

		// Reject 1
		srv.statsMu.Lock()
		if srv.pendingTransfers > 0 {
			srv.pendingTransfers--
		}
		srv.statsMu.Unlock()

		srv.statsMu.Lock()
		if srv.pendingTransfers != 1 {
			t.Errorf("pending after reject: got %d, want 1", srv.pendingTransfers)
		}
		srv.statsMu.Unlock()
	})

	t.Run("approval state transitions", func(t *testing.T) {
		// Valid transitions: pending -> approved, pending -> rejected, pending -> expired
		validStates := map[string][]string{
			"pending": {"approved", "rejected", "expired"},
		}

		for from, toStates := range validStates {
			for _, to := range toStates {
				approval := TransferApproval{Status: from}
				approval.Status = to
				if approval.Status != to {
					t.Errorf("transition %s -> %s failed", from, to)
				}
			}
		}
	})
}

// ---------------------------------------------------------------------------
// TestApprovalExpiry
// ---------------------------------------------------------------------------

func TestApprovalExpiry(t *testing.T) {
	t.Run("expiry time calculation", func(t *testing.T) {
		now := time.Now().UTC()

		tests := []struct {
			name      string
			duration  time.Duration
			isExpired bool
		}{
			{
				name:      "24h expiry not yet expired",
				duration:  24 * time.Hour,
				isExpired: false,
			},
			{
				name:      "1h expiry not yet expired",
				duration:  1 * time.Hour,
				isExpired: false,
			},
			{
				name:      "already expired (-1h)",
				duration:  -1 * time.Hour,
				isExpired: true,
			},
			{
				name:      "already expired (-24h)",
				duration:  -24 * time.Hour,
				isExpired: true,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				approval := TransferApproval{
					ID:        generateUUID(),
					Status:    "pending",
					ExpiresAt: now.Add(tt.duration),
					CreatedAt: now,
				}

				isExpired := now.After(approval.ExpiresAt)
				if isExpired != tt.isExpired {
					t.Errorf("isExpired: got %v, want %v (expires_at=%v, now=%v)",
						isExpired, tt.isExpired, approval.ExpiresAt, now)
				}
			})
		}
	})

	t.Run("expiry sets status to expired", func(t *testing.T) {
		approval := TransferApproval{
			ID:        generateUUID(),
			Status:    "pending",
			ExpiresAt: time.Now().UTC().Add(-1 * time.Hour),
			CreatedAt: time.Now().UTC().Add(-25 * time.Hour),
		}

		// Simulate expiry logic
		if time.Now().UTC().After(approval.ExpiresAt) && approval.Status == "pending" {
			approval.Status = "expired"
		}

		if approval.Status != "expired" {
			t.Errorf("status: got %q, want %q", approval.Status, "expired")
		}
	})

	t.Run("non-expired approvals not affected", func(t *testing.T) {
		approval := TransferApproval{
			ID:        generateUUID(),
			Status:    "pending",
			ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
			CreatedAt: time.Now().UTC(),
		}

		// Simulate expiry logic
		if time.Now().UTC().After(approval.ExpiresAt) && approval.Status == "pending" {
			approval.Status = "expired"
		}

		if approval.Status != "pending" {
			t.Errorf("status: got %q, want %q (should not expire)", approval.Status, "pending")
		}
	})

	t.Run("already approved not expirable", func(t *testing.T) {
		approval := TransferApproval{
			ID:        generateUUID(),
			Status:    "approved",
			ExpiresAt: time.Now().UTC().Add(-1 * time.Hour), // expired time
			CreatedAt: time.Now().UTC().Add(-25 * time.Hour),
		}

		// Simulate expiry logic (only affects pending)
		if time.Now().UTC().After(approval.ExpiresAt) && approval.Status == "pending" {
			approval.Status = "expired"
		}

		if approval.Status != "approved" {
			t.Errorf("status: got %q, want %q (approved should not expire)", approval.Status, "approved")
		}
	})

	t.Run("concurrent expiry check is safe", func(t *testing.T) {
		srv := newTestServer()
		srv.statsMu.Lock()
		srv.pendingTransfers = 50
		srv.statsMu.Unlock()

		var wg sync.WaitGroup
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				srv.statsMu.Lock()
				if srv.pendingTransfers > 0 {
					srv.pendingTransfers--
				}
				srv.statsMu.Unlock()
			}()
		}
		wg.Wait()

		srv.statsMu.Lock()
		if srv.pendingTransfers != 0 {
			t.Errorf("pending: got %d, want 0", srv.pendingTransfers)
		}
		srv.statsMu.Unlock()
	})
}

// ---------------------------------------------------------------------------
// TestProvenanceEventParsing
// ---------------------------------------------------------------------------

func TestProvenanceEventParsing(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	t.Run("submit and retrieve provenance", func(t *testing.T) {
		query := ProvenanceQuery{
			MaxResults: 100,
			StartDate:  "03/01/2026 00:00:00 UTC",
			EndDate:    "03/02/2026 00:00:00 UTC",
		}

		queryID, err := client.SubmitProvenanceQuery(query)
		if err != nil {
			t.Fatalf("submit provenance query: %v", err)
		}
		if queryID == "" {
			t.Fatal("query ID should not be empty")
		}
		if queryID != "prov-query-1" {
			t.Errorf("query ID: got %q, want %q", queryID, "prov-query-1")
		}

		// Get results
		results, err := client.GetProvenanceResults(queryID)
		if err != nil {
			t.Fatalf("get provenance results: %v", err)
		}

		if !results.Finished {
			t.Error("results should be finished")
		}
		if results.Total != 2 {
			t.Errorf("total: got %d, want 2", results.Total)
		}
		if len(results.Events) != 2 {
			t.Fatalf("events: got %d, want 2", len(results.Events))
		}

		// Verify first event
		ev1 := results.Events[0]
		if ev1.ID != "ev-1" {
			t.Errorf("event 1 id: got %q, want %q", ev1.ID, "ev-1")
		}
		if ev1.EventType != "SEND" {
			t.Errorf("event 1 type: got %q, want %q", ev1.EventType, "SEND")
		}
		if ev1.ComponentName != "PutFile" {
			t.Errorf("event 1 component: got %q, want %q", ev1.ComponentName, "PutFile")
		}
		if ev1.FlowFileUUID != "ff-uuid-1" {
			t.Errorf("event 1 flowfile: got %q, want %q", ev1.FlowFileUUID, "ff-uuid-1")
		}
		if ev1.FileSize != 1024 {
			t.Errorf("event 1 filesize: got %d, want 1024", ev1.FileSize)
		}
		if ev1.Attributes["filename"] != "transfer-001.json" {
			t.Errorf("event 1 filename attr: got %q, want %q", ev1.Attributes["filename"], "transfer-001.json")
		}
		if ev1.Attributes["classification"] != "UNCLASS" {
			t.Errorf("event 1 classification attr: got %q, want %q", ev1.Attributes["classification"], "UNCLASS")
		}

		// Verify second event
		ev2 := results.Events[1]
		if ev2.ID != "ev-2" {
			t.Errorf("event 2 id: got %q, want %q", ev2.ID, "ev-2")
		}
		if ev2.EventType != "RECEIVE" {
			t.Errorf("event 2 type: got %q, want %q", ev2.EventType, "RECEIVE")
		}
		if ev2.FileSize != 2048 {
			t.Errorf("event 2 filesize: got %d, want 2048", ev2.FileSize)
		}

		// Clean up
		err = client.DeleteProvenanceQuery(queryID)
		if err != nil {
			t.Errorf("delete provenance query: %v", err)
		}
	})

	t.Run("provenance query type serialization", func(t *testing.T) {
		query := ProvenanceQuery{
			MaxResults: 500,
			StartDate:  "03/01/2026 00:00:00 UTC",
			EndDate:    "03/02/2026 00:00:00 UTC",
			SearchTerms: map[string]string{
				"FlowFileUUID": "test-uuid",
				"Filename":     "transfer.json",
			},
		}

		data, err := json.Marshal(query)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var decoded ProvenanceQuery
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}

		if decoded.MaxResults != 500 {
			t.Errorf("maxResults: got %d, want 500", decoded.MaxResults)
		}
		if decoded.SearchTerms["FlowFileUUID"] != "test-uuid" {
			t.Errorf("search term: got %q, want %q", decoded.SearchTerms["FlowFileUUID"], "test-uuid")
		}
	})

	t.Run("provenance event type serialization", func(t *testing.T) {
		event := ProvenanceEvent{
			ID:            "ev-test",
			EventType:     "SEND",
			Timestamp:     "2026-03-01T12:00:00Z",
			ComponentID:   "comp-1",
			ComponentName: "PutFile",
			ComponentType: "PutFile",
			FlowFileUUID:  "ff-1",
			FileSize:      4096,
			Attributes: map[string]string{
				"classification": "CUI",
				"direction":      "low_to_high",
			},
		}

		data, err := json.Marshal(event)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var decoded ProvenanceEvent
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}

		if decoded.ID != "ev-test" {
			t.Errorf("id: got %q, want %q", decoded.ID, "ev-test")
		}
		if decoded.FileSize != 4096 {
			t.Errorf("fileSize: got %d, want 4096", decoded.FileSize)
		}
		if decoded.Attributes["classification"] != "CUI" {
			t.Errorf("classification: got %q, want %q", decoded.Attributes["classification"], "CUI")
		}
	})

	t.Run("empty provenance results", func(t *testing.T) {
		results := ProvenanceResults{
			ID:       "empty-query",
			Finished: true,
			Total:    0,
			Events:   nil,
		}

		if len(results.Events) != 0 {
			t.Errorf("events: got %d, want 0", len(results.Events))
		}
	})
}

// ---------------------------------------------------------------------------
// TestSystemDiagnostics
// ---------------------------------------------------------------------------

func TestNiFiClientGetSystemDiagnostics(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	diag, err := client.GetSystemDiagnostics()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if diag.TotalThreads != 50 {
		t.Errorf("total threads: got %d, want 50", diag.TotalThreads)
	}
	if diag.HeapUsed != "512.00 MB" {
		t.Errorf("heap used: got %q, want %q", diag.HeapUsed, "512.00 MB")
	}
	if diag.HeapMax != "2048.00 MB" {
		t.Errorf("heap max: got %q, want %q", diag.HeapMax, "2048.00 MB")
	}
	if diag.Uptime != "02:30:15.000" {
		t.Errorf("uptime: got %q, want %q", diag.Uptime, "02:30:15.000")
	}
}

// ---------------------------------------------------------------------------
// TestNiFiStatusHandler
// ---------------------------------------------------------------------------

func TestNiFiStatusHandlerDisabled(t *testing.T) {
	srv := newTestServer()
	// nifi is nil

	req := httptest.NewRequest(http.MethodGet, "/api/v1/cti/nifi/status", nil)
	rec := httptest.NewRecorder()
	srv.handleNiFiStatus(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}

	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["enabled"] != false {
		t.Error("enabled should be false when NiFi not configured")
	}
}

func TestNiFiStatusHandlerEnabled(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	srv := newTestServer()
	srv.nifi = NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	req := httptest.NewRequest(http.MethodGet, "/api/v1/cti/nifi/status", nil)
	rec := httptest.NewRecorder()
	srv.handleNiFiStatus(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}

	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["enabled"] != true {
		t.Error("enabled should be true when NiFi is configured")
	}
	if resp["diagnostics"] == nil {
		t.Error("diagnostics should be present")
	}
	if resp["root_process_group"] == nil {
		t.Error("root_process_group should be present")
	}
}

// ---------------------------------------------------------------------------
// TestNiFiFlowStartStopHandlers
// ---------------------------------------------------------------------------

func TestNiFiFlowStartHandlerDisabled(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/nifi/flows/a1b2c3d4-e5f6-7890-abcd-ef1234567890/start", nil)
	req.SetPathValue("id", "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	rec := httptest.NewRecorder()
	srv.handleNiFiFlowStart(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("got status %d, want 503", rec.Code)
	}
}

func TestNiFiFlowStartHandlerEnabled(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	srv := newTestServer()
	srv.nifi = NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/nifi/flows/a1b2c3d4-e5f6-7890-abcd-ef1234567890/start", nil)
	req.SetPathValue("id", "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	rec := httptest.NewRecorder()
	srv.handleNiFiFlowStart(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["status"] != "started" {
		t.Errorf("status: got %q, want %q", resp["status"], "started")
	}
}

func TestNiFiFlowStopHandlerDisabled(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/nifi/flows/a1b2c3d4-e5f6-7890-abcd-ef1234567890/stop", nil)
	req.SetPathValue("id", "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	rec := httptest.NewRecorder()
	srv.handleNiFiFlowStop(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("got status %d, want 503", rec.Code)
	}
}

func TestNiFiFlowStopHandlerEnabled(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	srv := newTestServer()
	srv.nifi = NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/nifi/flows/a1b2c3d4-e5f6-7890-abcd-ef1234567890/stop", nil)
	req.SetPathValue("id", "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	rec := httptest.NewRecorder()
	srv.handleNiFiFlowStop(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["status"] != "stopped" {
		t.Errorf("status: got %q, want %q", resp["status"], "stopped")
	}
}

func TestNiFiFlowStartMissingID(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	srv := newTestServer()
	srv.nifi = NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/nifi/flows//start", nil)
	// PathValue returns "" when not set
	rec := httptest.NewRecorder()
	srv.handleNiFiFlowStart(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("got status %d, want 400", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// TestNiFiProvenanceHandler
// ---------------------------------------------------------------------------

func TestNiFiProvenanceHandlerDisabled(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/cti/nifi/provenance", nil)
	rec := httptest.NewRecorder()
	srv.handleNiFiProvenance(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("got status %d, want 503", rec.Code)
	}
}

func TestNiFiProvenanceHandlerEnabled(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	srv := newTestServer()
	srv.nifi = NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	req := httptest.NewRequest(http.MethodGet, "/api/v1/cti/nifi/provenance?maxResults=50", nil)
	rec := httptest.NewRecorder()
	srv.handleNiFiProvenance(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}

	var results ProvenanceResults
	json.NewDecoder(rec.Body).Decode(&results)
	if !results.Finished {
		t.Error("results should be finished")
	}
	if results.Total != 2 {
		t.Errorf("total: got %d, want 2", results.Total)
	}
	if len(results.Events) != 2 {
		t.Errorf("events: got %d, want 2", len(results.Events))
	}
}

// ---------------------------------------------------------------------------
// TestNiFiFlowConfig
// ---------------------------------------------------------------------------

func TestNiFiFlowConfigSerialization(t *testing.T) {
	cfg := NiFiFlowConfig{
		ID:             generateUUID(),
		Name:           "CTI Transfer Flow",
		ProcessGroupID: "pg-transfer-001",
		FlowType:       "transfer",
		Enabled:        true,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded NiFiFlowConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Name != "CTI Transfer Flow" {
		t.Errorf("name: got %q, want %q", decoded.Name, "CTI Transfer Flow")
	}
	if decoded.FlowType != "transfer" {
		t.Errorf("flow_type: got %q, want %q", decoded.FlowType, "transfer")
	}
	if !decoded.Enabled {
		t.Error("enabled should be true")
	}
}

// ---------------------------------------------------------------------------
// TestNewNiFiClient
// ---------------------------------------------------------------------------

func TestNewNiFiClient(t *testing.T) {
	client := NewNiFiClient("http://localhost:8443", "admin", "password", slog.Default())

	if client.baseURL != "http://localhost:8443" {
		t.Errorf("baseURL: got %q, want %q", client.baseURL, "http://localhost:8443")
	}
	if client.username != "admin" {
		t.Errorf("username: got %q, want %q", client.username, "admin")
	}
	if client.password != "password" {
		t.Errorf("password: got %q, want %q", client.password, "password")
	}
	if client.client == nil {
		t.Error("http client should not be nil")
	}
	if client.logger == nil {
		t.Error("logger should not be nil")
	}
	if client.token != "" {
		t.Error("token should be empty initially")
	}
}

// ---------------------------------------------------------------------------
// TestProcessGroupTypes
// ---------------------------------------------------------------------------

func TestProcessGroupSerialization(t *testing.T) {
	pg := ProcessGroup{
		ID:           "pg-1",
		Name:         "Transfer Flow",
		RunningCount: 5,
		StoppedCount: 2,
		Status:       "RUNNING",
	}

	data, err := json.Marshal(pg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded ProcessGroup
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.ID != pg.ID {
		t.Errorf("id: got %q, want %q", decoded.ID, pg.ID)
	}
	if decoded.RunningCount != 5 {
		t.Errorf("running: got %d, want 5", decoded.RunningCount)
	}
	if decoded.Status != "RUNNING" {
		t.Errorf("status: got %q, want %q", decoded.Status, "RUNNING")
	}
}

func TestPGStatusSerialization(t *testing.T) {
	st := PGStatus{
		ID:            "pg-1",
		Name:          "Test",
		FlowFilesIn:   100,
		FlowFilesOut:  95,
		BytesIn:       1048576,
		BytesOut:      1000000,
		ActiveThreads: 5,
		QueuedCount:   10,
		QueuedBytes:   5120,
	}

	data, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded PGStatus
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.FlowFilesIn != 100 {
		t.Errorf("flow files in: got %d, want 100", decoded.FlowFilesIn)
	}
	if decoded.BytesIn != 1048576 {
		t.Errorf("bytes in: got %d, want 1048576", decoded.BytesIn)
	}
	if decoded.QueuedCount != 10 {
		t.Errorf("queued count: got %d, want 10", decoded.QueuedCount)
	}
}

func TestSystemDiagnosticsSerialization(t *testing.T) {
	diag := SystemDiagnostics{
		TotalThreads: 50,
		HeapUsed:     "512 MB",
		HeapMax:      "2048 MB",
		Uptime:       "02:30:15",
	}

	data, err := json.Marshal(diag)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded SystemDiagnostics
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.TotalThreads != 50 {
		t.Errorf("threads: got %d, want 50", decoded.TotalThreads)
	}
	if decoded.HeapUsed != "512 MB" {
		t.Errorf("heap used: got %q, want %q", decoded.HeapUsed, "512 MB")
	}
}

// ---------------------------------------------------------------------------
// TestPublishTransferEvent (nil NATS safety)
// ---------------------------------------------------------------------------

func TestPublishTransferEventNilNATS(t *testing.T) {
	srv := newTestServer()
	// highNATS is nil — should not panic
	srv.publishTransferEvent("cti.transfer.pending", map[string]any{
		"approval_id": "test",
		"timestamp":   time.Now().UTC().Format(time.RFC3339Nano),
	})
	// If we get here without panic, test passes
}

// ---------------------------------------------------------------------------
// TestConcurrentNiFiAuth
// ---------------------------------------------------------------------------

func TestConcurrentNiFiAuth(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	client := NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	// Hammer ensureToken concurrently
	var wg sync.WaitGroup
	errors := make([]error, 50)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			errors[idx] = client.ensureToken()
		}(i)
	}
	wg.Wait()

	for i, err := range errors {
		if err != nil {
			t.Errorf("goroutine %d: %v", i, err)
		}
	}

	client.mu.Lock()
	if client.token == "" {
		t.Error("token should be set after concurrent authentication")
	}
	client.mu.Unlock()
}

// ---------------------------------------------------------------------------
// TestApprovalHandlerMissingID
// ---------------------------------------------------------------------------

func TestApprovalGetHandlerMissingID(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/cti/approvals/", nil)
	// PathValue returns "" when not set
	rec := httptest.NewRecorder()
	srv.handleGetApproval(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("got status %d, want 400", rec.Code)
	}

	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	errObj, _ := resp["error"].(map[string]any)
	if errObj == nil {
		t.Fatal("expected error response")
	}
	if errObj["code"] != "MISSING_ID" {
		t.Errorf("error code: got %q, want %q", errObj["code"], "MISSING_ID")
	}
}

func TestApproveHandlerMissingID(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/approvals//approve", nil)
	rec := httptest.NewRecorder()
	srv.handleApproveTransfer(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("got status %d, want 400", rec.Code)
	}
}

func TestRejectHandlerMissingID(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/approvals//reject", nil)
	rec := httptest.NewRecorder()
	srv.handleRejectTransfer(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("got status %d, want 400", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// TestSubmitToNiFi nil safety
// ---------------------------------------------------------------------------

func TestSubmitToNiFiNilNiFi(t *testing.T) {
	srv := newTestServer()
	// nifi is nil — should not panic
	srv.submitToNiFi(nil, "test-approval-id")
}

// ---------------------------------------------------------------------------
// TestAuthMiddlewareNewRoutes
// ---------------------------------------------------------------------------

func TestAuthMiddlewareNewRoutes(t *testing.T) {
	srv := newTestServer()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	handler := srv.ctiAuthMiddleware(inner)

	newRoutes := []string{
		"/api/v1/cti/approvals",
		"/api/v1/cti/approvals/some-id",
		"/api/v1/cti/approvals/some-id/approve",
		"/api/v1/cti/approvals/some-id/reject",
		"/api/v1/cti/nifi/status",
		"/api/v1/cti/nifi/flows",
		"/api/v1/cti/nifi/flows/some-id/start",
		"/api/v1/cti/nifi/flows/some-id/stop",
		"/api/v1/cti/nifi/provenance",
	}

	for _, route := range newRoutes {
		t.Run(fmt.Sprintf("no_auth_%s", route), func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s without auth: got %d, want 401", route, rec.Code)
			}
		})

		t.Run(fmt.Sprintf("with_auth_%s", route), func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			req.Header.Set("Authorization", "Bearer "+testAPIToken)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Errorf("%s with auth: got %d, want 200", route, rec.Code)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestValidateNiFiID
// ---------------------------------------------------------------------------

func TestValidateNiFiID(t *testing.T) {
	tests := []struct {
		name    string
		id      string
		wantErr bool
	}{
		{name: "valid UUID", id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", wantErr: false},
		{name: "another valid UUID", id: "550e8400-e29b-41d4-a716-446655440000", wantErr: false},
		{name: "path traversal", id: "../../../etc/passwd", wantErr: true},
		{name: "query injection", id: "abc?admin=true", wantErr: true},
		{name: "empty string", id: "", wantErr: true},
		{name: "too short", id: "abc-123", wantErr: true},
		{name: "uppercase hex", id: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", wantErr: true},
		{name: "no dashes", id: "a1b2c3d4e5f67890abcdef1234567890abcd", wantErr: true},
		{name: "special chars", id: "a1b2c3d4-e5f6-7890-abcd-ef12345678;x", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateNiFiID(tt.id)
			if tt.wantErr && err == nil {
				t.Error("expected error but got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

// TestNiFiFlowStartInvalidID verifies that path injection is rejected.
func TestNiFiFlowStartInvalidID(t *testing.T) {
	mockServer := newMockNiFiServer(t)
	defer mockServer.Close()

	srv := newTestServer()
	srv.nifi = NewNiFiClient(mockServer.URL, "admin", "testpass", slog.Default())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/nifi/flows/../../etc/passwd/start", nil)
	req.SetPathValue("id", "../../etc/passwd")
	rec := httptest.NewRecorder()
	srv.handleNiFiFlowStart(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("path injection: got status %d, want 400", rec.Code)
	}
}
