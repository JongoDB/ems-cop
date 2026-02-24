package main

import (
	"context"
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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Server struct {
	db     *pgxpool.Pool
	nc     *nats.Conn
	port   string
	logger *slog.Logger
}

type Operation struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Objective          string   `json:"objective"`
	ScopeDescription   string   `json:"scope_description"`
	RulesOfEngagement  string   `json:"rules_of_engagement"`
	RiskLevel          int      `json:"risk_level"`
	Status             string   `json:"status"`
	WorkflowID         *string  `json:"workflow_id"`
	PlannedStart       *string  `json:"planned_start"`
	PlannedEnd         *string  `json:"planned_end"`
	ActualStart        *string  `json:"actual_start"`
	ActualEnd          *string  `json:"actual_end"`
	Tags               []string `json:"tags"`
	Metadata           any      `json:"metadata"`
	CreatedBy          string   `json:"created_by"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at"`
	NetworkCount       int      `json:"network_count"`
	FindingCount       int      `json:"finding_count"`
}

type OperationMember struct {
	UserID          string `json:"user_id"`
	Username        string `json:"username"`
	DisplayName     string `json:"display_name"`
	RoleInOperation string `json:"role_in_operation"`
}

type CreateOperationRequest struct {
	Name              string   `json:"name"`
	Objective         string   `json:"objective"`
	ScopeDescription  string   `json:"scope_description"`
	RulesOfEngagement string   `json:"rules_of_engagement"`
	RiskLevel         *int     `json:"risk_level"`
	Tags              []string `json:"tags"`
	Metadata          any      `json:"metadata"`
}

type UpdateOperationRequest struct {
	Name              *string  `json:"name"`
	Objective         *string  `json:"objective"`
	ScopeDescription  *string  `json:"scope_description"`
	RulesOfEngagement *string  `json:"rules_of_engagement"`
	RiskLevel         *int     `json:"risk_level"`
	Tags              *[]string `json:"tags"`
	Metadata          any      `json:"metadata"`
}

type TransitionRequest struct {
	Status string `json:"status"`
}

type AddMemberRequest struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

// ---------------------------------------------------------------------------
// Valid status transitions
// ---------------------------------------------------------------------------

var validTransitions = map[string][]string{
	"draft":            {"pending_approval", "in_progress"},
	"pending_approval": {"approved", "draft"},
	"approved":         {"in_progress"},
	"in_progress":      {"paused", "completed", "aborted"},
	"paused":           {"in_progress", "aborted"},
}

func isValidTransition(from, to string) bool {
	targets, ok := validTransitions[from]
	if !ok {
		return false
	}
	for _, t := range targets {
		if t == to {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func (s *Server) publishEvent(eventType string, data any) {
	if s.nc == nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"event_type": eventType,
		"data":       data,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		s.logger.Warn("failed to marshal event", "event", eventType, "error", err)
		return
	}
	if err := s.nc.Publish(eventType, payload); err != nil {
		s.logger.Warn("failed to publish event", "event", eventType, "error", err)
	}
}

func getUserID(r *http.Request) string {
	return r.Header.Get("X-User-ID")
}

func parsePagination(r *http.Request) (page, limit, offset int) {
	page = 1
	limit = 20
	if p := r.URL.Query().Get("page"); p != "" {
		if v, err := strconv.Atoi(p); err == nil && v > 0 {
			page = v
		}
	}
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 && v <= 100 {
			limit = v
		}
	}
	offset = (page - 1) * limit
	return
}

// scanOperation scans a row into an Operation struct.
// The query must select columns in exactly this order:
// id, name, objective, scope_description, rules_of_engagement, risk_level, status,
// workflow_id, planned_start, planned_end, actual_start, actual_end,
// tags, metadata, created_by, created_at, updated_at, network_count, finding_count
func scanOperation(scanner interface {
	Scan(dest ...any) error
}) (Operation, error) {
	var op Operation
	var (
		workflowID   *string
		plannedStart *time.Time
		plannedEnd   *time.Time
		actualStart  *time.Time
		actualEnd    *time.Time
		createdAt    time.Time
		updatedAt    time.Time
		metadata     []byte
	)
	err := scanner.Scan(
		&op.ID, &op.Name, &op.Objective, &op.ScopeDescription, &op.RulesOfEngagement,
		&op.RiskLevel, &op.Status,
		&workflowID, &plannedStart, &plannedEnd, &actualStart, &actualEnd,
		&op.Tags, &metadata, &op.CreatedBy, &createdAt, &updatedAt,
		&op.NetworkCount, &op.FindingCount,
	)
	if err != nil {
		return op, err
	}

	op.WorkflowID = workflowID
	if plannedStart != nil {
		s := plannedStart.UTC().Format(time.RFC3339)
		op.PlannedStart = &s
	}
	if plannedEnd != nil {
		s := plannedEnd.UTC().Format(time.RFC3339)
		op.PlannedEnd = &s
	}
	if actualStart != nil {
		s := actualStart.UTC().Format(time.RFC3339)
		op.ActualStart = &s
	}
	if actualEnd != nil {
		s := actualEnd.UTC().Format(time.RFC3339)
		op.ActualEnd = &s
	}
	op.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	op.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	if op.Tags == nil {
		op.Tags = []string{}
	}

	// Parse metadata JSONB
	if len(metadata) > 0 {
		var m any
		if err := json.Unmarshal(metadata, &m); err == nil {
			op.Metadata = m
		} else {
			op.Metadata = map[string]any{}
		}
	} else {
		op.Metadata = map[string]any{}
	}

	return op, nil
}

const operationSelectCols = `o.id, o.name, o.objective, o.scope_description, o.rules_of_engagement,
       o.risk_level, o.status,
       o.workflow_id, o.planned_start, o.planned_end, o.actual_start, o.actual_end,
       o.tags, o.metadata, o.created_by, o.created_at, o.updated_at,
       (SELECT count(*) FROM networks WHERE operation_id = o.id) AS network_count,
       (SELECT count(*) FROM findings WHERE operation_id = o.id) AS finding_count`

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	// Quick DB ping
	err := s.db.Ping(r.Context())
	status := "ok"
	if err != nil {
		status = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status, "service": "workflow-engine"})
}

func (s *Server) handleCreateOperation(w http.ResponseWriter, r *http.Request) {
	var req CreateOperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")
		return
	}
	if req.Objective == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "objective is required")
		return
	}

	riskLevel := 3
	if req.RiskLevel != nil {
		riskLevel = *req.RiskLevel
		if riskLevel < 1 || riskLevel > 5 {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "risk_level must be between 1 and 5")
			return
		}
	}

	userID := getUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "X-User-ID header required")
		return
	}

	tags := req.Tags
	if tags == nil {
		tags = []string{}
	}

	metadataBytes := []byte("{}")
	if req.Metadata != nil {
		if b, err := json.Marshal(req.Metadata); err == nil {
			metadataBytes = b
		}
	}

	query := `INSERT INTO operations (name, objective, scope_description, rules_of_engagement, risk_level, tags, metadata, created_by)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              RETURNING id, name, objective, scope_description, rules_of_engagement, risk_level, status,
                        workflow_id, planned_start, planned_end, actual_start, actual_end,
                        tags, metadata, created_by, created_at, updated_at, 0, 0`

	row := s.db.QueryRow(r.Context(), query,
		req.Name, req.Objective, req.ScopeDescription, req.RulesOfEngagement,
		riskLevel, tags, metadataBytes, userID)

	op, err := scanOperation(row)
	if err != nil {
		s.logger.Error("create operation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create operation")
		return
	}

	s.publishEvent("operation.created", op)
	writeJSON(w, http.StatusCreated, op)
}

func (s *Server) handleListOperations(w http.ResponseWriter, r *http.Request) {
	page, limit, offset := parsePagination(r)
	status := r.URL.Query().Get("status")
	search := r.URL.Query().Get("search")

	query := fmt.Sprintf(`SELECT %s FROM operations o
		WHERE ($1 = '' OR o.status = $1)
		  AND ($2 = '' OR o.name ILIKE '%%' || $2 || '%%' OR o.objective ILIKE '%%' || $2 || '%%')
		ORDER BY o.created_at DESC
		LIMIT $3 OFFSET $4`, operationSelectCols)

	rows, err := s.db.Query(r.Context(), query, status, search, limit, offset)
	if err != nil {
		s.logger.Error("list operations query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to query operations")
		return
	}
	defer rows.Close()

	var ops []Operation
	for rows.Next() {
		op, err := scanOperation(rows)
		if err != nil {
			s.logger.Error("scan operation failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan operation")
			return
		}
		ops = append(ops, op)
	}
	if ops == nil {
		ops = []Operation{}
	}

	// Count total
	countQuery := `SELECT count(*) FROM operations o
		WHERE ($1 = '' OR o.status = $1)
		  AND ($2 = '' OR o.name ILIKE '%' || $2 || '%' OR o.objective ILIKE '%' || $2 || '%')`
	var total int
	if err := s.db.QueryRow(r.Context(), countQuery, status, search).Scan(&total); err != nil {
		s.logger.Error("count operations failed", "error", err)
		total = len(ops)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": ops,
		"pagination": map[string]int{
			"page":  page,
			"limit": limit,
			"total": total,
		},
	})
}

func (s *Server) handleGetOperation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	query := fmt.Sprintf(`SELECT %s FROM operations o WHERE o.id = $1`, operationSelectCols)
	row := s.db.QueryRow(r.Context(), query, id)
	op, err := scanOperation(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Operation not found")
			return
		}
		s.logger.Error("get operation failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get operation")
		return
	}

	writeJSON(w, http.StatusOK, op)
}

func (s *Server) handleUpdateOperation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req UpdateOperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}

	// Build dynamic SET clause
	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if req.Name != nil {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *req.Name)
		argIdx++
	}
	if req.Objective != nil {
		setClauses = append(setClauses, fmt.Sprintf("objective = $%d", argIdx))
		args = append(args, *req.Objective)
		argIdx++
	}
	if req.ScopeDescription != nil {
		setClauses = append(setClauses, fmt.Sprintf("scope_description = $%d", argIdx))
		args = append(args, *req.ScopeDescription)
		argIdx++
	}
	if req.RulesOfEngagement != nil {
		setClauses = append(setClauses, fmt.Sprintf("rules_of_engagement = $%d", argIdx))
		args = append(args, *req.RulesOfEngagement)
		argIdx++
	}
	if req.RiskLevel != nil {
		if *req.RiskLevel < 1 || *req.RiskLevel > 5 {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "risk_level must be between 1 and 5")
			return
		}
		setClauses = append(setClauses, fmt.Sprintf("risk_level = $%d", argIdx))
		args = append(args, *req.RiskLevel)
		argIdx++
	}
	if req.Tags != nil {
		setClauses = append(setClauses, fmt.Sprintf("tags = $%d", argIdx))
		args = append(args, *req.Tags)
		argIdx++
	}
	if req.Metadata != nil {
		metaBytes, _ := json.Marshal(req.Metadata)
		setClauses = append(setClauses, fmt.Sprintf("metadata = $%d", argIdx))
		args = append(args, metaBytes)
		argIdx++
	}

	if len(setClauses) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "No fields to update")
		return
	}

	setClauses = append(setClauses, "updated_at = NOW()")

	query := fmt.Sprintf("UPDATE operations SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), argIdx)
	args = append(args, id)

	result, err := s.db.Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update operation failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update operation")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Operation not found")
		return
	}

	// Fetch updated operation
	fetchQuery := fmt.Sprintf(`SELECT %s FROM operations o WHERE o.id = $1`, operationSelectCols)
	row := s.db.QueryRow(r.Context(), fetchQuery, id)
	op, err := scanOperation(row)
	if err != nil {
		s.logger.Error("fetch updated operation failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated operation")
		return
	}

	s.publishEvent("operation.updated", op)
	writeJSON(w, http.StatusOK, op)
}

func (s *Server) handleTransitionOperation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req TransitionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.Status == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "status is required")
		return
	}

	// Get current status
	var currentStatus string
	err := s.db.QueryRow(r.Context(), "SELECT status FROM operations WHERE id = $1", id).Scan(&currentStatus)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Operation not found")
			return
		}
		s.logger.Error("get operation status failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get operation status")
		return
	}

	if !isValidTransition(currentStatus, req.Status) {
		writeError(w, http.StatusBadRequest, "INVALID_TRANSITION",
			fmt.Sprintf("Cannot transition from %s to %s", currentStatus, req.Status))
		return
	}

	// Update status
	_, err = s.db.Exec(r.Context(),
		"UPDATE operations SET status = $1, updated_at = NOW() WHERE id = $2",
		req.Status, id)
	if err != nil {
		s.logger.Error("transition operation failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update operation status")
		return
	}

	// Fetch updated operation
	fetchQuery := fmt.Sprintf(`SELECT %s FROM operations o WHERE o.id = $1`, operationSelectCols)
	row := s.db.QueryRow(r.Context(), fetchQuery, id)
	op, err := scanOperation(row)
	if err != nil {
		s.logger.Error("fetch transitioned operation failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch operation")
		return
	}

	s.publishEvent("operation.status_changed", map[string]any{
		"operation_id": id,
		"from_status":  currentStatus,
		"to_status":    req.Status,
		"operation":    op,
	})

	writeJSON(w, http.StatusOK, op)
}

func (s *Server) handleListMembers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Verify operation exists
	var exists bool
	err := s.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM operations WHERE id = $1)", id).Scan(&exists)
	if err != nil || !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Operation not found")
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT om.user_id, u.username, u.display_name, om.role_in_operation
		FROM operation_members om
		JOIN users u ON u.id = om.user_id
		WHERE om.operation_id = $1
		ORDER BY om.added_at`, id)
	if err != nil {
		s.logger.Error("list members failed", "error", err, "operation_id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to list members")
		return
	}
	defer rows.Close()

	var members []OperationMember
	for rows.Next() {
		var m OperationMember
		if err := rows.Scan(&m.UserID, &m.Username, &m.DisplayName, &m.RoleInOperation); err != nil {
			s.logger.Error("scan member failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan member")
			return
		}
		members = append(members, m)
	}
	if members == nil {
		members = []OperationMember{}
	}

	writeJSON(w, http.StatusOK, members)
}

func (s *Server) handleAddMember(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req AddMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "user_id is required")
		return
	}
	if req.Role == "" {
		req.Role = "member"
	}

	// Verify operation exists
	var exists bool
	err := s.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM operations WHERE id = $1)", id).Scan(&exists)
	if err != nil || !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Operation not found")
		return
	}

	_, err = s.db.Exec(r.Context(),
		`INSERT INTO operation_members (operation_id, user_id, role_in_operation) VALUES ($1, $2, $3)
		 ON CONFLICT (operation_id, user_id) DO UPDATE SET role_in_operation = $3`,
		id, req.UserID, req.Role)
	if err != nil {
		s.logger.Error("add member failed", "error", err, "operation_id", id, "user_id", req.UserID)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to add member")
		return
	}

	s.publishEvent("operation.member_added", map[string]any{
		"operation_id":      id,
		"user_id":           req.UserID,
		"role_in_operation": req.Role,
	})

	// Return the member details
	var m OperationMember
	err = s.db.QueryRow(r.Context(), `
		SELECT om.user_id, u.username, u.display_name, om.role_in_operation
		FROM operation_members om
		JOIN users u ON u.id = om.user_id
		WHERE om.operation_id = $1 AND om.user_id = $2`, id, req.UserID).
		Scan(&m.UserID, &m.Username, &m.DisplayName, &m.RoleInOperation)
	if err != nil {
		s.logger.Error("fetch added member failed", "error", err)
		writeJSON(w, http.StatusCreated, map[string]string{
			"user_id":           req.UserID,
			"role_in_operation": req.Role,
		})
		return
	}

	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	userID := r.PathValue("userId")
	if id == "" || userID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "operation id and userId are required")
		return
	}

	result, err := s.db.Exec(r.Context(),
		"DELETE FROM operation_members WHERE operation_id = $1 AND user_id = $2",
		id, userID)
	if err != nil {
		s.logger.Error("remove member failed", "error", err, "operation_id", id, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to remove member")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Member not found in operation")
		return
	}

	s.publishEvent("operation.member_removed", map[string]any{
		"operation_id": id,
		"user_id":      userID,
	})

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

func (s *Server) Start() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /api/v1/operations", s.handleCreateOperation)
	mux.HandleFunc("GET /api/v1/operations", s.handleListOperations)
	mux.HandleFunc("GET /api/v1/operations/{id}", s.handleGetOperation)
	mux.HandleFunc("PATCH /api/v1/operations/{id}", s.handleUpdateOperation)
	mux.HandleFunc("POST /api/v1/operations/{id}/transition", s.handleTransitionOperation)
	mux.HandleFunc("GET /api/v1/operations/{id}/members", s.handleListMembers)
	mux.HandleFunc("POST /api/v1/operations/{id}/members", s.handleAddMember)
	mux.HandleFunc("DELETE /api/v1/operations/{id}/members/{userId}", s.handleRemoveMember)

	s.logger.Info("starting workflow-engine", "port", s.port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", s.port), mux); err != nil {
		s.logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	pgURL := fmt.Sprintf("postgres://%s:%s@%s:%s/%s",
		getEnv("POSTGRES_USER", "ems_user"),
		getEnv("POSTGRES_PASSWORD", "ems_password"),
		getEnv("POSTGRES_HOST", "localhost"),
		getEnv("POSTGRES_PORT", "5432"),
		getEnv("POSTGRES_DB", "ems_cop"))

	pool, err := pgxpool.New(context.Background(), pgURL)
	if err != nil {
		logger.Error("postgres connect failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(context.Background()); err != nil {
		logger.Error("postgres ping failed", "error", err)
		os.Exit(1)
	}
	logger.Info("connected to postgres")

	var nc *nats.Conn
	natsURL := getEnv("NATS_URL", "nats://localhost:4222")
	nc, err = nats.Connect(natsURL)
	if err != nil {
		logger.Warn("NATS connect failed, events disabled", "error", err)
	} else {
		logger.Info("connected to NATS")
	}

	port := getEnv("SERVICE_PORT", "3002")
	server := &Server{db: pool, nc: nc, port: port, logger: logger}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		if nc != nil {
			nc.Close()
		}
		pool.Close()
		os.Exit(0)
	}()

	server.Start()
}
