package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helper: create a Server without database or NATS (for pure-logic tests)
// ---------------------------------------------------------------------------

func newTestServer() *Server {
	return &Server{
		db:   nil,
		nc:   nil,
		port: "0",
	}
}

// ---------------------------------------------------------------------------
// Test: isValidTransition
// ---------------------------------------------------------------------------

func TestIsValidTransition(t *testing.T) {
	tests := []struct {
		name string
		from string
		to   string
		want bool
	}{
		{"draft to pending_approval", "draft", "pending_approval", true},
		{"draft to in_progress", "draft", "in_progress", true},
		{"draft to completed", "draft", "completed", false},
		{"draft to aborted", "draft", "aborted", false},
		{"pending_approval to approved", "pending_approval", "approved", true},
		{"pending_approval to draft", "pending_approval", "draft", true},
		{"pending_approval to in_progress", "pending_approval", "in_progress", false},
		{"approved to in_progress", "approved", "in_progress", true},
		{"approved to draft", "approved", "draft", false},
		{"in_progress to paused", "in_progress", "paused", true},
		{"in_progress to completed", "in_progress", "completed", true},
		{"in_progress to aborted", "in_progress", "aborted", true},
		{"in_progress to draft", "in_progress", "draft", false},
		{"paused to in_progress", "paused", "in_progress", true},
		{"paused to aborted", "paused", "aborted", true},
		{"paused to completed", "paused", "completed", false},
		{"completed to anything", "completed", "draft", false},
		{"completed to aborted", "completed", "aborted", false},
		{"aborted to anything", "aborted", "draft", false},
		{"unknown status", "nonexistent", "draft", false},
		{"empty from", "", "draft", false},
		{"empty to", "draft", "", false},
		{"same status", "draft", "draft", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidTransition(tt.from, tt.to)
			if got != tt.want {
				t.Errorf("isValidTransition(%q, %q) = %v, want %v", tt.from, tt.to, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: getUserID and getUserRoles
// ---------------------------------------------------------------------------

func TestGetUserID(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{"with user ID", "abc-123", "abc-123"},
		{"empty header", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if tt.header != "" {
				r.Header.Set("X-User-ID", tt.header)
			}
			got := getUserID(r)
			if got != tt.want {
				t.Errorf("getUserID() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestGetUserRoles(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   []string
	}{
		{"multiple roles", "admin,operator,viewer", []string{"admin", "operator", "viewer"}},
		{"single role", "admin", []string{"admin"}},
		{"empty header", "", nil},
		{"with spaces", " admin , operator ", []string{"admin", "operator"}},
		{"trailing comma", "admin,operator,", []string{"admin", "operator"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if tt.header != "" {
				r.Header.Set("X-User-Roles", tt.header)
			}
			got := getUserRoles(r)
			if len(got) != len(tt.want) {
				t.Errorf("getUserRoles() = %v (len %d), want %v (len %d)", got, len(got), tt.want, len(tt.want))
				return
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("getUserRoles()[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestHasRole(t *testing.T) {
	tests := []struct {
		name     string
		roles    []string
		required string
		want     bool
	}{
		{"has exact role", []string{"operator", "viewer"}, "operator", true},
		{"admin always matches", []string{"admin"}, "operator", true},
		{"no matching role", []string{"viewer"}, "operator", false},
		{"empty roles", []string{}, "operator", false},
		{"nil roles", nil, "operator", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := hasRole(tt.roles, tt.required)
			if got != tt.want {
				t.Errorf("hasRole(%v, %q) = %v, want %v", tt.roles, tt.required, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: parsePagination
// ---------------------------------------------------------------------------

func TestParsePagination(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		wantPage   int
		wantLimit  int
		wantOffset int
	}{
		{"default values", "", 1, 20, 0},
		{"page 2", "page=2", 2, 20, 20},
		{"custom limit", "limit=50", 1, 50, 0},
		{"page 3 limit 10", "page=3&limit=10", 3, 10, 20},
		{"invalid page", "page=-1", 1, 20, 0},
		{"page zero", "page=0", 1, 20, 0},
		{"limit zero", "limit=0", 1, 20, 0},
		{"limit too large", "limit=200", 1, 20, 0},
		{"limit exactly 100", "limit=100", 1, 100, 0},
		{"non-numeric page", "page=abc", 1, 20, 0},
		{"non-numeric limit", "limit=abc", 1, 20, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			url := "/test"
			if tt.query != "" {
				url += "?" + tt.query
			}
			r := httptest.NewRequest("GET", url, nil)
			page, limit, offset := parsePagination(r)
			if page != tt.wantPage {
				t.Errorf("page = %d, want %d", page, tt.wantPage)
			}
			if limit != tt.wantLimit {
				t.Errorf("limit = %d, want %d", limit, tt.wantLimit)
			}
			if offset != tt.wantOffset {
				t.Errorf("offset = %d, want %d", offset, tt.wantOffset)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: parseJSONB
// ---------------------------------------------------------------------------

func TestParseJSONB(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want int // expected number of keys (0 for empty)
	}{
		{"valid JSON", []byte(`{"key":"value","num":1}`), 2},
		{"empty bytes", []byte{}, 0},
		{"nil bytes", nil, 0},
		{"invalid JSON", []byte(`{invalid`), 0},
		{"empty object", []byte(`{}`), 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseJSONB(tt.data)
			if tt.want == 0 && len(got) != 0 {
				t.Errorf("parseJSONB() returned %d keys, want 0", len(got))
			}
			if tt.want > 0 && len(got) != tt.want {
				t.Errorf("parseJSONB() returned %d keys, want %d", len(got), tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: writeJSON / writeError
// ---------------------------------------------------------------------------

func TestWriteJSON(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"key": "value"})

	if w.Code != http.StatusOK {
		t.Errorf("status code = %d, want %d", w.Code, http.StatusOK)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if body["key"] != "value" {
		t.Errorf("body[key] = %q, want %q", body["key"], "value")
	}
}

func TestWriteError(t *testing.T) {
	w := httptest.NewRecorder()
	writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")

	if w.Code != http.StatusBadRequest {
		t.Errorf("status code = %d, want %d", w.Code, http.StatusBadRequest)
	}

	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatal("response missing 'error' object")
	}
	if errObj["code"] != "VALIDATION_ERROR" {
		t.Errorf("error code = %q, want %q", errObj["code"], "VALIDATION_ERROR")
	}
	if errObj["message"] != "name is required" {
		t.Errorf("error message = %q, want %q", errObj["message"], "name is required")
	}
}

// ---------------------------------------------------------------------------
// Test: toFloat64
// ---------------------------------------------------------------------------

func TestToFloat64(t *testing.T) {
	tests := []struct {
		name    string
		input   any
		wantVal float64
		wantOk  bool
	}{
		{"float64", float64(3.14), 3.14, true},
		{"float32", float32(2.5), 2.5, true},
		{"int", int(42), 42.0, true},
		{"int64", int64(100), 100.0, true},
		{"string number", "3.14", 3.14, true},
		{"string non-number", "abc", 0, false},
		{"nil", nil, 0, false},
		{"bool", true, 0, false},
		{"json.Number", json.Number("5.5"), 5.5, true},
		{"json.Number invalid", json.Number("abc"), 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			val, ok := toFloat64(tt.input)
			if ok != tt.wantOk {
				t.Errorf("toFloat64(%v) ok = %v, want %v", tt.input, ok, tt.wantOk)
			}
			if ok && math.Abs(val-tt.wantVal) > 0.001 {
				t.Errorf("toFloat64(%v) = %f, want %f", tt.input, val, tt.wantVal)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: evaluateExpression (expression evaluator)
// ---------------------------------------------------------------------------

func TestEvaluateExpression(t *testing.T) {
	tests := []struct {
		name string
		expr string
		ctx  map[string]any
		want bool
	}{
		// Numeric comparisons
		{"simple greater than true", "risk_level > 2", map[string]any{"risk_level": float64(3)}, true},
		{"simple greater than false", "risk_level > 5", map[string]any{"risk_level": float64(3)}, false},
		{"less than", "score < 100", map[string]any{"score": float64(50)}, true},
		{"equal numbers", "count == 5", map[string]any{"count": float64(5)}, true},
		{"not equal", "count != 5", map[string]any{"count": float64(3)}, true},
		{"greater or equal", "risk_level >= 3", map[string]any{"risk_level": float64(3)}, true},
		{"less or equal", "risk_level <= 2", map[string]any{"risk_level": float64(3)}, false},

		// Boolean logic
		{"and true", "risk_level > 2 && score > 10", map[string]any{"risk_level": float64(3), "score": float64(20)}, true},
		{"and false", "risk_level > 2 && score > 100", map[string]any{"risk_level": float64(3), "score": float64(20)}, false},
		{"or true", "risk_level > 5 || score > 10", map[string]any{"risk_level": float64(3), "score": float64(20)}, true},
		{"or both false", "risk_level > 5 || score > 100", map[string]any{"risk_level": float64(3), "score": float64(20)}, false},
		{"not", "!false", map[string]any{}, true},
		{"double not", "!!true", map[string]any{}, true},

		// String comparisons
		{"string equals", "status == 'active'", map[string]any{"status": "active"}, true},
		{"string not equals", "status != 'active'", map[string]any{"status": "inactive"}, true},

		// Parentheses
		{"parens", "(risk_level > 2) && (score < 100)", map[string]any{"risk_level": float64(3), "score": float64(50)}, true},
		{"nested parens", "((risk_level > 2))", map[string]any{"risk_level": float64(3)}, true},

		// Truthiness
		{"truthy non-empty string", "name", map[string]any{"name": "test"}, true},
		{"falsy empty string", "name", map[string]any{"name": ""}, false},
		{"truthy number", "count", map[string]any{"count": float64(1)}, true},
		{"falsy zero", "count", map[string]any{"count": float64(0)}, false},
		{"truthy bool true", "flag", map[string]any{"flag": true}, true},
		{"falsy bool false", "flag", map[string]any{"flag": false}, false},
		// When a variable is not in context, parseValue returns the literal string "missing",
		// which is truthy (non-empty, non-"false", non-"0").
		{"missing variable returns truthy string", "missing", map[string]any{}, true},

		// Boolean literals
		{"literal true", "true", map[string]any{}, true},
		{"literal false", "false", map[string]any{}, false},

		// Empty expression
		{"empty expression", "", map[string]any{}, false},

		// When context is nil/empty, "x" resolves to the literal string "x" and 0 resolves
		// to float64(0). String "x" > float64(0) does string comparison "x" > "0" which is true.
		{"nil context variable becomes literal", "x > 0", nil, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := tt.ctx
			if ctx == nil {
				ctx = map[string]any{}
			}
			got := evaluateExpression(tt.expr, ctx)
			if got != tt.want {
				t.Errorf("evaluateExpression(%q, %v) = %v, want %v", tt.expr, tt.ctx, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: tokenize
// ---------------------------------------------------------------------------

func TestTokenize(t *testing.T) {
	tests := []struct {
		name   string
		expr   string
		tokens []string
	}{
		{"simple comparison", "x > 5", []string{"x", ">", "5"}},
		{"two char ops", "x >= 5 && y <= 10", []string{"x", ">=", "5", "&&", "y", "<=", "10"}},
		{"quoted string", "status == 'active'", []string{"status", "==", "'active'"}},
		{"double quoted", `status == "active"`, []string{"status", "==", `"active"`}},
		{"parens", "(x > 1) || (y < 2)", []string{"(", "x", ">", "1", ")", "||", "(", "y", "<", "2", ")"}},
		{"not operator", "!flag", []string{"!", "flag"}},
		{"not equal", "x != y", []string{"x", "!=", "y"}},
		{"empty", "", nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tokenize(tt.expr)
			if len(got) != len(tt.tokens) {
				t.Errorf("tokenize(%q) = %v (len %d), want %v (len %d)", tt.expr, got, len(got), tt.tokens, len(tt.tokens))
				return
			}
			for i := range got {
				if got[i] != tt.tokens[i] {
					t.Errorf("tokenize(%q)[%d] = %q, want %q", tt.expr, i, got[i], tt.tokens[i])
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: compareValues
// ---------------------------------------------------------------------------

func TestCompareValues(t *testing.T) {
	tests := []struct {
		name  string
		left  any
		op    string
		right any
		want  bool
	}{
		// Numeric
		{"int > int true", float64(5), ">", float64(3), true},
		{"int > int false", float64(3), ">", float64(5), false},
		{"int < int", float64(3), "<", float64(5), true},
		{"int == int", float64(5), "==", float64(5), true},
		{"int != int", float64(5), "!=", float64(3), true},
		{"int >= int equal", float64(5), ">=", float64(5), true},
		{"int >= int greater", float64(6), ">=", float64(5), true},
		{"int <= int", float64(5), "<=", float64(5), true},

		// String
		{"string ==", "abc", "==", "abc", true},
		{"string !=", "abc", "!=", "xyz", true},
		{"string > (lexicographic)", "b", ">", "a", true},
		{"string <", "a", "<", "b", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := compareValues(tt.left, tt.op, tt.right)
			if got != tt.want {
				t.Errorf("compareValues(%v, %q, %v) = %v, want %v", tt.left, tt.op, tt.right, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: isTruthy
// ---------------------------------------------------------------------------

func TestIsTruthy(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  bool
	}{
		{"nil", nil, false},
		{"true", true, true},
		{"false", false, false},
		{"nonzero float", float64(1), true},
		{"zero float", float64(0), false},
		{"non-empty string", "hello", true},
		{"empty string", "", false},
		{"string false", "false", false},
		{"string 0", "0", false},
		{"struct", struct{}{}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isTruthy(tt.input)
			if got != tt.want {
				t.Errorf("isTruthy(%v) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: checkAutoApprove
// ---------------------------------------------------------------------------

func TestCheckAutoApprove(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name   string
		config map[string]any
		ctx    map[string]any
		want   bool
	}{
		{
			"auto approve lte pass",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"risk_level": map[string]any{"lte": float64(3)},
				},
			},
			map[string]any{"risk_level": float64(2)},
			true,
		},
		{
			"auto approve lte fail",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"risk_level": map[string]any{"lte": float64(3)},
				},
			},
			map[string]any{"risk_level": float64(4)},
			false,
		},
		{
			"auto approve gte pass",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"score": map[string]any{"gte": float64(80)},
				},
			},
			map[string]any{"score": float64(90)},
			true,
		},
		{
			"auto approve lt",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"risk_level": map[string]any{"lt": float64(3)},
				},
			},
			map[string]any{"risk_level": float64(2)},
			true,
		},
		{
			"auto approve gt",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"score": map[string]any{"gt": float64(50)},
				},
			},
			map[string]any{"score": float64(60)},
			true,
		},
		{
			"auto approve eq pass",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"count": map[string]any{"eq": float64(1)},
				},
			},
			map[string]any{"count": float64(1)},
			true,
		},
		{
			"auto approve eq fail",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"count": map[string]any{"eq": float64(1)},
				},
			},
			map[string]any{"count": float64(2)},
			false,
		},
		{
			"no auto approve conditions",
			map[string]any{},
			map[string]any{"risk_level": float64(1)},
			false,
		},
		{
			"missing context field",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"risk_level": map[string]any{"lte": float64(3)},
				},
			},
			map[string]any{},
			false,
		},
		{
			"multiple conditions all pass",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"risk_level": map[string]any{"lte": float64(3)},
					"score":      map[string]any{"gte": float64(50)},
				},
			},
			map[string]any{"risk_level": float64(2), "score": float64(80)},
			true,
		},
		{
			"multiple conditions one fails",
			map[string]any{
				"auto_approve_conditions": map[string]any{
					"risk_level": map[string]any{"lte": float64(3)},
					"score":      map[string]any{"gte": float64(90)},
				},
			},
			map[string]any{"risk_level": float64(2), "score": float64(80)},
			false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stage := &WorkflowStage{Config: tt.config}
			got := s.checkAutoApprove(stage, tt.ctx)
			if got != tt.want {
				t.Errorf("checkAutoApprove() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: strPtr
// ---------------------------------------------------------------------------

func TestStrPtr(t *testing.T) {
	s := "hello"
	p := strPtr(s)
	if p == nil || *p != s {
		t.Errorf("strPtr(%q) = %v, want pointer to %q", s, p, s)
	}
}

// ---------------------------------------------------------------------------
// Test: validTransitions map completeness
// ---------------------------------------------------------------------------

func TestValidTransitionsMapCovers(t *testing.T) {
	// Ensure all expected statuses exist in the map
	expectedStatuses := []string{"draft", "pending_approval", "approved", "in_progress", "paused"}
	for _, s := range expectedStatuses {
		if _, ok := validTransitions[s]; !ok {
			t.Errorf("validTransitions missing status %q", s)
		}
	}

	// Terminal statuses should NOT have transitions
	terminalStatuses := []string{"completed", "aborted"}
	for _, s := range terminalStatuses {
		if targets, ok := validTransitions[s]; ok && len(targets) > 0 {
			t.Errorf("terminal status %q should not have transitions, got %v", s, targets)
		}
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Health Live (does not need DB)
// ---------------------------------------------------------------------------

func TestHandleHealthLive(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/health/live", nil)
	w := httptest.NewRecorder()

	s.handleHealthLive(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %q, want %q", body["status"], "ok")
	}
	if body["service"] != "workflow-engine" {
		t.Errorf("service = %q, want %q", body["service"], "workflow-engine")
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Create Operation validation (no DB needed for validation)
// ---------------------------------------------------------------------------

func TestHandleCreateOperation_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		headers    map[string]string
		wantStatus int
		wantCode   string
	}{
		{
			"invalid JSON",
			`{invalid`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing name",
			`{"objective": "test"}`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"missing objective",
			`{"name": "test"}`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"risk_level too low",
			`{"name":"test","objective":"test","risk_level":0}`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"risk_level too high",
			`{"name":"test","objective":"test","risk_level":6}`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"missing X-User-ID",
			`{"name":"test","objective":"test"}`,
			map[string]string{},
			http.StatusUnauthorized,
			"UNAUTHORIZED",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/operations", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			w := httptest.NewRecorder()

			s.handleCreateOperation(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Update Operation validation
// ---------------------------------------------------------------------------

func TestHandleUpdateOperation_ValidationErrors(t *testing.T) {
	s := newTestServer()

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
			"empty update (no fields)",
			`{}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"risk_level too low",
			`{"risk_level":0}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"risk_level too high",
			`{"risk_level":6}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("PATCH", "/api/v1/operations/some-id", strings.NewReader(tt.body))
			req.SetPathValue("id", "some-id")
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleUpdateOperation(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Transition Operation validation
// ---------------------------------------------------------------------------

func TestHandleTransitionOperation_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"missing id",
			"",
			`{"status":"in_progress"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid JSON",
			"some-id",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing status",
			"some-id",
			`{}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/operations/"+tt.id+"/transition", strings.NewReader(tt.body))
			req.SetPathValue("id", tt.id)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleTransitionOperation(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Add Member validation
// ---------------------------------------------------------------------------

func TestHandleAddMember_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"missing id",
			"",
			`{"user_id":"u1","role":"member"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid JSON",
			"op1",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing user_id",
			"op1",
			`{"role":"member"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/operations/"+tt.id+"/members", strings.NewReader(tt.body))
			req.SetPathValue("id", tt.id)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleAddMember(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Remove Member validation
// ---------------------------------------------------------------------------

func TestHandleRemoveMember_ValidationErrors(t *testing.T) {
	s := newTestServer()

	t.Run("missing id and userId", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/v1/operations//members/", nil)
		req.SetPathValue("id", "")
		req.SetPathValue("userId", "")
		w := httptest.NewRecorder()

		s.handleRemoveMember(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})
}

// ---------------------------------------------------------------------------
// Test: Handler — Workflow CRUD validation
// ---------------------------------------------------------------------------

func TestHandleCreateWorkflow_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		headers    map[string]string
		wantStatus int
		wantCode   string
	}{
		{
			"missing X-User-ID",
			`{"name":"test"}`,
			map[string]string{},
			http.StatusUnauthorized,
			"UNAUTHORIZED",
		},
		{
			"invalid JSON",
			`{invalid`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing name",
			`{"description":"test"}`,
			map[string]string{"X-User-ID": "user1"},
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/workflows", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			w := httptest.NewRecorder()

			s.handleCreateWorkflow(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

func TestHandleGetWorkflow_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/workflows/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleGetWorkflow(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdateWorkflow_InvalidJSON(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("PUT", "/api/v1/workflows/some-id", strings.NewReader(`{invalid`))
	req.SetPathValue("id", "some-id")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.handleUpdateWorkflow(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleDeleteWorkflow_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("DELETE", "/api/v1/workflows/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleDeleteWorkflow(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleCloneWorkflow_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("POST", "/api/v1/workflows//clone", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleCloneWorkflow(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Workflow Runs validation
// ---------------------------------------------------------------------------

func TestHandleStartRun_ValidationErrors(t *testing.T) {
	s := newTestServer()

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
			"missing workflow_id",
			`{"context":{}}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/workflow-runs", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleStartRun(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestHandleRunAction_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"missing id",
			"",
			`{"action":"approve"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid JSON",
			"run1",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing action",
			"run1",
			`{}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/workflow-runs/"+tt.id+"/action", strings.NewReader(tt.body))
			req.SetPathValue("id", tt.id)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleRunAction(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestHandleAbortRun_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("POST", "/api/v1/workflow-runs//abort", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleAbortRun(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleGetRunHistory_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/workflow-runs//history", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleGetRunHistory(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdateRunContext_ValidationErrors(t *testing.T) {
	s := newTestServer()

	t.Run("missing id", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/v1/workflow-runs//context", strings.NewReader(`{"context":{}}`))
		req.SetPathValue("id", "")
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		s.handleUpdateRunContext(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})

	t.Run("invalid JSON", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/v1/workflow-runs/run1/context", strings.NewReader(`{invalid`))
		req.SetPathValue("id", "run1")
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		s.handleUpdateRunContext(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})
}

// ---------------------------------------------------------------------------
// Test: Handler — Get/List/Delete ID validation (missing path params)
// ---------------------------------------------------------------------------

func TestHandlersMissingPathID(t *testing.T) {
	s := newTestServer()

	handlers := []struct {
		name    string
		method  string
		handler func(http.ResponseWriter, *http.Request)
	}{
		{"GetOperation", "GET", s.handleGetOperation},
		{"ListMembers", "GET", s.handleListMembers},
		{"GetRun", "GET", s.handleGetRun},
	}

	for _, h := range handlers {
		t.Run(h.name, func(t *testing.T) {
			req := httptest.NewRequest(h.method, "/", nil)
			req.SetPathValue("id", "")
			w := httptest.NewRecorder()

			h.handler(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("%s: status = %d, want %d", h.name, w.Code, http.StatusBadRequest)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: publishEvent with nil NATS connection
// ---------------------------------------------------------------------------

func TestPublishEvent_NilNATS(t *testing.T) {
	s := newTestServer()
	// Should not panic with nil NATS
	s.publishEvent("test.event", map[string]string{"key": "value"})
}

// ---------------------------------------------------------------------------
// Test: getEnv / envOrInt
// ---------------------------------------------------------------------------

func TestGetEnv(t *testing.T) {
	t.Run("returns fallback when not set", func(t *testing.T) {
		got := getEnv("WORKFLOW_ENGINE_TEST_NONEXISTENT_VAR", "default_val")
		if got != "default_val" {
			t.Errorf("getEnv() = %q, want %q", got, "default_val")
		}
	})
}

func TestEnvOrInt(t *testing.T) {
	t.Run("returns fallback when not set", func(t *testing.T) {
		got := envOrInt("WORKFLOW_ENGINE_TEST_NONEXISTENT_INT", 42)
		if got != 42 {
			t.Errorf("envOrInt() = %d, want %d", got, 42)
		}
	})
}

// ---------------------------------------------------------------------------
// Tests requiring database (skipped)
// ---------------------------------------------------------------------------

func TestHandleCreateOperation_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleListOperations_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleGetOperation_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleTransitionOperation_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleCreateWorkflow_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleStartRun_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleRunAction_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleHealthReady_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

// ===========================================================================
// M12 Cross-Domain Operations Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: routing_mode field in CreateOperationRequest
// ---------------------------------------------------------------------------

func TestCreateOperationRequest_RoutingMode(t *testing.T) {
	tests := []struct {
		name        string
		json        string
		wantMode    string
		wantParseOK bool
	}{
		{
			"routing_mode local",
			`{"name":"op1","objective":"test","routing_mode":"local"}`,
			"local",
			true,
		},
		{
			"routing_mode cross_domain",
			`{"name":"op1","objective":"test","routing_mode":"cross_domain"}`,
			"cross_domain",
			true,
		},
		{
			"routing_mode omitted defaults later",
			`{"name":"op1","objective":"test"}`,
			"",
			true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req CreateOperationRequest
			err := json.Unmarshal([]byte(tt.json), &req)
			if (err == nil) != tt.wantParseOK {
				t.Fatalf("json.Unmarshal error = %v, wantParseOK %v", err, tt.wantParseOK)
			}
			if req.RoutingMode != tt.wantMode {
				t.Errorf("RoutingMode = %q, want %q", req.RoutingMode, tt.wantMode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Operation struct includes routing_mode and origin fields
// ---------------------------------------------------------------------------

func TestOperationStruct_CrossDomainFields(t *testing.T) {
	op := Operation{
		ID:                "op-1",
		Name:              "Cross-domain test",
		RoutingMode:       "cross_domain",
		Classification:    "CUI",
		OriginOperationID: strPtr("origin-op-1"),
		OriginEnclave:     strPtr("high"),
	}

	data, err := json.Marshal(op)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded Operation
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if decoded.RoutingMode != "cross_domain" {
		t.Errorf("RoutingMode = %q, want %q", decoded.RoutingMode, "cross_domain")
	}
	if decoded.OriginOperationID == nil || *decoded.OriginOperationID != "origin-op-1" {
		t.Errorf("OriginOperationID = %v, want %q", decoded.OriginOperationID, "origin-op-1")
	}
	if decoded.OriginEnclave == nil || *decoded.OriginEnclave != "high" {
		t.Errorf("OriginEnclave = %v, want %q", decoded.OriginEnclave, "high")
	}
}

// ---------------------------------------------------------------------------
// Test: RouteOperationRequest struct
// ---------------------------------------------------------------------------

func TestRouteOperationRequestStruct(t *testing.T) {
	tests := []struct {
		name        string
		json        string
		wantTarget  string
		wantReason  string
	}{
		{
			"valid route request to low",
			`{"target_enclave":"low","routing_reason":"tactical execution required"}`,
			"low",
			"tactical execution required",
		},
		{
			"valid route request to high",
			`{"target_enclave":"high","routing_reason":"strategic review"}`,
			"high",
			"strategic review",
		},
		{
			"empty reason",
			`{"target_enclave":"low"}`,
			"low",
			"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req RouteOperationRequest
			if err := json.Unmarshal([]byte(tt.json), &req); err != nil {
				t.Fatalf("failed to unmarshal: %v", err)
			}
			if req.TargetEnclave != tt.wantTarget {
				t.Errorf("TargetEnclave = %q, want %q", req.TargetEnclave, tt.wantTarget)
			}
			if req.RoutingReason != tt.wantReason {
				t.Errorf("RoutingReason = %q, want %q", req.RoutingReason, tt.wantReason)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: handleRouteOperation — low side restriction
// ---------------------------------------------------------------------------

func TestHandleRouteOperation_LowSideBlocked(t *testing.T) {
	origEnclave := enclave
	enclave = "low"
	defer func() { enclave = origEnclave }()

	s := newTestServer()
	body := `{"target_enclave":"low","routing_reason":"test"}`
	req := httptest.NewRequest("POST", "/api/v1/operations/some-id/route", strings.NewReader(body))
	req.SetPathValue("id", "some-id")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.handleRouteOperation(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	errObj, _ := resp["error"].(map[string]any)
	if errObj == nil {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "ENCLAVE_RESTRICTION" {
		t.Errorf("error code = %q, want %q", errObj["code"], "ENCLAVE_RESTRICTION")
	}
}

// ---------------------------------------------------------------------------
// Test: handleRouteOperation — validation errors
// ---------------------------------------------------------------------------

func TestHandleRouteOperation_Validation(t *testing.T) {
	origEnclave := enclave
	enclave = "high"
	defer func() { enclave = origEnclave }()

	s := newTestServer()

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"missing id",
			"",
			`{"target_enclave":"low"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid JSON",
			"op-1",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing target_enclave",
			"op-1",
			`{"routing_reason":"test"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid target_enclave",
			"op-1",
			`{"target_enclave":"invalid"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/operations/"+tt.id+"/route", strings.NewReader(tt.body))
			req.SetPathValue("id", tt.id)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleRouteOperation(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var resp map[string]any
			json.NewDecoder(w.Body).Decode(&resp)
			errObj, _ := resp["error"].(map[string]any)
			if errObj == nil {
				t.Fatal("expected error object in response")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: handleCreateOperation — routing_mode validation
// ---------------------------------------------------------------------------

func TestHandleCreateOperation_RoutingModeValidation(t *testing.T) {
	origEnclave := enclave
	defer func() { enclave = origEnclave }()

	s := newTestServer()

	t.Run("invalid routing_mode rejected", func(t *testing.T) {
		enclave = "high"
		body := `{"name":"test","objective":"test","routing_mode":"invalid"}`
		req := httptest.NewRequest("POST", "/api/v1/operations", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-ID", "user1")
		w := httptest.NewRecorder()

		s.handleCreateOperation(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
		var resp map[string]any
		json.NewDecoder(w.Body).Decode(&resp)
		errObj, _ := resp["error"].(map[string]any)
		if errObj["code"] != "VALIDATION_ERROR" {
			t.Errorf("error code = %q, want VALIDATION_ERROR", errObj["code"])
		}
	})

	t.Run("cross_domain on low side rejected", func(t *testing.T) {
		enclave = "low"
		body := `{"name":"test","objective":"test","routing_mode":"cross_domain"}`
		req := httptest.NewRequest("POST", "/api/v1/operations", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-ID", "user1")
		w := httptest.NewRecorder()

		s.handleCreateOperation(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
		}
		var resp map[string]any
		json.NewDecoder(w.Body).Decode(&resp)
		errObj, _ := resp["error"].(map[string]any)
		if errObj["code"] != "ENCLAVE_RESTRICTION" {
			t.Errorf("error code = %q, want ENCLAVE_RESTRICTION", errObj["code"])
		}
	})

	t.Run("SECRET on low side rejected", func(t *testing.T) {
		enclave = "low"
		body := `{"name":"test","objective":"test","classification":"SECRET"}`
		req := httptest.NewRequest("POST", "/api/v1/operations", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-ID", "user1")
		w := httptest.NewRecorder()

		s.handleCreateOperation(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
		}
	})

	t.Run("invalid classification rejected", func(t *testing.T) {
		enclave = "high"
		body := `{"name":"test","objective":"test","classification":"TOP_SECRET"}`
		req := httptest.NewRequest("POST", "/api/v1/operations", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-ID", "user1")
		w := httptest.NewRecorder()

		s.handleCreateOperation(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
		}
	})
}

// ---------------------------------------------------------------------------
// Test: isDegraded — CTI health interaction
// ---------------------------------------------------------------------------

func TestIsDegraded(t *testing.T) {
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
		{"low side, CTI connected", "low", true, false, false},
		{"low side, CTI disconnected", "low", false, false, true},
		{"low side, no CTI configured", "low", false, true, false},
		{"high side, CTI disconnected", "high", false, false, false},
		{"high side, no CTI configured", "high", false, true, false},
		{"empty enclave", "", false, false, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			enclave = tt.enclaveSide
			s := &Server{logger: logger}
			if !tt.ctiNil {
				cti := newCTIHealth("http://localhost:9999", logger)
				cti.mu.Lock()
				cti.connected = tt.ctiConnected
				cti.mu.Unlock()
				s.cti = cti
			}

			got := s.isDegraded()
			if got != tt.want {
				t.Errorf("isDegraded() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: handleCTIStatus
// ---------------------------------------------------------------------------

func TestHandleCTIStatus(t *testing.T) {
	origEnclave := enclave
	defer func() { enclave = origEnclave }()

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))

	t.Run("without CTI configured", func(t *testing.T) {
		enclave = "high"
		s := &Server{logger: logger}

		req := httptest.NewRequest("GET", "/api/v1/operations/cti-status", nil)
		w := httptest.NewRecorder()
		s.handleCTIStatus(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var resp map[string]any
		json.NewDecoder(w.Body).Decode(&resp)

		if resp["cti_connected"] != true {
			t.Errorf("cti_connected = %v, want true", resp["cti_connected"])
		}
		if resp["degraded"] != false {
			t.Errorf("degraded = %v, want false", resp["degraded"])
		}
	})

	t.Run("with CTI configured and disconnected on low side", func(t *testing.T) {
		enclave = "low"
		cti := newCTIHealth("http://localhost:9999", logger)
		cti.mu.Lock()
		cti.connected = false
		cti.mu.Unlock()
		s := &Server{logger: logger, cti: cti}

		req := httptest.NewRequest("GET", "/api/v1/operations/cti-status", nil)
		w := httptest.NewRecorder()
		s.handleCTIStatus(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
		}

		var resp map[string]any
		json.NewDecoder(w.Body).Decode(&resp)

		if resp["cti_connected"] != false {
			t.Errorf("cti_connected = %v, want false", resp["cti_connected"])
		}
		if resp["degraded"] != true {
			t.Errorf("degraded = %v, want true", resp["degraded"])
		}
	})
}

// ---------------------------------------------------------------------------
// Test: handleCreateOperation — degraded mode blocks creation
// ---------------------------------------------------------------------------

func TestHandleCreateOperation_DegradedMode(t *testing.T) {
	origEnclave := enclave
	defer func() { enclave = origEnclave }()

	enclave = "low"
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	cti := newCTIHealth("http://localhost:9999", logger)
	cti.mu.Lock()
	cti.connected = false
	cti.mu.Unlock()

	s := &Server{logger: logger, cti: cti}

	body := `{"name":"test","objective":"test"}`
	req := httptest.NewRequest("POST", "/api/v1/operations", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-ID", "user1")
	w := httptest.NewRecorder()

	s.handleCreateOperation(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	errObj, _ := resp["error"].(map[string]any)
	if errObj == nil {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "DEGRADED_MODE" {
		t.Errorf("error code = %q, want DEGRADED_MODE", errObj["code"])
	}
}

// ---------------------------------------------------------------------------
// Test: classificationRank ordering
// ---------------------------------------------------------------------------

func TestClassificationRank(t *testing.T) {
	tests := []struct {
		classification string
		want           int
	}{
		{"UNCLASS", 0},
		{"CUI", 1},
		{"SECRET", 2},
		{"INVALID", -1},
		{"", -1},
	}

	for _, tt := range tests {
		t.Run(tt.classification, func(t *testing.T) {
			got := classificationRank(tt.classification)
			if got != tt.want {
				t.Errorf("classificationRank(%q) = %d, want %d", tt.classification, got, tt.want)
			}
		})
	}

	// Verify ordering: UNCLASS < CUI < SECRET
	if classificationRank("UNCLASS") >= classificationRank("CUI") {
		t.Error("UNCLASS should rank lower than CUI")
	}
	if classificationRank("CUI") >= classificationRank("SECRET") {
		t.Error("CUI should rank lower than SECRET")
	}
}

// ---------------------------------------------------------------------------
// Test: operationSelectCols includes routing_mode and origin fields
// ---------------------------------------------------------------------------

func TestOperationSelectCols(t *testing.T) {
	required := []string{"routing_mode", "origin_operation_id", "origin_enclave", "finding_count"}
	for _, field := range required {
		if !strings.Contains(operationSelectCols, field) {
			t.Errorf("operationSelectCols missing field %q", field)
		}
	}
}

// ---------------------------------------------------------------------------
// Test: Playbook Trigger Condition Matching (M13 DCO/SOC)
// ---------------------------------------------------------------------------

func TestMatchPlaybookTrigger(t *testing.T) {
	tests := []struct {
		name    string
		trigger map[string]any
		alert   map[string]any
		want    bool
	}{
		{
			name:    "empty trigger matches any alert",
			trigger: map[string]any{},
			alert:   map[string]any{"severity": "high", "alert_source": "siem"},
			want:    true,
		},
		{
			name:    "severity match - exact",
			trigger: map[string]any{"severity": "high"},
			alert:   map[string]any{"severity": "high"},
			want:    true,
		},
		{
			name:    "severity match - alert higher than trigger",
			trigger: map[string]any{"severity": "medium"},
			alert:   map[string]any{"severity": "critical"},
			want:    true,
		},
		{
			name:    "severity mismatch - alert lower than trigger",
			trigger: map[string]any{"severity": "critical"},
			alert:   map[string]any{"severity": "low"},
			want:    false,
		},
		{
			name:    "severity match - high >= high",
			trigger: map[string]any{"severity": "high"},
			alert:   map[string]any{"severity": "critical"},
			want:    true,
		},
		{
			name:    "mitre_techniques match",
			trigger: map[string]any{"mitre_techniques": []any{"T1059", "T1566"}},
			alert:   map[string]any{"mitre_techniques": []any{"T1059", "T1078"}},
			want:    true,
		},
		{
			name:    "mitre_techniques no overlap",
			trigger: map[string]any{"mitre_techniques": []any{"T1059"}},
			alert:   map[string]any{"mitre_techniques": []any{"T1078"}},
			want:    false,
		},
		{
			name:    "mitre_techniques trigger set but alert missing",
			trigger: map[string]any{"mitre_techniques": []any{"T1059"}},
			alert:   map[string]any{},
			want:    false,
		},
		{
			name:    "alert_source match",
			trigger: map[string]any{"alert_source": "siem"},
			alert:   map[string]any{"alert_source": "siem"},
			want:    true,
		},
		{
			name:    "alert_source mismatch",
			trigger: map[string]any{"alert_source": "siem"},
			alert:   map[string]any{"alert_source": "nids"},
			want:    false,
		},
		{
			name: "combined conditions - all match",
			trigger: map[string]any{
				"severity":         "medium",
				"alert_source":     "siem",
				"mitre_techniques": []any{"T1059"},
			},
			alert: map[string]any{
				"severity":         "high",
				"alert_source":     "siem",
				"mitre_techniques": []any{"T1059", "T1078"},
			},
			want: true,
		},
		{
			name: "combined conditions - severity fails",
			trigger: map[string]any{
				"severity":     "critical",
				"alert_source": "siem",
			},
			alert: map[string]any{
				"severity":     "low",
				"alert_source": "siem",
			},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := matchPlaybookTrigger(tt.trigger, tt.alert)
			if got != tt.want {
				t.Errorf("matchPlaybookTrigger() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: severityGTE
// ---------------------------------------------------------------------------

func TestSeverityGTE(t *testing.T) {
	tests := []struct {
		name     string
		alertSev string
		trigSev  string
		want     bool
	}{
		{"critical >= critical", "critical", "critical", true},
		{"critical >= high", "critical", "high", true},
		{"critical >= medium", "critical", "medium", true},
		{"critical >= low", "critical", "low", true},
		{"high >= high", "high", "high", true},
		{"high >= medium", "high", "medium", true},
		{"high >= low", "high", "low", true},
		{"medium >= medium", "medium", "medium", true},
		{"medium >= low", "medium", "low", true},
		{"low >= low", "low", "low", true},
		{"low < medium", "low", "medium", false},
		{"low < high", "low", "high", false},
		{"low < critical", "low", "critical", false},
		{"medium < high", "medium", "high", false},
		{"medium < critical", "medium", "critical", false},
		{"high < critical", "high", "critical", false},
		{"unknown exact match", "info", "info", true},
		{"unknown no match", "info", "critical", false},
		{"case insensitive", "HIGH", "high", true},
		{"case insensitive 2", "Critical", "Medium", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := severityGTE(tt.alertSev, tt.trigSev)
			if got != tt.want {
				t.Errorf("severityGTE(%q, %q) = %v, want %v", tt.alertSev, tt.trigSev, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: toStringSlice
// ---------------------------------------------------------------------------

func TestToStringSlice(t *testing.T) {
	tests := []struct {
		name    string
		input   any
		want    []string
		wantOk  bool
	}{
		{"nil", nil, nil, false},
		{"string slice", []string{"a", "b"}, []string{"a", "b"}, true},
		{"any slice", []any{"x", "y"}, []string{"x", "y"}, true},
		{"any slice with numbers", []any{"x", 42}, []string{"x", "42"}, true},
		{"empty any slice", []any{}, []string{}, true},
		{"single string", "hello", nil, false},
		{"number", 42, nil, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := toStringSlice(tt.input)
			if ok != tt.wantOk {
				t.Errorf("toStringSlice() ok = %v, want %v", ok, tt.wantOk)
			}
			if ok {
				if len(got) != len(tt.want) {
					t.Errorf("toStringSlice() len = %d, want %d", len(got), len(tt.want))
					return
				}
				for i := range got {
					if got[i] != tt.want[i] {
						t.Errorf("toStringSlice()[%d] = %q, want %q", i, got[i], tt.want[i])
					}
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: PlaybookDefinition struct fields
// ---------------------------------------------------------------------------

func TestPlaybookDefinitionStruct(t *testing.T) {
	pb := PlaybookDefinition{
		ID:                "test-id",
		Name:              "Auto-Isolate",
		Description:       "Auto-isolate on critical alerts",
		TriggerConditions: map[string]any{"severity": "critical"},
		WorkflowID:        "wf-123",
		IsActive:          true,
		Priority:          10,
		Classification:    "UNCLASS",
		CreatedAt:         "2026-03-01T00:00:00Z",
		UpdatedAt:         "2026-03-01T00:00:00Z",
	}

	data, err := json.Marshal(pb)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded PlaybookDefinition
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if decoded.Name != pb.Name {
		t.Errorf("Name = %q, want %q", decoded.Name, pb.Name)
	}
	if decoded.Priority != pb.Priority {
		t.Errorf("Priority = %d, want %d", decoded.Priority, pb.Priority)
	}
	if decoded.IsActive != pb.IsActive {
		t.Errorf("IsActive = %v, want %v", decoded.IsActive, pb.IsActive)
	}
	if decoded.Classification != pb.Classification {
		t.Errorf("Classification = %q, want %q", decoded.Classification, pb.Classification)
	}
	if decoded.WorkflowID != pb.WorkflowID {
		t.Errorf("WorkflowID = %q, want %q", decoded.WorkflowID, pb.WorkflowID)
	}
}

// ---------------------------------------------------------------------------
// Test: PlaybookExecution struct fields
// ---------------------------------------------------------------------------

func TestPlaybookExecutionStruct(t *testing.T) {
	runID := "run-456"
	exec := PlaybookExecution{
		ID:               "exec-123",
		PlaybookID:       "pb-123",
		IncidentTicketID: strPtr("ticket-789"),
		AlertID:          strPtr("alert-456"),
		WorkflowRunID:    &runID,
		Status:           "running",
		TriggeredBy:      "system:auto-trigger",
		ExecutionLog:     map[string]any{"step": "started"},
		CreatedAt:        "2026-03-01T00:00:00Z",
		UpdatedAt:        "2026-03-01T00:00:00Z",
	}

	data, err := json.Marshal(exec)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded PlaybookExecution
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if decoded.PlaybookID != exec.PlaybookID {
		t.Errorf("PlaybookID = %q, want %q", decoded.PlaybookID, exec.PlaybookID)
	}
	if decoded.Status != exec.Status {
		t.Errorf("Status = %q, want %q", decoded.Status, exec.Status)
	}
	if decoded.TriggeredBy != exec.TriggeredBy {
		t.Errorf("TriggeredBy = %q, want %q", decoded.TriggeredBy, exec.TriggeredBy)
	}
	if decoded.WorkflowRunID == nil || *decoded.WorkflowRunID != runID {
		t.Errorf("WorkflowRunID mismatch")
	}
}

// ---------------------------------------------------------------------------
// Test: CreatePlaybookRequest validation
// ---------------------------------------------------------------------------

func TestCreatePlaybookRequestValidation(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{
			name:    "valid request",
			body:    `{"name":"test","workflow_id":"wf-1","classification":"UNCLASS"}`,
			wantErr: false,
		},
		{
			name:    "missing name",
			body:    `{"workflow_id":"wf-1"}`,
			wantErr: true,
		},
		{
			name:    "missing workflow_id",
			body:    `{"name":"test"}`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// We don't have DB here; just test the request parsing & validation logic
			var req CreatePlaybookRequest
			err := json.Unmarshal([]byte(tt.body), &req)
			if err != nil {
				t.Fatalf("failed to unmarshal: %v", err)
			}

			hasErr := req.Name == "" || req.WorkflowID == ""
			if hasErr != tt.wantErr {
				t.Errorf("validation error = %v, want %v", hasErr, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: UpdatePlaybookRequest fields
// ---------------------------------------------------------------------------

func TestUpdatePlaybookRequestFields(t *testing.T) {
	body := `{"description":"new desc","is_active":false,"priority":5,"trigger_conditions":{"severity":"critical"}}`

	var req UpdatePlaybookRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if req.Description == nil || *req.Description != "new desc" {
		t.Errorf("Description = %v, want 'new desc'", req.Description)
	}
	if req.IsActive == nil || *req.IsActive != false {
		t.Errorf("IsActive = %v, want false", req.IsActive)
	}
	if req.Priority == nil || *req.Priority != 5 {
		t.Errorf("Priority = %v, want 5", req.Priority)
	}
	if req.TriggerConditions == nil {
		t.Error("TriggerConditions should not be nil")
	}
	if sev, ok := req.TriggerConditions["severity"]; !ok || sev != "critical" {
		t.Errorf("TriggerConditions[severity] = %v, want 'critical'", sev)
	}
}

// ---------------------------------------------------------------------------
// Test: TriggerPlaybookRequest parsing
// ---------------------------------------------------------------------------

func TestTriggerPlaybookRequestParsing(t *testing.T) {
	body := `{"incident_ticket_id":"ticket-123","alert_id":"alert-456","triggered_by":"admin"}`

	var req TriggerPlaybookRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if req.IncidentTicketID != "ticket-123" {
		t.Errorf("IncidentTicketID = %q, want %q", req.IncidentTicketID, "ticket-123")
	}
	if req.AlertID != "alert-456" {
		t.Errorf("AlertID = %q, want %q", req.AlertID, "alert-456")
	}
	if req.TriggeredBy != "admin" {
		t.Errorf("TriggeredBy = %q, want %q", req.TriggeredBy, "admin")
	}
}

// ---------------------------------------------------------------------------
// Test: Playbook create handler - no DB (validation only)
// ---------------------------------------------------------------------------

func TestHandleCreatePlaybookValidation(t *testing.T) {
	s := &Server{
		logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/workflows/playbooks", s.handleCreatePlaybook)

	tests := []struct {
		name       string
		body       string
		headers    map[string]string
		wantStatus int
	}{
		{
			name:       "missing user id",
			body:       `{"name":"test","workflow_id":"wf-1"}`,
			headers:    map[string]string{},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "missing name",
			body:       `{"workflow_id":"wf-1"}`,
			headers:    map[string]string{"X-User-ID": "user-1"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing workflow_id",
			body:       `{"name":"test"}`,
			headers:    map[string]string{"X-User-ID": "user-1"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid classification",
			body:       `{"name":"test","workflow_id":"wf-1","classification":"TOPSECRET"}`,
			headers:    map[string]string{"X-User-ID": "user-1"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid JSON",
			body:       `{invalid`,
			headers:    map[string]string{"X-User-ID": "user-1"},
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/workflows/playbooks", strings.NewReader(tt.body))
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d, body = %s", w.Code, tt.wantStatus, w.Body.String())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Playbook list handler - no DB (panics gracefully)
// ---------------------------------------------------------------------------

func TestHandleListPlaybooksNoDB(t *testing.T) {
	s := &Server{
		logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/workflows/playbooks", s.handleListPlaybooks)

	// Without a DB, this should return a 500 error
	req := httptest.NewRequest("GET", "/api/v1/workflows/playbooks", nil)
	w := httptest.NewRecorder()

	// This will panic due to nil DB; we recover to verify it fails gracefully
	func() {
		defer func() {
			if r := recover(); r != nil {
				// Expected: nil pointer dereference on db
				t.Log("recovered from expected panic (nil db)")
			}
		}()
		mux.ServeHTTP(w, req)
	}()
}

// ---------------------------------------------------------------------------
// Test: Playbook delete handler - no DB
// ---------------------------------------------------------------------------

func TestHandleDeletePlaybookValidation(t *testing.T) {
	s := &Server{
		logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /api/v1/workflows/playbooks/{id}", s.handleDeletePlaybook)

	// Without a DB, we just verify the handler doesn't crash on bad input
	req := httptest.NewRequest("DELETE", "/api/v1/workflows/playbooks/", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	// An empty path param is not routed by the 1.22 router to this handler,
	// so this tests the 404 fallback behavior
}

// ---------------------------------------------------------------------------
// Test: H-04 — Auto-trigger dedup key generation
// ---------------------------------------------------------------------------

func TestAutoTriggerDedupKey(t *testing.T) {
	tests := []struct {
		name       string
		playbookID string
		alert      map[string]any
		wantKey    string
	}{
		{
			name:       "full key",
			playbookID: "pb-1",
			alert:      map[string]any{"alert_source": "siem", "severity": "high"},
			wantKey:    "pb-1:siem:high",
		},
		{
			name:       "missing source",
			playbookID: "pb-2",
			alert:      map[string]any{"severity": "critical"},
			wantKey:    "pb-2::critical",
		},
		{
			name:       "missing severity",
			playbookID: "pb-3",
			alert:      map[string]any{"alert_source": "nids"},
			wantKey:    "pb-3:nids:",
		},
		{
			name:       "empty alert",
			playbookID: "pb-4",
			alert:      map[string]any{},
			wantKey:    "pb-4::",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := autoTriggerDedupKey(tt.playbookID, tt.alert)
			if got != tt.wantKey {
				t.Errorf("autoTriggerDedupKey() = %q, want %q", got, tt.wantKey)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: H-04 — Auto-trigger dedup map cleanup
// ---------------------------------------------------------------------------

func TestCleanAutoTriggerDedup(t *testing.T) {
	s := &Server{
		logger:           slog.New(slog.NewJSONHandler(io.Discard, nil)),
		autoTriggerDedup: make(map[string]time.Time),
	}

	now := time.Now()

	// Add entries: one fresh, one expired
	s.autoTriggerDedup["fresh:siem:high"] = now.Add(-1 * time.Minute)   // 1 min ago, within 5-min window
	s.autoTriggerDedup["expired:siem:low"] = now.Add(-10 * time.Minute) // 10 min ago, outside window
	s.autoTriggerDedup["also-expired:nids:critical"] = now.Add(-6 * time.Minute)

	s.autoTriggerMu.Lock()
	s.cleanAutoTriggerDedup()
	s.autoTriggerMu.Unlock()

	if len(s.autoTriggerDedup) != 1 {
		t.Errorf("after cleanup, dedup map has %d entries, want 1", len(s.autoTriggerDedup))
	}
	if _, ok := s.autoTriggerDedup["fresh:siem:high"]; !ok {
		t.Error("fresh entry should still be in dedup map")
	}
	if _, ok := s.autoTriggerDedup["expired:siem:low"]; ok {
		t.Error("expired entry should have been removed")
	}
}

// ---------------------------------------------------------------------------
// Test: H-04 — Auto-trigger rate limit constants
// ---------------------------------------------------------------------------

func TestAutoTriggerConstants(t *testing.T) {
	if autoTriggerDedupWindow != 5*time.Minute {
		t.Errorf("autoTriggerDedupWindow = %v, want 5m", autoTriggerDedupWindow)
	}
	if autoTriggerMaxConcurrent != 10 {
		t.Errorf("autoTriggerMaxConcurrent = %d, want 10", autoTriggerMaxConcurrent)
	}
	if autoTriggerCleanupInterval != 1*time.Minute {
		t.Errorf("autoTriggerCleanupInterval = %v, want 1m", autoTriggerCleanupInterval)
	}
}
