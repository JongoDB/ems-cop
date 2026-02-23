package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

type Server struct {
	ch     clickhouse.Conn
	nc     *nats.Conn
	logger *slog.Logger

	mu           sync.Mutex
	buffer       []AuditEvent
	lastHash     string
	flushTicker  *time.Ticker
}

type AuditEvent struct {
	EventType     string `json:"event_type"`
	ActorID       string `json:"actor_id"`
	ActorUsername  string `json:"actor_username"`
	ActorIP       string `json:"actor_ip"`
	SessionID     string `json:"session_id"`
	ResourceType  string `json:"resource_type"`
	ResourceID    string `json:"resource_id"`
	Action        string `json:"action"`
	Details       string `json:"details"`
	Timestamp     string `json:"timestamp"`
	Hash          string `json:"hash"`
	PreviousHash  string `json:"previous_hash"`
}

const (
	batchSize     = 100
	flushInterval = 1 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := envOr("SERVICE_PORT", "3006")

	ctx := context.Background()

	// ClickHouse — use native port (9000), not HTTP port (8123)
	chHost := envOr("CLICKHOUSE_HOST", "localhost")
	chPort := envOr("CLICKHOUSE_NATIVE_PORT", "9000")
	chDB := envOr("CLICKHOUSE_DB", "ems_audit")

	chUser := envOr("CLICKHOUSE_USER", "ems_audit")
	chPass := envOr("CLICKHOUSE_PASSWORD", "")

	ch, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{fmt.Sprintf("%s:%s", chHost, chPort)},
		Auth: clickhouse.Auth{
			Database: chDB,
			Username: chUser,
			Password: chPass,
		},
		Settings: clickhouse.Settings{
			"max_execution_time": 60,
		},
		MaxOpenConns: 5,
		MaxIdleConns: 2,
	})
	if err != nil {
		logger.Error("failed to open clickhouse", "error", err)
		os.Exit(1)
	}
	if err := ch.Ping(ctx); err != nil {
		logger.Error("failed to ping clickhouse", "error", err)
		os.Exit(1)
	}
	logger.Info("connected to clickhouse")

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

	srv := &Server{
		ch:     ch,
		nc:     nc,
		logger: logger,
		buffer: make([]AuditEvent, 0, batchSize),
	}

	// Recover last hash from ClickHouse
	srv.recoverLastHash(ctx)

	// Subscribe to audit-relevant NATS subjects
	subjects := []string{"auth.>", "ticket.>", "workflow.>", "operation.>", "c2.>", "endpoint.>"}
	for _, subj := range subjects {
		_, err := nc.Subscribe(subj, func(msg *nats.Msg) {
			srv.handleEvent(msg)
		})
		if err != nil {
			logger.Error("failed to subscribe", "subject", subj, "error", err)
		} else {
			logger.Info("subscribed", "subject", subj)
		}
	}

	// Start flush ticker
	srv.flushTicker = time.NewTicker(flushInterval)
	go func() {
		for range srv.flushTicker.C {
			srv.flush(context.Background())
		}
	}()

	// HTTP
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.handleHealth)
	mux.HandleFunc("GET /api/v1/audit/events", srv.handleQueryEvents)

	logger.Info("audit-service starting", "port", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", port), mux); err != nil {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "audit"})
}

func (s *Server) handleEvent(msg *nats.Msg) {
	var event AuditEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal event", "subject", msg.Subject, "error", err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Compute hash chain
	event.PreviousHash = s.lastHash
	eventJSON, _ := json.Marshal(event)
	hash := sha256.Sum256(append([]byte(s.lastHash), eventJSON...))
	event.Hash = hex.EncodeToString(hash[:])
	s.lastHash = event.Hash

	s.buffer = append(s.buffer, event)

	if len(s.buffer) >= batchSize {
		go s.flush(context.Background())
	}
}

func (s *Server) flush(ctx context.Context) {
	s.mu.Lock()
	if len(s.buffer) == 0 {
		s.mu.Unlock()
		return
	}
	batch := make([]AuditEvent, len(s.buffer))
	copy(batch, s.buffer)
	s.buffer = s.buffer[:0]
	s.mu.Unlock()

	b, err := s.ch.PrepareBatch(ctx,
		`INSERT INTO ems_audit.events
		 (event_type, actor_id, actor_username, actor_ip, session_id,
		  resource_type, resource_id, action, details, timestamp, hash, previous_hash)`)
	if err != nil {
		s.logger.Error("failed to prepare batch", "error", err)
		// Put events back in buffer
		s.mu.Lock()
		s.buffer = append(batch, s.buffer...)
		s.mu.Unlock()
		return
	}

	for _, e := range batch {
		ts := parseTimestamp(e.Timestamp)
		actorID := parseUUID(e.ActorID)
		resourceID := parseUUID(e.ResourceID)

		if err := b.Append(
			e.EventType,
			actorID,
			e.ActorUsername,
			e.ActorIP,
			e.SessionID,
			e.ResourceType,
			resourceID,
			e.Action,
			e.Details,
			ts,
			e.Hash,
			e.PreviousHash,
		); err != nil {
			s.logger.Error("failed to append to batch", "error", err)
		}
	}

	if err := b.Send(); err != nil {
		s.logger.Error("failed to send batch", "error", err)
		s.mu.Lock()
		s.buffer = append(batch, s.buffer...)
		s.mu.Unlock()
		return
	}

	s.logger.Info("flushed audit events", "count", len(batch))
}

func (s *Server) recoverLastHash(ctx context.Context) {
	var hash string
	row := s.ch.QueryRow(ctx,
		`SELECT hash FROM ems_audit.events ORDER BY timestamp DESC LIMIT 1`)
	if err := row.Scan(&hash); err != nil {
		s.logger.Info("no previous hash found, starting fresh chain")
		s.lastHash = ""
		return
	}
	s.lastHash = hash
	s.logger.Info("recovered last hash", "hash", hash[:16]+"...")
}

func (s *Server) handleQueryEvents(w http.ResponseWriter, r *http.Request) {
	page := maxInt(1, queryInt(r, "page", 1))
	limit := clamp(1, 100, queryInt(r, "limit", 50))
	offset := (page - 1) * limit

	conditions := []string{}
	params := []any{}

	if v := r.URL.Query().Get("event_type"); v != "" {
		conditions = append(conditions, "event_type = ?")
		params = append(params, v)
	}
	if v := r.URL.Query().Get("actor_id"); v != "" {
		conditions = append(conditions, "actor_id = ?")
		params = append(params, parseUUID(v))
	}
	if v := r.URL.Query().Get("resource_type"); v != "" {
		conditions = append(conditions, "resource_type = ?")
		params = append(params, v)
	}
	if v := r.URL.Query().Get("from"); v != "" {
		conditions = append(conditions, "timestamp >= ?")
		params = append(params, v)
	}
	if v := r.URL.Query().Get("to"); v != "" {
		conditions = append(conditions, "timestamp <= ?")
		params = append(params, v)
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	ctx := r.Context()

	// Count
	var total uint64
	countQuery := fmt.Sprintf("SELECT count() FROM ems_audit.events %s", where)
	if err := s.ch.QueryRow(ctx, countQuery, params...).Scan(&total); err != nil {
		s.logger.Error("failed to count events", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query events")
		return
	}

	// Data
	dataQuery := fmt.Sprintf(
		`SELECT event_type, actor_id, actor_username, actor_ip, session_id,
		        resource_type, resource_id, action, details, timestamp, hash, previous_hash
		 FROM ems_audit.events %s
		 ORDER BY timestamp DESC
		 LIMIT ? OFFSET ?`, where)
	params = append(params, limit, offset)

	rows, err := s.ch.Query(ctx, dataQuery, params...)
	if err != nil {
		s.logger.Error("failed to query events", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query events")
		return
	}
	defer rows.Close()

	type EventRow struct {
		EventType    string    `json:"event_type"`
		ActorID      string    `json:"actor_id"`
		ActorUsername string   `json:"actor_username"`
		ActorIP      string    `json:"actor_ip"`
		SessionID    string    `json:"session_id"`
		ResourceType string    `json:"resource_type"`
		ResourceID   string    `json:"resource_id"`
		Action       string    `json:"action"`
		Details      string    `json:"details"`
		Timestamp    time.Time `json:"timestamp"`
		Hash         string    `json:"hash"`
		PreviousHash string    `json:"previous_hash"`
	}

	var events []EventRow
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(&e.EventType, &e.ActorID, &e.ActorUsername, &e.ActorIP, &e.SessionID,
			&e.ResourceType, &e.ResourceID, &e.Action, &e.Details, &e.Timestamp, &e.Hash, &e.PreviousHash,
		); err != nil {
			s.logger.Error("failed to scan event row", "error", err)
			continue
		}
		events = append(events, e)
	}

	if events == nil {
		events = []EventRow{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       events,
		"pagination": map[string]any{"page": page, "limit": limit, "total": total},
	})
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clamp(min, max, val int) int {
	return int(math.Max(float64(min), math.Min(float64(max), float64(val))))
}

func parseTimestamp(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Now().UTC()
	}
	return t
}

func parseUUID(s string) uuid.UUID {
	u, err := uuid.Parse(s)
	if err != nil {
		return uuid.UUID{}
	}
	return u
}
