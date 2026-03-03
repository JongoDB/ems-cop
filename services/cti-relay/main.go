package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Server struct {
	logger      *slog.Logger
	ctiAPIToken string
	lowDB       *pgxpool.Pool
	highDB      *pgxpool.Pool
	lowNATS     *nats.Conn
	highNATS    *nats.Conn
	nifi        *NiFiClient // NiFi REST API client (nil if NiFi not configured)
	clickhouse  *sql.DB     // ClickHouse for provenance export (nil if not configured)

	mu       sync.RWMutex
	policies []TransferPolicy

	statsMu              sync.Mutex
	lastAuthSync         time.Time
	lastTelemetryTransfer time.Time
	pendingTransfers     int
	transferStats        map[string]int // classification -> count
}

type TransferPolicy struct {
	ID             string `json:"id"`
	SourceEnclave  string `json:"source_enclave"`
	TargetEnclave  string `json:"target_enclave"`
	EntityType     string `json:"entity_type"`
	Classification string `json:"classification"`
	Action         string `json:"action"`
	RiskLevelMin   *int   `json:"risk_level_min,omitempty"`
	RiskLevelMax   *int   `json:"risk_level_max,omitempty"`
}

type TransferRequest struct {
	Direction      string   `json:"direction"`
	EntityType     string   `json:"entity_type"`
	EntityIDs      []string `json:"entity_ids"`
	Classification string   `json:"classification"`
}

type TransferRecord struct {
	ID             string    `json:"id"`
	Direction      string    `json:"direction"`
	EntityType     string    `json:"entity_type"`
	EntityIDs      []string  `json:"entity_ids"`
	Classification string    `json:"classification"`
	Status         string    `json:"status"`
	Reason         string    `json:"reason,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

type StatusResponse struct {
	LowConnected         bool           `json:"low_connected"`
	HighConnected        bool           `json:"high_connected"`
	LastAuthSync         string         `json:"last_auth_sync"`
	LastTelemetryTransfer string        `json:"last_telemetry_transfer"`
	PendingTransfers     int            `json:"pending_transfers"`
	TransferStats        map[string]int `json:"transfer_stats"`
}

// TransferApproval tracks a queued transfer awaiting manual approval.
type TransferApproval struct {
	ID             string    `json:"id"`
	TransferID     string    `json:"transfer_id"`
	Direction      string    `json:"direction"`
	EntityType     string    `json:"entity_type"`
	EntityIDs      []string  `json:"entity_ids"`
	Classification string    `json:"classification"`
	Status         string    `json:"status"` // "pending", "approved", "rejected", "expired"
	RequestedBy    string    `json:"requested_by,omitempty"`
	Reason         string    `json:"reason,omitempty"`
	ReviewedBy     string    `json:"reviewed_by,omitempty"`
	ReviewedAt     *time.Time `json:"reviewed_at,omitempty"`
	ExpiresAt      time.Time `json:"expires_at"`
	CreatedAt      time.Time `json:"created_at"`
}

// NiFiFlowConfig stores NiFi flow configuration from the database.
type NiFiFlowConfig struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	ProcessGroupID string `json:"process_group_id"`
	FlowType       string `json:"flow_type"` // "transfer", "enrichment", "sanitization"
	Enabled        bool   `json:"enabled"`
	CreatedAt      string `json:"created_at"`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := envOr("SERVICE_PORT", "3010")
	transferInterval := parseDuration(envOr("TRANSFER_INTERVAL", "30s"), 30*time.Second)
	authSyncInterval := parseDuration(envOr("AUTH_SYNC_INTERVAL", "60s"), 60*time.Second)

	ctiAPIToken := os.Getenv("CTI_API_TOKEN")
	if ctiAPIToken == "" {
		logger.Error("CTI_API_TOKEN environment variable is required but not set")
		os.Exit(1)
	}

	ctx := context.Background()

	// Low-side PostgreSQL
	lowPGPassword := envOr("CTI_LOW_PG_PASSWORD", "")
	if lowPGPassword == "" {
		logger.Error("CTI_LOW_PG_PASSWORD is required")
		os.Exit(1)
	}
	lowDB, err := connectPG(ctx, logger, "low",
		envOr("CTI_LOW_PG_HOST", "localhost"),
		envOr("CTI_LOW_PG_PORT", "5432"),
		envOr("CTI_LOW_PG_DB", "ems_cop"),
		envOr("CTI_LOW_PG_USER", "ems"),
		lowPGPassword,
	)
	if err != nil {
		logger.Error("failed to connect to low-side postgres", "error", err)
		os.Exit(1)
	}
	defer lowDB.Close()

	// High-side PostgreSQL
	highPGPassword := envOr("CTI_HIGH_PG_PASSWORD", "")
	if highPGPassword == "" {
		logger.Error("CTI_HIGH_PG_PASSWORD is required")
		os.Exit(1)
	}
	highDB, err := connectPG(ctx, logger, "high",
		envOr("CTI_HIGH_PG_HOST", "localhost"),
		envOr("CTI_HIGH_PG_PORT", "5432"),
		envOr("CTI_HIGH_PG_DB", "ems_cop"),
		envOr("CTI_HIGH_PG_USER", "ems"),
		highPGPassword,
	)
	if err != nil {
		logger.Error("failed to connect to high-side postgres", "error", err)
		os.Exit(1)
	}
	defer highDB.Close()

	// Low-side NATS
	lowNATSURL := envOr("CTI_LOW_NATS_URL", "nats://localhost:4222")
	lowNATS, err := connectNATS(logger, "low", lowNATSURL)
	if err != nil {
		logger.Error("failed to connect to low-side nats", "error", err)
		os.Exit(1)
	}
	defer lowNATS.Close()

	// High-side NATS
	highNATSURL := envOr("CTI_HIGH_NATS_URL", "nats://localhost:4222")
	highNATS, err := connectNATS(logger, "high", highNATSURL)
	if err != nil {
		logger.Error("failed to connect to high-side nats", "error", err)
		os.Exit(1)
	}
	defer highNATS.Close()

	srv := &Server{
		logger:        logger,
		ctiAPIToken:   ctiAPIToken,
		lowDB:         lowDB,
		highDB:        highDB,
		lowNATS:       lowNATS,
		highNATS:      highNATS,
		policies:      defaultPolicies(),
		transferStats: make(map[string]int),
	}

	// Optional NiFi client
	nifiURL := envOr("NIFI_URL", "")
	if nifiURL != "" {
		nifiUser := envOr("NIFI_USERNAME", "")
		nifiPass := envOr("NIFI_PASSWORD", "")
		if nifiUser == "" {
			logger.Error("NIFI_URL is set but NIFI_USERNAME is empty — refusing to start with missing NiFi credentials")
			os.Exit(1)
		}
		if nifiPass == "" {
			logger.Error("NIFI_URL is set but NIFI_PASSWORD is empty — refusing to start with missing NiFi credentials")
			os.Exit(1)
		}
		srv.nifi = NewNiFiClient(nifiURL, nifiUser, nifiPass, logger)
		logger.Info("nifi client configured", "url", nifiURL)
	} else {
		logger.Info("NIFI_URL not set, NiFi integration disabled")
	}

	// Optional ClickHouse for provenance export
	chHost := envOr("CTI_CLICKHOUSE_HOST", "")
	if chHost != "" {
		chPort := envOr("CTI_CLICKHOUSE_PORT", "9000")
		chDB := envOr("CTI_CLICKHOUSE_DB", "ems_audit")
		chPass := envOr("CTI_CLICKHOUSE_PASSWORD", "")
		chDSN := fmt.Sprintf("clickhouse://%s:%s/%s?username=default&password=%s", chHost, chPort, chDB, chPass)
		chConn, err := sql.Open("clickhouse", chDSN)
		if err != nil {
			logger.Warn("failed to open clickhouse connection", "error", err)
		} else {
			if err := chConn.Ping(); err != nil {
				logger.Warn("clickhouse ping failed (provenance export disabled)", "error", err)
				chConn.Close()
			} else {
				srv.clickhouse = chConn
				logger.Info("clickhouse connected for provenance export", "host", chHost)
			}
		}
	} else {
		logger.Info("CTI_CLICKHOUSE_HOST not set, provenance export disabled")
	}

	// Create transfer records table on high-side DB (idempotent)
	srv.ensureTransferTable(ctx)

	// Create transfer approvals table on high-side DB (idempotent)
	srv.ensureApprovalTable(ctx)

	// Create NiFi flow configs table on high-side DB (idempotent)
	srv.ensureNiFiFlowConfigTable(ctx)

	// Create finding sync state table on high-side DB (idempotent)
	srv.ensureFindingSyncTable(ctx)

	// Ensure ClickHouse provenance table exists (idempotent)
	srv.ensureProvenanceTable()

	// Load policies from high-side DB
	srv.loadPolicies(ctx)

	// Start background workers
	stopCh := make(chan struct{})
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runAuthSync(ctx, authSyncInterval, stopCh)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runTelemetryRelay(stopCh)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runPolicyRefresh(ctx, 5*time.Minute, stopCh)
	}()

	// Approval auto-expiry worker
	approvalExpiryInterval := parseDuration(envOr("APPROVAL_EXPIRY_CHECK_INTERVAL", "5m"), 5*time.Minute)
	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runApprovalExpiry(ctx, approvalExpiryInterval, stopCh)
	}()

	// Finding relay — subscribe to finding events on low-side NATS
	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runFindingRelay(stopCh)
	}()

	// Finding sync — periodic batch sync from low→high
	findingSyncInterval := parseDuration(envOr("FINDING_SYNC_INTERVAL", "60s"), 60*time.Second)
	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runFindingSync(ctx, findingSyncInterval, stopCh)
	}()

	// NiFi provenance export worker (only if both NiFi and ClickHouse are configured)
	if srv.nifi != nil && srv.clickhouse != nil {
		provenanceInterval := parseDuration(envOr("PROVENANCE_EXPORT_INTERVAL", "30s"), 30*time.Second)
		wg.Add(1)
		go func() {
			defer wg.Done()
			srv.runProvenanceExport(ctx, provenanceInterval, stopCh)
		}()
	}

	// Cross-domain command relay (M12)
	wg.Add(1)
	go func() {
		defer wg.Done()
		srv.runCommandRelay(stopCh)
	}()

	_ = transferInterval // available for future automatic batch transfers

	// HTTP routes
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", srv.handleHealthLive)
	mux.HandleFunc("GET /health/ready", srv.handleHealthReady)
	mux.HandleFunc("GET /health", srv.handleHealthReady)
	mux.HandleFunc("GET /api/v1/cti/status", srv.handleStatus)
	mux.HandleFunc("POST /api/v1/cti/transfer", srv.handleTransfer)
	mux.HandleFunc("GET /api/v1/cti/transfers", srv.handleListTransfers)
	mux.HandleFunc("POST /api/v1/cti/auth-sync", srv.handleAuthSync)
	mux.HandleFunc("GET /api/v1/cti/policies", srv.handleListPolicies)

	// Approval workflow routes
	mux.HandleFunc("GET /api/v1/cti/approvals", srv.handleListApprovals)
	mux.HandleFunc("GET /api/v1/cti/approvals/{id}", srv.handleGetApproval)
	mux.HandleFunc("POST /api/v1/cti/approvals/{id}/approve", srv.handleApproveTransfer)
	mux.HandleFunc("POST /api/v1/cti/approvals/{id}/reject", srv.handleRejectTransfer)

	// Finding sync routes
	mux.HandleFunc("GET /api/v1/cti/findings/sync-status", srv.handleFindingSyncStatus)
	mux.HandleFunc("POST /api/v1/cti/findings/sync", srv.handleFindingSync)

	// Cross-domain command relay routes (M12)
	mux.HandleFunc("GET /api/v1/cti/commands", srv.handleListRelayedCommands)
	mux.HandleFunc("GET /api/v1/cti/commands/{id}/status", srv.handleGetRelayedCommandStatus)

	// NiFi integration routes
	mux.HandleFunc("GET /api/v1/cti/nifi/status", srv.handleNiFiStatus)
	mux.HandleFunc("POST /api/v1/cti/nifi/flows/{id}/start", srv.handleNiFiFlowStart)
	mux.HandleFunc("POST /api/v1/cti/nifi/flows/{id}/stop", srv.handleNiFiFlowStop)
	mux.HandleFunc("GET /api/v1/cti/nifi/provenance", srv.handleNiFiProvenance)
	mux.HandleFunc("GET /api/v1/cti/nifi/flows", srv.handleListNiFiFlows)

	handler := maxBodyMiddleware(1<<20, srv.ctiAuthMiddleware(mux)) // 1 MB

	httpServer := &http.Server{
		Addr:         fmt.Sprintf(":%s", port),
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down cti-relay")

		close(stopCh)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		httpServer.Shutdown(shutdownCtx)

		// Drain NATS connections
		lowNATS.Drain()
		highNATS.Drain()

		// Close PG pools
		lowDB.Close()
		highDB.Close()

		// Close ClickHouse if connected
		if srv.clickhouse != nil {
			srv.clickhouse.Close()
		}

		wg.Wait()
	}()

	logger.Info("cti-relay starting", "port", port)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

func connectPG(ctx context.Context, logger *slog.Logger, side, host, port, dbname, user, password string) (*pgxpool.Pool, error) {
	pgURL := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, password, host, port, dbname)
	pgConfig, err := pgxpool.ParseConfig(pgURL)
	if err != nil {
		return nil, fmt.Errorf("parse %s pg config: %w", side, err)
	}
	pgConfig.MaxConns = int32(envOrInt("PG_MAX_CONNS", 10))
	pgConfig.MinConns = int32(envOrInt("PG_MIN_CONNS", 2))
	pgConfig.MaxConnLifetime = time.Duration(envOrInt("PG_CONN_MAX_LIFETIME_MINS", 30)) * time.Minute
	pgConfig.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, pgConfig)
	if err != nil {
		return nil, fmt.Errorf("connect %s postgres: %w", side, err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping %s postgres: %w", side, err)
	}
	logger.Info("connected to postgres", "side", side, "host", host)
	return pool, nil
}

func connectNATS(logger *slog.Logger, side, url string) (*nats.Conn, error) {
	nc, err := nats.Connect(url,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("connect %s nats: %w", side, err)
	}
	logger.Info("connected to nats", "side", side, "url", url)
	return nc, nil
}

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

func (s *Server) handleHealthLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "cti-relay"})
}

func (s *Server) handleHealthReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	status := http.StatusOK
	overall := "ok"

	ctx := r.Context()

	// Low PG
	if err := s.lowDB.Ping(ctx); err != nil {
		checks["low_postgres"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["low_postgres"] = "ok"
	}

	// High PG
	if err := s.highDB.Ping(ctx); err != nil {
		checks["high_postgres"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["high_postgres"] = "ok"
	}

	// Low NATS
	if !s.lowNATS.IsConnected() {
		checks["low_nats"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["low_nats"] = "ok"
	}

	// High NATS
	if !s.highNATS.IsConnected() {
		checks["high_nats"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["high_nats"] = "ok"
	}

	// Optional NiFi check (non-critical — does not affect overall status)
	if s.nifi != nil {
		if s.nifi.IsHealthy() {
			checks["nifi"] = "ok"
		} else {
			checks["nifi"] = "error"
		}
	}

	// Optional ClickHouse check (non-critical)
	if s.clickhouse != nil {
		if err := s.clickhouse.Ping(); err != nil {
			checks["clickhouse"] = "error"
		} else {
			checks["clickhouse"] = "ok"
		}
	}

	writeJSON(w, status, map[string]any{
		"status":  overall,
		"service": "cti-relay",
		"checks":  checks,
	})
}

// ---------------------------------------------------------------------------
// Status endpoint
// ---------------------------------------------------------------------------

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	lowPGOK := s.lowDB.Ping(ctx) == nil
	highPGOK := s.highDB.Ping(ctx) == nil
	lowConnected := lowPGOK && s.lowNATS.IsConnected()
	highConnected := highPGOK && s.highNATS.IsConnected()

	s.statsMu.Lock()
	resp := StatusResponse{
		LowConnected:         lowConnected,
		HighConnected:        highConnected,
		LastAuthSync:         formatTimeISO(s.lastAuthSync),
		LastTelemetryTransfer: formatTimeISO(s.lastTelemetryTransfer),
		PendingTransfers:     s.pendingTransfers,
		TransferStats:        copyMap(s.transferStats),
	}
	s.statsMu.Unlock()

	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Transfer endpoint
// ---------------------------------------------------------------------------

func (s *Server) handleTransfer(w http.ResponseWriter, r *http.Request) {
	var req TransferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body")
		return
	}

	// Normalize classification at input boundary
	req.Classification = normalizeClassification(req.Classification)

	// Validate direction
	if req.Direction != "low_to_high" && req.Direction != "high_to_low" {
		writeError(w, http.StatusBadRequest, "INVALID_DIRECTION", "Direction must be 'low_to_high' or 'high_to_low'")
		return
	}

	// Validate entity type
	validTypes := map[string]bool{"ticket": true, "finding": true, "operation": true, "audit_event": true}
	if !validTypes[req.EntityType] {
		writeError(w, http.StatusBadRequest, "INVALID_ENTITY_TYPE", "Entity type must be one of: ticket, finding, operation, audit_event")
		return
	}

	// Validate classification
	if !isValidClassification(req.Classification) {
		writeError(w, http.StatusBadRequest, "INVALID_CLASSIFICATION", "Classification must be UNCLASS, CUI, or SECRET")
		return
	}

	// Validate entity IDs
	if len(req.EntityIDs) == 0 {
		writeError(w, http.StatusBadRequest, "MISSING_ENTITY_IDS", "At least one entity ID is required")
		return
	}

	// Apply policy
	action, reason := s.evaluatePolicy(req)

	transferID := generateUUID()
	status := action // "auto" -> "accepted", "queue" -> "queued", "block" -> "rejected"
	var approvalID string
	switch action {
	case "auto":
		status = "accepted"
	case "queue":
		status = "queued"
		s.statsMu.Lock()
		s.pendingTransfers++
		s.statsMu.Unlock()
	case "block":
		status = "rejected"
	}

	// Record the transfer
	record := TransferRecord{
		ID:             transferID,
		Direction:      req.Direction,
		EntityType:     req.EntityType,
		EntityIDs:      req.EntityIDs,
		Classification: req.Classification,
		Status:         status,
		Reason:         reason,
		CreatedAt:      time.Now().UTC(),
	}
	if err := s.recordTransfer(r.Context(), record); err != nil {
		s.logger.Error("failed to record transfer", "error", err, "transfer_id", transferID)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to record transfer")
		return
	}

	// If queued, create an approval record
	if status == "queued" {
		approvalID = generateUUID()
		defaultExpiry := parseDuration(envOr("APPROVAL_EXPIRY", "24h"), 24*time.Hour)
		approval := TransferApproval{
			ID:             approvalID,
			TransferID:     transferID,
			Direction:      req.Direction,
			EntityType:     req.EntityType,
			EntityIDs:      req.EntityIDs,
			Classification: req.Classification,
			Status:         "pending",
			RequestedBy:    r.Header.Get("X-User-ID"),
			Reason:         reason,
			ExpiresAt:      time.Now().UTC().Add(defaultExpiry),
			CreatedAt:      time.Now().UTC(),
		}
		if err := s.createApproval(r.Context(), approval); err != nil {
			s.logger.Error("failed to create approval", "error", err, "transfer_id", transferID)
			// Non-fatal: transfer is recorded, approval tracking failed
		} else {
			// Publish pending event
			s.publishTransferEvent("cti.transfer.pending", map[string]any{
				"approval_id":    approvalID,
				"transfer_id":    transferID,
				"direction":      req.Direction,
				"entity_type":    req.EntityType,
				"classification": req.Classification,
				"entity_count":   len(req.EntityIDs),
				"expires_at":     approval.ExpiresAt.Format(time.RFC3339),
				"timestamp":      time.Now().UTC().Format(time.RFC3339Nano),
			})
		}
	}

	// Update stats
	s.statsMu.Lock()
	s.transferStats[req.Classification]++
	s.statsMu.Unlock()

	s.logger.Info("transfer request processed",
		"transfer_id", transferID,
		"direction", req.Direction,
		"entity_type", req.EntityType,
		"classification", req.Classification,
		"status", status,
		"entity_count", len(req.EntityIDs),
	)

	resp := map[string]string{
		"transfer_id": transferID,
		"status":      status,
		"reason":      reason,
	}
	if approvalID != "" {
		resp["approval_id"] = approvalID
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// List transfers endpoint
// ---------------------------------------------------------------------------

func (s *Server) handleListTransfers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	page := maxInt(1, queryInt(r, "page", 1))
	limit := clamp(1, 100, queryInt(r, "limit", 20))
	offset := (page - 1) * limit

	// Count
	var total int
	err := s.highDB.QueryRow(ctx, `SELECT COUNT(*) FROM cti_transfers`).Scan(&total)
	if err != nil {
		s.logger.Error("failed to count transfers", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query transfers")
		return
	}

	// Data
	rows, err := s.highDB.Query(ctx,
		`SELECT id, direction, entity_type, entity_ids, classification, status, reason, created_at
		 FROM cti_transfers
		 ORDER BY created_at DESC
		 LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		s.logger.Error("failed to query transfers", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query transfers")
		return
	}
	defer rows.Close()

	var transfers []TransferRecord
	for rows.Next() {
		var t TransferRecord
		if err := rows.Scan(&t.ID, &t.Direction, &t.EntityType, &t.EntityIDs, &t.Classification, &t.Status, &t.Reason, &t.CreatedAt); err != nil {
			s.logger.Error("failed to scan transfer", "error", err)
			continue
		}
		transfers = append(transfers, t)
	}
	if transfers == nil {
		transfers = []TransferRecord{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       transfers,
		"pagination": map[string]any{"page": page, "limit": limit, "total": total},
	})
}

// ---------------------------------------------------------------------------
// Auth sync endpoint (manual trigger)
// ---------------------------------------------------------------------------

func (s *Server) handleAuthSync(w http.ResponseWriter, r *http.Request) {
	result, err := s.syncAuth(r.Context())
	if err != nil {
		s.logger.Error("manual auth sync failed", "error", err)
		writeError(w, http.StatusInternalServerError, "SYNC_FAILED", "Auth sync failed")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ---------------------------------------------------------------------------
// List policies endpoint
// ---------------------------------------------------------------------------

func (s *Server) handleListPolicies(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	policies := make([]TransferPolicy, len(s.policies))
	copy(policies, s.policies)
	s.mu.RUnlock()

	writeJSON(w, http.StatusOK, map[string]any{"data": policies})
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

func (s *Server) evaluatePolicy(req TransferRequest) (action string, reason string) {
	// SECRET never transfers — hard rule, checked first regardless of policies
	// Case-insensitive comparison to prevent bypass via mixed-case classification
	if strings.EqualFold(req.Classification, "SECRET") {
		return "block", "SECRET classification never transfers between enclaves"
	}

	sourceEnclave := "low"
	targetEnclave := "high"
	if req.Direction == "high_to_low" {
		sourceEnclave = "high"
		targetEnclave = "low"
	}

	// CUI high→low always queues for review (case-insensitive)
	if strings.EqualFold(req.Classification, "CUI") && sourceEnclave == "high" && targetEnclave == "low" {
		return "queue", "CUI transfers from high to low require review"
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	// Find matching policy (case-insensitive classification comparison)
	for _, p := range s.policies {
		if p.SourceEnclave == sourceEnclave && p.TargetEnclave == targetEnclave &&
			p.EntityType == req.EntityType && strings.EqualFold(p.Classification, req.Classification) {
			return p.Action, fmt.Sprintf("Policy %s: %s %s %s→%s", p.ID, p.Action, p.Classification, p.SourceEnclave, p.TargetEnclave)
		}
	}

	// Default: queue for manual review if no explicit policy matches
	return "queue", "No matching policy found; queued for manual review"
}

// EvaluatePolicyForTest exposes evaluatePolicy for testing.
func (s *Server) EvaluatePolicyForTest(req TransferRequest) (string, string) {
	return s.evaluatePolicy(req)
}

// ---------------------------------------------------------------------------
// Auth sync logic
// ---------------------------------------------------------------------------

type AuthSyncResult struct {
	UsersSynced  int    `json:"users_synced"`
	RolesSynced  int    `json:"roles_synced"`
	BindingsSynced int  `json:"bindings_synced"`
	Errors       []string `json:"errors,omitempty"`
	SyncedAt     string `json:"synced_at"`
}

func (s *Server) syncAuth(ctx context.Context) (*AuthSyncResult, error) {
	result := &AuthSyncResult{
		SyncedAt: time.Now().UTC().Format(time.RFC3339),
	}
	var errors []string

	// Sync roles from high→low
	roleCount, err := s.syncRoles(ctx)
	if err != nil {
		errors = append(errors, fmt.Sprintf("roles sync error: %v", err))
		s.logger.Error("role sync error", "error", err)
	}
	result.RolesSynced = roleCount

	// Sync users from high→low
	userCount, err := s.syncUsers(ctx)
	if err != nil {
		errors = append(errors, fmt.Sprintf("users sync error: %v", err))
		s.logger.Error("user sync error", "error", err)
	}
	result.UsersSynced = userCount

	// Sync role_bindings from high→low
	bindingCount, err := s.syncRoleBindings(ctx)
	if err != nil {
		errors = append(errors, fmt.Sprintf("role_bindings sync error: %v", err))
		s.logger.Error("role_bindings sync error", "error", err)
	}
	result.BindingsSynced = bindingCount

	result.Errors = errors

	// Update last sync time
	s.statsMu.Lock()
	s.lastAuthSync = time.Now().UTC()
	s.statsMu.Unlock()

	// Publish event on low-side NATS
	eventData, _ := json.Marshal(map[string]any{
		"event_type":    "auth.sync_completed",
		"users_synced":  userCount,
		"roles_synced":  roleCount,
		"bindings_synced": bindingCount,
		"errors":        errors,
		"timestamp":     time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := s.lowNATS.Publish("auth.sync_completed", eventData); err != nil {
		s.logger.Error("failed to publish auth.sync_completed", "error", err)
	}

	s.logger.Info("auth sync completed",
		"users_synced", userCount,
		"roles_synced", roleCount,
		"bindings_synced", bindingCount,
		"errors", len(errors),
	)

	return result, nil
}

func (s *Server) syncRoles(ctx context.Context) (int, error) {
	rows, err := s.highDB.Query(ctx,
		`SELECT id, name, description, permissions, scope, is_system, created_at, updated_at
		 FROM roles`)
	if err != nil {
		return 0, fmt.Errorf("query high-side roles: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id, name, description, scope string
		var permissions []byte
		var isSystem bool
		var createdAt, updatedAt time.Time

		if err := rows.Scan(&id, &name, &description, &permissions, &scope, &isSystem, &createdAt, &updatedAt); err != nil {
			return count, fmt.Errorf("scan role: %w", err)
		}

		_, err := s.lowDB.Exec(ctx,
			`INSERT INTO roles (id, name, description, permissions, scope, is_system, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				description = EXCLUDED.description,
				permissions = EXCLUDED.permissions,
				scope = EXCLUDED.scope,
				is_system = EXCLUDED.is_system,
				updated_at = EXCLUDED.updated_at`,
			id, name, description, permissions, scope, isSystem, createdAt, updatedAt)
		if err != nil {
			s.logger.Error("failed to upsert role", "id", id, "name", name, "error", err)
			continue
		}
		count++
	}
	return count, rows.Err()
}

func (s *Server) syncUsers(ctx context.Context) (int, error) {
	rows, err := s.highDB.Query(ctx,
		`SELECT id, username, display_name, email, password_hash, auth_provider, status,
				mfa_enabled, avatar_url, preferences, created_at, updated_at
		 FROM users`)
	if err != nil {
		return 0, fmt.Errorf("query high-side users: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id, username, displayName, email, authProvider, status string
		var passwordHash, avatarURL *string
		var mfaEnabled bool
		var preferences []byte
		var createdAt, updatedAt time.Time

		if err := rows.Scan(&id, &username, &displayName, &email, &passwordHash, &authProvider, &status,
			&mfaEnabled, &avatarURL, &preferences, &createdAt, &updatedAt); err != nil {
			return count, fmt.Errorf("scan user: %w", err)
		}

		_, err := s.lowDB.Exec(ctx,
			`INSERT INTO users (id, username, display_name, email, password_hash, auth_provider, status,
								mfa_enabled, avatar_url, preferences, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
			 ON CONFLICT (id) DO UPDATE SET
				username = EXCLUDED.username,
				display_name = EXCLUDED.display_name,
				email = EXCLUDED.email,
				password_hash = EXCLUDED.password_hash,
				auth_provider = EXCLUDED.auth_provider,
				status = EXCLUDED.status,
				mfa_enabled = EXCLUDED.mfa_enabled,
				avatar_url = EXCLUDED.avatar_url,
				preferences = EXCLUDED.preferences,
				updated_at = EXCLUDED.updated_at`,
			id, username, displayName, email, passwordHash, authProvider, status,
			mfaEnabled, avatarURL, preferences, createdAt, updatedAt)
		if err != nil {
			s.logger.Error("failed to upsert user", "id", id, "username", username, "error", err)
			continue
		}
		count++
	}
	return count, rows.Err()
}

func (s *Server) syncRoleBindings(ctx context.Context) (int, error) {
	rows, err := s.highDB.Query(ctx,
		`SELECT id, user_id, role_id, scope_type, scope_id, granted_by, granted_at, expires_at
		 FROM role_bindings`)
	if err != nil {
		return 0, fmt.Errorf("query high-side role_bindings: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id, userID, roleID, scopeType string
		var scopeID, grantedBy *string
		var grantedAt time.Time
		var expiresAt *time.Time

		if err := rows.Scan(&id, &userID, &roleID, &scopeType, &scopeID, &grantedBy, &grantedAt, &expiresAt); err != nil {
			return count, fmt.Errorf("scan role_binding: %w", err)
		}

		_, err := s.lowDB.Exec(ctx,
			`INSERT INTO role_bindings (id, user_id, role_id, scope_type, scope_id, granted_by, granted_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT (id) DO UPDATE SET
				user_id = EXCLUDED.user_id,
				role_id = EXCLUDED.role_id,
				scope_type = EXCLUDED.scope_type,
				scope_id = EXCLUDED.scope_id,
				granted_by = EXCLUDED.granted_by,
				granted_at = EXCLUDED.granted_at,
				expires_at = EXCLUDED.expires_at`,
			id, userID, roleID, scopeType, scopeID, grantedBy, grantedAt, expiresAt)
		if err != nil {
			s.logger.Error("failed to upsert role_binding", "id", id, "error", err)
			continue
		}
		count++
	}
	return count, rows.Err()
}

// ---------------------------------------------------------------------------
// Telemetry relay
// ---------------------------------------------------------------------------

func (s *Server) runTelemetryRelay(stopCh <-chan struct{}) {
	subjects := []string{"audit.>", "endpoint.>", "c2.>"}
	var subs []*nats.Subscription

	for _, subj := range subjects {
		sub, err := s.lowNATS.Subscribe(subj, func(msg *nats.Msg) {
			s.relayMessage(msg)
		})
		if err != nil {
			s.logger.Error("failed to subscribe for relay", "subject", subj, "error", err)
			continue
		}
		subs = append(subs, sub)
		s.logger.Info("telemetry relay subscribed", "subject", subj)
	}

	<-stopCh

	for _, sub := range subs {
		sub.Unsubscribe()
	}
	s.logger.Info("telemetry relay stopped")
}

func (s *Server) relayMessage(msg *nats.Msg) {
	// Parse to check classification
	var event map[string]any
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal relay message", "subject", msg.Subject, "error", err)
		return
	}

	// Defense in depth: never relay SECRET (case-insensitive)
	classification, _ := event["classification"].(string)
	if strings.EqualFold(classification, "SECRET") {
		s.logger.Warn("blocked SECRET event from relay", "subject", msg.Subject)
		return
	}

	// Republish to high-side NATS with cti.relayed. prefix
	highSubject := "cti.relayed." + msg.Subject
	if err := s.highNATS.Publish(highSubject, msg.Data); err != nil {
		s.logger.Error("failed to relay to high-side", "subject", highSubject, "error", err)
		return
	}

	// Update stats
	s.statsMu.Lock()
	s.lastTelemetryTransfer = time.Now().UTC()
	if classification == "" {
		classification = "UNCLASS"
	}
	s.transferStats[classification]++
	s.statsMu.Unlock()
}

// ---------------------------------------------------------------------------
// Cross-domain command relay (M12)
// ---------------------------------------------------------------------------

// CommandRelayRecord tracks a command relay in memory.
type CommandRelayRecord struct {
	CommandID   string    `json:"command_id"`
	OperationID string    `json:"operation_id"`
	SessionID   string    `json:"session_id"`
	Command     string    `json:"command"`
	RiskLevel   int       `json:"risk_level"`
	Direction   string    `json:"direction"` // "high_to_low" or "low_to_high"
	Status      string    `json:"status"`    // "relayed", "blocked", "completed"
	RelayedAt   time.Time `json:"relayed_at"`
}

func (s *Server) runCommandRelay(stopCh <-chan struct{}) {
	// Subscribe to cti.command.execute on high-side NATS (high→low commands)
	highCmdSub, err := s.highNATS.Subscribe("cti.command.execute", func(msg *nats.Msg) {
		s.relayCommandHighToLow(msg)
	})
	if err != nil {
		s.logger.Error("failed to subscribe to cti.command.execute on high-side", "error", err)
	} else {
		s.logger.Info("command relay: subscribed to cti.command.execute on high-side NATS")
	}

	// Subscribe to cti.command.result on low-side NATS (low→high results)
	lowResultSub, err := s.lowNATS.Subscribe("cti.command.result", func(msg *nats.Msg) {
		s.relayCommandResultLowToHigh(msg)
	})
	if err != nil {
		s.logger.Error("failed to subscribe to cti.command.result on low-side", "error", err)
	} else {
		s.logger.Info("command relay: subscribed to cti.command.result on low-side NATS")
	}

	// Subscribe to cti.operation.created on high-side NATS (cross-domain operation mirroring)
	highOpSub, err := s.highNATS.Subscribe("cti.operation.created", func(msg *nats.Msg) {
		s.relayOperationHighToLow(msg)
	})
	if err != nil {
		s.logger.Error("failed to subscribe to cti.operation.created on high-side", "error", err)
	} else {
		s.logger.Info("command relay: subscribed to cti.operation.created on high-side NATS")
	}

	// Subscribe to cti.operation.route_request on high-side NATS
	highRouteSub, err := s.highNATS.Subscribe("cti.operation.route_request", func(msg *nats.Msg) {
		s.relayOperationHighToLow(msg) // same relay logic for route requests
	})
	if err != nil {
		s.logger.Error("failed to subscribe to cti.operation.route_request on high-side", "error", err)
	} else {
		s.logger.Info("command relay: subscribed to cti.operation.route_request on high-side NATS")
	}

	<-stopCh

	if highCmdSub != nil {
		highCmdSub.Unsubscribe()
	}
	if lowResultSub != nil {
		lowResultSub.Unsubscribe()
	}
	if highOpSub != nil {
		highOpSub.Unsubscribe()
	}
	if highRouteSub != nil {
		highRouteSub.Unsubscribe()
	}
	s.logger.Info("command relay stopped")
}

// relayCommandHighToLow relays a command from the high-side to the low-side.
func (s *Server) relayCommandHighToLow(msg *nats.Msg) {
	var event map[string]any
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal command relay message", "error", err)
		return
	}

	// Classification check: never relay SECRET commands
	classification, _ := event["classification"].(string)
	if strings.EqualFold(classification, "SECRET") {
		s.logger.Warn("blocked SECRET command from relay", "command_id", event["command_id"])
		return
	}

	// Risk-level based relay policy
	riskLevel := 0
	if rl, ok := event["risk_level"].(float64); ok {
		riskLevel = int(rl)
	}

	// Risk 1-2: auto-relay
	// Risk 3+: should already be approved by the c2-gateway before reaching here
	s.logger.Info("relaying command high→low",
		"command_id", event["command_id"],
		"command", event["command"],
		"risk_level", riskLevel,
		"classification", classification,
	)

	// Republish to low-side NATS with cti.relayed. prefix
	lowSubject := "cti.relayed." + msg.Subject
	if err := s.lowNATS.Publish(lowSubject, msg.Data); err != nil {
		s.logger.Error("failed to relay command to low-side",
			"subject", lowSubject, "error", err,
			"command_id", event["command_id"])
		return
	}

	// Record the relay
	s.statsMu.Lock()
	if classification == "" {
		classification = "UNCLASS"
	}
	s.transferStats[classification]++
	s.statsMu.Unlock()

	s.logger.Info("command relayed high→low successfully",
		"command_id", event["command_id"])
}

// relayCommandResultLowToHigh relays a command result from low-side to high-side.
func (s *Server) relayCommandResultLowToHigh(msg *nats.Msg) {
	var event map[string]any
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal command result", "error", err)
		return
	}

	// Block suspicious SECRET-classified results from low side
	classification, _ := event["classification"].(string)
	if strings.EqualFold(classification, "SECRET") {
		s.logger.Warn("blocked suspicious SECRET-classified result from low side",
			"subject", msg.Subject,
			"command_id", event["command_id"])
		return
	}

	s.logger.Info("relaying command result low→high",
		"command_id", event["command_id"],
		"status", event["status"],
	)

	// Republish to high-side NATS with cti.relayed. prefix
	highSubject := "cti.relayed." + msg.Subject
	if err := s.highNATS.Publish(highSubject, msg.Data); err != nil {
		s.logger.Error("failed to relay command result to high-side",
			"subject", highSubject, "error", err,
			"command_id", event["command_id"])
		return
	}

	s.logger.Info("command result relayed low→high successfully",
		"command_id", event["command_id"])
}

// relayOperationHighToLow relays cross-domain operation events from high to low.
func (s *Server) relayOperationHighToLow(msg *nats.Msg) {
	var event map[string]any
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal operation relay message", "error", err)
		return
	}

	// Classification check
	classification, _ := event["classification"].(string)
	if strings.EqualFold(classification, "SECRET") {
		s.logger.Warn("blocked SECRET operation from relay",
			"operation_id", event["operation_id"])
		return
	}

	s.logger.Info("relaying operation event high→low",
		"subject", msg.Subject,
		"operation_id", event["operation_id"],
	)

	// Republish to low-side NATS with cti.relayed. prefix
	lowSubject := "cti.relayed." + msg.Subject
	if err := s.lowNATS.Publish(lowSubject, msg.Data); err != nil {
		s.logger.Error("failed to relay operation to low-side",
			"subject", lowSubject, "error", err)
	}
}

// handleListRelayedCommands returns cross-domain commands tracked by the relay.
func (s *Server) handleListRelayedCommands(w http.ResponseWriter, r *http.Request) {
	// Query cross_domain_commands from the high-side DB
	ctx := r.Context()
	page := maxInt(1, queryInt(r, "page", 1))
	limit := clamp(1, 100, queryInt(r, "limit", 20))
	offset := (page - 1) * limit
	statusFilter := r.URL.Query().Get("status")

	conditions := []string{}
	args := []any{}
	argIdx := 1

	if statusFilter != "" {
		conditions = append(conditions, fmt.Sprintf("status = $%d", argIdx))
		args = append(args, statusFilter)
		argIdx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	var total int
	_ = s.highDB.QueryRow(ctx,
		fmt.Sprintf("SELECT count(*) FROM cross_domain_commands %s", where), args...).Scan(&total)

	args = append(args, limit, offset)
	q := fmt.Sprintf(
		`SELECT id, operation_id, command, target_session_id, risk_level, classification,
				status, requested_at, created_at
		 FROM cross_domain_commands %s
		 ORDER BY created_at DESC
		 LIMIT $%d OFFSET $%d`, where, argIdx, argIdx+1)

	rows, err := s.highDB.Query(ctx, q, args...)
	if err != nil {
		s.logger.Error("failed to list relayed commands", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query commands")
		return
	}
	defer rows.Close()

	type relayedCmd struct {
		ID              string `json:"id"`
		OperationID     string `json:"operation_id"`
		Command         string `json:"command"`
		TargetSessionID string `json:"target_session_id"`
		RiskLevel       int    `json:"risk_level"`
		Classification  string `json:"classification"`
		Status          string `json:"status"`
		RequestedAt     string `json:"requested_at"`
		CreatedAt       string `json:"created_at"`
	}

	var commands []relayedCmd
	for rows.Next() {
		var cmd relayedCmd
		var requestedAt, createdAt time.Time
		if err := rows.Scan(&cmd.ID, &cmd.OperationID, &cmd.Command, &cmd.TargetSessionID,
			&cmd.RiskLevel, &cmd.Classification, &cmd.Status, &requestedAt, &createdAt); err != nil {
			s.logger.Error("failed to scan relayed command", "error", err)
			continue
		}
		cmd.RequestedAt = requestedAt.Format(time.RFC3339)
		cmd.CreatedAt = createdAt.Format(time.RFC3339)
		commands = append(commands, cmd)
	}
	if commands == nil {
		commands = []relayedCmd{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       commands,
		"pagination": map[string]any{"page": page, "limit": limit, "total": total},
	})
}

// handleGetRelayedCommandStatus returns the status of a specific relayed command.
func (s *Server) handleGetRelayedCommandStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "MISSING_ID", "Command ID is required")
		return
	}

	var cmd struct {
		ID              string    `json:"id"`
		OperationID     string    `json:"operation_id"`
		Command         string    `json:"command"`
		TargetSessionID string    `json:"target_session_id"`
		RiskLevel       int       `json:"risk_level"`
		Classification  string    `json:"classification"`
		Status          string    `json:"status"`
		RequestedAt     time.Time `json:"requested_at"`
		CreatedAt       time.Time `json:"created_at"`
	}

	err := s.highDB.QueryRow(r.Context(),
		`SELECT id, operation_id, command, target_session_id, risk_level, classification,
				status, requested_at, created_at
		 FROM cross_domain_commands WHERE id = $1`, id).
		Scan(&cmd.ID, &cmd.OperationID, &cmd.Command, &cmd.TargetSessionID,
			&cmd.RiskLevel, &cmd.Classification, &cmd.Status, &cmd.RequestedAt, &cmd.CreatedAt)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Command not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":                cmd.ID,
		"operation_id":      cmd.OperationID,
		"command":           cmd.Command,
		"target_session_id": cmd.TargetSessionID,
		"risk_level":        cmd.RiskLevel,
		"classification":    cmd.Classification,
		"status":            cmd.Status,
		"requested_at":      cmd.RequestedAt.Format(time.RFC3339),
		"created_at":        cmd.CreatedAt.Format(time.RFC3339),
	})
}

// ---------------------------------------------------------------------------
// Background workers
// ---------------------------------------------------------------------------

func (s *Server) runAuthSync(ctx context.Context, interval time.Duration, stopCh <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if _, err := s.syncAuth(ctx); err != nil {
				s.logger.Error("periodic auth sync failed", "error", err)
			}
		case <-stopCh:
			s.logger.Info("auth sync worker stopped")
			return
		}
	}
}

func (s *Server) runPolicyRefresh(ctx context.Context, interval time.Duration, stopCh <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.loadPolicies(ctx)
		case <-stopCh:
			s.logger.Info("policy refresh worker stopped")
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

func (s *Server) loadPolicies(ctx context.Context) {
	rows, err := s.highDB.Query(ctx,
		`SELECT id, source_enclave, target_enclave, entity_type, classification, action, risk_level_min, risk_level_max
		 FROM classification_policies
		 WHERE active = true`)
	if err != nil {
		s.logger.Warn("failed to load policies from DB, using defaults", "error", err)
		return
	}
	defer rows.Close()

	var policies []TransferPolicy
	for rows.Next() {
		var p TransferPolicy
		if err := rows.Scan(&p.ID, &p.SourceEnclave, &p.TargetEnclave, &p.EntityType, &p.Classification, &p.Action, &p.RiskLevelMin, &p.RiskLevelMax); err != nil {
			s.logger.Error("failed to scan policy", "error", err)
			continue
		}
		policies = append(policies, p)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("error iterating policies", "error", err)
		return
	}

	if len(policies) > 0 {
		s.mu.Lock()
		s.policies = policies
		s.mu.Unlock()
		s.logger.Info("loaded transfer policies", "count", len(policies))
	}
}

// defaultPolicies returns the built-in policies used when DB is unavailable.
func defaultPolicies() []TransferPolicy {
	return []TransferPolicy{
		{ID: "default-1", SourceEnclave: "low", TargetEnclave: "high", EntityType: "telemetry", Classification: "UNCLASS", Action: "auto"},
		{ID: "default-2", SourceEnclave: "low", TargetEnclave: "high", EntityType: "telemetry", Classification: "CUI", Action: "auto"},
		{ID: "default-3", SourceEnclave: "low", TargetEnclave: "high", EntityType: "audit_event", Classification: "UNCLASS", Action: "auto"},
		{ID: "default-4", SourceEnclave: "low", TargetEnclave: "high", EntityType: "audit_event", Classification: "CUI", Action: "auto"},
		{ID: "default-5", SourceEnclave: "low", TargetEnclave: "high", EntityType: "ticket", Classification: "UNCLASS", Action: "auto"},
		{ID: "default-6", SourceEnclave: "low", TargetEnclave: "high", EntityType: "ticket", Classification: "CUI", Action: "auto"},
		{ID: "default-7", SourceEnclave: "low", TargetEnclave: "high", EntityType: "finding", Classification: "UNCLASS", Action: "auto"},
		{ID: "default-8", SourceEnclave: "low", TargetEnclave: "high", EntityType: "finding", Classification: "CUI", Action: "auto"},
		{ID: "default-9", SourceEnclave: "high", TargetEnclave: "low", EntityType: "ticket", Classification: "UNCLASS", Action: "auto"},
		{ID: "default-10", SourceEnclave: "high", TargetEnclave: "low", EntityType: "finding", Classification: "UNCLASS", Action: "auto"},
		// SECRET transfers are always blocked by hard rule in evaluatePolicy, no policy needed
		// CUI high→low is always queued by hard rule in evaluatePolicy
	}
}

// ---------------------------------------------------------------------------
// Transfer recording
// ---------------------------------------------------------------------------

// Fallback — migration 009_cti_transfers.sql is the primary mechanism.
// This function is kept as a safety net for environments where the migration
// has not yet been applied (e.g., dual-enclave postgres-high that doesn't
// share migrations with the initial postgres init).
func (s *Server) ensureTransferTable(ctx context.Context) {
	s.logger.Info("ensuring cti_transfers table exists (fallback for migration 009)")
	_, err := s.highDB.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS cti_transfers (
			id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			direction       VARCHAR(16) NOT NULL CHECK (direction IN ('low_to_high', 'high_to_low')),
			entity_type     VARCHAR(32) NOT NULL,
			entity_ids      TEXT[]      NOT NULL DEFAULT '{}',
			classification  VARCHAR(16) NOT NULL DEFAULT 'UNCLASS',
			status          VARCHAR(16) NOT NULL DEFAULT 'queued'
							CHECK (status IN ('accepted', 'queued', 'rejected', 'completed', 'failed')),
			reason          TEXT        NOT NULL DEFAULT '',
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	if err != nil {
		s.logger.Warn("failed to ensure cti_transfers table", "error", err)
	}
}

func (s *Server) recordTransfer(ctx context.Context, rec TransferRecord) error {
	if s.highDB == nil {
		return fmt.Errorf("high-side database not connected")
	}
	_, err := s.highDB.Exec(ctx,
		`INSERT INTO cti_transfers (id, direction, entity_type, entity_ids, classification, status, reason, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		rec.ID, rec.Direction, rec.EntityType, rec.EntityIDs, rec.Classification, rec.Status, rec.Reason, rec.CreatedAt)
	if err != nil {
		s.logger.Error("failed to record transfer", "error", err, "transfer_id", rec.ID)
		return fmt.Errorf("record transfer: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Approval table and handlers
// ---------------------------------------------------------------------------

func (s *Server) ensureApprovalTable(ctx context.Context) {
	s.logger.Info("ensuring transfer_approvals table exists")
	_, err := s.highDB.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS transfer_approvals (
			id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			transfer_id     UUID NOT NULL,
			direction       VARCHAR(16) NOT NULL,
			entity_type     VARCHAR(32) NOT NULL,
			entity_ids      TEXT[]      NOT NULL DEFAULT '{}',
			classification  VARCHAR(16) NOT NULL DEFAULT 'UNCLASS',
			status          VARCHAR(16) NOT NULL DEFAULT 'pending'
							CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
			requested_by    VARCHAR(255) NOT NULL DEFAULT '',
			reason          TEXT        NOT NULL DEFAULT '',
			reviewed_by     VARCHAR(255),
			reviewed_at     TIMESTAMPTZ,
			expires_at      TIMESTAMPTZ NOT NULL,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	if err != nil {
		s.logger.Warn("failed to ensure transfer_approvals table", "error", err)
	}
}

func (s *Server) ensureNiFiFlowConfigTable(ctx context.Context) {
	s.logger.Info("ensuring nifi_flow_configs table exists")
	_, err := s.highDB.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS nifi_flow_configs (
			id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name              VARCHAR(255) NOT NULL,
			process_group_id  VARCHAR(255) NOT NULL,
			flow_type         VARCHAR(32)  NOT NULL DEFAULT 'transfer'
							  CHECK (flow_type IN ('transfer', 'enrichment', 'sanitization')),
			enabled           BOOLEAN NOT NULL DEFAULT true,
			created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	if err != nil {
		s.logger.Warn("failed to ensure nifi_flow_configs table", "error", err)
	}
}

func (s *Server) ensureProvenanceTable() {
	if s.clickhouse == nil {
		return
	}
	s.logger.Info("ensuring cti_provenance table exists in clickhouse")
	_, err := s.clickhouse.Exec(`
		CREATE TABLE IF NOT EXISTS cti_provenance (
			event_id        String,
			event_type      String,
			timestamp       DateTime64(3, 'UTC'),
			component_id    String,
			component_name  String,
			component_type  String,
			flow_file_uuid  String,
			file_size       Int64,
			attributes      Map(String, String),
			exported_at     DateTime64(3, 'UTC') DEFAULT now64(3)
		) ENGINE = MergeTree()
		ORDER BY (timestamp, event_id)
		TTL toDateTime(timestamp) + INTERVAL 5 YEAR`)
	if err != nil {
		s.logger.Warn("failed to ensure cti_provenance table in clickhouse", "error", err)
	}
}

func (s *Server) createApproval(ctx context.Context, a TransferApproval) error {
	if s.highDB == nil {
		return fmt.Errorf("high-side database not connected")
	}
	_, err := s.highDB.Exec(ctx,
		`INSERT INTO transfer_approvals
			(id, transfer_id, direction, entity_type, entity_ids, classification, status, requested_by, reason, expires_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		a.ID, a.TransferID, a.Direction, a.EntityType, a.EntityIDs, a.Classification,
		a.Status, a.RequestedBy, a.Reason, a.ExpiresAt, a.CreatedAt)
	return err
}

func (s *Server) publishTransferEvent(subject string, data map[string]any) {
	if s.highNATS == nil {
		return
	}
	payload, err := json.Marshal(data)
	if err != nil {
		s.logger.Error("failed to marshal transfer event", "subject", subject, "error", err)
		return
	}
	if err := s.highNATS.Publish(subject, payload); err != nil {
		s.logger.Error("failed to publish transfer event", "subject", subject, "error", err)
	}
}

// handleListApprovals returns paginated pending transfer approvals.
func (s *Server) handleListApprovals(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	page := maxInt(1, queryInt(r, "page", 1))
	limit := clamp(1, 100, queryInt(r, "limit", 20))
	offset := (page - 1) * limit
	statusFilter := r.URL.Query().Get("status")
	validStatuses := map[string]bool{"pending": true, "approved": true, "rejected": true, "expired": true, "": true}
	if !validStatuses[statusFilter] {
		writeError(w, 400, "INVALID_STATUS", "status must be one of: pending, approved, rejected, expired")
		return
	}
	if statusFilter == "" {
		statusFilter = "pending"
	}

	var total int
	err := s.highDB.QueryRow(ctx,
		`SELECT COUNT(*) FROM transfer_approvals WHERE status = $1`, statusFilter).Scan(&total)
	if err != nil {
		s.logger.Error("failed to count approvals", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query approvals")
		return
	}

	rows, err := s.highDB.Query(ctx,
		`SELECT id, transfer_id, direction, entity_type, entity_ids, classification,
				status, COALESCE(requested_by, ''), reason, reviewed_by, reviewed_at, expires_at, created_at
		 FROM transfer_approvals
		 WHERE status = $1
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`, statusFilter, limit, offset)
	if err != nil {
		s.logger.Error("failed to query approvals", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query approvals")
		return
	}
	defer rows.Close()

	var approvals []TransferApproval
	for rows.Next() {
		var a TransferApproval
		var reviewedBy *string
		var reviewedAt *time.Time
		if err := rows.Scan(&a.ID, &a.TransferID, &a.Direction, &a.EntityType, &a.EntityIDs,
			&a.Classification, &a.Status, &a.RequestedBy, &a.Reason, &reviewedBy, &reviewedAt, &a.ExpiresAt, &a.CreatedAt); err != nil {
			s.logger.Error("failed to scan approval", "error", err)
			continue
		}
		if reviewedBy != nil {
			a.ReviewedBy = *reviewedBy
		}
		a.ReviewedAt = reviewedAt
		approvals = append(approvals, a)
	}
	if approvals == nil {
		approvals = []TransferApproval{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       approvals,
		"pagination": map[string]any{"page": page, "limit": limit, "total": total},
	})
}

// handleGetApproval returns a single transfer approval by ID.
func (s *Server) handleGetApproval(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "MISSING_ID", "Approval ID is required")
		return
	}

	var a TransferApproval
	var reviewedBy *string
	var reviewedAt *time.Time
	err := s.highDB.QueryRow(r.Context(),
		`SELECT id, transfer_id, direction, entity_type, entity_ids, classification,
				status, COALESCE(requested_by, ''), reason, reviewed_by, reviewed_at, expires_at, created_at
		 FROM transfer_approvals WHERE id = $1`, id).Scan(
		&a.ID, &a.TransferID, &a.Direction, &a.EntityType, &a.EntityIDs,
		&a.Classification, &a.Status, &a.RequestedBy, &a.Reason, &reviewedBy, &reviewedAt, &a.ExpiresAt, &a.CreatedAt)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Approval not found")
		return
	}
	if reviewedBy != nil {
		a.ReviewedBy = *reviewedBy
	}
	a.ReviewedAt = reviewedAt

	writeJSON(w, http.StatusOK, a)
}

// handleApproveTransfer approves a pending transfer and optionally submits to NiFi.
func (s *Server) handleApproveTransfer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "MISSING_ID", "Approval ID is required")
		return
	}

	// Extract authenticated user from ForwardAuth header
	reviewerUserID := r.Header.Get("X-User-ID")
	if reviewerUserID == "" {
		reviewerUserID = "system"
	}

	ctx := r.Context()
	now := time.Now().UTC()

	// Check current status and requestor
	var currentStatus string
	var expiresAt time.Time
	var requestedBy string
	err := s.highDB.QueryRow(ctx,
		`SELECT status, expires_at, COALESCE(requested_by, '') FROM transfer_approvals WHERE id = $1`, id).Scan(&currentStatus, &expiresAt, &requestedBy)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Approval not found")
		return
	}

	// Prevent self-approval
	if reviewerUserID != "system" && requestedBy != "" && reviewerUserID == requestedBy {
		writeError(w, http.StatusForbidden, "SELF_APPROVAL", "cannot approve own transfer request")
		return
	}

	if currentStatus != "pending" {
		writeError(w, http.StatusConflict, "INVALID_STATE", fmt.Sprintf("Approval is already %s", currentStatus))
		return
	}
	if now.After(expiresAt) {
		// Auto-expire it
		s.highDB.Exec(ctx,
			`UPDATE transfer_approvals SET status = 'expired' WHERE id = $1`, id)
		writeError(w, http.StatusConflict, "EXPIRED", "Approval has expired")
		return
	}

	// Update approval — use authenticated user as reviewed_by
	_, err = s.highDB.Exec(ctx,
		`UPDATE transfer_approvals SET status = 'approved', reviewed_by = $2, reviewed_at = $3 WHERE id = $1`,
		id, reviewerUserID, now)
	if err != nil {
		s.logger.Error("failed to approve transfer", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to approve transfer")
		return
	}

	// Update corresponding transfer record
	var transferID string
	s.highDB.QueryRow(ctx,
		`SELECT transfer_id FROM transfer_approvals WHERE id = $1`, id).Scan(&transferID)
	if transferID != "" {
		s.highDB.Exec(ctx,
			`UPDATE cti_transfers SET status = 'accepted' WHERE id = $1`, transferID)
	}

	// Decrement pending count
	s.statsMu.Lock()
	if s.pendingTransfers > 0 {
		s.pendingTransfers--
	}
	s.statsMu.Unlock()

	// If NiFi is available, submit the transfer for execution
	if s.nifi != nil {
		s.submitToNiFi(ctx, id)
	}

	// Publish event
	s.publishTransferEvent("cti.transfer.approved", map[string]any{
		"approval_id": id,
		"transfer_id": transferID,
		"reviewed_by": reviewerUserID,
		"timestamp":   now.Format(time.RFC3339Nano),
	})

	s.logger.Info("transfer approved", "approval_id", id, "transfer_id", transferID, "reviewed_by", reviewerUserID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "approved", "approval_id": id})
}

// handleRejectTransfer rejects a pending transfer.
func (s *Server) handleRejectTransfer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "MISSING_ID", "Approval ID is required")
		return
	}

	// Extract authenticated user from ForwardAuth header
	reviewerUserID := r.Header.Get("X-User-ID")
	if reviewerUserID == "" {
		reviewerUserID = "system"
	}

	var body struct {
		Reason string `json:"reason"`
	}
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&body)
	}

	ctx := r.Context()
	now := time.Now().UTC()

	// Check current status and requestor
	var currentStatus string
	var requestedBy string
	err := s.highDB.QueryRow(ctx,
		`SELECT status, COALESCE(requested_by, '') FROM transfer_approvals WHERE id = $1`, id).Scan(&currentStatus, &requestedBy)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Approval not found")
		return
	}

	// Prevent self-rejection (same pattern as self-approval)
	if reviewerUserID != "system" && requestedBy != "" && reviewerUserID == requestedBy {
		writeError(w, http.StatusForbidden, "SELF_APPROVAL", "cannot approve own transfer request")
		return
	}

	if currentStatus != "pending" {
		writeError(w, http.StatusConflict, "INVALID_STATE", fmt.Sprintf("Approval is already %s", currentStatus))
		return
	}

	// Update approval — use authenticated user as reviewed_by
	rejectReason := body.Reason
	if rejectReason == "" {
		rejectReason = "Rejected by reviewer"
	}
	_, err = s.highDB.Exec(ctx,
		`UPDATE transfer_approvals SET status = 'rejected', reason = $2, reviewed_by = $3, reviewed_at = $4 WHERE id = $1`,
		id, rejectReason, reviewerUserID, now)
	if err != nil {
		s.logger.Error("failed to reject transfer", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to reject transfer")
		return
	}

	// Update corresponding transfer record
	var transferID string
	s.highDB.QueryRow(ctx,
		`SELECT transfer_id FROM transfer_approvals WHERE id = $1`, id).Scan(&transferID)
	if transferID != "" {
		s.highDB.Exec(ctx,
			`UPDATE cti_transfers SET status = 'rejected' WHERE id = $1`, transferID)
	}

	// Decrement pending count
	s.statsMu.Lock()
	if s.pendingTransfers > 0 {
		s.pendingTransfers--
	}
	s.statsMu.Unlock()

	// Publish event
	s.publishTransferEvent("cti.transfer.rejected", map[string]any{
		"approval_id": id,
		"transfer_id": transferID,
		"reviewed_by": reviewerUserID,
		"reason":      rejectReason,
		"timestamp":   now.Format(time.RFC3339Nano),
	})

	s.logger.Info("transfer rejected", "approval_id", id, "transfer_id", transferID, "reviewed_by", reviewerUserID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "rejected", "approval_id": id})
}

// submitToNiFi triggers NiFi to execute an approved transfer. Best-effort.
func (s *Server) submitToNiFi(ctx context.Context, approvalID string) {
	if s.nifi == nil {
		return
	}
	// Look up the first enabled flow for transfers and start it
	var pgID string
	err := s.highDB.QueryRow(ctx,
		`SELECT process_group_id FROM nifi_flow_configs
		 WHERE flow_type = 'transfer' AND enabled = true
		 LIMIT 1`).Scan(&pgID)
	if err != nil {
		s.logger.Warn("no NiFi transfer flow configured, skipping NiFi submission", "approval_id", approvalID)
		return
	}

	if err := s.nifi.StartProcessGroup(pgID); err != nil {
		s.logger.Error("failed to start NiFi flow for transfer", "approval_id", approvalID, "pg_id", pgID, "error", err)
		return
	}
	s.logger.Info("submitted transfer to NiFi", "approval_id", approvalID, "pg_id", pgID)
}

// ---------------------------------------------------------------------------
// NiFi handler endpoints
// ---------------------------------------------------------------------------

// handleNiFiStatus returns NiFi system diagnostics and root flow status.
func (s *Server) handleNiFiStatus(w http.ResponseWriter, r *http.Request) {
	if s.nifi == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
			"message": "NiFi integration not configured",
		})
		return
	}

	result := map[string]any{"enabled": true}

	// System diagnostics
	diag, err := s.nifi.GetSystemDiagnostics()
	if err != nil {
		s.logger.Error("NiFi diagnostics failed", "error", err)
		result["diagnostics_error"] = "NiFi diagnostics unavailable"
	} else {
		result["diagnostics"] = diag
	}

	// Root process group status
	rootPG, err := s.nifi.GetRootProcessGroup()
	if err != nil {
		s.logger.Error("NiFi root process group status failed", "error", err)
		result["root_pg_error"] = "NiFi flow status unavailable"
	} else {
		result["root_process_group"] = rootPG
	}

	writeJSON(w, http.StatusOK, result)
}

// handleNiFiFlowStart starts a NiFi process group flow.
func (s *Server) handleNiFiFlowStart(w http.ResponseWriter, r *http.Request) {
	if s.nifi == nil {
		writeError(w, http.StatusServiceUnavailable, "NIFI_DISABLED", "NiFi integration not configured")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "MISSING_ID", "Flow ID is required")
		return
	}
	if err := validateNiFiID(id); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ID", "Flow ID must be a valid UUID")
		return
	}

	if err := s.nifi.StartProcessGroup(id); err != nil {
		s.logger.Error("failed to start NiFi flow", "id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "NIFI_ERROR", "Failed to start NiFi flow")
		return
	}

	s.logger.Info("NiFi flow started", "id", id)
	writeJSON(w, http.StatusOK, map[string]string{"status": "started", "id": id})
}

// handleNiFiFlowStop stops a NiFi process group flow.
func (s *Server) handleNiFiFlowStop(w http.ResponseWriter, r *http.Request) {
	if s.nifi == nil {
		writeError(w, http.StatusServiceUnavailable, "NIFI_DISABLED", "NiFi integration not configured")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "MISSING_ID", "Flow ID is required")
		return
	}
	if err := validateNiFiID(id); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ID", "Flow ID must be a valid UUID")
		return
	}

	if err := s.nifi.StopProcessGroup(id); err != nil {
		s.logger.Error("failed to stop NiFi flow", "id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "NIFI_ERROR", "Failed to stop NiFi flow")
		return
	}

	s.logger.Info("NiFi flow stopped", "id", id)
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopped", "id": id})
}

// handleNiFiProvenance queries NiFi provenance with optional filters.
func (s *Server) handleNiFiProvenance(w http.ResponseWriter, r *http.Request) {
	if s.nifi == nil {
		writeError(w, http.StatusServiceUnavailable, "NIFI_DISABLED", "NiFi integration not configured")
		return
	}

	maxResults := clamp(1, 1000, queryInt(r, "maxResults", 100))
	startDate := r.URL.Query().Get("startDate")
	endDate := r.URL.Query().Get("endDate")

	query := ProvenanceQuery{
		MaxResults: maxResults,
		StartDate:  startDate,
		EndDate:    endDate,
	}

	// Submit query
	queryID, err := s.nifi.SubmitProvenanceQuery(query)
	if err != nil {
		s.logger.Error("failed to submit provenance query", "error", err)
		writeError(w, http.StatusInternalServerError, "NIFI_ERROR", "Failed to query provenance")
		return
	}

	// Poll for results (NiFi provenance queries are async)
	var results *ProvenanceResults
	for i := 0; i < 10; i++ {
		results, err = s.nifi.GetProvenanceResults(queryID)
		if err != nil {
			s.logger.Error("failed to get provenance results", "error", err, "query_id", queryID)
			writeError(w, http.StatusInternalServerError, "NIFI_ERROR", "Failed to retrieve provenance results")
			return
		}
		if results.Finished {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Clean up the query
	s.nifi.DeleteProvenanceQuery(queryID)

	if results == nil {
		results = &ProvenanceResults{Events: []ProvenanceEvent{}}
	}
	if results.Events == nil {
		results.Events = []ProvenanceEvent{}
	}

	writeJSON(w, http.StatusOK, results)
}

// handleListNiFiFlows returns NiFi flow configurations from the database.
func (s *Server) handleListNiFiFlows(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := s.highDB.Query(ctx,
		`SELECT id, name, process_group_id, flow_type, enabled, created_at
		 FROM nifi_flow_configs
		 ORDER BY created_at DESC`)
	if err != nil {
		s.logger.Error("failed to query nifi flow configs", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to query NiFi flows")
		return
	}
	defer rows.Close()

	var flows []NiFiFlowConfig
	for rows.Next() {
		var f NiFiFlowConfig
		var createdAt time.Time
		if err := rows.Scan(&f.ID, &f.Name, &f.ProcessGroupID, &f.FlowType, &f.Enabled, &createdAt); err != nil {
			s.logger.Error("failed to scan nifi flow config", "error", err)
			continue
		}
		f.CreatedAt = createdAt.Format(time.RFC3339)
		flows = append(flows, f)
	}
	if flows == nil {
		flows = []NiFiFlowConfig{}
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": flows})
}

// ---------------------------------------------------------------------------
// Approval auto-expiry worker
// ---------------------------------------------------------------------------

func (s *Server) runApprovalExpiry(ctx context.Context, interval time.Duration, stopCh <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.expirePendingApprovals(ctx)
		case <-stopCh:
			s.logger.Info("approval expiry worker stopped")
			return
		}
	}
}

func (s *Server) expirePendingApprovals(ctx context.Context) {
	if s.highDB == nil {
		return
	}
	now := time.Now().UTC()
	tag, err := s.highDB.Exec(ctx,
		`UPDATE transfer_approvals SET status = 'expired'
		 WHERE status = 'pending' AND expires_at < $1`, now)
	if err != nil {
		s.logger.Error("failed to expire pending approvals", "error", err)
		return
	}
	expired := tag.RowsAffected()
	if expired > 0 {
		s.logger.Info("expired pending approvals", "count", expired)
		// Also update corresponding transfers
		s.highDB.Exec(ctx,
			`UPDATE cti_transfers SET status = 'failed'
			 WHERE id IN (
				SELECT transfer_id FROM transfer_approvals
				WHERE status = 'expired' AND expires_at < $1
			 ) AND status = 'queued'`, now)

		// Decrement pending transfers count
		s.statsMu.Lock()
		s.pendingTransfers -= int(expired)
		if s.pendingTransfers < 0 {
			s.pendingTransfers = 0
		}
		s.statsMu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// Provenance export worker
// ---------------------------------------------------------------------------

func (s *Server) runProvenanceExport(ctx context.Context, interval time.Duration, stopCh <-chan struct{}) {
	if s.nifi == nil || s.clickhouse == nil {
		s.logger.Info("provenance export skipped (NiFi or ClickHouse not configured)")
		return
	}

	// Track the last exported timestamp
	lastExported := time.Now().UTC().Add(-1 * time.Hour) // start with last hour

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			newLast, err := s.exportProvenance(ctx, lastExported)
			if err != nil {
				s.logger.Error("provenance export failed", "error", err)
			} else {
				lastExported = newLast
			}
		case <-stopCh:
			s.logger.Info("provenance export worker stopped")
			return
		}
	}
}

func (s *Server) exportProvenance(ctx context.Context, since time.Time) (time.Time, error) {
	now := time.Now().UTC()

	query := ProvenanceQuery{
		MaxResults: 500,
		StartDate:  since.Format("01/02/2006 15:04:05 MST"),
		EndDate:    now.Format("01/02/2006 15:04:05 MST"),
	}

	queryID, err := s.nifi.SubmitProvenanceQuery(query)
	if err != nil {
		return since, fmt.Errorf("submit provenance query: %w", err)
	}
	defer s.nifi.DeleteProvenanceQuery(queryID)

	// Poll for results
	var results *ProvenanceResults
	for i := 0; i < 20; i++ {
		results, err = s.nifi.GetProvenanceResults(queryID)
		if err != nil {
			return since, fmt.Errorf("get provenance results: %w", err)
		}
		if results.Finished {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if results == nil || len(results.Events) == 0 {
		return now, nil
	}

	// Batch insert into ClickHouse
	tx, err := s.clickhouse.Begin()
	if err != nil {
		return since, fmt.Errorf("begin clickhouse tx: %w", err)
	}

	stmt, err := tx.Prepare(`INSERT INTO cti_provenance
		(event_id, event_type, timestamp, component_id, component_name, component_type,
		 flow_file_uuid, file_size, attributes)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return since, fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	inserted := 0
	for _, ev := range results.Events {
		ts, _ := time.Parse("01/02/2006 15:04:05.000 MST", ev.Timestamp)
		if ts.IsZero() {
			ts, _ = time.Parse(time.RFC3339, ev.Timestamp)
		}
		if ts.IsZero() {
			ts = now
		}

		attrs := ev.Attributes
		if attrs == nil {
			attrs = map[string]string{}
		}

		_, err := stmt.Exec(
			ev.ID, ev.EventType, ts, ev.ComponentID, ev.ComponentName, ev.ComponentType,
			ev.FlowFileUUID, ev.FileSize, attrs,
		)
		if err != nil {
			s.logger.Warn("failed to insert provenance event", "event_id", ev.ID, "error", err)
			continue
		}
		inserted++
	}

	if err := tx.Commit(); err != nil {
		return since, fmt.Errorf("commit provenance batch: %w", err)
	}

	if inserted > 0 {
		s.logger.Info("exported provenance events to clickhouse", "count", inserted)
	}

	return now, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ctiAuthMiddleware checks Authorization: Bearer <token> on /api/v1/cti/ routes.
// Health endpoints (/health/*) are excluded from authentication.
func (s *Server) ctiAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Health endpoints are unauthenticated (needed for Docker/K8s probes)
		if strings.HasPrefix(r.URL.Path, "/health") {
			next.ServeHTTP(w, r)
			return
		}

		// All /api/v1/cti/ routes require Bearer token
		if strings.HasPrefix(r.URL.Path, "/api/v1/cti/") {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
				writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or invalid CTI API token")
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			// Constant-time comparison to prevent timing attacks
			if subtle.ConstantTimeCompare([]byte(token), []byte(s.ctiAPIToken)) != 1 {
				writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or invalid CTI API token")
				return
			}
		}

		next.ServeHTTP(w, r)
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
	if val < min {
		return min
	}
	if val > max {
		return max
	}
	return val
}

// normalizeClassification uppercases and trims the classification string.
// This ensures case-insensitive handling at the input boundary.
func normalizeClassification(c string) string {
	return strings.ToUpper(strings.TrimSpace(c))
}

func isValidClassification(c string) bool {
	upper := normalizeClassification(c)
	return upper == "UNCLASS" || upper == "CUI" || upper == "SECRET"
}

func formatTimeISO(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func copyMap(m map[string]int) map[string]int {
	out := make(map[string]int, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func parseDuration(s string, fallback time.Duration) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		return fallback
	}
	return d
}

func generateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ---------------------------------------------------------------------------
// Finding sync — Types
// ---------------------------------------------------------------------------

type FindingSyncStatus struct {
	TotalSynced   int                 `json:"total_synced"`
	TotalPending  int                 `json:"total_pending"`
	TotalFailed   int                 `json:"total_failed"`
	LastSyncAt    string              `json:"last_sync_at"`
	ByClassification map[string]int   `json:"by_classification"`
}

type FindingSyncResult struct {
	Synced  int      `json:"synced"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors,omitempty"`
}

// ---------------------------------------------------------------------------
// Finding sync — Tables
// ---------------------------------------------------------------------------

func (s *Server) ensureFindingSyncTable(ctx context.Context) {
	s.logger.Info("ensuring cti_finding_sync_state table exists (fallback for migration 011)")
	_, err := s.highDB.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS cti_finding_sync_state (
			id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			direction       TEXT NOT NULL UNIQUE
							CHECK (direction IN ('low_to_high', 'high_to_low')),
			last_sync_at    TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
			findings_synced INTEGER NOT NULL DEFAULT 0,
			last_error      TEXT,
			updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	if err != nil {
		s.logger.Warn("failed to ensure cti_finding_sync_state table", "error", err)
		return
	}
	// Seed defaults
	s.highDB.Exec(ctx,
		`INSERT INTO cti_finding_sync_state (direction) VALUES ('low_to_high')
		 ON CONFLICT (direction) DO NOTHING`)
	s.highDB.Exec(ctx,
		`INSERT INTO cti_finding_sync_state (direction) VALUES ('high_to_low')
		 ON CONFLICT (direction) DO NOTHING`)
}

// ---------------------------------------------------------------------------
// Finding sync — NATS subscription
// ---------------------------------------------------------------------------

func (s *Server) runFindingRelay(stopCh <-chan struct{}) {
	// Subscribe to finding events on the low-side NATS
	subjects := []string{"finding.created", "finding.updated", "finding.enriched", "finding.redacted", "cti.finding.sync_request"}
	var subs []*nats.Subscription

	for _, subj := range subjects {
		sub, err := s.lowNATS.Subscribe(subj, func(msg *nats.Msg) {
			s.handleFindingEvent(msg)
		})
		if err != nil {
			s.logger.Error("failed to subscribe for finding relay", "subject", subj, "error", err)
			continue
		}
		subs = append(subs, sub)
		s.logger.Info("finding relay subscribed", "subject", subj)
	}

	<-stopCh

	for _, sub := range subs {
		sub.Unsubscribe()
	}
	s.logger.Info("finding relay stopped")
}

func (s *Server) handleFindingEvent(msg *nats.Msg) {
	var event map[string]any
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		s.logger.Error("failed to unmarshal finding event", "subject", msg.Subject, "error", err)
		return
	}

	// Defense in depth: never relay SECRET
	classification, _ := event["classification"].(string)
	if classification == "" {
		if data, ok := event["data"].(map[string]any); ok {
			classification, _ = data["classification"].(string)
		}
	}
	if strings.EqualFold(classification, "SECRET") {
		s.logger.Warn("blocked SECRET finding event from relay", "subject", msg.Subject)
		return
	}

	// Extract finding_id
	findingID, _ := event["finding_id"].(string)
	if findingID == "" {
		if data, ok := event["data"].(map[string]any); ok {
			findingID, _ = data["finding_id"].(string)
		}
	}

	if findingID == "" {
		s.logger.Warn("finding event missing finding_id", "subject", msg.Subject)
		return
	}

	// Sync the specific finding
	ctx := context.Background()
	if err := s.syncSingleFinding(ctx, findingID); err != nil {
		s.logger.Error("failed to sync finding from event",
			"finding_id", findingID,
			"subject", msg.Subject,
			"error", err)
		return
	}

	s.logger.Info("finding synced from event", "finding_id", findingID, "subject", msg.Subject)
}

// syncSingleFinding copies a single finding from low-side to high-side PG.
func (s *Server) syncSingleFinding(ctx context.Context, findingID string) error {
	// Read from low-side
	var (
		id, operationID, findingType, severity, title, description, evidence, createdBy string
		taskID, endpointID, remediation, cveID, networkNodeID, originFindingID, originEnclave, redactedSummary *string
		tags       []string
		metadata   []byte
		cvssScore  *float64
		classification string
		createdAt, updatedAt time.Time
	)

	err := s.lowDB.QueryRow(ctx,
		`SELECT id, task_id, operation_id, endpoint_id,
				finding_type, severity, title, description,
				evidence, remediation, tags, metadata,
				classification, cve_id, cvss_score, network_node_id,
				origin_finding_id, origin_enclave, redacted_summary,
				created_by, created_at, COALESCE(updated_at, created_at)
		 FROM findings WHERE id = $1`, findingID).Scan(
		&id, &taskID, &operationID, &endpointID,
		&findingType, &severity, &title, &description,
		&evidence, &remediation, &tags, &metadata,
		&classification, &cveID, &cvssScore, &networkNodeID,
		&originFindingID, &originEnclave, &redactedSummary,
		&createdBy, &createdAt, &updatedAt,
	)
	if err != nil {
		return fmt.Errorf("read finding from low-side: %w", err)
	}

	// Classification check
	if strings.EqualFold(classification, "SECRET") {
		return fmt.Errorf("SECRET finding cannot be synced to high side")
	}

	// Check transfer policy
	req := TransferRequest{
		Direction:      "low_to_high",
		EntityType:     "finding",
		Classification: classification,
	}
	action, reason := s.evaluatePolicy(req)
	if action == "block" {
		return fmt.Errorf("transfer blocked by policy: %s", reason)
	}

	// If action is "queue", record the transfer and queue for approval instead of auto-sync
	if action == "queue" {
		transferID := generateUUID()
		record := TransferRecord{
			ID:             transferID,
			Direction:      "low_to_high",
			EntityType:     "finding",
			EntityIDs:      []string{findingID},
			Classification: classification,
			Status:         "queued",
			Reason:         reason,
			CreatedAt:      time.Now().UTC(),
		}
		if err := s.recordTransfer(ctx, record); err != nil {
			s.logger.Error("failed to record queued finding transfer", "error", err)
		}
		s.statsMu.Lock()
		s.pendingTransfers++
		s.statsMu.Unlock()
		s.logger.Info("finding transfer queued for approval",
			"finding_id", findingID,
			"classification", classification,
		)
		return nil // not an error — just queued
	}

	// Upsert into high-side
	_, err = s.highDB.Exec(ctx,
		`INSERT INTO findings (
			id, task_id, operation_id, endpoint_id,
			finding_type, severity, title, description,
			evidence, remediation, tags, metadata,
			classification, cve_id, cvss_score, network_node_id,
			origin_finding_id, origin_enclave, redacted_summary,
			created_by, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
		ON CONFLICT (id) DO UPDATE SET
			finding_type = EXCLUDED.finding_type,
			severity = EXCLUDED.severity,
			title = EXCLUDED.title,
			description = EXCLUDED.description,
			evidence = EXCLUDED.evidence,
			remediation = EXCLUDED.remediation,
			tags = EXCLUDED.tags,
			metadata = EXCLUDED.metadata,
			classification = CASE
				WHEN (CASE EXCLUDED.classification
					WHEN 'SECRET' THEN 2 WHEN 'CUI' THEN 1 ELSE 0 END) >=
				     (CASE findings.classification
					WHEN 'SECRET' THEN 2 WHEN 'CUI' THEN 1 ELSE 0 END)
				THEN EXCLUDED.classification
				ELSE findings.classification
			END,
			cve_id = EXCLUDED.cve_id,
			cvss_score = EXCLUDED.cvss_score,
			network_node_id = EXCLUDED.network_node_id,
			origin_finding_id = EXCLUDED.origin_finding_id,
			origin_enclave = EXCLUDED.origin_enclave,
			redacted_summary = EXCLUDED.redacted_summary`,
		id, taskID, operationID, endpointID,
		findingType, severity, title, description,
		evidence, remediation, tags, metadata,
		classification, cveID, cvssScore, networkNodeID,
		originFindingID, "low", redactedSummary,
		createdBy, createdAt,
	)
	if err != nil {
		return fmt.Errorf("upsert finding to high-side: %w", err)
	}

	// Create a finding_links entry for the duplicate on high side
	s.highDB.Exec(ctx,
		`INSERT INTO finding_links (source_finding_id, linked_finding_id, link_type, source_enclave)
		 VALUES ($1, $1, 'duplicate', 'low')
		 ON CONFLICT (source_finding_id, linked_finding_id) DO NOTHING`,
		id)

	// Record the transfer
	transferID := generateUUID()
	record := TransferRecord{
		ID:             transferID,
		Direction:      "low_to_high",
		EntityType:     "finding",
		EntityIDs:      []string{findingID},
		Classification: classification,
		Status:         "accepted",
		Reason:         reason,
		CreatedAt:      time.Now().UTC(),
	}
	if err := s.recordTransfer(ctx, record); err != nil {
		s.logger.Warn("failed to record finding transfer", "error", err)
	}

	// Publish synced event on high-side NATS
	s.publishTransferEvent("finding.synced", map[string]any{
		"finding_id":     findingID,
		"classification": classification,
		"direction":      "low_to_high",
		"transfer_id":    transferID,
		"timestamp":      time.Now().UTC().Format(time.RFC3339Nano),
	})

	// Update stats
	s.statsMu.Lock()
	s.transferStats["finding_"+classification]++
	s.statsMu.Unlock()

	return nil
}

// ---------------------------------------------------------------------------
// Finding sync — Background worker
// ---------------------------------------------------------------------------

func (s *Server) runFindingSync(ctx context.Context, interval time.Duration, stopCh <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			result, err := s.batchSyncFindings(ctx)
			if err != nil {
				s.logger.Error("periodic finding sync failed", "error", err)
			} else if result.Synced > 0 {
				s.logger.Info("periodic finding sync completed",
					"synced", result.Synced,
					"skipped", result.Skipped,
					"errors", len(result.Errors),
				)
			}
		case <-stopCh:
			s.logger.Info("finding sync worker stopped")
			return
		}
	}
}

func (s *Server) batchSyncFindings(ctx context.Context) (*FindingSyncResult, error) {
	result := &FindingSyncResult{}

	// Get last sync watermark from high-side DB
	var lastSyncAt time.Time
	err := s.highDB.QueryRow(ctx,
		`SELECT last_sync_at FROM cti_finding_sync_state WHERE direction = 'low_to_high'`,
	).Scan(&lastSyncAt)
	if err != nil {
		// Table might not exist yet — use epoch
		lastSyncAt = time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)
	}

	// Query low-side for findings updated since last sync
	rows, err := s.lowDB.Query(ctx,
		`SELECT id, classification FROM findings
		 WHERE COALESCE(updated_at, created_at) > $1
		 ORDER BY COALESCE(updated_at, created_at) ASC
		 LIMIT 500`, lastSyncAt)
	if err != nil {
		return result, fmt.Errorf("query low-side findings: %w", err)
	}
	defer rows.Close()

	var latestTS time.Time
	for rows.Next() {
		var findingID, classification string
		if err := rows.Scan(&findingID, &classification); err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("scan: %v", err))
			continue
		}

		// Skip SECRET
		if strings.EqualFold(classification, "SECRET") {
			result.Skipped++
			continue
		}

		if err := s.syncSingleFinding(ctx, findingID); err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("finding %s: %v", findingID, err))
			continue
		}
		result.Synced++
	}
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("iterate findings: %w", err)
	}

	// Update watermark
	if result.Synced > 0 || result.Skipped > 0 {
		if latestTS.IsZero() {
			latestTS = time.Now().UTC()
		}
		var lastErr *string
		if len(result.Errors) > 0 {
			errStr := strings.Join(result.Errors, "; ")
			lastErr = &errStr
		}
		s.highDB.Exec(ctx,
			`UPDATE cti_finding_sync_state
			 SET last_sync_at = $1, findings_synced = findings_synced + $2, last_error = $3, updated_at = NOW()
			 WHERE direction = 'low_to_high'`,
			time.Now().UTC(), result.Synced, lastErr)
	}

	return result, nil
}

// ---------------------------------------------------------------------------
// Finding sync — HTTP endpoints
// ---------------------------------------------------------------------------

func (s *Server) handleFindingSyncStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	status := FindingSyncStatus{
		ByClassification: make(map[string]int),
	}

	// Get sync state
	var lastSyncAt time.Time
	var totalSynced int
	err := s.highDB.QueryRow(ctx,
		`SELECT last_sync_at, findings_synced FROM cti_finding_sync_state WHERE direction = 'low_to_high'`,
	).Scan(&lastSyncAt, &totalSynced)
	if err == nil {
		status.TotalSynced = totalSynced
		status.LastSyncAt = formatTimeISO(lastSyncAt)
	}

	// Count pending (queued finding transfers)
	s.highDB.QueryRow(ctx,
		`SELECT COUNT(*) FROM cti_transfers WHERE entity_type = 'finding' AND status = 'queued'`,
	).Scan(&status.TotalPending)

	// Count failed
	s.highDB.QueryRow(ctx,
		`SELECT COUNT(*) FROM cti_transfers WHERE entity_type = 'finding' AND status = 'failed'`,
	).Scan(&status.TotalFailed)

	// Classification breakdown of synced findings on high side with origin_enclave = 'low'
	rows, err := s.highDB.Query(ctx,
		`SELECT classification, COUNT(*) FROM findings
		 WHERE origin_enclave = 'low'
		 GROUP BY classification`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var cls string
			var cnt int
			if err := rows.Scan(&cls, &cnt); err == nil {
				status.ByClassification[cls] = cnt
			}
		}
	}

	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleFindingSync(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	result, err := s.batchSyncFindings(ctx)
	if err != nil {
		s.logger.Error("manual finding sync failed", "error", err)
		writeError(w, http.StatusInternalServerError, "SYNC_FAILED", "Finding sync failed")
		return
	}

	s.logger.Info("manual finding sync completed",
		"synced", result.Synced,
		"skipped", result.Skipped,
	)

	writeJSON(w, http.StatusOK, result)
}

// FilterTelemetryEvent returns true if the event should be relayed (not SECRET).
// Exported for testing.
func FilterTelemetryEvent(data []byte) (allowed bool, classification string) {
	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil {
		return false, ""
	}
	c, _ := event["classification"].(string)
	if strings.EqualFold(c, "SECRET") {
		return false, c
	}
	return true, c
}
