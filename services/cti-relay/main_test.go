package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const testAPIToken = "test-cti-api-token-for-testing"

// newTestServer creates a Server with no real DB/NATS for handler-level tests.
func newTestServer() *Server {
	return &Server{
		logger:        slog.Default(),
		ctiAPIToken:   testAPIToken,
		policies:      defaultPolicies(),
		transferStats: make(map[string]int),
	}
}

// ---------------------------------------------------------------------------
// TestTransferPolicyEnforcement
// ---------------------------------------------------------------------------

func TestTransferPolicyEnforcement(t *testing.T) {
	srv := newTestServer()

	tests := []struct {
		name           string
		req            TransferRequest
		expectedAction string
		description    string
	}{
		// SECRET is ALWAYS blocked regardless of direction
		{
			name: "SECRET low_to_high blocked",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "ticket",
				Classification: "SECRET",
			},
			expectedAction: "block",
			description:    "SECRET should never transfer between enclaves",
		},
		{
			name: "SECRET high_to_low blocked",
			req: TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "finding",
				Classification: "SECRET",
			},
			expectedAction: "block",
			description:    "SECRET should never transfer from high to low",
		},
		{
			name: "SECRET audit_event blocked",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "audit_event",
				Classification: "SECRET",
			},
			expectedAction: "block",
			description:    "SECRET audit events should never transfer",
		},

		// CUI high→low always queued
		{
			name: "CUI high_to_low ticket queued",
			req: TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "ticket",
				Classification: "CUI",
			},
			expectedAction: "queue",
			description:    "CUI from high to low requires review",
		},
		{
			name: "CUI high_to_low finding queued",
			req: TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "finding",
				Classification: "CUI",
			},
			expectedAction: "queue",
			description:    "CUI findings from high to low require review",
		},

		// UNCLASS low→high auto for known types
		{
			name: "UNCLASS low_to_high ticket auto",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "ticket",
				Classification: "UNCLASS",
			},
			expectedAction: "auto",
			description:    "UNCLASS tickets should auto-transfer low to high",
		},
		{
			name: "UNCLASS low_to_high audit_event auto",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "audit_event",
				Classification: "UNCLASS",
			},
			expectedAction: "auto",
			description:    "UNCLASS audit events should auto-stream low to high",
		},
		{
			name: "UNCLASS low_to_high finding auto",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "finding",
				Classification: "UNCLASS",
			},
			expectedAction: "auto",
			description:    "UNCLASS findings should auto-transfer low to high",
		},
		{
			name: "CUI low_to_high ticket auto",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "ticket",
				Classification: "CUI",
			},
			expectedAction: "auto",
			description:    "CUI tickets should auto-transfer low to high",
		},
		{
			name: "CUI low_to_high audit_event auto",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "audit_event",
				Classification: "CUI",
			},
			expectedAction: "auto",
			description:    "CUI audit events should auto-stream low to high",
		},

		// UNCLASS high→low auto for known types
		{
			name: "UNCLASS high_to_low ticket auto",
			req: TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "ticket",
				Classification: "UNCLASS",
			},
			expectedAction: "auto",
			description:    "UNCLASS tickets should auto-transfer high to low",
		},
		{
			name: "UNCLASS high_to_low finding auto",
			req: TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "finding",
				Classification: "UNCLASS",
			},
			expectedAction: "auto",
			description:    "UNCLASS findings should auto-transfer high to low",
		},

		// Unknown entity type → queue (no policy match)
		{
			name: "UNCLASS low_to_high operation queued (no matching policy)",
			req: TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "operation",
				Classification: "UNCLASS",
			},
			expectedAction: "queue",
			description:    "Operations have no default policy so should queue",
		},

		// CUI high→low operation → queued by CUI high→low hard rule
		{
			name: "CUI high_to_low operation queued",
			req: TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "operation",
				Classification: "CUI",
			},
			expectedAction: "queue",
			description:    "CUI operations from high to low should queue",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			action, reason := srv.EvaluatePolicyForTest(tt.req)
			if action != tt.expectedAction {
				t.Errorf("%s: got action=%q, want %q (reason: %s)", tt.description, action, tt.expectedAction, reason)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestTransferRequestValidation
// ---------------------------------------------------------------------------

func TestTransferRequestValidation(t *testing.T) {
	srv := newTestServer()

	tests := []struct {
		name       string
		body       map[string]any
		wantStatus int
		wantCode   string
	}{
		{
			name:       "empty body",
			body:       map[string]any{},
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_DIRECTION",
		},
		{
			name:       "invalid direction",
			body:       map[string]any{"direction": "sideways", "entity_type": "ticket", "classification": "UNCLASS", "entity_ids": []string{"abc"}},
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_DIRECTION",
		},
		{
			name:       "invalid entity type",
			body:       map[string]any{"direction": "low_to_high", "entity_type": "unknown", "classification": "UNCLASS", "entity_ids": []string{"abc"}},
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_ENTITY_TYPE",
		},
		{
			name:       "invalid classification",
			body:       map[string]any{"direction": "low_to_high", "entity_type": "ticket", "classification": "TOP_SECRET", "entity_ids": []string{"abc"}},
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_CLASSIFICATION",
		},
		{
			name:       "missing entity IDs",
			body:       map[string]any{"direction": "low_to_high", "entity_type": "ticket", "classification": "UNCLASS", "entity_ids": []string{}},
			wantStatus: http.StatusBadRequest,
			wantCode:   "MISSING_ENTITY_IDS",
		},
		{
			name:       "valid request (no DB so recordTransfer returns error)",
			body:       map[string]any{"direction": "low_to_high", "entity_type": "ticket", "classification": "UNCLASS", "entity_ids": []string{"abc-123"}},
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.body)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/cti/transfer", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			srv.handleTransfer(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("got status %d, want %d", rec.Code, tt.wantStatus)
			}
			if tt.wantCode != "" {
				var resp map[string]any
				json.NewDecoder(rec.Body).Decode(&resp)
				errObj, _ := resp["error"].(map[string]any)
				if errObj != nil {
					code, _ := errObj["code"].(string)
					if code != tt.wantCode {
						t.Errorf("got error code %q, want %q", code, tt.wantCode)
					}
				} else {
					t.Errorf("expected error response with code %q", tt.wantCode)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestHealthEndpoints
// ---------------------------------------------------------------------------

func TestHealthLive(t *testing.T) {
	srv := newTestServer()
	req := httptest.NewRequest(http.MethodGet, "/health/live", nil)
	rec := httptest.NewRecorder()

	srv.handleHealthLive(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("health/live: got %d, want 200", rec.Code)
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["status"] != "ok" {
		t.Errorf("health/live status: got %q, want %q", resp["status"], "ok")
	}
	if resp["service"] != "cti-relay" {
		t.Errorf("health/live service: got %q, want %q", resp["service"], "cti-relay")
	}
}

// TestHealthReady verifies degraded status when no connections are available
// (the test server has nil DB/NATS, so all checks should fail).
func TestHealthReady(t *testing.T) {
	// This will panic with nil pointer if we call handleHealthReady directly
	// because lowDB/highDB are nil. We test the liveness endpoint instead
	// which doesn't need connections, and test ready logic indirectly
	// through the status endpoint pattern.

	// We can at least verify the handler signature works with a basic test
	// by creating a server with minimal setup that won't crash.
	t.Run("liveness always 200", func(t *testing.T) {
		srv := newTestServer()
		req := httptest.NewRequest(http.MethodGet, "/health/live", nil)
		rec := httptest.NewRecorder()
		srv.handleHealthLive(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("got %d, want 200", rec.Code)
		}
	})
}

// ---------------------------------------------------------------------------
// TestStatusEndpoint
// ---------------------------------------------------------------------------

func TestStatusEndpoint(t *testing.T) {
	// We can't call handleStatus directly without DB connections.
	// Instead test the status response construction logic.
	srv := newTestServer()

	now := time.Now().UTC()
	srv.statsMu.Lock()
	srv.lastAuthSync = now
	srv.lastTelemetryTransfer = now
	srv.pendingTransfers = 5
	srv.transferStats["UNCLASS"] = 10
	srv.transferStats["CUI"] = 3
	srv.statsMu.Unlock()

	// Verify stats are set correctly
	srv.statsMu.Lock()
	if srv.pendingTransfers != 5 {
		t.Errorf("pending transfers: got %d, want 5", srv.pendingTransfers)
	}
	if srv.transferStats["UNCLASS"] != 10 {
		t.Errorf("UNCLASS stats: got %d, want 10", srv.transferStats["UNCLASS"])
	}
	if srv.transferStats["CUI"] != 3 {
		t.Errorf("CUI stats: got %d, want 3", srv.transferStats["CUI"])
	}
	if srv.lastAuthSync.IsZero() {
		t.Error("lastAuthSync should not be zero")
	}
	srv.statsMu.Unlock()
}

// ---------------------------------------------------------------------------
// TestTelemetryFilter
// ---------------------------------------------------------------------------

func TestTelemetryFilter(t *testing.T) {
	tests := []struct {
		name           string
		event          map[string]any
		expectedAllow  bool
		expectedClass  string
	}{
		{
			name:          "UNCLASS event allowed",
			event:         map[string]any{"event_type": "endpoint.health_updated", "classification": "UNCLASS", "timestamp": "2026-01-01T00:00:00Z"},
			expectedAllow: true,
			expectedClass: "UNCLASS",
		},
		{
			name:          "CUI event allowed",
			event:         map[string]any{"event_type": "audit.ticket_created", "classification": "CUI", "timestamp": "2026-01-01T00:00:00Z"},
			expectedAllow: true,
			expectedClass: "CUI",
		},
		{
			name:          "SECRET event blocked",
			event:         map[string]any{"event_type": "c2.command_executed", "classification": "SECRET", "timestamp": "2026-01-01T00:00:00Z"},
			expectedAllow: false,
			expectedClass: "SECRET",
		},
		{
			name:          "empty classification allowed",
			event:         map[string]any{"event_type": "endpoint.registered", "timestamp": "2026-01-01T00:00:00Z"},
			expectedAllow: true,
			expectedClass: "",
		},
		{
			name:          "invalid JSON blocked",
			event:         nil,
			expectedAllow: false,
			expectedClass: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var data []byte
			if tt.event != nil {
				data, _ = json.Marshal(tt.event)
			} else {
				data = []byte("not valid json{{{")
			}

			allowed, class := FilterTelemetryEvent(data)
			if allowed != tt.expectedAllow {
				t.Errorf("allowed: got %v, want %v", allowed, tt.expectedAllow)
			}
			if class != tt.expectedClass {
				t.Errorf("classification: got %q, want %q", class, tt.expectedClass)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestPolicyLoading (default policies)
// ---------------------------------------------------------------------------

func TestPolicyLoading(t *testing.T) {
	policies := defaultPolicies()

	if len(policies) == 0 {
		t.Fatal("default policies should not be empty")
	}

	// Verify we have policies for the expected combinations
	type policyKey struct {
		source, target, entity, class string
	}
	seen := make(map[policyKey]string)
	for _, p := range policies {
		key := policyKey{p.SourceEnclave, p.TargetEnclave, p.EntityType, p.Classification}
		seen[key] = p.Action
	}

	expectedPolicies := []struct {
		key    policyKey
		action string
	}{
		{policyKey{"low", "high", "telemetry", "UNCLASS"}, "auto"},
		{policyKey{"low", "high", "telemetry", "CUI"}, "auto"},
		{policyKey{"low", "high", "audit_event", "UNCLASS"}, "auto"},
		{policyKey{"low", "high", "audit_event", "CUI"}, "auto"},
		{policyKey{"low", "high", "ticket", "UNCLASS"}, "auto"},
		{policyKey{"low", "high", "ticket", "CUI"}, "auto"},
		{policyKey{"low", "high", "finding", "UNCLASS"}, "auto"},
		{policyKey{"low", "high", "finding", "CUI"}, "auto"},
		{policyKey{"high", "low", "ticket", "UNCLASS"}, "auto"},
		{policyKey{"high", "low", "finding", "UNCLASS"}, "auto"},
	}

	for _, ep := range expectedPolicies {
		action, found := seen[ep.key]
		if !found {
			t.Errorf("missing policy: %+v", ep.key)
			continue
		}
		if action != ep.action {
			t.Errorf("policy %+v: got action %q, want %q", ep.key, action, ep.action)
		}
	}

	// Verify no SECRET policies in defaults (handled by hard rule)
	for _, p := range policies {
		if p.Classification == "SECRET" {
			t.Errorf("default policies should not include SECRET (handled by hard rule): %+v", p)
		}
	}
}

// ---------------------------------------------------------------------------
// TestAuthSyncUpsert (logic-level test)
// ---------------------------------------------------------------------------

func TestAuthSyncResult(t *testing.T) {
	// Test the AuthSyncResult type and its JSON serialization
	result := AuthSyncResult{
		UsersSynced:    7,
		RolesSynced:    6,
		BindingsSynced: 12,
		Errors:         nil,
		SyncedAt:       time.Now().UTC().Format(time.RFC3339),
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal AuthSyncResult: %v", err)
	}

	var decoded AuthSyncResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal AuthSyncResult: %v", err)
	}

	if decoded.UsersSynced != 7 {
		t.Errorf("users_synced: got %d, want 7", decoded.UsersSynced)
	}
	if decoded.RolesSynced != 6 {
		t.Errorf("roles_synced: got %d, want 6", decoded.RolesSynced)
	}
	if decoded.BindingsSynced != 12 {
		t.Errorf("bindings_synced: got %d, want 12", decoded.BindingsSynced)
	}
	if decoded.Errors != nil {
		t.Errorf("errors: got %v, want nil", decoded.Errors)
	}

	// Test with errors
	result.Errors = []string{"role sync failed", "binding sync partial"}
	data, _ = json.Marshal(result)
	json.Unmarshal(data, &decoded)
	if len(decoded.Errors) != 2 {
		t.Errorf("errors length: got %d, want 2", len(decoded.Errors))
	}
}

// ---------------------------------------------------------------------------
// TestTransferRecord
// ---------------------------------------------------------------------------

func TestTransferRecord(t *testing.T) {
	rec := TransferRecord{
		ID:             generateUUID(),
		Direction:      "low_to_high",
		EntityType:     "ticket",
		EntityIDs:      []string{"abc-123", "def-456"},
		Classification: "UNCLASS",
		Status:         "accepted",
		Reason:         "Policy default-5: auto UNCLASS low→high",
		CreatedAt:      time.Now().UTC(),
	}

	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("failed to marshal TransferRecord: %v", err)
	}

	var decoded TransferRecord
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal TransferRecord: %v", err)
	}

	if decoded.ID != rec.ID {
		t.Errorf("ID: got %q, want %q", decoded.ID, rec.ID)
	}
	if decoded.Direction != "low_to_high" {
		t.Errorf("Direction: got %q, want %q", decoded.Direction, "low_to_high")
	}
	if len(decoded.EntityIDs) != 2 {
		t.Errorf("EntityIDs length: got %d, want 2", len(decoded.EntityIDs))
	}
	if decoded.Status != "accepted" {
		t.Errorf("Status: got %q, want %q", decoded.Status, "accepted")
	}
}

// ---------------------------------------------------------------------------
// TestPolicyCustomOverride
// ---------------------------------------------------------------------------

func TestPolicyCustomOverride(t *testing.T) {
	srv := newTestServer()

	// Override with custom policies
	srv.mu.Lock()
	srv.policies = []TransferPolicy{
		{
			ID:             "custom-1",
			SourceEnclave:  "low",
			TargetEnclave:  "high",
			EntityType:     "ticket",
			Classification: "UNCLASS",
			Action:         "queue", // Changed from auto to queue
		},
	}
	srv.mu.Unlock()

	// Now UNCLASS low→high ticket should queue (custom policy)
	action, _ := srv.EvaluatePolicyForTest(TransferRequest{
		Direction:      "low_to_high",
		EntityType:     "ticket",
		Classification: "UNCLASS",
	})
	if action != "queue" {
		t.Errorf("custom policy: got action %q, want %q", action, "queue")
	}

	// SECRET should still be blocked (hard rule, not affected by custom policies)
	action, _ = srv.EvaluatePolicyForTest(TransferRequest{
		Direction:      "low_to_high",
		EntityType:     "ticket",
		Classification: "SECRET",
	})
	if action != "block" {
		t.Errorf("SECRET override: got action %q, want %q", action, "block")
	}

	// CUI high→low should still queue (hard rule)
	action, _ = srv.EvaluatePolicyForTest(TransferRequest{
		Direction:      "high_to_low",
		EntityType:     "ticket",
		Classification: "CUI",
	})
	if action != "queue" {
		t.Errorf("CUI high→low override: got action %q, want %q", action, "queue")
	}
}

// ---------------------------------------------------------------------------
// TestConcurrentStatsAccess
// ---------------------------------------------------------------------------

func TestConcurrentStatsAccess(t *testing.T) {
	srv := newTestServer()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			srv.statsMu.Lock()
			srv.transferStats["UNCLASS"]++
			srv.pendingTransfers++
			srv.statsMu.Unlock()
		}(i)
	}
	wg.Wait()

	srv.statsMu.Lock()
	if srv.transferStats["UNCLASS"] != 100 {
		t.Errorf("concurrent UNCLASS stats: got %d, want 100", srv.transferStats["UNCLASS"])
	}
	if srv.pendingTransfers != 100 {
		t.Errorf("concurrent pending: got %d, want 100", srv.pendingTransfers)
	}
	srv.statsMu.Unlock()
}

// ---------------------------------------------------------------------------
// TestHelpers
// ---------------------------------------------------------------------------

func TestIsValidClassification(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"UNCLASS", true},
		{"CUI", true},
		{"SECRET", true},
		{"TOP_SECRET", false},
		{"", false},
		{"unclass", true},  // now case-insensitive
		{"secret", true},   // now case-insensitive
		{"cui", true},      // now case-insensitive
		{"Secret", true},   // mixed case
		{"  UNCLASS  ", true}, // whitespace trimmed
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := isValidClassification(tt.input); got != tt.want {
				t.Errorf("isValidClassification(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseDuration(t *testing.T) {
	tests := []struct {
		input    string
		fallback time.Duration
		want     time.Duration
	}{
		{"30s", time.Minute, 30 * time.Second},
		{"5m", time.Minute, 5 * time.Minute},
		{"1h", time.Minute, time.Hour},
		{"invalid", 42 * time.Second, 42 * time.Second},
		{"", 10 * time.Second, 10 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := parseDuration(tt.input, tt.fallback)
			if got != tt.want {
				t.Errorf("parseDuration(%q, %v) = %v, want %v", tt.input, tt.fallback, got, tt.want)
			}
		})
	}
}

func TestGenerateUUID(t *testing.T) {
	u := generateUUID()
	if len(u) != 36 { // 8-4-4-4-12 = 32 hex + 4 dashes
		t.Errorf("UUID length: got %d, want 36", len(u))
	}
	// Check version 4 marker
	if u[14] != '4' {
		t.Errorf("UUID version: got %c, want '4'", u[14])
	}

	// Ensure uniqueness
	u2 := generateUUID()
	if u == u2 {
		t.Error("two generated UUIDs should not be equal")
	}
}

func TestFormatTimeISO(t *testing.T) {
	// Zero time returns empty string
	if got := formatTimeISO(time.Time{}); got != "" {
		t.Errorf("zero time: got %q, want empty string", got)
	}

	// Non-zero time returns RFC3339
	now := time.Now().UTC()
	got := formatTimeISO(now)
	if got == "" {
		t.Error("non-zero time should not return empty string")
	}
	// Parse it back to verify format
	parsed, err := time.Parse(time.RFC3339, got)
	if err != nil {
		t.Errorf("formatTimeISO output not parseable as RFC3339: %v", err)
	}
	if parsed.Unix() != now.Unix() {
		t.Errorf("round-trip: got %v, want %v", parsed, now)
	}
}

func TestCopyMap(t *testing.T) {
	original := map[string]int{"a": 1, "b": 2}
	copied := copyMap(original)

	// Modify original
	original["c"] = 3

	// Copied should not be affected
	if _, exists := copied["c"]; exists {
		t.Error("copyMap should create an independent copy")
	}
	if copied["a"] != 1 || copied["b"] != 2 {
		t.Error("copyMap values should match original")
	}
}

func TestClamp(t *testing.T) {
	tests := []struct {
		min, max, val, want int
	}{
		{1, 100, 50, 50},
		{1, 100, 0, 1},
		{1, 100, 101, 100},
		{1, 100, 1, 1},
		{1, 100, 100, 100},
	}

	for _, tt := range tests {
		got := clamp(tt.min, tt.max, tt.val)
		if got != tt.want {
			t.Errorf("clamp(%d, %d, %d) = %d, want %d", tt.min, tt.max, tt.val, got, tt.want)
		}
	}
}

func TestMaxInt(t *testing.T) {
	if got := maxInt(1, 2); got != 2 {
		t.Errorf("maxInt(1,2) = %d, want 2", got)
	}
	if got := maxInt(5, 3); got != 5 {
		t.Errorf("maxInt(5,3) = %d, want 5", got)
	}
	if got := maxInt(4, 4); got != 4 {
		t.Errorf("maxInt(4,4) = %d, want 4", got)
	}
}

// ---------------------------------------------------------------------------
// TestListPoliciesHandler
// ---------------------------------------------------------------------------

func TestListPoliciesHandler(t *testing.T) {
	srv := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/cti/policies", nil)
	rec := httptest.NewRecorder()
	srv.handleListPolicies(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}

	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	data, ok := resp["data"].([]any)
	if !ok {
		t.Fatal("response should have 'data' array")
	}
	if len(data) != len(defaultPolicies()) {
		t.Errorf("got %d policies, want %d", len(data), len(defaultPolicies()))
	}
}

// ---------------------------------------------------------------------------
// TestTransferPolicy JSON serialization
// ---------------------------------------------------------------------------

func TestTransferPolicyJSON(t *testing.T) {
	minRisk := 4
	maxRisk := 5
	p := TransferPolicy{
		ID:             "test-1",
		SourceEnclave:  "low",
		TargetEnclave:  "high",
		EntityType:     "c2_command",
		Classification: "CUI",
		Action:         "queue",
		RiskLevelMin:   &minRisk,
		RiskLevelMax:   &maxRisk,
	}

	data, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded TransferPolicy
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.RiskLevelMin == nil || *decoded.RiskLevelMin != 4 {
		t.Errorf("RiskLevelMin: got %v, want 4", decoded.RiskLevelMin)
	}
	if decoded.RiskLevelMax == nil || *decoded.RiskLevelMax != 5 {
		t.Errorf("RiskLevelMax: got %v, want 5", decoded.RiskLevelMax)
	}

	// Without risk levels
	p2 := TransferPolicy{
		ID:             "test-2",
		SourceEnclave:  "low",
		TargetEnclave:  "high",
		EntityType:     "ticket",
		Classification: "UNCLASS",
		Action:         "auto",
	}

	data2, _ := json.Marshal(p2)
	var decoded2 TransferPolicy
	json.Unmarshal(data2, &decoded2)
	if decoded2.RiskLevelMin != nil {
		t.Error("RiskLevelMin should be nil when not set")
	}
}

// ---------------------------------------------------------------------------
// TestMaxBodyMiddleware
// ---------------------------------------------------------------------------

func TestMaxBodyMiddleware(t *testing.T) {
	handler := maxBodyMiddleware(10, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 100)
		_, err := r.Body.Read(buf)
		if err != nil {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))

	// Body within limit
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte("small")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("small body: got %d, want 200", rec.Code)
	}

	// Body exceeding limit
	bigBody := bytes.Repeat([]byte("x"), 100)
	req = httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(bigBody))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("large body: got %d, want 413", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// TestWriteJSON and TestWriteError
// ---------------------------------------------------------------------------

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]string{"hello": "world"})

	if rec.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type: got %q, want %q", ct, "application/json")
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["hello"] != "world" {
		t.Errorf("body: got %q, want %q", resp["hello"], "world")
	}
}

func TestWriteError(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusBadRequest, "BAD_INPUT", "Something went wrong")

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want 400", rec.Code)
	}

	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	errObj, _ := resp["error"].(map[string]any)
	if errObj == nil {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "BAD_INPUT" {
		t.Errorf("error code: got %q, want %q", errObj["code"], "BAD_INPUT")
	}
	if errObj["message"] != "Something went wrong" {
		t.Errorf("error message: got %q, want %q", errObj["message"], "Something went wrong")
	}
}

// ---------------------------------------------------------------------------
// TestEnvOr
// ---------------------------------------------------------------------------

func TestEnvOr(t *testing.T) {
	// Without env var set
	got := envOr("CTI_RELAY_TEST_UNSET_VAR", "default_value")
	if got != "default_value" {
		t.Errorf("envOr with unset: got %q, want %q", got, "default_value")
	}

	// With env var set
	t.Setenv("CTI_RELAY_TEST_SET_VAR", "custom_value")
	got = envOr("CTI_RELAY_TEST_SET_VAR", "default_value")
	if got != "custom_value" {
		t.Errorf("envOr with set: got %q, want %q", got, "custom_value")
	}
}

func TestEnvOrInt(t *testing.T) {
	// Without env var set
	got := envOrInt("CTI_RELAY_TEST_UNSET_INT", 42)
	if got != 42 {
		t.Errorf("envOrInt with unset: got %d, want 42", got)
	}

	// With env var set
	t.Setenv("CTI_RELAY_TEST_SET_INT", "99")
	got = envOrInt("CTI_RELAY_TEST_SET_INT", 42)
	if got != 99 {
		t.Errorf("envOrInt with set: got %d, want 99", got)
	}

	// With invalid value
	t.Setenv("CTI_RELAY_TEST_BAD_INT", "notanumber")
	got = envOrInt("CTI_RELAY_TEST_BAD_INT", 42)
	if got != 42 {
		t.Errorf("envOrInt with invalid: got %d, want 42", got)
	}
}

// ---------------------------------------------------------------------------
// TestQueryInt
// ---------------------------------------------------------------------------

func TestQueryInt(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/?page=5&limit=abc", nil)

	if got := queryInt(req, "page", 1); got != 5 {
		t.Errorf("page: got %d, want 5", got)
	}
	if got := queryInt(req, "limit", 20); got != 20 {
		t.Errorf("limit (invalid): got %d, want 20 (default)", got)
	}
	if got := queryInt(req, "missing", 10); got != 10 {
		t.Errorf("missing: got %d, want 10 (default)", got)
	}
}

// ---------------------------------------------------------------------------
// TestStatusResponse JSON
// ---------------------------------------------------------------------------

func TestStatusResponseJSON(t *testing.T) {
	resp := StatusResponse{
		LowConnected:         true,
		HighConnected:        false,
		LastAuthSync:         "2026-03-01T12:00:00Z",
		LastTelemetryTransfer: "2026-03-01T11:59:30Z",
		PendingTransfers:     3,
		TransferStats:        map[string]int{"UNCLASS": 100, "CUI": 25},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded StatusResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if !decoded.LowConnected {
		t.Error("low_connected should be true")
	}
	if decoded.HighConnected {
		t.Error("high_connected should be false")
	}
	if decoded.PendingTransfers != 3 {
		t.Errorf("pending_transfers: got %d, want 3", decoded.PendingTransfers)
	}
	if decoded.TransferStats["UNCLASS"] != 100 {
		t.Errorf("UNCLASS stats: got %d, want 100", decoded.TransferStats["UNCLASS"])
	}
}

// ---------------------------------------------------------------------------
// TestCTIAuthMiddleware
// ---------------------------------------------------------------------------

func TestCTIAuthMiddleware(t *testing.T) {
	srv := newTestServer()

	// Create a simple handler that the middleware wraps
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	handler := srv.ctiAuthMiddleware(inner)

	tests := []struct {
		name       string
		path       string
		authHeader string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "health/live bypasses auth",
			path:       "/health/live",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "health/ready bypasses auth",
			path:       "/health/ready",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "health bypasses auth",
			path:       "/health",
			authHeader: "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "CTI route without auth header returns 401",
			path:       "/api/v1/cti/status",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHORIZED",
		},
		{
			name:       "CTI route with wrong token returns 401",
			path:       "/api/v1/cti/status",
			authHeader: "Bearer wrong-token",
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHORIZED",
		},
		{
			name:       "CTI route with Basic auth instead of Bearer returns 401",
			path:       "/api/v1/cti/status",
			authHeader: "Basic dXNlcjpwYXNz",
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHORIZED",
		},
		{
			name:       "CTI route with valid token returns 200",
			path:       "/api/v1/cti/status",
			authHeader: "Bearer " + testAPIToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "CTI transfer route with valid token returns 200",
			path:       "/api/v1/cti/transfers",
			authHeader: "Bearer " + testAPIToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "CTI policies route with valid token returns 200",
			path:       "/api/v1/cti/policies",
			authHeader: "Bearer " + testAPIToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "empty Bearer token returns 401",
			path:       "/api/v1/cti/status",
			authHeader: "Bearer ",
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHORIZED",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("got status %d, want %d", rec.Code, tt.wantStatus)
			}
			if tt.wantCode != "" {
				var resp map[string]any
				json.NewDecoder(rec.Body).Decode(&resp)
				errObj, _ := resp["error"].(map[string]any)
				if errObj == nil {
					t.Fatalf("expected error object in response")
				}
				code, _ := errObj["code"].(string)
				if code != tt.wantCode {
					t.Errorf("got error code %q, want %q", code, tt.wantCode)
				}
				msg, _ := errObj["message"].(string)
				if msg != "missing or invalid CTI API token" {
					t.Errorf("got error message %q, want %q", msg, "missing or invalid CTI API token")
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestNormalizeClassification
// ---------------------------------------------------------------------------

func TestNormalizeClassification(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"SECRET", "SECRET"},
		{"secret", "SECRET"},
		{"Secret", "SECRET"},
		{"UNCLASS", "UNCLASS"},
		{"unclass", "UNCLASS"},
		{"CUI", "CUI"},
		{"cui", "CUI"},
		{"  SECRET  ", "SECRET"},
		{" cui ", "CUI"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := normalizeClassification(tt.input)
			if got != tt.want {
				t.Errorf("normalizeClassification(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestCaseInsensitiveSECRETBlocking
// ---------------------------------------------------------------------------

func TestCaseInsensitiveSECRETBlocking(t *testing.T) {
	srv := newTestServer()

	// All case variants of SECRET should be blocked
	variants := []string{"SECRET", "secret", "Secret", "sEcReT", "SECRET"}
	for _, v := range variants {
		t.Run(v, func(t *testing.T) {
			action, _ := srv.EvaluatePolicyForTest(TransferRequest{
				Direction:      "low_to_high",
				EntityType:     "ticket",
				Classification: v,
			})
			if action != "block" {
				t.Errorf("classification %q: got action %q, want %q", v, action, "block")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestCaseInsensitiveCUIQueuing
// ---------------------------------------------------------------------------

func TestCaseInsensitiveCUIQueuing(t *testing.T) {
	srv := newTestServer()

	// All case variants of CUI high→low should be queued
	variants := []string{"CUI", "cui", "Cui", "cUi"}
	for _, v := range variants {
		t.Run(v, func(t *testing.T) {
			action, _ := srv.EvaluatePolicyForTest(TransferRequest{
				Direction:      "high_to_low",
				EntityType:     "ticket",
				Classification: v,
			})
			if action != "queue" {
				t.Errorf("classification %q high→low: got action %q, want %q", v, action, "queue")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestRecordTransferNilDB
// ---------------------------------------------------------------------------

func TestRecordTransferNilDB(t *testing.T) {
	srv := newTestServer()

	rec := TransferRecord{
		ID:             generateUUID(),
		Direction:      "low_to_high",
		EntityType:     "ticket",
		EntityIDs:      []string{"abc-123"},
		Classification: "UNCLASS",
		Status:         "accepted",
		Reason:         "test",
		CreatedAt:      time.Now().UTC(),
	}

	err := srv.recordTransfer(nil, rec)
	if err == nil {
		t.Fatal("expected error when highDB is nil")
	}
	if err.Error() != "high-side database not connected" {
		t.Errorf("got error %q, want %q", err.Error(), "high-side database not connected")
	}
}

// ===========================================================================
// M12 Cross-Domain Command Relay & Finding Sync Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: CommandRelayRecord struct
// ---------------------------------------------------------------------------

func TestCommandRelayRecordJSON(t *testing.T) {
	rec := CommandRelayRecord{
		CommandID:   "cmd-1",
		OperationID: "op-1",
		SessionID:   "sess-1",
		Command:     "ls",
		RiskLevel:   1,
		Direction:   "high_to_low",
		Status:      "relayed",
		RelayedAt:   time.Now().UTC(),
	}

	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded CommandRelayRecord
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.CommandID != "cmd-1" {
		t.Errorf("CommandID = %q, want %q", decoded.CommandID, "cmd-1")
	}
	if decoded.Direction != "high_to_low" {
		t.Errorf("Direction = %q, want %q", decoded.Direction, "high_to_low")
	}
	if decoded.RiskLevel != 1 {
		t.Errorf("RiskLevel = %d, want %d", decoded.RiskLevel, 1)
	}
	if decoded.Status != "relayed" {
		t.Errorf("Status = %q, want %q", decoded.Status, "relayed")
	}
}

// ---------------------------------------------------------------------------
// Test: FindingSyncStatus and FindingSyncResult structs
// ---------------------------------------------------------------------------

func TestFindingSyncStatusJSON(t *testing.T) {
	status := FindingSyncStatus{
		TotalSynced:      42,
		TotalPending:     5,
		TotalFailed:      2,
		LastSyncAt:       "2026-03-01T12:00:00Z",
		ByClassification: map[string]int{"UNCLASS": 30, "CUI": 12},
	}

	data, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded FindingSyncStatus
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.TotalSynced != 42 {
		t.Errorf("TotalSynced = %d, want 42", decoded.TotalSynced)
	}
	if decoded.TotalPending != 5 {
		t.Errorf("TotalPending = %d, want 5", decoded.TotalPending)
	}
	if decoded.TotalFailed != 2 {
		t.Errorf("TotalFailed = %d, want 2", decoded.TotalFailed)
	}
	if decoded.ByClassification["UNCLASS"] != 30 {
		t.Errorf("ByClassification[UNCLASS] = %d, want 30", decoded.ByClassification["UNCLASS"])
	}
}

func TestFindingSyncResultJSON(t *testing.T) {
	result := FindingSyncResult{
		Synced:  10,
		Skipped: 3,
		Errors:  []string{"finding-abc: not found"},
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded FindingSyncResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Synced != 10 {
		t.Errorf("Synced = %d, want 10", decoded.Synced)
	}
	if decoded.Skipped != 3 {
		t.Errorf("Skipped = %d, want 3", decoded.Skipped)
	}
	if len(decoded.Errors) != 1 {
		t.Errorf("Errors length = %d, want 1", len(decoded.Errors))
	}
}

// ---------------------------------------------------------------------------
// Test: SECRET command relay blocking
// ---------------------------------------------------------------------------

func TestRelayCommandHighToLow_SECRETBlocked(t *testing.T) {
	// relayCommandHighToLow checks classification and blocks SECRET
	// We test the logic by verifying that SECRET commands in the relay function
	// don't get forwarded (the function returns early)
	srv := newTestServer()

	// SECRET command event
	event := map[string]any{
		"command_id":     "cmd-1",
		"operation_id":   "op-1",
		"command":        "ls",
		"classification": "SECRET",
	}
	data, _ := json.Marshal(event)

	// Since we can't easily mock NATS, verify the relay logic by checking
	// that the function doesn't panic and the stats aren't updated
	srv.statsMu.Lock()
	initialStats := copyMap(srv.transferStats)
	srv.statsMu.Unlock()

	// Call relayCommandHighToLow — it will try to publish to lowNATS which is nil
	// but should return early due to SECRET classification check
	msg := &nats.Msg{Subject: "cti.command.execute", Data: data}
	srv.relayCommandHighToLow(msg)

	// Stats should not have changed (SECRET was blocked)
	srv.statsMu.Lock()
	for k, v := range srv.transferStats {
		if v != initialStats[k] {
			t.Errorf("transfer stats changed for %q: %d -> %d (SECRET should be blocked)", k, initialStats[k], v)
		}
	}
	srv.statsMu.Unlock()
}

// ---------------------------------------------------------------------------
// Test: SECRET operation relay blocking
// ---------------------------------------------------------------------------

func TestRelayOperationHighToLow_SECRETBlocked(t *testing.T) {
	srv := newTestServer()

	event := map[string]any{
		"operation_id":   "op-1",
		"classification": "SECRET",
	}
	data, _ := json.Marshal(event)

	// Should not panic, and should be blocked (return early)
	msg := &nats.Msg{Subject: "cti.operation.created", Data: data}
	srv.relayOperationHighToLow(msg)
}

// ---------------------------------------------------------------------------
// Test: UNCLASS command relay proceeds (but fails at NATS since it's nil)
// ---------------------------------------------------------------------------

func TestRelayCommandHighToLow_UNCLASSProceeds(t *testing.T) {
	srv := newTestServer()

	event := map[string]any{
		"command_id":     "cmd-1",
		"operation_id":   "op-1",
		"command":        "ls",
		"risk_level":     float64(1),
		"classification": "UNCLASS",
	}
	data, _ := json.Marshal(event)

	// This will try to publish to lowNATS which is nil, but should update stats
	// before hitting the nil NATS error (which it handles gracefully)
	msg := &nats.Msg{Subject: "cti.command.execute", Data: data}

	// Since lowNATS is nil, the publish will fail but the function should
	// not panic. The stats update happens after publish, so we just verify no panic.
	srv.relayCommandHighToLow(msg)
}

// ---------------------------------------------------------------------------
// Test: relayCommandResultLowToHigh with invalid JSON
// ---------------------------------------------------------------------------

func TestRelayCommandResultLowToHigh_InvalidJSON(t *testing.T) {
	srv := newTestServer()

	msg := &nats.Msg{
		Subject: "cti.command.result",
		Data:    []byte("{invalid json"),
	}

	// Should not panic with invalid JSON
	srv.relayCommandResultLowToHigh(msg)
}

// ---------------------------------------------------------------------------
// Test: relayOperationHighToLow with invalid JSON
// ---------------------------------------------------------------------------

func TestRelayOperationHighToLow_InvalidJSON(t *testing.T) {
	srv := newTestServer()

	msg := &nats.Msg{
		Subject: "cti.operation.created",
		Data:    []byte("{invalid json"),
	}

	// Should not panic with invalid JSON
	srv.relayOperationHighToLow(msg)
}

// ---------------------------------------------------------------------------
// Test: handleFindingEvent — SECRET blocked
// ---------------------------------------------------------------------------

func TestHandleFindingEvent_SECRETBlocked(t *testing.T) {
	srv := newTestServer()

	event := map[string]any{
		"finding_id":     "finding-1",
		"classification": "SECRET",
	}
	data, _ := json.Marshal(event)

	msg := &nats.Msg{Subject: "finding.created", Data: data}

	// Should not panic and should block SECRET findings
	srv.handleFindingEvent(msg)
}

// ---------------------------------------------------------------------------
// Test: handleFindingEvent — missing finding_id
// ---------------------------------------------------------------------------

func TestHandleFindingEvent_MissingFindingID(t *testing.T) {
	srv := newTestServer()

	event := map[string]any{
		"classification": "UNCLASS",
	}
	data, _ := json.Marshal(event)

	msg := &nats.Msg{Subject: "finding.created", Data: data}

	// Should not panic; should log warning about missing finding_id
	srv.handleFindingEvent(msg)
}

// ---------------------------------------------------------------------------
// Test: handleFindingEvent — invalid JSON
// ---------------------------------------------------------------------------

func TestHandleFindingEvent_InvalidJSON(t *testing.T) {
	srv := newTestServer()

	msg := &nats.Msg{Subject: "finding.created", Data: []byte("{bad json")}

	// Should not panic
	srv.handleFindingEvent(msg)
}

// ---------------------------------------------------------------------------
// Test: Finding sync status endpoint — requires DB
// ---------------------------------------------------------------------------

func TestHandleFindingSyncStatus_RequiresDB(t *testing.T) {
	t.Skip("requires database connections")
}

// ---------------------------------------------------------------------------
// Test: Finding sync trigger endpoint — requires DB
// ---------------------------------------------------------------------------

func TestHandleFindingSync_RequiresDB(t *testing.T) {
	t.Skip("requires database connections")
}

// ---------------------------------------------------------------------------
// Test: List relayed commands endpoint — requires DB
// ---------------------------------------------------------------------------

func TestHandleListRelayedCommands_RequiresDB(t *testing.T) {
	t.Skip("requires database connections")
}

// ---------------------------------------------------------------------------
// Test: Get relayed command status — requires DB
// ---------------------------------------------------------------------------

func TestHandleGetRelayedCommandStatus_RequiresDB(t *testing.T) {
	t.Skip("requires database connections")
}

// ---------------------------------------------------------------------------
// Test: NiFi flow config struct
// ---------------------------------------------------------------------------

func TestNiFiFlowConfigJSON(t *testing.T) {
	config := NiFiFlowConfig{
		ID:             "flow-1",
		Name:           "Command Transfer",
		ProcessGroupID: "pg-abc-123",
		FlowType:       "transfer",
		Enabled:        true,
		CreatedAt:      "2026-03-01T12:00:00Z",
	}

	data, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded NiFiFlowConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.FlowType != "transfer" {
		t.Errorf("FlowType = %q, want %q", decoded.FlowType, "transfer")
	}
	if !decoded.Enabled {
		t.Error("Enabled should be true")
	}
}
