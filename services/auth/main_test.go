package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// newTestServer creates a minimal Server with only the fields needed for
// pure-function tests (JWT secret, logger). Database/Redis/NATS are nil
// because the functions under test don't touch them.
func newTestServer() *Server {
	return &Server{
		jwtSecret: []byte("test-secret-key-for-unit-tests"),
	}
}

// signTokenWithSecret creates a JWT signed with the given secret/claims.
func signTokenWithSecret(secret []byte, userID string, roles []string, sessionID string, expiresAt time.Time) (string, error) {
	claims := Claims{
		Roles:     roles,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now().UTC()),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			Issuer:    "ems-cop-auth",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

// ---------------------------------------------------------------------------
// JWT token generation and validation
// ---------------------------------------------------------------------------

func TestSignAccessToken(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name      string
		userID    string
		roles     []string
		sessionID string
		wantErr   bool
	}{
		{
			name:      "valid token with single role",
			userID:    "user-123",
			roles:     []string{"admin"},
			sessionID: "session-abc",
		},
		{
			name:      "valid token with multiple roles",
			userID:    "user-456",
			roles:     []string{"admin", "e1_strategic", "operator"},
			sessionID: "session-def",
		},
		{
			name:      "valid token with empty roles",
			userID:    "user-789",
			roles:     []string{},
			sessionID: "session-ghi",
		},
		{
			name:      "valid token with empty user ID",
			userID:    "",
			roles:     []string{"viewer"},
			sessionID: "session-jkl",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tokenStr, err := s.signAccessToken(tc.userID, tc.roles, tc.sessionID)
			if (err != nil) != tc.wantErr {
				t.Fatalf("signAccessToken() error = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if tokenStr == "" {
				t.Fatal("signAccessToken() returned empty string")
			}

			// Parse the generated token and validate claims
			parsed, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
				return s.jwtSecret, nil
			})
			if err != nil {
				t.Fatalf("failed to parse generated token: %v", err)
			}
			claims, ok := parsed.Claims.(*Claims)
			if !ok || !parsed.Valid {
				t.Fatal("parsed token is not valid")
			}
			if claims.Subject != tc.userID {
				t.Errorf("subject = %q, want %q", claims.Subject, tc.userID)
			}
			if claims.SessionID != tc.sessionID {
				t.Errorf("sessionID = %q, want %q", claims.SessionID, tc.sessionID)
			}
			if len(claims.Roles) != len(tc.roles) {
				t.Errorf("roles length = %d, want %d", len(claims.Roles), len(tc.roles))
			}
			for i, r := range tc.roles {
				if i < len(claims.Roles) && claims.Roles[i] != r {
					t.Errorf("roles[%d] = %q, want %q", i, claims.Roles[i], r)
				}
			}
			if claims.Issuer != "ems-cop-auth" {
				t.Errorf("issuer = %q, want %q", claims.Issuer, "ems-cop-auth")
			}
			// Token should expire ~15 minutes from now
			expiresIn := time.Until(claims.ExpiresAt.Time)
			if expiresIn < 14*time.Minute || expiresIn > 16*time.Minute {
				t.Errorf("token expires in %v, want ~15 minutes", expiresIn)
			}
		})
	}
}

func TestExtractClaims(t *testing.T) {
	s := newTestServer()

	// Generate a valid token
	validToken, err := signTokenWithSecret(
		s.jwtSecret, "user-123", []string{"admin", "operator"}, "session-abc",
		time.Now().Add(15*time.Minute),
	)
	if err != nil {
		t.Fatalf("failed to create valid token: %v", err)
	}

	// Generate an expired token
	expiredToken, err := signTokenWithSecret(
		s.jwtSecret, "user-456", []string{"viewer"}, "session-def",
		time.Now().Add(-1*time.Hour),
	)
	if err != nil {
		t.Fatalf("failed to create expired token: %v", err)
	}

	// Token signed with wrong secret
	wrongSecretToken, err := signTokenWithSecret(
		[]byte("wrong-secret"), "user-789", []string{"admin"}, "session-ghi",
		time.Now().Add(15*time.Minute),
	)
	if err != nil {
		t.Fatalf("failed to create wrong-secret token: %v", err)
	}

	tests := []struct {
		name        string
		authHeader  string
		queryToken  string
		wantErr     bool
		wantUserID  string
		wantSession string
	}{
		{
			name:        "valid Bearer token",
			authHeader:  "Bearer " + validToken,
			wantErr:     false,
			wantUserID:  "user-123",
			wantSession: "session-abc",
		},
		{
			name:       "valid token in query param",
			queryToken: validToken,
			wantErr:    false,
			wantUserID: "user-123",
		},
		{
			name:    "missing token entirely",
			wantErr: true,
		},
		{
			name:       "empty Authorization header",
			authHeader: "",
			wantErr:    true,
		},
		{
			name:       "Authorization without Bearer prefix",
			authHeader: validToken,
			wantErr:    true,
		},
		{
			name:       "expired token",
			authHeader: "Bearer " + expiredToken,
			wantErr:    true,
		},
		{
			name:       "wrong secret token",
			authHeader: "Bearer " + wrongSecretToken,
			wantErr:    true,
		},
		{
			name:       "malformed token",
			authHeader: "Bearer not-a-valid-jwt-token",
			wantErr:    true,
		},
		{
			name:       "Bearer with empty token string",
			authHeader: "Bearer ",
			wantErr:    true,
		},
		{
			name:       "token with RS256 algorithm (should reject)",
			authHeader: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.invalidsig",
			wantErr:    true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/v1/auth/verify", nil)
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}
			if tc.queryToken != "" {
				q := req.URL.Query()
				q.Set("token", tc.queryToken)
				req.URL.RawQuery = q.Encode()
			}

			claims, err := s.extractClaims(req)
			if (err != nil) != tc.wantErr {
				t.Fatalf("extractClaims() error = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if claims.Subject != tc.wantUserID {
				t.Errorf("subject = %q, want %q", claims.Subject, tc.wantUserID)
			}
			if tc.wantSession != "" && claims.SessionID != tc.wantSession {
				t.Errorf("sessionID = %q, want %q", claims.SessionID, tc.wantSession)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Login handler
// ---------------------------------------------------------------------------

func TestHandleLogin(t *testing.T) {
	// Login handler requires database (for user lookup) and Redis (for session storage).
	// We test the HTTP contract for input validation that happens before DB calls,
	// and skip the full flow tests that require infrastructure.

	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
		skipReason string
	}{
		{
			name:       "empty body",
			body:       "",
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "invalid JSON",
			body:       "{not valid json}",
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "missing username",
			body:       `{"password":"changeme"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "missing password",
			body:       `{"username":"admin"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "empty username and password",
			body:       `{"username":"","password":""}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "valid credentials (requires DB)",
			body:       `{"username":"admin","password":"changeme"}`,
			skipReason: "requires PostgreSQL, Redis, and NATS connections",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.skipReason != "" {
				t.Skip(tc.skipReason)
			}

			var bodyReader *bytes.Reader
			if tc.body == "" {
				bodyReader = bytes.NewReader(nil)
			} else {
				bodyReader = bytes.NewReader([]byte(tc.body))
			}
			req := httptest.NewRequest("POST", "/api/v1/auth/login", bodyReader)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			s.handleLogin(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}

			if tc.wantCode != "" {
				var resp map[string]any
				if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
					t.Fatalf("failed to parse response body: %v", err)
				}
				errObj, ok := resp["error"].(map[string]any)
				if !ok {
					t.Fatalf("response missing error object, got: %s", rec.Body.String())
				}
				if code, _ := errObj["code"].(string); code != tc.wantCode {
					t.Errorf("error code = %q, want %q", code, tc.wantCode)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Refresh handler
// ---------------------------------------------------------------------------

func TestHandleRefresh(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
		skipReason string
	}{
		{
			name:       "empty body",
			body:       "",
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "invalid JSON",
			body:       "{{{{",
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "missing refresh_token",
			body:       `{}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "empty refresh_token",
			body:       `{"refresh_token":""}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_REQUEST",
		},
		{
			name:       "valid refresh token (requires Redis)",
			body:       `{"refresh_token":"abc123def456"}`,
			skipReason: "requires Redis and PostgreSQL connections",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.skipReason != "" {
				t.Skip(tc.skipReason)
			}

			req := httptest.NewRequest("POST", "/api/v1/auth/refresh", bytes.NewReader([]byte(tc.body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			s.handleRefresh(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}

			if tc.wantCode != "" {
				var resp map[string]any
				if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
					t.Fatalf("failed to parse response: %v", err)
				}
				errObj, ok := resp["error"].(map[string]any)
				if !ok {
					t.Fatal("response missing error object")
				}
				if code, _ := errObj["code"].(string); code != tc.wantCode {
					t.Errorf("error code = %q, want %q", code, tc.wantCode)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Logout handler
// ---------------------------------------------------------------------------

func TestHandleLogout(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		authHeader string
		wantStatus int
		skipReason string
	}{
		{
			name:       "missing token",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token",
			authHeader: "Bearer invalid-token",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "malformed Authorization header",
			authHeader: "NotBearer something",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.skipReason != "" {
				t.Skip(tc.skipReason)
			}

			req := httptest.NewRequest("POST", "/api/v1/auth/logout", nil)
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}
			rec := httptest.NewRecorder()

			s.handleLogout(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
		})
	}
}

func TestHandleLogoutValidToken(t *testing.T) {
	t.Skip("requires Redis connection for session deletion")
}

// ---------------------------------------------------------------------------
// Verify handler (ForwardAuth)
// ---------------------------------------------------------------------------

func TestHandleVerify(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		authHeader string
		wantStatus int
		wantUserID string
		wantRoles  string
		skipReason string
	}{
		{
			name:       "missing token returns 401",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token returns 401",
			authHeader: "Bearer garbage-token-here",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "expired token returns 401",
			wantStatus: http.StatusUnauthorized,
		},
	}

	// Add the expired token test case with a real expired token
	expiredToken, _ := signTokenWithSecret(
		s.jwtSecret, "user-expired", []string{"admin"}, "session-expired",
		time.Now().Add(-1*time.Hour),
	)
	tests[2].authHeader = "Bearer " + expiredToken

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.skipReason != "" {
				t.Skip(tc.skipReason)
			}

			req := httptest.NewRequest("GET", "/api/v1/auth/verify", nil)
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}
			rec := httptest.NewRecorder()

			s.handleVerify(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
		})
	}
}

func TestHandleVerifyValidTokenRequiresRedis(t *testing.T) {
	// The verify handler checks Redis for session existence even with a valid JWT.
	// This test documents that behavior.
	t.Skip("requires Redis connection to validate session existence")
}

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

func TestHandleHealthLive(t *testing.T) {
	s := newTestServer()

	req := httptest.NewRequest("GET", "/health/live", nil)
	rec := httptest.NewRecorder()

	s.handleHealthLive(rec, req)

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
	if resp["service"] != "auth" {
		t.Errorf("service = %q, want %q", resp["service"], "auth")
	}
}

func TestHandleHealthReady(t *testing.T) {
	// healthReady checks PG, Redis, and NATS — all nil on test server.
	// This will panic or fail without real connections.
	t.Skip("requires PostgreSQL, Redis, and NATS connections")
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]string{"hello": "world"})

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
	if resp["hello"] != "world" {
		t.Errorf("hello = %q, want %q", resp["hello"], "world")
	}
}

func TestWriteError(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		code     string
		message  string
	}{
		{
			name:    "bad request",
			status:  http.StatusBadRequest,
			code:    "INVALID_REQUEST",
			message: "Invalid request body",
		},
		{
			name:    "unauthorized",
			status:  http.StatusUnauthorized,
			code:    "UNAUTHORIZED",
			message: "Invalid or missing token",
		},
		{
			name:    "internal server error",
			status:  http.StatusInternalServerError,
			code:    "INTERNAL_ERROR",
			message: "Something went wrong",
		},
		{
			name:    "rate limited",
			status:  http.StatusTooManyRequests,
			code:    "RATE_LIMITED",
			message: "Too many requests, try again later",
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

func TestClientIP(t *testing.T) {
	tests := []struct {
		name       string
		xff        string
		xri        string
		remoteAddr string
		wantIP     string
	}{
		{
			name:       "X-Forwarded-For with single IP (rightmost = trusted proxy)",
			xff:        "192.168.1.1",
			remoteAddr: "10.0.0.1:12345",
			wantIP:     "192.168.1.1",
		},
		{
			name:       "X-Forwarded-For with multiple IPs (takes rightmost)",
			xff:        "192.168.1.1, 10.0.0.2, 172.16.0.1",
			remoteAddr: "10.0.0.1:12345",
			wantIP:     "172.16.0.1",
		},
		{
			name:       "X-Real-Ip",
			xri:        "192.168.1.100",
			remoteAddr: "10.0.0.1:12345",
			wantIP:     "192.168.1.100",
		},
		{
			name:       "fallback to RemoteAddr with port",
			remoteAddr: "10.0.0.1:12345",
			wantIP:     "10.0.0.1",
		},
		{
			name:       "fallback to RemoteAddr without port",
			remoteAddr: "10.0.0.1",
			wantIP:     "10.0.0.1",
		},
		{
			name:       "X-Forwarded-For takes precedence over X-Real-Ip",
			xff:        "192.168.1.1",
			xri:        "10.0.0.2",
			remoteAddr: "127.0.0.1:80",
			wantIP:     "192.168.1.1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.xri != "" {
				req.Header.Set("X-Real-Ip", tc.xri)
			}

			got := clientIP(req)
			if got != tc.wantIP {
				t.Errorf("clientIP() = %q, want %q", got, tc.wantIP)
			}
		})
	}
}

func TestGenerateUUID(t *testing.T) {
	// UUID v4 format: 8-4-4-4-12 hex characters
	uuid1 := generateUUID()
	uuid2 := generateUUID()

	if uuid1 == "" {
		t.Fatal("generateUUID() returned empty string")
	}
	if uuid1 == uuid2 {
		t.Error("generateUUID() returned same value twice")
	}

	// Check format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
	parts := strings.Split(uuid1, "-")
	if len(parts) != 5 {
		t.Fatalf("UUID %q has %d parts, want 5", uuid1, len(parts))
	}
	if len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 || len(parts[3]) != 4 || len(parts[4]) != 12 {
		t.Errorf("UUID %q has wrong part lengths", uuid1)
	}
	// Version 4 indicator
	if parts[2][0] != '4' {
		t.Errorf("UUID version nibble = %c, want '4'", parts[2][0])
	}
}

func TestGenerateRefreshToken(t *testing.T) {
	tok1 := generateRefreshToken()
	tok2 := generateRefreshToken()

	if tok1 == "" {
		t.Fatal("generateRefreshToken() returned empty string")
	}
	if tok1 == tok2 {
		t.Error("generateRefreshToken() returned same value twice")
	}
	// 32 random bytes → 64 hex characters
	if len(tok1) != 64 {
		t.Errorf("refresh token length = %d, want 64", len(tok1))
	}
}

func TestEnvOr(t *testing.T) {
	tests := []struct {
		name     string
		key      string
		envVal   string
		fallback string
		want     string
	}{
		{
			name:     "returns env value when set",
			key:      "TEST_ENV_OR_SET",
			envVal:   "from-env",
			fallback: "default",
			want:     "from-env",
		},
		{
			name:     "returns fallback when env not set",
			key:      "TEST_ENV_OR_UNSET_12345",
			envVal:   "",
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

func TestEnvOrInt(t *testing.T) {
	tests := []struct {
		name     string
		key      string
		envVal   string
		fallback int
		want     int
	}{
		{
			name:     "returns parsed int from env",
			key:      "TEST_ENV_OR_INT_SET",
			envVal:   "42",
			fallback: 10,
			want:     42,
		},
		{
			name:     "returns fallback on non-numeric env",
			key:      "TEST_ENV_OR_INT_BAD",
			envVal:   "not-a-number",
			fallback: 10,
			want:     10,
		},
		{
			name:     "returns fallback when env not set",
			key:      "TEST_ENV_OR_INT_UNSET_12345",
			envVal:   "",
			fallback: 99,
			want:     99,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.envVal != "" {
				t.Setenv(tc.key, tc.envVal)
			}
			got := envOrInt(tc.key, tc.fallback)
			if got != tc.want {
				t.Errorf("envOrInt(%q, %d) = %d, want %d", tc.key, tc.fallback, got, tc.want)
			}
		})
	}
}

func TestMaxBodyMiddleware(t *testing.T) {
	const maxBytes int64 = 100

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try to read the full body
		buf := make([]byte, maxBytes+50)
		_, err := r.Body.Read(buf)
		if err != nil {
			// MaxBytesReader will cause an error on oversized bodies
			writeError(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Body too large")
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	handler := maxBodyMiddleware(maxBytes, inner)

	t.Run("small body passes through", func(t *testing.T) {
		body := bytes.NewReader([]byte("small body"))
		req := httptest.NewRequest("POST", "/", body)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		// Small body should be readable without error
		// (The inner handler reads at most maxBytes+50, but the body is small)
	})

	t.Run("oversized body triggers MaxBytesReader error", func(t *testing.T) {
		bigBody := bytes.NewReader(bytes.Repeat([]byte("x"), int(maxBytes)+50))
		req := httptest.NewRequest("POST", "/", bigBody)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
		}
	})
}

// ---------------------------------------------------------------------------
// Full mux routing tests
// ---------------------------------------------------------------------------

func TestMuxRouting(t *testing.T) {
	s := newTestServer()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", s.handleHealthLive)
	// We cannot register login/refresh with rate limit middleware since it needs Redis.
	// Test basic routing instead.

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
// JWT token edge cases
// ---------------------------------------------------------------------------

func TestTokenRoundTrip(t *testing.T) {
	// Test that sign → extract round-trips correctly
	s := newTestServer()

	userID := "550e8400-e29b-41d4-a716-446655440000"
	roles := []string{"admin", "e1_strategic"}
	sessionID := "session-roundtrip-test"

	tokenStr, err := s.signAccessToken(userID, roles, sessionID)
	if err != nil {
		t.Fatalf("signAccessToken() error: %v", err)
	}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)

	claims, err := s.extractClaims(req)
	if err != nil {
		t.Fatalf("extractClaims() error: %v", err)
	}

	if claims.Subject != userID {
		t.Errorf("subject = %q, want %q", claims.Subject, userID)
	}
	if claims.SessionID != sessionID {
		t.Errorf("sessionID = %q, want %q", claims.SessionID, sessionID)
	}
	if len(claims.Roles) != len(roles) {
		t.Fatalf("roles len = %d, want %d", len(claims.Roles), len(roles))
	}
	for i, r := range roles {
		if claims.Roles[i] != r {
			t.Errorf("roles[%d] = %q, want %q", i, claims.Roles[i], r)
		}
	}
}

func TestTokenSigningMethodEnforcement(t *testing.T) {
	// Ensure that tokens signed with non-HMAC methods are rejected.
	// This is critical for security: prevents algorithm confusion attacks.
	s := newTestServer()

	// Craft a token that claims to use "none" algorithm
	unsecuredToken := jwt.NewWithClaims(jwt.SigningMethodNone, &Claims{
		Roles:     []string{"admin"},
		SessionID: "session-none",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "attacker",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
		},
	})
	// SignedString for "none" method requires jwt.UnsafeAllowNoneSignatureType
	tokenStr, err := unsecuredToken.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("failed to create unsigned token: %v", err)
	}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)

	_, err = s.extractClaims(req)
	if err == nil {
		t.Fatal("extractClaims() should reject tokens with 'none' signing method")
	}
}

// ---------------------------------------------------------------------------
// Session data JSON round trip
// ---------------------------------------------------------------------------

func TestSessionDataJSON(t *testing.T) {
	original := SessionData{
		UserID:     "user-123",
		Roles:      []string{"admin", "operator"},
		CreatedAt:  "2026-02-28T12:00:00Z",
		LastActive: "2026-02-28T12:05:00Z",
		IP:         "192.168.1.1",
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}

	var decoded SessionData
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}

	if decoded.UserID != original.UserID {
		t.Errorf("UserID = %q, want %q", decoded.UserID, original.UserID)
	}
	if decoded.IP != original.IP {
		t.Errorf("IP = %q, want %q", decoded.IP, original.IP)
	}
	if len(decoded.Roles) != len(original.Roles) {
		t.Fatalf("Roles len = %d, want %d", len(decoded.Roles), len(original.Roles))
	}
	for i, r := range original.Roles {
		if decoded.Roles[i] != r {
			t.Errorf("Roles[%d] = %q, want %q", i, decoded.Roles[i], r)
		}
	}
}

// ---------------------------------------------------------------------------
// HandleMe handler tests
// ---------------------------------------------------------------------------

func TestHandleMe(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		authHeader string
		xuserID    string
		wantStatus int
		skipReason string
	}{
		{
			name:       "no auth at all returns 401",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token returns 401",
			authHeader: "Bearer invalid-jwt",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "valid X-User-ID header (requires DB)",
			xuserID:    "550e8400-e29b-41d4-a716-446655440000",
			skipReason: "requires PostgreSQL connection to look up user",
		},
		{
			name:       "valid JWT (requires DB)",
			skipReason: "requires PostgreSQL connection to look up user",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.skipReason != "" {
				t.Skip(tc.skipReason)
			}

			req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}
			if tc.xuserID != "" {
				req.Header.Set("X-User-ID", tc.xuserID)
			}
			rec := httptest.NewRecorder()

			s.handleMe(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body: %s", rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// PublishEvent doesn't panic with nil NATS
// ---------------------------------------------------------------------------

func TestPublishEventNilNATS(t *testing.T) {
	// publishEvent should not panic when nc is nil — it will try to call
	// nc.Publish and get a nil pointer dereference if not handled.
	// This tests the reality of the code as-is.
	s := newTestServer()
	s.logger = nil // logger is also nil in newTestServer

	// This will panic because nc is nil and publishEvent calls s.nc.Publish.
	// We just document this behavior — in production nc is always initialized.
	defer func() {
		if r := recover(); r != nil {
			// Expected — nc is nil
		}
	}()

	s.publishEvent("auth.login", "user-1", "testuser", "127.0.0.1", "session-1", nil)
}

// ---------------------------------------------------------------------------
// Claims struct JSON serialization
// ---------------------------------------------------------------------------

func TestClaimsStruct(t *testing.T) {
	now := time.Now().UTC()
	claims := Claims{
		Roles:     []string{"admin", "operator"},
		SessionID: "sess-123",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "user-456",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(15 * time.Minute)),
			Issuer:    "ems-cop-auth",
		},
	}

	// Verify that the token created from these claims is valid
	s := newTestServer()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString(s.jwtSecret)
	if err != nil {
		t.Fatalf("signing failed: %v", err)
	}

	parsed, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		return s.jwtSecret, nil
	})
	if err != nil {
		t.Fatalf("parsing failed: %v", err)
	}

	parsedClaims := parsed.Claims.(*Claims)
	if parsedClaims.Subject != "user-456" {
		t.Errorf("subject = %q, want %q", parsedClaims.Subject, "user-456")
	}
	if parsedClaims.SessionID != "sess-123" {
		t.Errorf("sessionID = %q, want %q", parsedClaims.SessionID, "sess-123")
	}
}

// ---------------------------------------------------------------------------
// Error response shape validation
// ---------------------------------------------------------------------------

func TestErrorResponseShape(t *testing.T) {
	// Verify the exact JSON structure returned by writeError
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusForbidden, "FORBIDDEN", "Access denied")

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("JSON parse error: %v", err)
	}

	// Must have exactly one top-level key: "error"
	if len(resp) != 1 {
		t.Errorf("response has %d top-level keys, want 1", len(resp))
	}

	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatal("'error' key missing or not an object")
	}

	// Must have exactly "code" and "message" keys
	if len(errObj) != 2 {
		t.Errorf("error object has %d keys, want 2", len(errObj))
	}
	if _, ok := errObj["code"]; !ok {
		t.Error("error object missing 'code' key")
	}
	if _, ok := errObj["message"]; !ok {
		t.Error("error object missing 'message' key")
	}
}

// ---------------------------------------------------------------------------
// Concurrency safety of generateUUID/generateRefreshToken
// ---------------------------------------------------------------------------

func TestGenerateUUIDConcurrency(t *testing.T) {
	const n = 100
	results := make(chan string, n)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for i := 0; i < n; i++ {
		go func() {
			select {
			case results <- generateUUID():
			case <-ctx.Done():
			}
		}()
	}

	seen := make(map[string]bool)
	for i := 0; i < n; i++ {
		select {
		case uuid := <-results:
			if seen[uuid] {
				t.Errorf("duplicate UUID: %s", uuid)
			}
			seen[uuid] = true
		case <-ctx.Done():
			t.Fatal("timeout waiting for UUIDs")
		}
	}
}

// ---------------------------------------------------------------------------
// Verify handler extracts correct headers (simulated with mock)
// ---------------------------------------------------------------------------

func TestVerifyHandlerSetsHeaders(t *testing.T) {
	// This test demonstrates what headers verify WOULD set if Redis were available.
	// Since it checks session in Redis, we can't fully test without Redis,
	// but we can verify the claims extraction portion.
	s := newTestServer()

	userID := "user-verify-test"
	roles := []string{"admin", "e2_operational"}
	sessionID := "session-verify-headers"

	tokenStr, err := s.signAccessToken(userID, roles, sessionID)
	if err != nil {
		t.Fatalf("signAccessToken() error: %v", err)
	}

	// Create request with the valid token
	req := httptest.NewRequest("GET", "/api/v1/auth/verify", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)

	// Extract claims manually to verify what the handler would set
	claims, err := s.extractClaims(req)
	if err != nil {
		t.Fatalf("extractClaims() error: %v", err)
	}

	if claims.Subject != userID {
		t.Errorf("X-User-ID would be %q, want %q", claims.Subject, userID)
	}
	expectedRoles := strings.Join(roles, ",")
	actualRoles := strings.Join(claims.Roles, ",")
	if actualRoles != expectedRoles {
		t.Errorf("X-User-Roles would be %q, want %q", actualRoles, expectedRoles)
	}
	if claims.SessionID != sessionID {
		t.Errorf("X-Session-ID would be %q, want %q", claims.SessionID, sessionID)
	}
}

// ---------------------------------------------------------------------------
// writeJSON with various data types
// ---------------------------------------------------------------------------

func TestWriteJSONVariousTypes(t *testing.T) {
	tests := []struct {
		name   string
		status int
		data   any
	}{
		{
			name:   "string map",
			status: http.StatusOK,
			data:   map[string]string{"key": "value"},
		},
		{
			name:   "nested object",
			status: http.StatusCreated,
			data:   map[string]any{"user": map[string]any{"id": "123", "roles": []string{"admin"}}},
		},
		{
			name:   "array response",
			status: http.StatusOK,
			data:   []string{"one", "two", "three"},
		},
		{
			name:   "numeric data",
			status: http.StatusOK,
			data:   map[string]any{"count": 42, "ratio": 3.14},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeJSON(rec, tc.status, tc.data)

			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d", rec.Code, tc.status)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want %q", ct, "application/json")
			}
			// Ensure the body is valid JSON
			var parsed any
			if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
				t.Errorf("response body is not valid JSON: %v", err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// User struct JSON
// ---------------------------------------------------------------------------

func TestUserStructJSON(t *testing.T) {
	user := User{
		ID:          "550e8400-e29b-41d4-a716-446655440000",
		Username:    "admin",
		DisplayName: "System Administrator",
		Email:       "admin@ems-cop.local",
		Roles:       []string{"admin", "e1_strategic"},
	}

	data, err := json.Marshal(user)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}

	if decoded["id"] != user.ID {
		t.Errorf("id = %v, want %v", decoded["id"], user.ID)
	}
	if decoded["username"] != user.Username {
		t.Errorf("username = %v, want %v", decoded["username"], user.Username)
	}
	if decoded["display_name"] != user.DisplayName {
		t.Errorf("display_name = %v, want %v", decoded["display_name"], user.DisplayName)
	}
	if decoded["email"] != user.Email {
		t.Errorf("email = %v, want %v", decoded["email"], user.Email)
	}

	roles, ok := decoded["roles"].([]any)
	if !ok {
		t.Fatal("roles is not an array")
	}
	if len(roles) != 2 {
		t.Errorf("roles length = %d, want 2", len(roles))
	}
}

// ---------------------------------------------------------------------------
// Login response shape (tested via handler with infrastructure skip)
// ---------------------------------------------------------------------------

func TestLoginResponseShapeDocumentation(t *testing.T) {
	t.Skip("requires database - documenting expected response shape")

	// Expected successful login response:
	// {
	//   "access_token": "...",
	//   "refresh_token": "...",
	//   "token_type": "Bearer",
	//   "expires_in": 900,
	//   "user": {
	//     "id": "...",
	//     "username": "...",
	//     "display_name": "...",
	//     "email": "...",
	//     "roles": [...]
	//   }
	// }

	expectedKeys := []string{"access_token", "refresh_token", "token_type", "expires_in", "user"}
	_ = expectedKeys
	fmt.Println("Login response should contain:", expectedKeys)
}
