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
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// CTI Health Checker
// ---------------------------------------------------------------------------

type ctiHealth struct {
	mu        sync.RWMutex
	connected bool
	lastCheck time.Time
	relayURL  string
	logger    *slog.Logger
	client    *http.Client
}

func newCTIHealth(relayURL string, logger *slog.Logger) *ctiHealth {
	return &ctiHealth{
		relayURL:  relayURL,
		logger:    logger,
		connected: true,
		client:    &http.Client{Timeout: 5 * time.Second},
	}
}

func (c *ctiHealth) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

func (c *ctiHealth) LastCheck() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.lastCheck
}

func (c *ctiHealth) Start(ctx context.Context) {
	if c.relayURL == "" {
		c.logger.Info("CTI relay URL not configured, single-enclave mode")
		return
	}
	c.logger.Info("starting CTI health checker", "relay_url", c.relayURL)
	c.check()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.check()
			}
		}
	}()
}

func (c *ctiHealth) check() {
	resp, err := c.client.Get(c.relayURL + "/health")
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastCheck = time.Now()
	if err != nil {
		if c.connected {
			c.logger.Warn("CTI relay health check failed", "error", err)
		}
		c.connected = false
		return
	}
	resp.Body.Close()
	wasConnected := c.connected
	c.connected = resp.StatusCode >= 200 && resp.StatusCode < 300
	if !wasConnected && c.connected {
		c.logger.Info("CTI relay connection restored")
	} else if wasConnected && !c.connected {
		c.logger.Warn("CTI relay health check returned non-OK status", "status", resp.StatusCode)
	}
}

type Server struct {
	ch     clickhouse.Conn
	nc     *nats.Conn
	logger *slog.Logger
	cti    *ctiHealth

	mu           sync.Mutex
	buffer       []AuditEvent
	lastHash     string
	flushTicker  *time.Ticker
}

func (s *Server) isDegraded() bool {
	return enclave == "low" && s.cti != nil && !s.cti.IsConnected()
}

type AuditEvent struct {
	EventType      string `json:"event_type"`
	ActorID        string `json:"actor_id"`
	ActorUsername   string `json:"actor_username"`
	ActorIP        string `json:"actor_ip"`
	SessionID      string `json:"session_id"`
	ResourceType   string `json:"resource_type"`
	ResourceID     string `json:"resource_id"`
	Action         string `json:"action"`
	Details        string `json:"details"`
	Timestamp      string `json:"timestamp"`
	Classification string `json:"classification"`
	Hash           string `json:"hash"`
	PreviousHash   string `json:"previous_hash"`
	SourceEnclave  string `json:"source_enclave"`
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

	// CTI health checker
	ctiCtx, ctiCancel := context.WithCancel(context.Background())
	ctiRelayURL := os.Getenv("CTI_RELAY_URL")
	if ctiRelayURL != "" {
		srv.cti = newCTIHealth(ctiRelayURL, logger)
		srv.cti.Start(ctiCtx)
	}

	// Recover last hash from ClickHouse
	srv.recoverLastHash(ctx)

	// Subscribe to audit-relevant NATS subjects
	subjects := []string{"auth.>", "ticket.>", "workflow.>", "operation.>", "c2.>", "endpoint.>", "command_preset.>", "dco.>"}
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

	// On the high side, also subscribe to CTI-relayed audit events from the low side.
	// These arrive on cti.relayed.audit.* and are tagged with source_enclave='low'.
	if enclave == "high" {
		ctiSubjects := []string{"cti.relayed.audit.>"}
		for _, subj := range ctiSubjects {
			_, err := nc.Subscribe(subj, func(msg *nats.Msg) {
				srv.handleCTIRelayedEvent(msg)
			})
			if err != nil {
				logger.Error("failed to subscribe to CTI relay subject", "subject", subj, "error", err)
			} else {
				logger.Info("subscribed to CTI relay subject", "subject", subj)
			}
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
	mux.HandleFunc("GET /health/live", srv.handleHealthLive)
	mux.HandleFunc("GET /health/ready", srv.handleHealthReady)
	mux.HandleFunc("GET /health", srv.handleHealthReady)
	mux.HandleFunc("GET /api/v1/audit/events", srv.handleQueryEvents)
	mux.HandleFunc("GET /api/v1/audit/cti-status", srv.handleCTIStatus)
	mux.HandleFunc("GET /api/v1/audit/consolidated", srv.handleConsolidated)
	mux.HandleFunc("GET /api/v1/audit/consolidated/stats", srv.handleConsolidatedStats)
	mux.HandleFunc("GET /api/v1/audit/consolidated/correlation", srv.handleConsolidatedCorrelation)

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
		ctiCancel() // stop CTI health checker
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		httpServer.Shutdown(shutdownCtx)
		srv.flushTicker.Stop()
		srv.flush(context.Background())
		nc.Close()
		ch.Close()
	}()

	logger.Info("audit-service starting", "port", port)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func (s *Server) handleHealthLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "audit"})
}

func (s *Server) handleHealthReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	status := http.StatusOK
	overall := "ok"

	if err := s.ch.Ping(r.Context()); err != nil {
		checks["clickhouse"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["clickhouse"] = "ok"
	}

	if !s.nc.IsConnected() {
		checks["nats"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["nats"] = "ok"
	}

	resp := map[string]any{"status": overall, "service": "audit", "checks": checks}
	if s.cti != nil {
		resp["cti_connected"] = s.cti.IsConnected()
		resp["degraded"] = s.isDegraded()
	}
	writeJSON(w, status, resp)
}

func (s *Server) handleCTIStatus(w http.ResponseWriter, r *http.Request) {
	ctiConnected := true
	degraded := false
	if s.cti != nil {
		ctiConnected = s.cti.IsConnected()
		degraded = s.isDegraded()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cti_connected": ctiConnected,
		"enclave":       enclave,
		"degraded":      degraded,
	})
}

func (s *Server) handleEvent(msg *nats.Msg) {
	s.handleEventWithSource(msg, enclave)
}

func (s *Server) handleCTIRelayedEvent(msg *nats.Msg) {
	s.handleEventWithSource(msg, "low")
}

// ---------------------------------------------------------------------------
// Consolidated Audit Dashboard Endpoints (high side only)
// ---------------------------------------------------------------------------

// requireHighSide returns true if the request should be rejected (low side).
func requireHighSide(w http.ResponseWriter) bool {
	if enclave != "high" {
		writeError(w, http.StatusForbidden, "FORBIDDEN",
			"Consolidated audit is only available on the high-side enclave")
		return true
	}
	return false
}

// handleConsolidated returns a unified audit timeline merging local and CTI-relayed events.
// Only available when ENCLAVE=high.
func (s *Server) handleConsolidated(w http.ResponseWriter, r *http.Request) {
	if requireHighSide(w) {
		return
	}

	page := maxInt(1, queryInt(r, "page", 1))
	limit := clamp(1, 100, queryInt(r, "limit", 50))
	offset := (page - 1) * limit

	conditions := []string{}
	params := []any{}

	// RBAC: non-leadership users can only see their own events
	userRoles := r.Header.Get("X-User-Roles")
	userID := r.Header.Get("X-User-ID")
	if userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational") {
		conditions = append(conditions, "actor_id = ?")
		params = append(params, parseUUID(userID))
	}

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
	if v := r.URL.Query().Get("source_enclave"); v != "" && v != "all" {
		conditions = append(conditions, "source_enclave = ?")
		params = append(params, v)
	}
	if v := r.URL.Query().Get("start_date"); v != "" {
		conditions = append(conditions, "timestamp >= ?")
		params = append(params, v)
	}
	if v := r.URL.Query().Get("end_date"); v != "" {
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
		s.logger.Error("consolidated: failed to count events", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query consolidated events")
		return
	}

	// Data
	dataQuery := fmt.Sprintf(
		`SELECT event_type, actor_id, actor_username, actor_ip, session_id,
		        resource_type, resource_id, action, details, timestamp,
		        classification, hash, previous_hash, source_enclave
		 FROM ems_audit.events %s
		 ORDER BY timestamp DESC
		 LIMIT ? OFFSET ?`, where)
	params = append(params, limit, offset)

	rows, err := s.ch.Query(ctx, dataQuery, params...)
	if err != nil {
		s.logger.Error("consolidated: failed to query events", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query consolidated events")
		return
	}
	defer rows.Close()

	type ConsolidatedEventRow struct {
		EventType      string    `json:"event_type"`
		ActorID        string    `json:"actor_id"`
		ActorUsername   string    `json:"actor_username"`
		ActorIP        string    `json:"actor_ip"`
		SessionID      string    `json:"session_id"`
		ResourceType   string    `json:"resource_type"`
		ResourceID     string    `json:"resource_id"`
		Action         string    `json:"action"`
		Details        string    `json:"details"`
		Timestamp      time.Time `json:"timestamp"`
		Classification string    `json:"classification"`
		Hash           string    `json:"hash"`
		PreviousHash   string    `json:"previous_hash"`
		SourceEnclave  string    `json:"source_enclave"`
	}

	var events []ConsolidatedEventRow
	for rows.Next() {
		var e ConsolidatedEventRow
		if err := rows.Scan(
			&e.EventType, &e.ActorID, &e.ActorUsername, &e.ActorIP, &e.SessionID,
			&e.ResourceType, &e.ResourceID, &e.Action, &e.Details, &e.Timestamp,
			&e.Classification, &e.Hash, &e.PreviousHash, &e.SourceEnclave,
		); err != nil {
			s.logger.Error("consolidated: failed to scan event row", "error", err)
			continue
		}
		events = append(events, e)
	}

	if events == nil {
		events = []ConsolidatedEventRow{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       events,
		"pagination": map[string]any{"page": page, "limit": limit, "total": total},
	})
}

// handleConsolidatedStats returns aggregate statistics for the consolidated audit view.
// Includes event counts by enclave, by type, hourly breakdown (last 24h), and CTI transfer counts.
func (s *Server) handleConsolidatedStats(w http.ResponseWriter, r *http.Request) {
	if requireHighSide(w) {
		return
	}

	ctx := r.Context()

	// 1. Event counts by source enclave
	type EnclaveStat struct {
		SourceEnclave string `json:"source_enclave"`
		Count         uint64 `json:"count"`
	}
	var enclaveStats []EnclaveStat
	enclaveRows, err := s.ch.Query(ctx,
		`SELECT source_enclave, count() AS cnt
		 FROM ems_audit.events
		 GROUP BY source_enclave
		 ORDER BY cnt DESC`)
	if err != nil {
		s.logger.Error("consolidated stats: failed to query enclave counts", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query statistics")
		return
	}
	for enclaveRows.Next() {
		var es EnclaveStat
		if err := enclaveRows.Scan(&es.SourceEnclave, &es.Count); err != nil {
			s.logger.Error("consolidated stats: failed to scan enclave stat", "error", err)
			continue
		}
		enclaveStats = append(enclaveStats, es)
	}
	enclaveRows.Close()
	if enclaveStats == nil {
		enclaveStats = []EnclaveStat{}
	}

	// 2. Event counts by type
	type TypeStat struct {
		EventType string `json:"event_type"`
		Count     uint64 `json:"count"`
	}
	var typeStats []TypeStat
	typeRows, err := s.ch.Query(ctx,
		`SELECT event_type, count() AS cnt
		 FROM ems_audit.events
		 GROUP BY event_type
		 ORDER BY cnt DESC
		 LIMIT 50`)
	if err != nil {
		s.logger.Error("consolidated stats: failed to query type counts", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query statistics")
		return
	}
	for typeRows.Next() {
		var ts TypeStat
		if err := typeRows.Scan(&ts.EventType, &ts.Count); err != nil {
			s.logger.Error("consolidated stats: failed to scan type stat", "error", err)
			continue
		}
		typeStats = append(typeStats, ts)
	}
	typeRows.Close()
	if typeStats == nil {
		typeStats = []TypeStat{}
	}

	// 3. Hourly breakdown for the last 24 hours (by source enclave)
	type HourlyStat struct {
		Hour          time.Time `json:"hour"`
		SourceEnclave string    `json:"source_enclave"`
		Count         uint64    `json:"count"`
	}
	var hourlyStats []HourlyStat
	hourlyRows, err := s.ch.Query(ctx,
		`SELECT toStartOfHour(timestamp) AS hour, source_enclave, count() AS cnt
		 FROM ems_audit.events
		 WHERE timestamp >= now() - INTERVAL 24 HOUR
		 GROUP BY hour, source_enclave
		 ORDER BY hour ASC, source_enclave ASC`)
	if err != nil {
		s.logger.Error("consolidated stats: failed to query hourly counts", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query statistics")
		return
	}
	for hourlyRows.Next() {
		var hs HourlyStat
		if err := hourlyRows.Scan(&hs.Hour, &hs.SourceEnclave, &hs.Count); err != nil {
			s.logger.Error("consolidated stats: failed to scan hourly stat", "error", err)
			continue
		}
		hourlyStats = append(hourlyStats, hs)
	}
	hourlyRows.Close()
	if hourlyStats == nil {
		hourlyStats = []HourlyStat{}
	}

	// 4. CTI transfer event counts (from cti_provenance table)
	type TransferStat struct {
		Direction   string `json:"direction"`
		EventType   string `json:"event_type"`
		Count       uint64 `json:"count"`
	}
	var transferStats []TransferStat
	transferRows, err := s.ch.Query(ctx,
		`SELECT direction, event_type, count() AS cnt
		 FROM ems_audit.cti_provenance
		 WHERE timestamp >= now() - INTERVAL 24 HOUR
		 GROUP BY direction, event_type
		 ORDER BY cnt DESC`)
	if err != nil {
		// cti_provenance table may not exist on all deployments; log but don't fail
		s.logger.Warn("consolidated stats: failed to query CTI transfer counts (table may not exist)", "error", err)
		transferStats = []TransferStat{}
	} else {
		for transferRows.Next() {
			var ts TransferStat
			if err := transferRows.Scan(&ts.Direction, &ts.EventType, &ts.Count); err != nil {
				s.logger.Error("consolidated stats: failed to scan transfer stat", "error", err)
				continue
			}
			transferStats = append(transferStats, ts)
		}
		transferRows.Close()
		if transferStats == nil {
			transferStats = []TransferStat{}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"by_enclave":  enclaveStats,
		"by_type":     typeStats,
		"by_hour":     hourlyStats,
		"transfers":   transferStats,
	})
}

// handleConsolidatedCorrelation returns all events for a given operation or resource
// across both enclaves. Useful for tracking cross-domain operations end-to-end.
func (s *Server) handleConsolidatedCorrelation(w http.ResponseWriter, r *http.Request) {
	if requireHighSide(w) {
		return
	}

	operationID := r.URL.Query().Get("operation_id")
	resourceID := r.URL.Query().Get("resource_id")

	if operationID == "" && resourceID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST",
			"Either operation_id or resource_id query parameter is required")
		return
	}

	page := maxInt(1, queryInt(r, "page", 1))
	limit := clamp(1, 100, queryInt(r, "limit", 50))
	offset := (page - 1) * limit

	conditions := []string{}
	params := []any{}

	// RBAC: non-leadership users can only see their own events
	userRoles := r.Header.Get("X-User-Roles")
	userID := r.Header.Get("X-User-ID")
	if userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational") {
		conditions = append(conditions, "actor_id = ?")
		params = append(params, parseUUID(userID))
	}

	if operationID != "" {
		conditions = append(conditions, "operation_id = ?")
		params = append(params, parseUUID(operationID))
	}
	if resourceID != "" {
		conditions = append(conditions, "resource_id = ?")
		params = append(params, parseUUID(resourceID))
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
		s.logger.Error("correlation: failed to count events", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query correlated events")
		return
	}

	// Data
	dataQuery := fmt.Sprintf(
		`SELECT event_type, actor_id, actor_username, actor_ip, session_id,
		        resource_type, resource_id, action, details, timestamp,
		        classification, hash, previous_hash, source_enclave
		 FROM ems_audit.events %s
		 ORDER BY timestamp ASC
		 LIMIT ? OFFSET ?`, where)
	params = append(params, limit, offset)

	rows, err := s.ch.Query(ctx, dataQuery, params...)
	if err != nil {
		s.logger.Error("correlation: failed to query events", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query correlated events")
		return
	}
	defer rows.Close()

	type CorrelatedEventRow struct {
		EventType      string    `json:"event_type"`
		ActorID        string    `json:"actor_id"`
		ActorUsername   string    `json:"actor_username"`
		ActorIP        string    `json:"actor_ip"`
		SessionID      string    `json:"session_id"`
		ResourceType   string    `json:"resource_type"`
		ResourceID     string    `json:"resource_id"`
		Action         string    `json:"action"`
		Details        string    `json:"details"`
		Timestamp      time.Time `json:"timestamp"`
		Classification string    `json:"classification"`
		Hash           string    `json:"hash"`
		PreviousHash   string    `json:"previous_hash"`
		SourceEnclave  string    `json:"source_enclave"`
	}

	var events []CorrelatedEventRow
	for rows.Next() {
		var e CorrelatedEventRow
		if err := rows.Scan(
			&e.EventType, &e.ActorID, &e.ActorUsername, &e.ActorIP, &e.SessionID,
			&e.ResourceType, &e.ResourceID, &e.Action, &e.Details, &e.Timestamp,
			&e.Classification, &e.Hash, &e.PreviousHash, &e.SourceEnclave,
		); err != nil {
			s.logger.Error("correlation: failed to scan event row", "error", err)
			continue
		}
		events = append(events, e)
	}

	if events == nil {
		events = []CorrelatedEventRow{}
	}

	// Summary: count events by source enclave for this correlation
	type EnclaveSummary struct {
		SourceEnclave string `json:"source_enclave"`
		Count         uint64 `json:"count"`
	}
	var enclaveSummary []EnclaveSummary

	// Re-build params without limit/offset for the summary query
	summaryParams := []any{}
	summaryConditions := []string{}
	if userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational") {
		summaryConditions = append(summaryConditions, "actor_id = ?")
		summaryParams = append(summaryParams, parseUUID(userID))
	}
	if operationID != "" {
		summaryConditions = append(summaryConditions, "operation_id = ?")
		summaryParams = append(summaryParams, parseUUID(operationID))
	}
	if resourceID != "" {
		summaryConditions = append(summaryConditions, "resource_id = ?")
		summaryParams = append(summaryParams, parseUUID(resourceID))
	}
	summaryWhere := ""
	if len(summaryConditions) > 0 {
		summaryWhere = "WHERE " + strings.Join(summaryConditions, " AND ")
	}

	summaryQuery := fmt.Sprintf(
		`SELECT source_enclave, count() AS cnt
		 FROM ems_audit.events %s
		 GROUP BY source_enclave
		 ORDER BY source_enclave`, summaryWhere)
	summaryRows, err := s.ch.Query(ctx, summaryQuery, summaryParams...)
	if err != nil {
		s.logger.Error("correlation: failed to query enclave summary", "error", err)
		// Non-fatal: return events without summary
		enclaveSummary = []EnclaveSummary{}
	} else {
		for summaryRows.Next() {
			var es EnclaveSummary
			if err := summaryRows.Scan(&es.SourceEnclave, &es.Count); err != nil {
				s.logger.Error("correlation: failed to scan enclave summary", "error", err)
				continue
			}
			enclaveSummary = append(enclaveSummary, es)
		}
		summaryRows.Close()
		if enclaveSummary == nil {
			enclaveSummary = []EnclaveSummary{}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":             events,
		"pagination":       map[string]any{"page": page, "limit": limit, "total": total},
		"enclave_summary":  enclaveSummary,
	})
}

func (s *Server) handleEventWithSource(msg *nats.Msg, sourceEnclave string) {
	var event AuditEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal event", "subject", msg.Subject, "error", err)
		return
	}

	// Default classification if not set
	if event.Classification == "" {
		event.Classification = "UNCLASS"
	}

	// Enclave enforcement: on low side, drop SECRET events
	if enclave == "low" && event.Classification == "SECRET" {
		return
	}

	// Degraded mode warning: CTI relay is down, events are only stored locally
	if s.isDegraded() {
		s.logger.Warn("CTI relay down — audit event stored locally only",
			"event_type", event.EventType, "subject", msg.Subject)
	}

	// Tag the event with its source enclave
	if sourceEnclave == "" {
		sourceEnclave = "local"
	}
	event.SourceEnclave = sourceEnclave

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
		  resource_type, resource_id, action, details, timestamp, classification, hash, previous_hash, source_enclave)`)
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

		classification := e.Classification
		if classification == "" {
			classification = "UNCLASS"
		}

		sourceEnclave := e.SourceEnclave
		if sourceEnclave == "" {
			sourceEnclave = "local"
		}

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
			classification,
			e.Hash,
			e.PreviousHash,
			sourceEnclave,
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

	// RBAC: non-leadership users can only see their own events
	userRoles := r.Header.Get("X-User-Roles")
	userID := r.Header.Get("X-User-ID")
	if userID != "" && !hasAnyRole(userRoles, "admin", "e1_strategic", "e2_operational") {
		conditions = append(conditions, "actor_id = ?")
		params = append(params, parseUUID(userID))
	}

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
	if v := r.URL.Query().Get("classification"); v != "" {
		conditions = append(conditions, "classification = ?")
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

	// Enclave enforcement: on low side, never return SECRET events
	if enclave == "low" {
		conditions = append(conditions, "classification != 'SECRET'")
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
		        resource_type, resource_id, action, details, timestamp, classification, hash, previous_hash
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
		EventType      string    `json:"event_type"`
		ActorID        string    `json:"actor_id"`
		ActorUsername   string   `json:"actor_username"`
		ActorIP        string    `json:"actor_ip"`
		SessionID      string    `json:"session_id"`
		ResourceType   string    `json:"resource_type"`
		ResourceID     string    `json:"resource_id"`
		Action         string    `json:"action"`
		Details        string    `json:"details"`
		Timestamp      time.Time `json:"timestamp"`
		Classification string    `json:"classification"`
		Hash           string    `json:"hash"`
		PreviousHash   string    `json:"previous_hash"`
	}

	var events []EventRow
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(&e.EventType, &e.ActorID, &e.ActorUsername, &e.ActorIP, &e.SessionID,
			&e.ResourceType, &e.ResourceID, &e.Action, &e.Details, &e.Timestamp, &e.Classification, &e.Hash, &e.PreviousHash,
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

func maxBodyMiddleware(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}

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

var enclave = envOr("ENCLAVE", "")

func isValidClassification(c string) bool {
	return c == "UNCLASS" || c == "CUI" || c == "SECRET"
}

func classificationRank(c string) int {
	switch c {
	case "UNCLASS":
		return 0
	case "CUI":
		return 1
	case "SECRET":
		return 2
	default:
		return -1
	}
}

func hasAnyRole(rolesHeader string, allowed ...string) bool {
	for _, role := range strings.Split(rolesHeader, ",") {
		role = strings.TrimSpace(role)
		for _, a := range allowed {
			if role == a {
				return true
			}
		}
	}
	return false
}
