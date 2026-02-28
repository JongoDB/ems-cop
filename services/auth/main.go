package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

type Server struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	nc        *nats.Conn
	jwtSecret []byte
	logger    *slog.Logger
}

type User struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"display_name"`
	Email       string   `json:"email"`
	Roles       []string `json:"roles"`
}

type SessionData struct {
	UserID    string   `json:"user_id"`
	Roles     []string `json:"roles"`
	CreatedAt string   `json:"created_at"`
	LastActive string  `json:"last_active"`
	IP        string   `json:"ip"`
}

type Claims struct {
	Roles     []string `json:"roles"`
	SessionID string   `json:"session_id"`
	jwt.RegisteredClaims
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := os.Getenv("SERVICE_PORT")
	if port == "" {
		port = "3001"
	}

	ctx := context.Background()

	// PostgreSQL
	pgURL := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		envOr("POSTGRES_USER", "ems"),
		envOr("POSTGRES_PASSWORD", "ems_dev_password"),
		envOr("POSTGRES_HOST", "localhost"),
		envOr("POSTGRES_PORT", "5432"),
		envOr("POSTGRES_DB", "ems_cop"),
	)
	pgConfig, err := pgxpool.ParseConfig(pgURL)
	if err != nil {
		logger.Error("failed to parse pg config", "error", err)
		os.Exit(1)
	}
	pgConfig.MaxConns = int32(envOrInt("PG_MAX_CONNS", 10))
	pgConfig.MinConns = int32(envOrInt("PG_MIN_CONNS", 2))
	pgConfig.MaxConnLifetime = time.Duration(envOrInt("PG_CONN_MAX_LIFETIME_MINS", 30)) * time.Minute
	pgConfig.MaxConnIdleTime = 5 * time.Minute

	db, err := pgxpool.NewWithConfig(ctx, pgConfig)
	if err != nil {
		logger.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		logger.Error("failed to ping postgres", "error", err)
		os.Exit(1)
	}
	logger.Info("connected to postgres")

	// Redis
	redisURL := envOr("REDIS_URL", "redis://localhost:6379")
	redisOpts, err := redis.ParseURL(redisURL)
	if err != nil {
		logger.Error("failed to parse redis url", "error", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(redisOpts)
	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Error("failed to ping redis", "error", err)
		os.Exit(1)
	}
	logger.Info("connected to redis")

	// NATS
	natsURL := envOr("NATS_URL", "nats://localhost:4222")
	nc, err := nats.Connect(natsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		logger.Error("failed to connect to nats", "error", err)
		os.Exit(1)
	}
	defer nc.Close()
	logger.Info("connected to nats")

	jwtSecret := envOr("JWT_SECRET", "dev-secret-change-me")

	srv := &Server{
		db:        db,
		rdb:       rdb,
		nc:        nc,
		jwtSecret: []byte(jwtSecret),
		logger:    logger,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", srv.handleHealthLive)
	mux.HandleFunc("GET /health/ready", srv.handleHealthReady)
	mux.HandleFunc("GET /health", srv.handleHealthReady)
	mux.HandleFunc("POST /api/v1/auth/login", srv.rateLimitMiddleware(10, 60, "login", srv.handleLogin))
	mux.HandleFunc("POST /api/v1/auth/refresh", srv.rateLimitMiddleware(20, 60, "refresh", srv.handleRefresh))
	mux.HandleFunc("POST /api/v1/auth/logout", srv.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/verify", srv.handleVerify)
	mux.HandleFunc("GET /api/v1/auth/me", srv.handleMe)

	handler := maxBodyMiddleware(1<<20, mux) // 1 MB

	httpServer := &http.Server{
		Addr:         fmt.Sprintf(":%s", port),
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpServer.Shutdown(ctx)
		nc.Close()
		rdb.Close()
		db.Close()
	}()

	logger.Info("auth-service starting", "port", port)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func (s *Server) handleHealthLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "auth"})
}

func (s *Server) handleHealthReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	status := http.StatusOK
	overall := "ok"

	if err := s.db.Ping(r.Context()); err != nil {
		checks["postgres"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["postgres"] = "ok"
	}

	if err := s.rdb.Ping(r.Context()).Err(); err != nil {
		checks["redis"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["redis"] = "ok"
	}

	if !s.nc.IsConnected() {
		checks["nats"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["nats"] = "ok"
	}

	writeJSON(w, status, map[string]any{"status": overall, "service": "auth", "checks": checks})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "Username and password are required")
		return
	}

	ctx := r.Context()

	// Query user
	var userID, passwordHash, displayName, email string
	err := s.db.QueryRow(ctx,
		`SELECT id, password_hash, display_name, email FROM users
		 WHERE username = $1 AND status = 'active'`, req.Username,
	).Scan(&userID, &passwordHash, &displayName, &email)
	if err != nil {
		s.publishEvent("auth.login_failed", "", req.Username, clientIP(r), "", map[string]string{
			"reason": "user_not_found",
		})
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid username or password")
		return
	}

	// Verify password
	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		s.publishEvent("auth.login_failed", userID, req.Username, clientIP(r), "", map[string]string{
			"reason": "invalid_password",
		})
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid username or password")
		return
	}

	// Get user roles
	roles, err := s.getUserRoles(ctx, userID)
	if err != nil {
		s.logger.Error("failed to get user roles", "error", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve user roles")
		return
	}

	// Create session
	sessionID := generateUUID()
	refreshToken := generateRefreshToken()
	now := time.Now().UTC()

	sessionData := SessionData{
		UserID:     userID,
		Roles:      roles,
		CreatedAt:  now.Format(time.RFC3339),
		LastActive: now.Format(time.RFC3339),
		IP:         clientIP(r),
	}
	sessionJSON, _ := json.Marshal(sessionData)

	// Store session + refresh token in Redis (7-day TTL)
	pipe := s.rdb.Pipeline()
	pipe.Set(ctx, "session:"+sessionID, string(sessionJSON), 7*24*time.Hour)
	pipe.Set(ctx, "refresh:"+refreshToken, sessionID, 7*24*time.Hour)
	if _, err := pipe.Exec(ctx); err != nil {
		s.logger.Error("failed to create session in redis", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to create session")
		return
	}

	// Sign access token
	accessToken, err := s.signAccessToken(userID, roles, sessionID)
	if err != nil {
		s.logger.Error("failed to sign access token", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to generate token")
		return
	}

	s.publishEvent("auth.login", userID, req.Username, clientIP(r), sessionID, map[string]string{
		"method": "local",
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"token_type":    "Bearer",
		"expires_in":    900, // 15 minutes
		"user": map[string]any{
			"id":           userID,
			"username":     req.Username,
			"display_name": displayName,
			"email":        email,
			"roles":        roles,
		},
	})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "Refresh token is required")
		return
	}

	ctx := r.Context()

	// Look up session ID from refresh token
	sessionID, err := s.rdb.Get(ctx, "refresh:"+req.RefreshToken).Result()
	if err != nil {
		writeError(w, http.StatusUnauthorized, "INVALID_TOKEN", "Invalid or expired refresh token")
		return
	}

	// Look up session data
	sessionJSON, err := s.rdb.Get(ctx, "session:"+sessionID).Result()
	if err != nil {
		writeError(w, http.StatusUnauthorized, "SESSION_EXPIRED", "Session no longer active")
		return
	}

	var session SessionData
	if err := json.Unmarshal([]byte(sessionJSON), &session); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Corrupt session data")
		return
	}

	// Update last_active
	session.LastActive = time.Now().UTC().Format(time.RFC3339)
	updatedJSON, _ := json.Marshal(session)
	s.rdb.Set(ctx, "session:"+sessionID, string(updatedJSON), 7*24*time.Hour)

	// Issue new access token
	accessToken, err := s.signAccessToken(session.UserID, session.Roles, sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to generate token")
		return
	}

	// Get username for event
	var username string
	_ = s.db.QueryRow(ctx, "SELECT username FROM users WHERE id = $1", session.UserID).Scan(&username)

	s.publishEvent("auth.token_refreshed", session.UserID, username, clientIP(r), sessionID, nil)

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": accessToken,
		"token_type":   "Bearer",
		"expires_in":   900,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	claims, err := s.extractClaims(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or missing token")
		return
	}

	ctx := r.Context()

	// Delete session and find+delete refresh token
	s.rdb.Del(ctx, "session:"+claims.SessionID)

	// Scan for refresh token pointing to this session (best-effort cleanup)
	iter := s.rdb.Scan(ctx, 0, "refresh:*", 100).Iterator()
	for iter.Next(ctx) {
		val, err := s.rdb.Get(ctx, iter.Val()).Result()
		if err == nil && val == claims.SessionID {
			s.rdb.Del(ctx, iter.Val())
			break
		}
	}

	var username string
	_ = s.db.QueryRow(ctx, "SELECT username FROM users WHERE id = $1", claims.Subject).Scan(&username)

	s.publishEvent("auth.logout", claims.Subject, username, clientIP(r), claims.SessionID, nil)

	writeJSON(w, http.StatusOK, map[string]string{"message": "Logged out"})
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	claims, err := s.extractClaims(r)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	ctx := r.Context()

	// Check session still exists in Redis
	exists, err := s.rdb.Exists(ctx, "session:"+claims.SessionID).Result()
	if err != nil || exists == 0 {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	// Set response headers for Traefik ForwardAuth
	w.Header().Set("X-User-ID", claims.Subject)
	w.Header().Set("X-User-Roles", strings.Join(claims.Roles, ","))
	w.Header().Set("X-Session-ID", claims.SessionID)
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	// In production, X-User-ID comes from Traefik ForwardAuth.
	// For direct calls, fall back to extracting from JWT.
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		claims, err := s.extractClaims(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or missing token")
			return
		}
		userID = claims.Subject
	}

	ctx := r.Context()
	var user User
	err := s.db.QueryRow(ctx,
		`SELECT id, username, display_name, email FROM users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Username, &user.DisplayName, &user.Email)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return
	}

	roles, _ := s.getUserRoles(ctx, userID)
	user.Roles = roles

	writeJSON(w, http.StatusOK, map[string]any{"data": user})
}

// --- Rate Limiting ---

func (s *Server) rateLimitMiddleware(maxRequests int, windowSecs int, keyPrefix string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		key := fmt.Sprintf("ratelimit:%s:%s", keyPrefix, ip)
		ctx := r.Context()
		now := time.Now().UnixMilli()
		windowMs := int64(windowSecs) * 1000

		pipe := s.rdb.Pipeline()
		pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", now-windowMs))
		countCmd := pipe.ZCard(ctx, key)
		pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d", now)})
		pipe.Expire(ctx, key, time.Duration(windowSecs*2)*time.Second)
		pipe.Exec(ctx)

		if countCmd.Val() >= int64(maxRequests) {
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests, try again later")
			return
		}
		next(w, r)
	}
}

// --- Helpers ---

func (s *Server) getUserRoles(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.db.Query(ctx,
		`SELECT r.name FROM roles r
		 JOIN role_bindings rb ON rb.role_id = r.id
		 WHERE rb.user_id = $1
		   AND (rb.expires_at IS NULL OR rb.expires_at > NOW())`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query roles: %w", err)
	}
	defer rows.Close()

	var roles []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan role: %w", err)
		}
		roles = append(roles, name)
	}
	return roles, rows.Err()
}

func (s *Server) signAccessToken(userID string, roles []string, sessionID string) (string, error) {
	now := time.Now().UTC()
	claims := Claims{
		Roles:     roles,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(15 * time.Minute)),
			Issuer:    "ems-cop-auth",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func (s *Server) extractClaims(r *http.Request) (*Claims, error) {
	auth := r.Header.Get("Authorization")
	var tokenStr string
	if strings.HasPrefix(auth, "Bearer ") {
		tokenStr = strings.TrimPrefix(auth, "Bearer ")
	} else if t := r.URL.Query().Get("token"); t != "" {
		tokenStr = t
	} else {
		return nil, fmt.Errorf("missing bearer token")
	}

	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, fmt.Errorf("parse token: %w", err)
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}
	return claims, nil
}

func (s *Server) publishEvent(eventType, actorID, actorUsername, actorIP, sessionID string, details map[string]string) {
	if details == nil {
		details = map[string]string{}
	}
	detailsJSON, _ := json.Marshal(details)
	event := map[string]any{
		"event_type":     eventType,
		"actor_id":       actorID,
		"actor_username": actorUsername,
		"actor_ip":       actorIP,
		"session_id":     sessionID,
		"resource_type":  "user",
		"resource_id":    actorID,
		"action":         strings.Split(eventType, ".")[1],
		"details":        string(detailsJSON),
		"timestamp":      time.Now().UTC().Format(time.RFC3339Nano),
	}
	data, _ := json.Marshal(event)
	if err := s.nc.Publish(eventType, data); err != nil {
		s.logger.Error("failed to publish nats event", "event_type", eventType, "error", err)
	}
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func maxBodyMiddleware(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.Split(xff, ",")[0]
	}
	if xri := r.Header.Get("X-Real-Ip"); xri != "" {
		return xri
	}
	return strings.Split(r.RemoteAddr, ":")[0]
}

func generateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func generateRefreshToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}
