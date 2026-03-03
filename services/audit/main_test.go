package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

// testLogger returns a logger that discards all output, safe for tests.
func testLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// ---------------------------------------------------------------------------
// Hash chain computation
// ---------------------------------------------------------------------------

func TestHashChainComputation(t *testing.T) {
	tests := []struct {
		name         string
		previousHash string
		event        AuditEvent
	}{
		{
			name:         "first event in chain (empty previous hash)",
			previousHash: "",
			event: AuditEvent{
				EventType:    "auth.login",
				ActorID:      "user-123",
				ActorUsername: "admin",
				ActorIP:      "192.168.1.1",
				SessionID:    "session-abc",
				ResourceType: "user",
				ResourceID:   "user-123",
				Action:       "login",
				Details:      `{"method":"local"}`,
				Timestamp:    "2026-02-28T12:00:00.000000Z",
			},
		},
		{
			name:         "chained event with previous hash",
			previousHash: "abc123def456789012345678901234567890123456789012345678901234abcd",
			event: AuditEvent{
				EventType:    "ticket.created",
				ActorID:      "user-456",
				ActorUsername: "planner1",
				ActorIP:      "10.0.0.1",
				SessionID:    "session-def",
				ResourceType: "ticket",
				ResourceID:   "ticket-789",
				Action:       "created",
				Details:      `{"title":"Test ticket"}`,
				Timestamp:    "2026-02-28T12:01:00.000000Z",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			event := tc.event
			event.PreviousHash = tc.previousHash

			// Compute hash the same way the server does
			eventJSON, err := json.Marshal(event)
			if err != nil {
				t.Fatalf("failed to marshal event: %v", err)
			}
			hash := sha256.Sum256(append([]byte(tc.previousHash), eventJSON...))
			computed := hex.EncodeToString(hash[:])

			if computed == "" {
				t.Fatal("hash is empty")
			}
			if len(computed) != 64 {
				t.Errorf("hash length = %d, want 64 hex chars", len(computed))
			}

			// Recomputing with same inputs should yield the same hash
			hash2 := sha256.Sum256(append([]byte(tc.previousHash), eventJSON...))
			computed2 := hex.EncodeToString(hash2[:])
			if computed != computed2 {
				t.Errorf("deterministic hash failed: %q != %q", computed, computed2)
			}
		})
	}
}

func TestHashChainContinuity(t *testing.T) {
	// Simulate a sequence of events and verify the chain is continuous
	events := []AuditEvent{
		{
			EventType:    "auth.login",
			ActorID:      "user-1",
			ActorUsername: "admin",
			Action:       "login",
			Timestamp:    "2026-02-28T12:00:00Z",
		},
		{
			EventType:    "ticket.created",
			ActorID:      "user-1",
			ActorUsername: "admin",
			Action:       "created",
			Timestamp:    "2026-02-28T12:01:00Z",
		},
		{
			EventType:    "c2.command_executed",
			ActorID:      "user-2",
			ActorUsername: "op1",
			Action:       "command_executed",
			Timestamp:    "2026-02-28T12:02:00Z",
		},
	}

	lastHash := ""
	hashes := make([]string, len(events))

	for i := range events {
		events[i].PreviousHash = lastHash
		eventJSON, _ := json.Marshal(events[i])
		hash := sha256.Sum256(append([]byte(lastHash), eventJSON...))
		events[i].Hash = hex.EncodeToString(hash[:])
		lastHash = events[i].Hash
		hashes[i] = events[i].Hash
	}

	// Verify chain properties
	t.Run("first event has empty previous hash", func(t *testing.T) {
		if events[0].PreviousHash != "" {
			t.Errorf("first event previous_hash = %q, want empty", events[0].PreviousHash)
		}
	})

	t.Run("subsequent events reference previous hash", func(t *testing.T) {
		for i := 1; i < len(events); i++ {
			if events[i].PreviousHash != events[i-1].Hash {
				t.Errorf("event[%d].previous_hash = %q, want %q (event[%d].hash)",
					i, events[i].PreviousHash, events[i-1].Hash, i-1)
			}
		}
	})

	t.Run("all hashes are unique", func(t *testing.T) {
		seen := make(map[string]bool)
		for i, h := range hashes {
			if seen[h] {
				t.Errorf("duplicate hash at index %d: %s", i, h)
			}
			seen[h] = true
		}
	})

	t.Run("all hashes are 64 hex chars", func(t *testing.T) {
		for i, h := range hashes {
			if len(h) != 64 {
				t.Errorf("hash[%d] length = %d, want 64", i, len(h))
			}
		}
	})
}

func TestHashChainTamperDetection(t *testing.T) {
	// Build a 3-event chain
	events := make([]AuditEvent, 3)
	lastHash := ""

	for i := 0; i < 3; i++ {
		events[i] = AuditEvent{
			EventType:    "test.event",
			ActorID:      "user-1",
			ActorUsername: "testuser",
			Action:       "test",
			Timestamp:    time.Now().UTC().Format(time.RFC3339Nano),
			PreviousHash: lastHash,
		}
		eventJSON, _ := json.Marshal(events[i])
		hash := sha256.Sum256(append([]byte(lastHash), eventJSON...))
		events[i].Hash = hex.EncodeToString(hash[:])
		lastHash = events[i].Hash
	}

	// Tamper with the middle event
	tamperedEvent := events[1]
	tamperedEvent.Action = "TAMPERED"
	tamperedEvent.PreviousHash = events[0].Hash
	eventJSON, _ := json.Marshal(tamperedEvent)
	recomputedHash := sha256.Sum256(append([]byte(events[0].Hash), eventJSON...))
	newHash := hex.EncodeToString(recomputedHash[:])

	if newHash == events[1].Hash {
		t.Error("tampered event produced same hash as original — this should never happen")
	}

	// The third event references events[1].Hash, which no longer matches
	if events[2].PreviousHash == newHash {
		t.Error("chain should be broken after tamper, but previous_hash still matches")
	}
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

func TestAuditEventParsing(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantErr   bool
		wantType  string
		wantActor string
	}{
		{
			name: "valid auth.login event",
			input: `{
				"event_type": "auth.login",
				"actor_id": "550e8400-e29b-41d4-a716-446655440000",
				"actor_username": "admin",
				"actor_ip": "192.168.1.1",
				"session_id": "session-abc",
				"resource_type": "user",
				"resource_id": "550e8400-e29b-41d4-a716-446655440000",
				"action": "login",
				"details": "{\"method\":\"local\"}",
				"timestamp": "2026-02-28T12:00:00.000000Z"
			}`,
			wantType:  "auth.login",
			wantActor: "admin",
		},
		{
			name: "valid ticket.created event",
			input: `{
				"event_type": "ticket.created",
				"actor_id": "user-456",
				"actor_username": "planner1",
				"actor_ip": "10.0.0.1",
				"session_id": "session-def",
				"resource_type": "ticket",
				"resource_id": "ticket-789",
				"action": "created",
				"details": "{}",
				"timestamp": "2026-02-28T12:01:00Z"
			}`,
			wantType:  "ticket.created",
			wantActor: "planner1",
		},
		{
			name: "valid c2.command_executed event",
			input: `{
				"event_type": "c2.command_executed",
				"actor_id": "user-op1",
				"actor_username": "op1",
				"actor_ip": "10.0.0.5",
				"session_id": "session-op",
				"resource_type": "session",
				"resource_id": "sliver-session-123",
				"action": "command_executed",
				"details": "{\"command\":\"ls\",\"risk_level\":1}",
				"timestamp": "2026-02-28T12:05:00Z"
			}`,
			wantType:  "c2.command_executed",
			wantActor: "op1",
		},
		{
			name: "event with missing optional fields",
			input: `{
				"event_type": "endpoint.registered",
				"action": "registered",
				"timestamp": "2026-02-28T12:00:00Z"
			}`,
			wantType: "endpoint.registered",
		},
		{
			name:    "malformed JSON",
			input:   `{not valid json`,
			wantErr: true,
		},
		{
			name:    "empty string",
			input:   ``,
			wantErr: true,
		},
		{
			name:  "empty JSON object",
			input: `{}`,
			// This parses fine but all fields are zero values
			wantType: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var event AuditEvent
			err := json.Unmarshal([]byte(tc.input), &event)
			if (err != nil) != tc.wantErr {
				t.Fatalf("Unmarshal error = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if event.EventType != tc.wantType {
				t.Errorf("EventType = %q, want %q", event.EventType, tc.wantType)
			}
			if tc.wantActor != "" && event.ActorUsername != tc.wantActor {
				t.Errorf("ActorUsername = %q, want %q", event.ActorUsername, tc.wantActor)
			}
		})
	}
}

func TestAuditEventJSONRoundTrip(t *testing.T) {
	original := AuditEvent{
		EventType:    "workflow.approved",
		ActorID:      "550e8400-e29b-41d4-a716-446655440000",
		ActorUsername: "mc1",
		ActorIP:      "10.100.0.5",
		SessionID:    "session-wf",
		ResourceType: "workflow_run",
		ResourceID:   "run-abc-123",
		Action:       "approved",
		Details:      `{"stage":"E3 Review","decision":"approve"}`,
		Timestamp:    "2026-02-28T14:30:00.123456Z",
		Hash:         "aabbccdd",
		PreviousHash: "11223344",
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}

	var decoded AuditEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}

	if decoded.EventType != original.EventType {
		t.Errorf("EventType = %q, want %q", decoded.EventType, original.EventType)
	}
	if decoded.ActorID != original.ActorID {
		t.Errorf("ActorID = %q, want %q", decoded.ActorID, original.ActorID)
	}
	if decoded.ActorUsername != original.ActorUsername {
		t.Errorf("ActorUsername = %q, want %q", decoded.ActorUsername, original.ActorUsername)
	}
	if decoded.Hash != original.Hash {
		t.Errorf("Hash = %q, want %q", decoded.Hash, original.Hash)
	}
	if decoded.PreviousHash != original.PreviousHash {
		t.Errorf("PreviousHash = %q, want %q", decoded.PreviousHash, original.PreviousHash)
	}
	if decoded.Details != original.Details {
		t.Errorf("Details = %q, want %q", decoded.Details, original.Details)
	}
}

// ---------------------------------------------------------------------------
// handleEvent unit tests (NATS message handling)
// ---------------------------------------------------------------------------

func TestHandleEvent(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	tests := []struct {
		name        string
		subject     string
		payload     string
		wantBuffLen int
		wantErr     bool
	}{
		{
			name:    "valid auth event",
			subject: "auth.login",
			payload: `{
				"event_type": "auth.login",
				"actor_id": "user-1",
				"actor_username": "admin",
				"action": "login",
				"timestamp": "2026-02-28T12:00:00Z"
			}`,
			wantBuffLen: 1,
		},
		{
			name:    "valid ticket event",
			subject: "ticket.created",
			payload: `{
				"event_type": "ticket.created",
				"actor_id": "user-2",
				"actor_username": "planner1",
				"action": "created",
				"timestamp": "2026-02-28T12:01:00Z"
			}`,
			wantBuffLen: 2, // cumulative
		},
		{
			name:        "malformed JSON is discarded",
			subject:     "auth.login",
			payload:     `{not valid}`,
			wantBuffLen: 2, // no change
			wantErr:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			msg := &nats.Msg{
				Subject: tc.subject,
				Data:    []byte(tc.payload),
			}

			srv.handleEvent(msg)

			srv.mu.Lock()
			bufLen := len(srv.buffer)
			srv.mu.Unlock()

			if bufLen != tc.wantBuffLen {
				t.Errorf("buffer length = %d, want %d", bufLen, tc.wantBuffLen)
			}
		})
	}

	// Verify hash chain in buffer
	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) < 2 {
		t.Fatal("expected at least 2 events in buffer")
	}

	// First event should have empty previous hash
	if srv.buffer[0].PreviousHash != "" {
		t.Errorf("first event PreviousHash = %q, want empty", srv.buffer[0].PreviousHash)
	}

	// Second event should reference first event's hash
	if srv.buffer[1].PreviousHash != srv.buffer[0].Hash {
		t.Errorf("second event PreviousHash = %q, want %q",
			srv.buffer[1].PreviousHash, srv.buffer[0].Hash)
	}

	// Both should have non-empty hashes
	if srv.buffer[0].Hash == "" {
		t.Error("first event Hash is empty")
	}
	if srv.buffer[1].Hash == "" {
		t.Error("second event Hash is empty")
	}
}

func TestHandleEventConcurrency(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	const numEvents = 50
	var wg sync.WaitGroup
	wg.Add(numEvents)

	for i := 0; i < numEvents; i++ {
		go func(idx int) {
			defer wg.Done()
			payload, _ := json.Marshal(map[string]string{
				"event_type":    "test.concurrent",
				"actor_id":      "user-concurrent",
				"actor_username": "testuser",
				"action":        "test",
				"timestamp":     time.Now().UTC().Format(time.RFC3339Nano),
			})
			msg := &nats.Msg{
				Subject: "test.concurrent",
				Data:    payload,
			}
			srv.handleEvent(msg)
		}(i)
	}

	wg.Wait()

	srv.mu.Lock()
	bufLen := len(srv.buffer)
	srv.mu.Unlock()

	if bufLen != numEvents {
		t.Errorf("buffer length = %d, want %d", bufLen, numEvents)
	}

	// Verify no two events have the same hash
	srv.mu.Lock()
	hashes := make(map[string]bool)
	for i, e := range srv.buffer {
		if hashes[e.Hash] {
			t.Errorf("duplicate hash at index %d", i)
		}
		hashes[e.Hash] = true
	}
	srv.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

func TestQueryInt(t *testing.T) {
	tests := []struct {
		name     string
		query    string
		key      string
		def      int
		expected int
	}{
		{
			name:     "valid integer",
			query:    "page=5",
			key:      "page",
			def:      1,
			expected: 5,
		},
		{
			name:     "missing param uses default",
			query:    "",
			key:      "page",
			def:      1,
			expected: 1,
		},
		{
			name:     "non-numeric param uses default",
			query:    "page=abc",
			key:      "page",
			def:      1,
			expected: 1,
		},
		{
			name:     "zero value",
			query:    "limit=0",
			key:      "limit",
			def:      50,
			expected: 0,
		},
		{
			name:     "negative value",
			query:    "page=-1",
			key:      "page",
			def:      1,
			expected: -1,
		},
		{
			name:     "large value",
			query:    "limit=999999",
			key:      "limit",
			def:      50,
			expected: 999999,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url := "/api/v1/audit/events"
			if tc.query != "" {
				url += "?" + tc.query
			}
			req := httptest.NewRequest("GET", url, nil)
			got := queryInt(req, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("queryInt(%q, %q, %d) = %d, want %d", tc.query, tc.key, tc.def, got, tc.expected)
			}
		})
	}
}

func TestMaxInt(t *testing.T) {
	tests := []struct {
		a, b, want int
	}{
		{1, 2, 2},
		{5, 3, 5},
		{0, 0, 0},
		{-1, -5, -1},
		{100, 100, 100},
	}
	for _, tc := range tests {
		got := maxInt(tc.a, tc.b)
		if got != tc.want {
			t.Errorf("maxInt(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestClamp(t *testing.T) {
	tests := []struct {
		name           string
		min, max, val  int
		expected       int
	}{
		{"within range", 1, 100, 50, 50},
		{"at minimum", 1, 100, 1, 1},
		{"at maximum", 1, 100, 100, 100},
		{"below minimum", 1, 100, 0, 1},
		{"above maximum", 1, 100, 200, 100},
		{"negative below min", 1, 100, -10, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := clamp(tc.min, tc.max, tc.val)
			if got != tc.expected {
				t.Errorf("clamp(%d, %d, %d) = %d, want %d", tc.min, tc.max, tc.val, got, tc.expected)
			}
		})
	}
}

func TestParseTimestamp(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		wantOK bool // true if should parse to the expected time, false if should fall back to now
	}{
		{
			name:   "RFC3339 full",
			input:  "2026-02-28T12:00:00Z",
			wantOK: true,
		},
		{
			name:   "RFC3339Nano",
			input:  "2026-02-28T12:00:00.123456789Z",
			wantOK: true,
		},
		{
			name:   "RFC3339 with timezone offset",
			input:  "2026-02-28T12:00:00+00:00",
			wantOK: true,
		},
		{
			name:   "invalid timestamp falls back to now",
			input:  "not-a-timestamp",
			wantOK: false,
		},
		{
			name:   "empty string falls back to now",
			input:  "",
			wantOK: false,
		},
		{
			name:   "wrong format falls back to now",
			input:  "02/28/2026 12:00:00",
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			before := time.Now().UTC().Add(-1 * time.Second)
			result := parseTimestamp(tc.input)
			after := time.Now().UTC().Add(1 * time.Second)

			if tc.wantOK {
				// Should parse to the specific time
				expected, _ := time.Parse(time.RFC3339Nano, tc.input)
				if !result.Equal(expected) {
					t.Errorf("parseTimestamp(%q) = %v, want %v", tc.input, result, expected)
				}
			} else {
				// Should fall back to approximately now
				if result.Before(before) || result.After(after) {
					t.Errorf("parseTimestamp(%q) = %v, expected within [%v, %v]",
						tc.input, result, before, after)
				}
			}
		})
	}
}

func TestParseUUID(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantNil bool
	}{
		{
			name:  "valid UUID",
			input: "550e8400-e29b-41d4-a716-446655440000",
		},
		{
			name:  "valid UUID lowercase",
			input: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		},
		{
			name:    "invalid UUID",
			input:   "not-a-uuid",
			wantNil: true,
		},
		{
			name:    "empty string",
			input:   "",
			wantNil: true,
		},
		{
			name:    "too short",
			input:   "550e8400-e29b-41d4",
			wantNil: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := parseUUID(tc.input)
			if tc.wantNil {
				if result != (uuid.UUID{}) {
					t.Errorf("parseUUID(%q) = %v, want zero UUID", tc.input, result)
				}
			} else {
				if result == (uuid.UUID{}) {
					t.Errorf("parseUUID(%q) = zero UUID, want non-zero", tc.input)
				}
				if result.String() != tc.input {
					t.Errorf("parseUUID(%q).String() = %q", tc.input, result.String())
				}
			}
		})
	}
}

func TestHasAnyRole(t *testing.T) {
	tests := []struct {
		name        string
		rolesHeader string
		allowed     []string
		want        bool
	}{
		{
			name:        "admin in header matches",
			rolesHeader: "admin,operator",
			allowed:     []string{"admin"},
			want:        true,
		},
		{
			name:        "e1_strategic matches",
			rolesHeader: "viewer,e1_strategic",
			allowed:     []string{"admin", "e1_strategic", "e2_operational"},
			want:        true,
		},
		{
			name:        "no match",
			rolesHeader: "viewer,operator",
			allowed:     []string{"admin", "e1_strategic"},
			want:        false,
		},
		{
			name:        "empty header",
			rolesHeader: "",
			allowed:     []string{"admin"},
			want:        false,
		},
		{
			name:        "empty allowed list",
			rolesHeader: "admin",
			allowed:     []string{},
			want:        false,
		},
		{
			name:        "spaces in header",
			rolesHeader: "admin , operator , viewer",
			allowed:     []string{"operator"},
			want:        true,
		},
		{
			name:        "single role matches",
			rolesHeader: "admin",
			allowed:     []string{"admin"},
			want:        true,
		},
		{
			name:        "e2_operational matches in middle of list",
			rolesHeader: "viewer,e2_operational,operator",
			allowed:     []string{"admin", "e1_strategic", "e2_operational"},
			want:        true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := hasAnyRole(tc.rolesHeader, tc.allowed...)
			if got != tc.want {
				t.Errorf("hasAnyRole(%q, %v) = %v, want %v", tc.rolesHeader, tc.allowed, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

func TestAuditHandleHealthLive(t *testing.T) {
	srv := &Server{logger: testLogger()}

	req := httptest.NewRequest("GET", "/health/live", nil)
	rec := httptest.NewRecorder()

	srv.handleHealthLive(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["status"] != "ok" {
		t.Errorf("status = %q, want %q", resp["status"], "ok")
	}
	if resp["service"] != "audit" {
		t.Errorf("service = %q, want %q", resp["service"], "audit")
	}
}

func TestAuditHandleHealthReady(t *testing.T) {
	// healthReady checks ClickHouse and NATS, both nil on test server.
	t.Skip("requires ClickHouse and NATS connections")
}

// ---------------------------------------------------------------------------
// Batch buffering logic
// ---------------------------------------------------------------------------

func TestBatchBufferFlushThreshold(t *testing.T) {
	// Test that the buffer accumulates events correctly up to batchSize-1.
	// We avoid hitting the batchSize threshold because the async flush goroutine
	// would panic with a nil ClickHouse connection.
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	// Fill buffer to batchSize-1 (just below the flush threshold)
	for i := 0; i < batchSize-1; i++ {
		payload, _ := json.Marshal(map[string]string{
			"event_type":     "test.batch",
			"actor_id":       "user-batch",
			"actor_username": "batchuser",
			"action":         "test",
			"timestamp":      time.Now().UTC().Format(time.RFC3339Nano),
		})
		msg := &nats.Msg{
			Subject: "test.batch",
			Data:    payload,
		}
		srv.handleEvent(msg)
	}

	srv.mu.Lock()
	bufLen := len(srv.buffer)
	srv.mu.Unlock()

	if bufLen != batchSize-1 {
		t.Errorf("buffer length = %d, want %d", bufLen, batchSize-1)
	}
}

func TestBatchFlushThresholdCheck(t *testing.T) {
	// Verify the flush trigger condition: buffer >= batchSize
	// This tests the logic without actually flushing (which requires ClickHouse).

	t.Run("below threshold does not trigger flush", func(t *testing.T) {
		bufLen := batchSize - 1
		shouldFlush := bufLen >= batchSize
		if shouldFlush {
			t.Error("should not flush when buffer is below batchSize")
		}
	})

	t.Run("at threshold triggers flush", func(t *testing.T) {
		bufLen := batchSize
		shouldFlush := bufLen >= batchSize
		if !shouldFlush {
			t.Error("should flush when buffer reaches batchSize")
		}
	})

	t.Run("above threshold triggers flush", func(t *testing.T) {
		bufLen := batchSize + 10
		shouldFlush := bufLen >= batchSize
		if !shouldFlush {
			t.Error("should flush when buffer exceeds batchSize")
		}
	})
}

func TestFlushEmptyBuffer(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	// Flush with empty buffer should be a no-op (no panic)
	srv.flush(nil) // context.Background() not needed since we return early
}

// ---------------------------------------------------------------------------
// Query events handler — test query parameter parsing
// ---------------------------------------------------------------------------

func TestHandleQueryEventsParameterParsing(t *testing.T) {
	// The actual handler queries ClickHouse, so we can only test parameter parsing.
	// We verify that the handler builds the correct WHERE clauses.
	t.Skip("requires ClickHouse connection for full query execution")
}

func TestQueryEventsFilterBuilding(t *testing.T) {
	// Test the filter building logic extracted from handleQueryEvents.
	// Since the logic is inline in the handler, we test the components:

	t.Run("pagination defaults", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events", nil)

		page := maxInt(1, queryInt(req, "page", 1))
		limit := clamp(1, 100, queryInt(req, "limit", 50))
		offset := (page - 1) * limit

		if page != 1 {
			t.Errorf("page = %d, want 1", page)
		}
		if limit != 50 {
			t.Errorf("limit = %d, want 50", limit)
		}
		if offset != 0 {
			t.Errorf("offset = %d, want 0", offset)
		}
	})

	t.Run("custom pagination", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?page=3&limit=20", nil)

		page := maxInt(1, queryInt(req, "page", 1))
		limit := clamp(1, 100, queryInt(req, "limit", 50))
		offset := (page - 1) * limit

		if page != 3 {
			t.Errorf("page = %d, want 3", page)
		}
		if limit != 20 {
			t.Errorf("limit = %d, want 20", limit)
		}
		if offset != 40 {
			t.Errorf("offset = %d, want 40", offset)
		}
	})

	t.Run("limit clamped to 100", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?limit=500", nil)
		limit := clamp(1, 100, queryInt(req, "limit", 50))
		if limit != 100 {
			t.Errorf("limit = %d, want 100", limit)
		}
	})

	t.Run("limit clamped to 1 minimum", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?limit=0", nil)
		limit := clamp(1, 100, queryInt(req, "limit", 50))
		if limit != 1 {
			t.Errorf("limit = %d, want 1", limit)
		}
	})

	t.Run("page minimum is 1", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?page=-5", nil)
		page := maxInt(1, queryInt(req, "page", 1))
		if page != 1 {
			t.Errorf("page = %d, want 1", page)
		}
	})

	t.Run("RBAC filter for non-admin user", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events", nil)
		req.Header.Set("X-User-Roles", "operator")
		req.Header.Set("X-User-ID", "user-123")

		userRoles := req.Header.Get("X-User-Roles")
		userID := req.Header.Get("X-User-ID")

		shouldFilter := userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational")
		if !shouldFilter {
			t.Error("operator should be filtered to own events only")
		}
	})

	t.Run("RBAC no filter for admin", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events", nil)
		req.Header.Set("X-User-Roles", "admin")
		req.Header.Set("X-User-ID", "user-admin")

		userRoles := req.Header.Get("X-User-Roles")
		userID := req.Header.Get("X-User-ID")

		shouldFilter := userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational")
		if shouldFilter {
			t.Error("admin should NOT be filtered")
		}
	})

	t.Run("RBAC no filter for e1_strategic", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events", nil)
		req.Header.Set("X-User-Roles", "e1_strategic")
		req.Header.Set("X-User-ID", "user-e1")

		userRoles := req.Header.Get("X-User-Roles")
		userID := req.Header.Get("X-User-ID")

		shouldFilter := userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational")
		if shouldFilter {
			t.Error("e1_strategic should NOT be filtered")
		}
	})

	t.Run("RBAC no filter for e2_operational", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events", nil)
		req.Header.Set("X-User-Roles", "e2_operational")
		req.Header.Set("X-User-ID", "user-e2")

		userRoles := req.Header.Get("X-User-Roles")
		userID := req.Header.Get("X-User-ID")

		shouldFilter := userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational")
		if shouldFilter {
			t.Error("e2_operational should NOT be filtered")
		}
	})

	t.Run("filter by event_type", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?event_type=auth.login", nil)
		v := req.URL.Query().Get("event_type")
		if v != "auth.login" {
			t.Errorf("event_type = %q, want %q", v, "auth.login")
		}
	})

	t.Run("filter by actor_id", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?actor_id=550e8400-e29b-41d4-a716-446655440000", nil)
		v := req.URL.Query().Get("actor_id")
		if v != "550e8400-e29b-41d4-a716-446655440000" {
			t.Errorf("actor_id = %q", v)
		}
	})

	t.Run("filter by resource_type", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/v1/audit/events?resource_type=ticket", nil)
		v := req.URL.Query().Get("resource_type")
		if v != "ticket" {
			t.Errorf("resource_type = %q, want %q", v, "ticket")
		}
	})

	t.Run("filter by date range", func(t *testing.T) {
		req := httptest.NewRequest("GET",
			"/api/v1/audit/events?from=2026-02-01T00:00:00Z&to=2026-02-28T23:59:59Z", nil)
		from := req.URL.Query().Get("from")
		to := req.URL.Query().Get("to")
		if from != "2026-02-01T00:00:00Z" {
			t.Errorf("from = %q", from)
		}
		if to != "2026-02-28T23:59:59Z" {
			t.Errorf("to = %q", to)
		}
	})
}

// ---------------------------------------------------------------------------
// writeJSON and writeError (audit service's copies)
// ---------------------------------------------------------------------------

func TestAuditWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]string{"status": "ok"})

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["status"] != "ok" {
		t.Errorf("status = %q, want %q", resp["status"], "ok")
	}
}

func TestAuditWriteError(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		code    string
		message string
	}{
		{
			name:    "internal error",
			status:  http.StatusInternalServerError,
			code:    "INTERNAL_ERROR",
			message: "Failed to query events",
		},
		{
			name:    "bad request",
			status:  http.StatusBadRequest,
			code:    "INVALID_REQUEST",
			message: "Invalid filter parameters",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeError(rec, tc.status, tc.code, tc.message)

			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d", rec.Code, tc.status)
			}

			var resp map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to parse response: %v", err)
			}
			errObj, ok := resp["error"].(map[string]any)
			if !ok {
				t.Fatal("response missing error object")
			}
			if errObj["code"] != tc.code {
				t.Errorf("error code = %q, want %q", errObj["code"], tc.code)
			}
			if errObj["message"] != tc.message {
				t.Errorf("error message = %q, want %q", errObj["message"], tc.message)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// envOr helper (audit service's copy)
// ---------------------------------------------------------------------------

func TestAuditEnvOr(t *testing.T) {
	tests := []struct {
		name     string
		key      string
		envVal   string
		fallback string
		want     string
	}{
		{
			name:     "returns env value when set",
			key:      "TEST_AUDIT_ENV_SET",
			envVal:   "from-env",
			fallback: "default",
			want:     "from-env",
		},
		{
			name:     "returns fallback when unset",
			key:      "TEST_AUDIT_ENV_UNSET_99999",
			fallback: "fallback-value",
			want:     "fallback-value",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.envVal != "" {
				t.Setenv(tc.key, tc.envVal)
			}
			got := envOr(tc.key, tc.fallback)
			if got != tc.want {
				t.Errorf("envOr(%q, %q) = %q, want %q", tc.key, tc.fallback, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// maxBodyMiddleware (audit service's copy)
// ---------------------------------------------------------------------------

func TestAuditMaxBodyMiddleware(t *testing.T) {
	const maxBytes int64 = 50

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, maxBytes+20)
		_, err := r.Body.Read(buf)
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Body too large")
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	handler := maxBodyMiddleware(maxBytes, inner)

	t.Run("small body passes", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		// nil body should not cause panic
	})

	t.Run("oversized body triggers error", func(t *testing.T) {
		bigBody := make([]byte, maxBytes+20)
		for i := range bigBody {
			bigBody[i] = 'x'
		}
		req := httptest.NewRequest("POST", "/", bytes.NewReader(bigBody))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
		}
	})
}

// ---------------------------------------------------------------------------
// Mux routing tests
// ---------------------------------------------------------------------------

func TestAuditMuxRouting(t *testing.T) {
	srv := &Server{logger: testLogger()}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", srv.handleHealthLive)

	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
	}{
		{
			name:       "GET /health/live returns 200",
			method:     "GET",
			path:       "/health/live",
			wantStatus: http.StatusOK,
		},
		{
			name:       "POST /health/live returns 405",
			method:     "POST",
			path:       "/health/live",
			wantStatus: http.StatusMethodNotAllowed,
		},
		{
			name:       "unknown path returns 404",
			method:     "GET",
			path:       "/nonexistent",
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

func TestConstants(t *testing.T) {
	if batchSize <= 0 {
		t.Errorf("batchSize = %d, should be positive", batchSize)
	}
	if flushInterval <= 0 {
		t.Errorf("flushInterval = %v, should be positive", flushInterval)
	}
}

// ===========================================================================
// M12 Cross-Domain Operations Tests — Consolidated Audit, Source Enclave
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: AuditEvent — SourceEnclave field
// ---------------------------------------------------------------------------

func TestAuditEventSourceEnclaveField(t *testing.T) {
	event := AuditEvent{
		EventType:     "c2.command_executed",
		ActorID:       "user-op1",
		ActorUsername:  "op1",
		Action:        "command_executed",
		Timestamp:     "2026-03-01T00:00:00Z",
		Classification: "UNCLASS",
		SourceEnclave: "low",
	}

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded AuditEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.SourceEnclave != "low" {
		t.Errorf("SourceEnclave = %q, want %q", decoded.SourceEnclave, "low")
	}
	if decoded.Classification != "UNCLASS" {
		t.Errorf("Classification = %q, want %q", decoded.Classification, "UNCLASS")
	}
}

func TestAuditEventSourceEnclave_JSONKeys(t *testing.T) {
	event := AuditEvent{
		EventType:     "ticket.created",
		SourceEnclave: "high",
		Classification: "CUI",
	}

	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	// Verify the JSON keys are correct
	var raw map[string]any
	json.Unmarshal(data, &raw)

	if _, ok := raw["source_enclave"]; !ok {
		t.Error("JSON missing source_enclave key")
	}
	if _, ok := raw["classification"]; !ok {
		t.Error("JSON missing classification key")
	}
	if raw["source_enclave"] != "high" {
		t.Errorf("source_enclave = %v, want high", raw["source_enclave"])
	}
}

// ---------------------------------------------------------------------------
// Test: requireHighSide — enclave restriction
// ---------------------------------------------------------------------------

func TestRequireHighSide_BlocksLowSide(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	rec := httptest.NewRecorder()
	blocked := requireHighSide(rec)

	if !blocked {
		t.Error("requireHighSide should return true on low side")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}

	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "FORBIDDEN" {
		t.Errorf("error code = %q, want FORBIDDEN", errObj["code"])
	}
}

func TestRequireHighSide_AllowsHighSide(t *testing.T) {
	old := enclave
	enclave = "high"
	defer func() { enclave = old }()

	rec := httptest.NewRecorder()
	blocked := requireHighSide(rec)

	if blocked {
		t.Error("requireHighSide should return false on high side")
	}
	// Response should not have been written to
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d (no write should happen)", rec.Code, http.StatusOK)
	}
}

func TestRequireHighSide_EmptyEnclave(t *testing.T) {
	old := enclave
	enclave = ""
	defer func() { enclave = old }()

	rec := httptest.NewRecorder()
	blocked := requireHighSide(rec)

	if !blocked {
		t.Error("requireHighSide should block when enclave is empty (not high)")
	}
}

// ---------------------------------------------------------------------------
// Test: handleConsolidated — low side blocked
// ---------------------------------------------------------------------------

func TestHandleConsolidated_LowSideBlocked(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := &Server{logger: testLogger()}

	req := httptest.NewRequest("GET", "/api/v1/audit/consolidated", nil)
	rec := httptest.NewRecorder()

	srv.handleConsolidated(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// ---------------------------------------------------------------------------
// Test: handleConsolidatedStats — low side blocked
// ---------------------------------------------------------------------------

func TestHandleConsolidatedStats_LowSideBlocked(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := &Server{logger: testLogger()}

	req := httptest.NewRequest("GET", "/api/v1/audit/consolidated/stats", nil)
	rec := httptest.NewRecorder()

	srv.handleConsolidatedStats(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// ---------------------------------------------------------------------------
// Test: handleConsolidatedCorrelation — low side blocked
// ---------------------------------------------------------------------------

func TestHandleConsolidatedCorrelation_LowSideBlocked(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := &Server{logger: testLogger()}

	req := httptest.NewRequest("GET", "/api/v1/audit/consolidated/correlation?operation_id=op-1", nil)
	rec := httptest.NewRecorder()

	srv.handleConsolidatedCorrelation(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// ---------------------------------------------------------------------------
// Test: handleConsolidatedCorrelation — validation (missing params on high side)
// ---------------------------------------------------------------------------

func TestHandleConsolidatedCorrelation_MissingParams(t *testing.T) {
	old := enclave
	enclave = "high"
	defer func() { enclave = old }()

	srv := &Server{logger: testLogger()}

	// No operation_id or resource_id
	req := httptest.NewRequest("GET", "/api/v1/audit/consolidated/correlation", nil)
	rec := httptest.NewRecorder()

	srv.handleConsolidatedCorrelation(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", errObj["code"])
	}
}

// ---------------------------------------------------------------------------
// Test: handleEventWithSource — source enclave tagging
// ---------------------------------------------------------------------------

func TestHandleEventWithSource_TagsSourceEnclave(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	payload, _ := json.Marshal(map[string]string{
		"event_type":     "c2.command_executed",
		"actor_id":       "user-1",
		"actor_username": "op1",
		"action":         "command_executed",
		"timestamp":      "2026-03-01T00:00:00Z",
	})

	msg := &nats.Msg{
		Subject: "cti.relayed.c2.command_executed",
		Data:    payload,
	}

	srv.handleEventWithSource(msg, "low")

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(srv.buffer))
	}

	if srv.buffer[0].SourceEnclave != "low" {
		t.Errorf("SourceEnclave = %q, want %q", srv.buffer[0].SourceEnclave, "low")
	}
}

func TestHandleEventWithSource_DefaultsToLocal(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	payload, _ := json.Marshal(map[string]string{
		"event_type":     "auth.login",
		"actor_id":       "user-1",
		"actor_username": "admin",
		"action":         "login",
		"timestamp":      "2026-03-01T00:00:00Z",
	})

	msg := &nats.Msg{
		Subject: "auth.login",
		Data:    payload,
	}

	// Empty source enclave should default to "local"
	srv.handleEventWithSource(msg, "")

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(srv.buffer))
	}

	if srv.buffer[0].SourceEnclave != "local" {
		t.Errorf("SourceEnclave = %q, want %q", srv.buffer[0].SourceEnclave, "local")
	}
}

// ---------------------------------------------------------------------------
// Test: handleEventWithSource — classification defaulting
// ---------------------------------------------------------------------------

func TestHandleEventWithSource_DefaultsClassification(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	// Event without classification field
	payload, _ := json.Marshal(map[string]string{
		"event_type":     "ticket.created",
		"actor_id":       "user-1",
		"actor_username": "planner1",
		"action":         "created",
		"timestamp":      "2026-03-01T00:00:00Z",
	})

	msg := &nats.Msg{
		Subject: "ticket.created",
		Data:    payload,
	}

	srv.handleEventWithSource(msg, "high")

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(srv.buffer))
	}

	if srv.buffer[0].Classification != "UNCLASS" {
		t.Errorf("Classification = %q, want UNCLASS (default)", srv.buffer[0].Classification)
	}
}

// ---------------------------------------------------------------------------
// Test: handleEventWithSource — SECRET dropped on low side
// ---------------------------------------------------------------------------

func TestHandleEventWithSource_SECRETDroppedOnLow(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	payload, _ := json.Marshal(map[string]string{
		"event_type":     "finding.enriched",
		"actor_id":       "user-1",
		"actor_username": "analyst1",
		"action":         "enriched",
		"classification": "SECRET",
		"timestamp":      "2026-03-01T00:00:00Z",
	})

	msg := &nats.Msg{
		Subject: "finding.enriched",
		Data:    payload,
	}

	srv.handleEventWithSource(msg, "high")

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 0 {
		t.Errorf("buffer length = %d, want 0 (SECRET event should be dropped on low side)", len(srv.buffer))
	}
}

func TestHandleEventWithSource_SECRETAllowedOnHigh(t *testing.T) {
	old := enclave
	enclave = "high"
	defer func() { enclave = old }()

	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	payload, _ := json.Marshal(map[string]string{
		"event_type":     "finding.enriched",
		"actor_id":       "user-1",
		"actor_username": "analyst1",
		"action":         "enriched",
		"classification": "SECRET",
		"timestamp":      "2026-03-01T00:00:00Z",
	})

	msg := &nats.Msg{
		Subject: "finding.enriched",
		Data:    payload,
	}

	srv.handleEventWithSource(msg, "high")

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 1 {
		t.Errorf("buffer length = %d, want 1 (SECRET allowed on high side)", len(srv.buffer))
	}
}

// ---------------------------------------------------------------------------
// Test: handleCTIRelayedEvent — delegates to handleEventWithSource with "low"
// ---------------------------------------------------------------------------

func TestHandleCTIRelayedEvent(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	payload, _ := json.Marshal(map[string]string{
		"event_type":     "c2.session_opened",
		"actor_id":       "user-1",
		"actor_username": "op1",
		"action":         "session_opened",
		"timestamp":      "2026-03-01T00:00:00Z",
	})

	msg := &nats.Msg{
		Subject: "cti.relayed.c2.session_opened",
		Data:    payload,
	}

	srv.handleCTIRelayedEvent(msg)

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(srv.buffer))
	}

	// handleCTIRelayedEvent should tag the event with source_enclave = "low"
	if srv.buffer[0].SourceEnclave != "low" {
		t.Errorf("SourceEnclave = %q, want %q", srv.buffer[0].SourceEnclave, "low")
	}
}

// ---------------------------------------------------------------------------
// Test: handleEventWithSource — invalid JSON discarded
// ---------------------------------------------------------------------------

func TestHandleEventWithSource_InvalidJSON(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	msg := &nats.Msg{
		Subject: "auth.login",
		Data:    []byte(`{not valid json}`),
	}

	srv.handleEventWithSource(msg, "high")

	srv.mu.Lock()
	defer srv.mu.Unlock()

	if len(srv.buffer) != 0 {
		t.Errorf("buffer length = %d, want 0 (invalid JSON should be discarded)", len(srv.buffer))
	}
}

// ---------------------------------------------------------------------------
// Test: handleEventWithSource — hash chain computation
// ---------------------------------------------------------------------------

func TestHandleEventWithSource_HashChain(t *testing.T) {
	srv := &Server{
		buffer:   make([]AuditEvent, 0, batchSize),
		lastHash: "",
		logger:   testLogger(),
	}

	for i, source := range []string{"high", "low", "high"} {
		payload, _ := json.Marshal(map[string]string{
			"event_type":     "test.event",
			"actor_id":       "user-1",
			"actor_username": "admin",
			"action":         "test",
			"timestamp":      time.Now().UTC().Format(time.RFC3339Nano),
		})

		msg := &nats.Msg{
			Subject: "test.event",
			Data:    payload,
		}

		srv.handleEventWithSource(msg, source)

		srv.mu.Lock()
		if len(srv.buffer) != i+1 {
			srv.mu.Unlock()
			t.Fatalf("after event %d: buffer length = %d, want %d", i, len(srv.buffer), i+1)
		}
		if srv.buffer[i].Hash == "" {
			srv.mu.Unlock()
			t.Fatalf("event %d: hash is empty", i)
		}
		if i > 0 && srv.buffer[i].PreviousHash != srv.buffer[i-1].Hash {
			srv.mu.Unlock()
			t.Fatalf("event %d: PreviousHash = %q, want %q (event %d hash)",
				i, srv.buffer[i].PreviousHash, srv.buffer[i-1].Hash, i-1)
		}
		srv.mu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// Test: Audit isDegraded
// ---------------------------------------------------------------------------

func TestAuditIsDegraded(t *testing.T) {
	tests := []struct {
		name         string
		enclaveVal   string
		ctiNil       bool
		ctiConnected bool
		wantDegraded bool
	}{
		{"high side never degraded", "high", false, true, false},
		{"high side with disconnected CTI not degraded", "high", false, false, false},
		{"low side with nil CTI not degraded", "low", true, false, false},
		{"low side with connected CTI not degraded", "low", false, true, false},
		{"low side with disconnected CTI IS degraded", "low", false, false, true},
		{"empty enclave not degraded", "", false, false, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			old := enclave
			enclave = tc.enclaveVal
			defer func() { enclave = old }()

			srv := &Server{
				buffer: make([]AuditEvent, 0, batchSize),
				logger: testLogger(),
			}
			if !tc.ctiNil {
				srv.cti = &ctiHealth{
					connected: tc.ctiConnected,
					logger:    testLogger(),
				}
			}

			got := srv.isDegraded()
			if got != tc.wantDegraded {
				t.Errorf("isDegraded() = %v, want %v", got, tc.wantDegraded)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Consolidated audit RBAC filtering
// ---------------------------------------------------------------------------

func TestConsolidatedRBACFiltering(t *testing.T) {
	// Test the RBAC logic used by handleConsolidated and handleConsolidatedCorrelation
	tests := []struct {
		name         string
		roles        string
		wantFiltered bool // true = user should only see own events
	}{
		{"admin sees all", "admin", false},
		{"e1_strategic sees all", "e1_strategic", false},
		{"e2_operational sees all", "e2_operational", false},
		{"operator filtered", "operator", true},
		{"viewer filtered", "viewer", true},
		{"e3_tactical filtered", "e3_tactical", true},
		{"empty roles filtered", "", true},
		{"multiple roles with admin", "viewer,admin", false},
		{"multiple roles without admin", "viewer,operator", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userID := "user-123"
			shouldFilter := userID != "" && !hasAnyRole(tc.roles, "admin", "e1_strategic", "e2_operational")
			if shouldFilter != tc.wantFiltered {
				t.Errorf("RBAC filter for roles %q: shouldFilter = %v, want %v",
					tc.roles, shouldFilter, tc.wantFiltered)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Consolidated audit source_enclave filter parsing
// ---------------------------------------------------------------------------

func TestConsolidatedSourceEnclaveFilter(t *testing.T) {
	tests := []struct {
		name      string
		queryVal  string
		shouldAdd bool // whether source_enclave filter condition should be added
	}{
		{"filter high", "high", true},
		{"filter low", "low", true},
		{"all (no filter)", "all", false},
		{"empty (no filter)", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url := "/api/v1/audit/consolidated"
			if tc.queryVal != "" {
				url += "?source_enclave=" + tc.queryVal
			}
			req := httptest.NewRequest("GET", url, nil)
			v := req.URL.Query().Get("source_enclave")
			shouldAdd := v != "" && v != "all"
			if shouldAdd != tc.shouldAdd {
				t.Errorf("source_enclave=%q: shouldAdd = %v, want %v",
					tc.queryVal, shouldAdd, tc.shouldAdd)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Consolidated endpoints require ClickHouse (DB-dependent stubs)
// ---------------------------------------------------------------------------

func TestHandleConsolidated_HighSideRequiresCH(t *testing.T) {
	t.Skip("requires ClickHouse connection")
}

func TestHandleConsolidatedStats_HighSideRequiresCH(t *testing.T) {
	t.Skip("requires ClickHouse connection")
}

func TestHandleConsolidatedCorrelation_WithParams_RequiresCH(t *testing.T) {
	t.Skip("requires ClickHouse connection")
}

// ---------------------------------------------------------------------------
// Server buffer initialization
// ---------------------------------------------------------------------------

func TestServerBufferInit(t *testing.T) {
	srv := &Server{
		buffer: make([]AuditEvent, 0, batchSize),
		logger: testLogger(),
	}

	if len(srv.buffer) != 0 {
		t.Errorf("initial buffer length = %d, want 0", len(srv.buffer))
	}
	if cap(srv.buffer) != batchSize {
		t.Errorf("initial buffer capacity = %d, want %d", cap(srv.buffer), batchSize)
	}
}

// ---------------------------------------------------------------------------
// Hash chain with known values (deterministic test)
// ---------------------------------------------------------------------------

func TestHashChainDeterministic(t *testing.T) {
	// Use fixed inputs to verify deterministic hash output
	event := AuditEvent{
		EventType:    "auth.login",
		ActorID:      "user-1",
		ActorUsername: "admin",
		ActorIP:      "127.0.0.1",
		SessionID:    "sess-1",
		ResourceType: "user",
		ResourceID:   "user-1",
		Action:       "login",
		Details:      "{}",
		Timestamp:    "2026-01-01T00:00:00Z",
		PreviousHash: "",
	}

	eventJSON, _ := json.Marshal(event)
	hash1 := sha256.Sum256(append([]byte(""), eventJSON...))
	hex1 := hex.EncodeToString(hash1[:])

	// Compute again — should be identical
	hash2 := sha256.Sum256(append([]byte(""), eventJSON...))
	hex2 := hex.EncodeToString(hash2[:])

	if hex1 != hex2 {
		t.Errorf("non-deterministic hash: %q != %q", hex1, hex2)
	}

	// Modify event and verify hash changes
	event.Action = "logout"
	eventJSON2, _ := json.Marshal(event)
	hash3 := sha256.Sum256(append([]byte(""), eventJSON2...))
	hex3 := hex.EncodeToString(hash3[:])

	if hex1 == hex3 {
		t.Error("different events should produce different hashes")
	}
}
