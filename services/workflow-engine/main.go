package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// ---------------------------------------------------------------------------
// Types — Operations (existing)
// ---------------------------------------------------------------------------

type Server struct {
	db     *pgxpool.Pool
	nc     *nats.Conn
	port   string
	logger *slog.Logger
}

type Operation struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Objective         string   `json:"objective"`
	ScopeDescription  string   `json:"scope_description"`
	RulesOfEngagement string   `json:"rules_of_engagement"`
	RiskLevel         int      `json:"risk_level"`
	Status            string   `json:"status"`
	WorkflowID        *string  `json:"workflow_id"`
	PlannedStart      *string  `json:"planned_start"`
	PlannedEnd        *string  `json:"planned_end"`
	ActualStart       *string  `json:"actual_start"`
	ActualEnd         *string  `json:"actual_end"`
	Tags              []string `json:"tags"`
	Metadata          any      `json:"metadata"`
	CreatedBy         string   `json:"created_by"`
	CreatedAt         string   `json:"created_at"`
	UpdatedAt         string   `json:"updated_at"`
	NetworkCount      int      `json:"network_count"`
	FindingCount      int      `json:"finding_count"`
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
	Name              *string   `json:"name"`
	Objective         *string   `json:"objective"`
	ScopeDescription  *string   `json:"scope_description"`
	RulesOfEngagement *string   `json:"rules_of_engagement"`
	RiskLevel         *int      `json:"risk_level"`
	Tags              *[]string `json:"tags"`
	Metadata          any       `json:"metadata"`
}

type TransitionRequest struct {
	Status string `json:"status"`
}

type AddMemberRequest struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

// ---------------------------------------------------------------------------
// Types — Workflows
// ---------------------------------------------------------------------------

type Workflow struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	Description string               `json:"description"`
	Version     int                  `json:"version"`
	IsTemplate  bool                 `json:"is_template"`
	IsDefault   bool                 `json:"is_default"`
	CreatedBy   *string              `json:"created_by"`
	CreatedAt   string               `json:"created_at"`
	UpdatedAt   string               `json:"updated_at"`
	Stages      []WorkflowStage      `json:"stages"`
	Transitions []WorkflowTransition `json:"transitions"`
}

type WorkflowStage struct {
	ID         string         `json:"id"`
	WorkflowID string        `json:"workflow_id"`
	Name       string         `json:"name"`
	StageOrder int            `json:"stage_order"`
	StageType  string         `json:"stage_type"`
	Config     map[string]any `json:"config"`
	CreatedAt  string         `json:"created_at"`
}

type WorkflowTransition struct {
	ID            string  `json:"id"`
	WorkflowID    string  `json:"workflow_id"`
	FromStageID   string  `json:"from_stage_id"`
	ToStageID     string  `json:"to_stage_id"`
	Trigger       string  `json:"trigger"`
	ConditionExpr *string `json:"condition_expr"`
	Label         *string `json:"label"`
	CreatedAt     string  `json:"created_at"`
}

type WorkflowRun struct {
	ID             string                `json:"id"`
	WorkflowID     string                `json:"workflow_id"`
	TicketID       *string               `json:"ticket_id"`
	CurrentStageID *string               `json:"current_stage_id"`
	CurrentStage   *WorkflowStage        `json:"current_stage,omitempty"`
	Status         string                `json:"status"`
	Context        map[string]any        `json:"context"`
	StartedAt      string                `json:"started_at"`
	CompletedAt    *string               `json:"completed_at"`
	History        []WorkflowRunHistory  `json:"history,omitempty"`
	WorkflowName   string                `json:"workflow_name,omitempty"`
}

type WorkflowRunHistory struct {
	ID        string         `json:"id"`
	RunID     string         `json:"run_id"`
	StageID   string         `json:"stage_id"`
	StageName string         `json:"stage_name"`
	Action    string         `json:"action"`
	ActorID   *string        `json:"actor_id"`
	Comment   *string        `json:"comment"`
	Metadata  map[string]any `json:"metadata"`
	OccurredAt string        `json:"occurred_at"`
}

// Request types
type CreateWorkflowRequest struct {
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	IsTemplate  bool                       `json:"is_template"`
	IsDefault   bool                       `json:"is_default"`
	Stages      []CreateStageRequest       `json:"stages"`
	Transitions []CreateTransitionRequest  `json:"transitions"`
}

type CreateStageRequest struct {
	Name       string         `json:"name"`
	StageOrder int            `json:"stage_order"`
	StageType  string         `json:"stage_type"`
	Config     map[string]any `json:"config"`
}

type CreateTransitionRequest struct {
	FromStageOrder int     `json:"from_stage_order"`
	ToStageOrder   int     `json:"to_stage_order"`
	Trigger        string  `json:"trigger"`
	ConditionExpr  *string `json:"condition_expr"`
	Label          *string `json:"label"`
}

type UpdateWorkflowRequest struct {
	Name        *string                    `json:"name"`
	Description *string                    `json:"description"`
	IsTemplate  *bool                      `json:"is_template"`
	IsDefault   *bool                      `json:"is_default"`
	Stages      []CreateStageRequest       `json:"stages"`
	Transitions []CreateTransitionRequest  `json:"transitions"`
}

type StartRunRequest struct {
	WorkflowID string         `json:"workflow_id"`
	TicketID   *string        `json:"ticket_id"`
	Context    map[string]any `json:"context"`
}

type RunActionRequest struct {
	Action        string  `json:"action"`
	Comment       string  `json:"comment"`
	TargetStageID *string `json:"target_stage_id"`
}

type UpdateRunContextRequest struct {
	Context map[string]any `json:"context"`
}

// ---------------------------------------------------------------------------
// Valid status transitions (operations)
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

func getUserRoles(r *http.Request) []string {
	raw := r.Header.Get("X-User-Roles")
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	var roles []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			roles = append(roles, p)
		}
	}
	return roles
}

func hasRole(roles []string, required string) bool {
	for _, r := range roles {
		if r == required || r == "admin" {
			return true
		}
	}
	return false
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

func parseJSONB(data []byte) map[string]any {
	if len(data) == 0 {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return map[string]any{}
	}
	return m
}

// ---------------------------------------------------------------------------
// Scan helpers — Operations
// ---------------------------------------------------------------------------

func scanOperation(scanner interface{ Scan(dest ...any) error }) (Operation, error) {
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
// Scan helpers — Workflows
// ---------------------------------------------------------------------------

func scanWorkflowRow(scanner interface{ Scan(dest ...any) error }) (Workflow, error) {
	var wf Workflow
	var createdBy *string
	var createdAt, updatedAt time.Time
	err := scanner.Scan(&wf.ID, &wf.Name, &wf.Description, &wf.Version,
		&wf.IsTemplate, &wf.IsDefault, &createdBy, &createdAt, &updatedAt)
	if err != nil {
		return wf, err
	}
	wf.CreatedBy = createdBy
	wf.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	wf.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	wf.Stages = []WorkflowStage{}
	wf.Transitions = []WorkflowTransition{}
	return wf, nil
}

func scanStageRow(scanner interface{ Scan(dest ...any) error }) (WorkflowStage, error) {
	var st WorkflowStage
	var config []byte
	var createdAt time.Time
	err := scanner.Scan(&st.ID, &st.WorkflowID, &st.Name, &st.StageOrder, &st.StageType, &config, &createdAt)
	if err != nil {
		return st, err
	}
	st.Config = parseJSONB(config)
	st.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return st, nil
}

func scanTransitionRow(scanner interface{ Scan(dest ...any) error }) (WorkflowTransition, error) {
	var tr WorkflowTransition
	var condExpr *string
	var label *string
	var createdAt time.Time
	err := scanner.Scan(&tr.ID, &tr.WorkflowID, &tr.FromStageID, &tr.ToStageID, &tr.Trigger, &condExpr, &label, &createdAt)
	if err != nil {
		return tr, err
	}
	tr.ConditionExpr = condExpr
	tr.Label = label
	tr.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return tr, nil
}

func scanRunRow(scanner interface{ Scan(dest ...any) error }) (WorkflowRun, error) {
	var run WorkflowRun
	var contextData []byte
	var startedAt time.Time
	var completedAt *time.Time
	err := scanner.Scan(&run.ID, &run.WorkflowID, &run.TicketID, &run.CurrentStageID,
		&run.Status, &contextData, &startedAt, &completedAt)
	if err != nil {
		return run, err
	}
	run.Context = parseJSONB(contextData)
	run.StartedAt = startedAt.UTC().Format(time.RFC3339)
	if completedAt != nil {
		s := completedAt.UTC().Format(time.RFC3339)
		run.CompletedAt = &s
	}
	return run, nil
}

func scanHistoryRow(scanner interface{ Scan(dest ...any) error }) (WorkflowRunHistory, error) {
	var h WorkflowRunHistory
	var metadata []byte
	var occurredAt time.Time
	err := scanner.Scan(&h.ID, &h.RunID, &h.StageID, &h.StageName, &h.Action, &h.ActorID, &h.Comment, &metadata, &occurredAt)
	if err != nil {
		return h, err
	}
	h.Metadata = parseJSONB(metadata)
	h.OccurredAt = occurredAt.UTC().Format(time.RFC3339)
	return h, nil
}

// ---------------------------------------------------------------------------
// Workflow helpers — fetch full workflow with stages/transitions
// ---------------------------------------------------------------------------

func (s *Server) fetchWorkflowFull(ctx context.Context, id string) (*Workflow, error) {
	row := s.db.QueryRow(ctx,
		`SELECT id, name, description, version, is_template, is_default, created_by, created_at, updated_at
		 FROM workflows WHERE id = $1`, id)
	wf, err := scanWorkflowRow(row)
	if err != nil {
		return nil, err
	}

	// Stages
	rows, err := s.db.Query(ctx,
		`SELECT id, workflow_id, name, stage_order, stage_type, config, created_at
		 FROM workflow_stages WHERE workflow_id = $1 ORDER BY stage_order`, id)
	if err != nil {
		return nil, fmt.Errorf("fetch stages: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		st, err := scanStageRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan stage: %w", err)
		}
		wf.Stages = append(wf.Stages, st)
	}

	// Transitions
	tRows, err := s.db.Query(ctx,
		`SELECT id, workflow_id, from_stage_id, to_stage_id, trigger, condition_expr, label, created_at
		 FROM workflow_transitions WHERE workflow_id = $1`, id)
	if err != nil {
		return nil, fmt.Errorf("fetch transitions: %w", err)
	}
	defer tRows.Close()
	for tRows.Next() {
		tr, err := scanTransitionRow(tRows)
		if err != nil {
			return nil, fmt.Errorf("scan transition: %w", err)
		}
		wf.Transitions = append(wf.Transitions, tr)
	}

	return &wf, nil
}

func (s *Server) getDefaultWorkflowID(ctx context.Context) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `SELECT id FROM workflows WHERE is_default = true LIMIT 1`).Scan(&id)
	return id, err
}

func (s *Server) getStageByID(ctx context.Context, stageID string) (*WorkflowStage, error) {
	row := s.db.QueryRow(ctx,
		`SELECT id, workflow_id, name, stage_order, stage_type, config, created_at
		 FROM workflow_stages WHERE id = $1`, stageID)
	st, err := scanStageRow(row)
	if err != nil {
		return nil, err
	}
	return &st, nil
}

func (s *Server) getFirstStage(ctx context.Context, workflowID string) (*WorkflowStage, error) {
	row := s.db.QueryRow(ctx,
		`SELECT id, workflow_id, name, stage_order, stage_type, config, created_at
		 FROM workflow_stages WHERE workflow_id = $1 ORDER BY stage_order LIMIT 1`, workflowID)
	st, err := scanStageRow(row)
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// ---------------------------------------------------------------------------
// Workflow Run Engine
// ---------------------------------------------------------------------------

func (s *Server) startWorkflowRunInternal(ctx context.Context, workflowID string, ticketID *string, runContext map[string]any) (*WorkflowRun, error) {
	firstStage, err := s.getFirstStage(ctx, workflowID)
	if err != nil {
		return nil, fmt.Errorf("get first stage: %w", err)
	}

	contextBytes, _ := json.Marshal(runContext)

	var run WorkflowRun
	var startedAt time.Time
	err = s.db.QueryRow(ctx,
		`INSERT INTO workflow_runs (workflow_id, ticket_id, current_stage_id, status, context)
		 VALUES ($1, $2, $3, 'active', $4)
		 RETURNING id, workflow_id, ticket_id, current_stage_id, status, context, started_at, completed_at`,
		workflowID, ticketID, firstStage.ID, contextBytes).Scan(
		&run.ID, &run.WorkflowID, &run.TicketID, &run.CurrentStageID,
		&run.Status, &contextBytes, &startedAt, &run.CompletedAt)
	if err != nil {
		return nil, fmt.Errorf("insert run: %w", err)
	}
	run.Context = parseJSONB(contextBytes)
	run.StartedAt = startedAt.UTC().Format(time.RFC3339)

	// Record entered history
	s.recordHistory(ctx, run.ID, firstStage.ID, "entered", nil, nil, nil)

	// Link to ticket
	if ticketID != nil {
		_, err = s.db.Exec(ctx,
			`UPDATE tickets SET workflow_run_id = $1, current_stage_id = $2 WHERE id = $3`,
			run.ID, firstStage.ID, *ticketID)
		if err != nil {
			s.logger.Warn("failed to link ticket to run", "error", err, "ticket_id", *ticketID)
		}
	}

	s.publishEvent("workflow.run_started", map[string]any{
		"run_id":      run.ID,
		"workflow_id": workflowID,
		"ticket_id":   ticketID,
		"stage":       firstStage.Name,
	})

	// Process auto stages
	s.processAutoStage(ctx, &run)

	return &run, nil
}

func (s *Server) recordHistory(ctx context.Context, runID, stageID, action string, actorID *string, comment *string, meta map[string]any) {
	metaBytes := []byte("{}")
	if meta != nil {
		metaBytes, _ = json.Marshal(meta)
	}

	_, err := s.db.Exec(ctx,
		`INSERT INTO workflow_run_history (run_id, stage_id, action, actor_id, comment, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		runID, stageID, action, actorID, comment, metaBytes)
	if err != nil {
		s.logger.Warn("failed to record history", "error", err, "run_id", runID)
	}
}

func (s *Server) resolveNextStage(ctx context.Context, workflowID, fromStageID, trigger string) (*WorkflowStage, error) {
	// Check explicit transition
	var toStageID string
	err := s.db.QueryRow(ctx,
		`SELECT to_stage_id FROM workflow_transitions
		 WHERE workflow_id = $1 AND from_stage_id = $2 AND trigger = $3
		 LIMIT 1`, workflowID, fromStageID, trigger).Scan(&toStageID)
	if err == nil {
		return s.getStageByID(ctx, toStageID)
	}

	// Linear fallback: next by stage_order
	var currentOrder int
	err = s.db.QueryRow(ctx, `SELECT stage_order FROM workflow_stages WHERE id = $1`, fromStageID).Scan(&currentOrder)
	if err != nil {
		return nil, fmt.Errorf("get current stage order: %w", err)
	}

	row := s.db.QueryRow(ctx,
		`SELECT id, workflow_id, name, stage_order, stage_type, config, created_at
		 FROM workflow_stages WHERE workflow_id = $1 AND stage_order > $2
		 ORDER BY stage_order LIMIT 1`, workflowID, currentOrder)
	st, err := scanStageRow(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil // No next stage — run complete
		}
		return nil, fmt.Errorf("next stage: %w", err)
	}
	return &st, nil
}

func (s *Server) advanceToStage(ctx context.Context, run *WorkflowRun, nextStage *WorkflowStage, actorID *string) error {
	if nextStage == nil {
		// Complete the run
		_, err := s.db.Exec(ctx,
			`UPDATE workflow_runs SET status = 'completed', completed_at = NOW() WHERE id = $1`, run.ID)
		if err != nil {
			return fmt.Errorf("complete run: %w", err)
		}
		run.Status = "completed"
		if run.TicketID != nil {
			_, _ = s.db.Exec(ctx,
				`UPDATE tickets SET status = 'approved' WHERE id = $1`, *run.TicketID)
		}
		s.publishEvent("workflow.run_completed", map[string]any{
			"run_id":    run.ID,
			"ticket_id": run.TicketID,
		})
		return nil
	}

	// Update run
	_, err := s.db.Exec(ctx,
		`UPDATE workflow_runs SET current_stage_id = $1 WHERE id = $2`,
		nextStage.ID, run.ID)
	if err != nil {
		return fmt.Errorf("advance run: %w", err)
	}
	run.CurrentStageID = &nextStage.ID

	// Update ticket
	if run.TicketID != nil {
		_, _ = s.db.Exec(ctx,
			`UPDATE tickets SET current_stage_id = $1 WHERE id = $2`,
			nextStage.ID, *run.TicketID)
	}

	// Record entered
	s.recordHistory(ctx, run.ID, nextStage.ID, "entered", actorID, nil, nil)

	// Publish
	s.publishEvent("workflow.stage_entered", map[string]any{
		"run_id":     run.ID,
		"stage_id":   nextStage.ID,
		"stage_name": nextStage.Name,
		"stage_type": nextStage.StageType,
		"ticket_id":  run.TicketID,
	})

	// Handle terminal stage
	if nextStage.StageType == "terminal" {
		_, err := s.db.Exec(ctx,
			`UPDATE workflow_runs SET status = 'completed', completed_at = NOW() WHERE id = $1`, run.ID)
		if err != nil {
			return fmt.Errorf("complete run at terminal: %w", err)
		}
		run.Status = "completed"
		if run.TicketID != nil {
			_, _ = s.db.Exec(ctx,
				`UPDATE tickets SET status = 'approved' WHERE id = $1`, *run.TicketID)
		}
		s.publishEvent("workflow.run_completed", map[string]any{
			"run_id":    run.ID,
			"ticket_id": run.TicketID,
		})
	}

	return nil
}

func (s *Server) processAutoStage(ctx context.Context, run *WorkflowRun) {
	if run.CurrentStageID == nil || run.Status != "active" {
		return
	}

	stage, err := s.getStageByID(ctx, *run.CurrentStageID)
	if err != nil {
		return
	}

	switch stage.StageType {
	case "notification":
		// Auto-advance past notification stages
		s.publishEvent("workflow.notification", map[string]any{
			"run_id":     run.ID,
			"stage_name": stage.Name,
			"config":     stage.Config,
		})
		next, err := s.resolveNextStage(ctx, run.WorkflowID, stage.ID, "on_complete")
		if err != nil {
			s.logger.Warn("resolve next after notification failed", "error", err)
			return
		}
		if err := s.advanceToStage(ctx, run, next, nil); err != nil {
			s.logger.Warn("advance after notification failed", "error", err)
			return
		}
		s.processAutoStage(ctx, run)

	case "condition":
		expr, _ := stage.Config["expression"].(string)
		if expr == "" {
			return
		}
		result := evaluateExpression(expr, run.Context)
		trigger := "on_condition_false"
		if result {
			trigger = "on_condition_true"
		}
		next, err := s.resolveNextStage(ctx, run.WorkflowID, stage.ID, trigger)
		if err != nil {
			s.logger.Warn("resolve condition stage failed", "error", err)
			return
		}
		if err := s.advanceToStage(ctx, run, next, nil); err != nil {
			s.logger.Warn("advance after condition failed", "error", err)
			return
		}
		s.processAutoStage(ctx, run)

	case "approval":
		// Check auto-approve conditions
		if s.checkAutoApprove(stage, run.Context) {
			s.recordHistory(ctx, run.ID, stage.ID, "auto_approved", nil, strPtr("Auto-approved by condition"), nil)
			next, err := s.resolveNextStage(ctx, run.WorkflowID, stage.ID, "on_approve")
			if err != nil {
				s.logger.Warn("resolve next after auto-approve failed", "error", err)
				return
			}
			s.publishEvent("workflow.approved", map[string]any{
				"run_id":     run.ID,
				"stage_name": stage.Name,
				"auto":       true,
				"ticket_id":  run.TicketID,
			})
			if err := s.advanceToStage(ctx, run, next, nil); err != nil {
				s.logger.Warn("advance after auto-approve failed", "error", err)
				return
			}
			s.processAutoStage(ctx, run)
		}

	case "terminal":
		// Already handled in advanceToStage
	}
}

func strPtr(s string) *string { return &s }

func (s *Server) checkAutoApprove(stage *WorkflowStage, runCtx map[string]any) bool {
	raw, ok := stage.Config["auto_approve_conditions"]
	if !ok {
		return false
	}
	conditions, ok := raw.(map[string]any)
	if !ok {
		return false
	}

	for field, rule := range conditions {
		ruleMap, ok := rule.(map[string]any)
		if !ok {
			continue
		}
		val, exists := runCtx[field]
		if !exists {
			return false
		}
		valNum, ok := toFloat64(val)
		if !ok {
			return false
		}
		for op, threshold := range ruleMap {
			threshNum, ok := toFloat64(threshold)
			if !ok {
				continue
			}
			switch op {
			case "lte":
				if valNum > threshNum {
					return false
				}
			case "gte":
				if valNum < threshNum {
					return false
				}
			case "lt":
				if valNum >= threshNum {
					return false
				}
			case "gt":
				if valNum <= threshNum {
					return false
				}
			case "eq":
				if valNum != threshNum {
					return false
				}
			}
		}
	}
	return true
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}

// ---------------------------------------------------------------------------
// Expression Evaluator (simple recursive descent)
// ---------------------------------------------------------------------------

type exprParser struct {
	tokens []string
	pos    int
	ctx    map[string]any
}

func evaluateExpression(expr string, ctx map[string]any) bool {
	tokens := tokenize(expr)
	if len(tokens) == 0 {
		return false
	}
	p := &exprParser{tokens: tokens, pos: 0, ctx: ctx}
	result := p.parseOr()
	return result
}

func tokenize(expr string) []string {
	var tokens []string
	i := 0
	for i < len(expr) {
		ch := rune(expr[i])
		if unicode.IsSpace(ch) {
			i++
			continue
		}
		// Two-char operators
		if i+1 < len(expr) {
			two := expr[i : i+2]
			switch two {
			case "&&", "||", ">=", "<=", "==", "!=":
				tokens = append(tokens, two)
				i += 2
				continue
			}
		}
		// Single-char operators/parens
		switch ch {
		case '(', ')', '>', '<', '!':
			tokens = append(tokens, string(ch))
			i++
			continue
		}
		// Quoted string
		if ch == '\'' || ch == '"' {
			quote := ch
			j := i + 1
			for j < len(expr) && rune(expr[j]) != quote {
				j++
			}
			tokens = append(tokens, expr[i:j+1])
			i = j + 1
			continue
		}
		// Number or identifier
		j := i
		for j < len(expr) && !unicode.IsSpace(rune(expr[j])) &&
			expr[j] != '(' && expr[j] != ')' && expr[j] != '>' && expr[j] != '<' &&
			expr[j] != '=' && expr[j] != '!' && expr[j] != '&' && expr[j] != '|' {
			j++
		}
		tokens = append(tokens, expr[i:j])
		i = j
	}
	return tokens
}

func (p *exprParser) peek() string {
	if p.pos >= len(p.tokens) {
		return ""
	}
	return p.tokens[p.pos]
}

func (p *exprParser) next() string {
	tok := p.peek()
	p.pos++
	return tok
}

func (p *exprParser) parseOr() bool {
	left := p.parseAnd()
	for p.peek() == "||" {
		p.next()
		right := p.parseAnd()
		left = left || right
	}
	return left
}

func (p *exprParser) parseAnd() bool {
	left := p.parseNot()
	for p.peek() == "&&" {
		p.next()
		right := p.parseNot()
		left = left && right
	}
	return left
}

func (p *exprParser) parseNot() bool {
	if p.peek() == "!" {
		p.next()
		return !p.parseNot()
	}
	return p.parseComparison()
}

func (p *exprParser) parseComparison() bool {
	if p.peek() == "(" {
		p.next()
		result := p.parseOr()
		if p.peek() == ")" {
			p.next()
		}
		return result
	}

	left := p.parseValue()
	op := p.peek()
	switch op {
	case ">", "<", ">=", "<=", "==", "!=":
		p.next()
		right := p.parseValue()
		return compareValues(left, op, right)
	}

	// Truthy check
	return isTruthy(left)
}

func (p *exprParser) parseValue() any {
	tok := p.next()
	if tok == "" {
		return nil
	}
	// Boolean literals
	if tok == "true" {
		return true
	}
	if tok == "false" {
		return false
	}
	// Quoted string
	if (strings.HasPrefix(tok, "'") && strings.HasSuffix(tok, "'")) ||
		(strings.HasPrefix(tok, "\"") && strings.HasSuffix(tok, "\"")) {
		return tok[1 : len(tok)-1]
	}
	// Number
	if f, err := strconv.ParseFloat(tok, 64); err == nil {
		return f
	}
	// Context field lookup
	if val, ok := p.ctx[tok]; ok {
		return val
	}
	return tok
}

func compareValues(left any, op string, right any) bool {
	lf, lok := toFloat64(left)
	rf, rok := toFloat64(right)
	if lok && rok {
		switch op {
		case ">":
			return lf > rf
		case "<":
			return lf < rf
		case ">=":
			return lf >= rf
		case "<=":
			return lf <= rf
		case "==":
			return math.Abs(lf-rf) < 0.0001
		case "!=":
			return math.Abs(lf-rf) >= 0.0001
		}
	}
	// String comparison
	ls := fmt.Sprintf("%v", left)
	rs := fmt.Sprintf("%v", right)
	switch op {
	case "==":
		return ls == rs
	case "!=":
		return ls != rs
	case ">":
		return ls > rs
	case "<":
		return ls < rs
	case ">=":
		return ls >= rs
	case "<=":
		return ls <= rs
	}
	return false
}

func isTruthy(v any) bool {
	if v == nil {
		return false
	}
	switch val := v.(type) {
	case bool:
		return val
	case float64:
		return val != 0
	case string:
		return val != "" && val != "false" && val != "0"
	}
	return true
}

// ---------------------------------------------------------------------------
// Handlers — Operations (existing)
// ---------------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
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

	var currentStatus string
	var workflowID *string
	var opName string
	var riskLevel int
	err := s.db.QueryRow(r.Context(),
		"SELECT status, workflow_id, name, risk_level FROM operations WHERE id = $1", id).
		Scan(&currentStatus, &workflowID, &opName, &riskLevel)
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

	_, err = s.db.Exec(r.Context(),
		"UPDATE operations SET status = $1, updated_at = NOW() WHERE id = $2",
		req.Status, id)
	if err != nil {
		s.logger.Error("transition operation failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update operation status")
		return
	}

	// If transitioning to pending_approval, start a workflow run
	if req.Status == "pending_approval" {
		wfID := ""
		if workflowID != nil {
			wfID = *workflowID
		} else {
			wfID, _ = s.getDefaultWorkflowID(r.Context())
		}
		if wfID != "" {
			runCtx := map[string]any{
				"risk_level":     riskLevel,
				"operation_id":   id,
				"operation_name": opName,
			}
			run, err := s.startWorkflowRunInternal(r.Context(), wfID, nil, runCtx)
			if err != nil {
				s.logger.Warn("failed to start workflow run for operation", "error", err, "operation_id", id)
			} else {
				// Store run ID in operation metadata
				_, _ = s.db.Exec(r.Context(),
					`UPDATE operations SET metadata = metadata || $1 WHERE id = $2`,
					fmt.Sprintf(`{"workflow_run_id":"%s"}`, run.ID), id)
			}
		}
	}

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
// Handlers — Workflow Definition CRUD
// ---------------------------------------------------------------------------

func (s *Server) handleListWorkflows(w http.ResponseWriter, r *http.Request) {
	page, limit, offset := parsePagination(r)
	isTemplate := r.URL.Query().Get("is_template")
	isDefault := r.URL.Query().Get("is_default")

	conditions := []string{}
	args := []any{}
	argIdx := 1

	if isTemplate == "true" || isTemplate == "false" {
		conditions = append(conditions, fmt.Sprintf("is_template = $%d", argIdx))
		args = append(args, isTemplate == "true")
		argIdx++
	}
	if isDefault == "true" || isDefault == "false" {
		conditions = append(conditions, fmt.Sprintf("is_default = $%d", argIdx))
		args = append(args, isDefault == "true")
		argIdx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	// Count
	var total int
	countQ := fmt.Sprintf("SELECT count(*) FROM workflows %s", where)
	if err := s.db.QueryRow(r.Context(), countQ, args...).Scan(&total); err != nil {
		total = 0
	}

	// Query
	args = append(args, limit, offset)
	dataQ := fmt.Sprintf(
		`SELECT id, name, description, version, is_template, is_default, created_by, created_at, updated_at
		 FROM workflows %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`,
		where, argIdx, argIdx+1)

	rows, err := s.db.Query(r.Context(), dataQ, args...)
	if err != nil {
		s.logger.Error("list workflows query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to list workflows")
		return
	}
	defer rows.Close()

	var workflows []Workflow
	for rows.Next() {
		wf, err := scanWorkflowRow(rows)
		if err != nil {
			s.logger.Error("scan workflow failed", "error", err)
			continue
		}
		// Fetch stage count for list view
		var stageCount int
		_ = s.db.QueryRow(r.Context(), "SELECT count(*) FROM workflow_stages WHERE workflow_id = $1", wf.ID).Scan(&stageCount)
		wf.Stages = make([]WorkflowStage, stageCount)
		workflows = append(workflows, wf)
	}
	if workflows == nil {
		workflows = []Workflow{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": workflows,
		"pagination": map[string]int{
			"page":  page,
			"limit": limit,
			"total": total,
		},
	})
}

func (s *Server) handleGetWorkflow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	wf, err := s.fetchWorkflowFull(r.Context(), id)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Workflow not found")
			return
		}
		s.logger.Error("get workflow failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get workflow")
		return
	}

	writeJSON(w, http.StatusOK, wf)
}

func (s *Server) handleCreateWorkflow(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "X-User-ID header required")
		return
	}

	var req CreateWorkflowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")
		return
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	// If setting as default, clear existing default
	if req.IsDefault {
		_, _ = tx.Exec(ctx, "UPDATE workflows SET is_default = false WHERE is_default = true")
	}

	var wfID string
	err = tx.QueryRow(ctx,
		`INSERT INTO workflows (name, description, is_template, is_default, created_by)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		req.Name, req.Description, req.IsTemplate, req.IsDefault, userID).Scan(&wfID)
	if err != nil {
		s.logger.Error("create workflow failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create workflow")
		return
	}

	// Insert stages
	stageMap := map[int]string{} // stage_order -> UUID
	for _, st := range req.Stages {
		var stageID string
		configBytes, _ := json.Marshal(st.Config)
		err = tx.QueryRow(ctx,
			`INSERT INTO workflow_stages (workflow_id, name, stage_order, stage_type, config)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			wfID, st.Name, st.StageOrder, st.StageType, configBytes).Scan(&stageID)
		if err != nil {
			s.logger.Error("create stage failed", "error", err, "stage", st.Name)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", fmt.Sprintf("Failed to create stage: %s", st.Name))
			return
		}
		stageMap[st.StageOrder] = stageID
	}

	// Insert transitions (resolve stage_order to UUID)
	for _, tr := range req.Transitions {
		fromID, ok := stageMap[tr.FromStageOrder]
		if !ok {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
				fmt.Sprintf("from_stage_order %d not found", tr.FromStageOrder))
			return
		}
		toID, ok := stageMap[tr.ToStageOrder]
		if !ok {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
				fmt.Sprintf("to_stage_order %d not found", tr.ToStageOrder))
			return
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO workflow_transitions (workflow_id, from_stage_id, to_stage_id, trigger, condition_expr, label)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			wfID, fromID, toID, tr.Trigger, tr.ConditionExpr, tr.Label)
		if err != nil {
			s.logger.Error("create transition failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create transition")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to commit")
		return
	}

	wf, err := s.fetchWorkflowFull(ctx, wfID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch created workflow")
		return
	}

	s.publishEvent("workflow.created", wf)
	writeJSON(w, http.StatusCreated, wf)
}

func (s *Server) handleUpdateWorkflow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req UpdateWorkflowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}

	ctx := r.Context()

	// Check for active runs
	var activeCount int
	_ = s.db.QueryRow(ctx,
		`SELECT count(*) FROM workflow_runs WHERE workflow_id = $1 AND status = 'active'`, id).Scan(&activeCount)
	if activeCount > 0 && (req.Stages != nil || req.Transitions != nil) {
		writeError(w, http.StatusConflict, "ACTIVE_RUNS",
			fmt.Sprintf("Cannot modify stages/transitions: %d active runs", activeCount))
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	// Update workflow fields
	if req.Name != nil {
		_, _ = tx.Exec(ctx, "UPDATE workflows SET name = $1 WHERE id = $2", *req.Name, id)
	}
	if req.Description != nil {
		_, _ = tx.Exec(ctx, "UPDATE workflows SET description = $1 WHERE id = $2", *req.Description, id)
	}
	if req.IsTemplate != nil {
		_, _ = tx.Exec(ctx, "UPDATE workflows SET is_template = $1 WHERE id = $2", *req.IsTemplate, id)
	}
	if req.IsDefault != nil {
		if *req.IsDefault {
			_, _ = tx.Exec(ctx, "UPDATE workflows SET is_default = false WHERE is_default = true AND id != $1", id)
		}
		_, _ = tx.Exec(ctx, "UPDATE workflows SET is_default = $1 WHERE id = $2", *req.IsDefault, id)
	}

	// Bump version
	_, _ = tx.Exec(ctx, "UPDATE workflows SET version = version + 1 WHERE id = $1", id)

	// Replace stages and transitions if provided
	if req.Stages != nil {
		_, _ = tx.Exec(ctx, "DELETE FROM workflow_transitions WHERE workflow_id = $1", id)
		_, _ = tx.Exec(ctx, "DELETE FROM workflow_stages WHERE workflow_id = $1", id)

		stageMap := map[int]string{}
		for _, st := range req.Stages {
			var stageID string
			configBytes, _ := json.Marshal(st.Config)
			err = tx.QueryRow(ctx,
				`INSERT INTO workflow_stages (workflow_id, name, stage_order, stage_type, config)
				 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
				id, st.Name, st.StageOrder, st.StageType, configBytes).Scan(&stageID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "DB_ERROR", fmt.Sprintf("Failed to create stage: %s", st.Name))
				return
			}
			stageMap[st.StageOrder] = stageID
		}

		if req.Transitions != nil {
			for _, tr := range req.Transitions {
				fromID := stageMap[tr.FromStageOrder]
				toID := stageMap[tr.ToStageOrder]
				if fromID == "" || toID == "" {
					continue
				}
				_, _ = tx.Exec(ctx,
					`INSERT INTO workflow_transitions (workflow_id, from_stage_id, to_stage_id, trigger, condition_expr, label)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					id, fromID, toID, tr.Trigger, tr.ConditionExpr, tr.Label)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to commit")
		return
	}

	wf, err := s.fetchWorkflowFull(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated workflow")
		return
	}

	s.publishEvent("workflow.updated", wf)
	writeJSON(w, http.StatusOK, wf)
}

func (s *Server) handleDeleteWorkflow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var activeCount int
	_ = s.db.QueryRow(r.Context(),
		`SELECT count(*) FROM workflow_runs WHERE workflow_id = $1 AND status = 'active'`, id).Scan(&activeCount)
	if activeCount > 0 {
		writeError(w, http.StatusConflict, "ACTIVE_RUNS",
			fmt.Sprintf("Cannot delete workflow: %d active runs", activeCount))
		return
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	// Clear ticket references to stages/runs belonging to this workflow
	_, _ = tx.Exec(ctx,
		`UPDATE tickets SET workflow_run_id = NULL, current_stage_id = NULL
		 WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = $1)`, id)

	// Delete run history, then runs (no CASCADE on workflow_runs -> workflows)
	_, _ = tx.Exec(ctx,
		`DELETE FROM workflow_run_history WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = $1)`, id)
	_, _ = tx.Exec(ctx,
		`DELETE FROM workflow_runs WHERE workflow_id = $1`, id)

	// Now delete the workflow (stages and transitions CASCADE)
	result, err := tx.Exec(ctx, "DELETE FROM workflows WHERE id = $1", id)
	if err != nil {
		s.logger.Error("delete workflow failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to delete workflow")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Workflow not found")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("commit delete workflow failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to commit delete")
		return
	}

	s.publishEvent("workflow.deleted", map[string]any{"workflow_id": id})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCloneWorkflow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}
	userID := getUserID(r)

	ctx := r.Context()
	orig, err := s.fetchWorkflowFull(ctx, id)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Workflow not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch workflow")
		return
	}

	// Create the clone request
	cloneReq := CreateWorkflowRequest{
		Name:        orig.Name + " (Copy)",
		Description: orig.Description,
		IsTemplate:  orig.IsTemplate,
		IsDefault:   false,
	}

	// Map stages
	for _, st := range orig.Stages {
		cloneReq.Stages = append(cloneReq.Stages, CreateStageRequest{
			Name:       st.Name,
			StageOrder: st.StageOrder,
			StageType:  st.StageType,
			Config:     st.Config,
		})
	}

	// Build reverse map: original stage ID -> stage_order
	stageIDToOrder := map[string]int{}
	for _, st := range orig.Stages {
		stageIDToOrder[st.ID] = st.StageOrder
	}

	// Map transitions
	for _, tr := range orig.Transitions {
		cloneReq.Transitions = append(cloneReq.Transitions, CreateTransitionRequest{
			FromStageOrder: stageIDToOrder[tr.FromStageID],
			ToStageOrder:   stageIDToOrder[tr.ToStageID],
			Trigger:        tr.Trigger,
			ConditionExpr:  tr.ConditionExpr,
			Label:          tr.Label,
		})
	}

	// Use existing create logic via transaction
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx)

	var wfID string
	err = tx.QueryRow(ctx,
		`INSERT INTO workflows (name, description, is_template, is_default, created_by)
		 VALUES ($1, $2, $3, false, $4) RETURNING id`,
		cloneReq.Name, cloneReq.Description, cloneReq.IsTemplate, userID).Scan(&wfID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create cloned workflow")
		return
	}

	stageMap := map[int]string{}
	for _, st := range cloneReq.Stages {
		var stageID string
		configBytes, _ := json.Marshal(st.Config)
		err = tx.QueryRow(ctx,
			`INSERT INTO workflow_stages (workflow_id, name, stage_order, stage_type, config)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			wfID, st.Name, st.StageOrder, st.StageType, configBytes).Scan(&stageID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to clone stage")
			return
		}
		stageMap[st.StageOrder] = stageID
	}

	for _, tr := range cloneReq.Transitions {
		fromID := stageMap[tr.FromStageOrder]
		toID := stageMap[tr.ToStageOrder]
		if fromID == "" || toID == "" {
			continue
		}
		_, _ = tx.Exec(ctx,
			`INSERT INTO workflow_transitions (workflow_id, from_stage_id, to_stage_id, trigger, condition_expr, label)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			wfID, fromID, toID, tr.Trigger, tr.ConditionExpr, tr.Label)
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to commit clone")
		return
	}

	wf, err := s.fetchWorkflowFull(ctx, wfID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch cloned workflow")
		return
	}

	writeJSON(w, http.StatusCreated, wf)
}

// ---------------------------------------------------------------------------
// Handlers — Workflow Runs
// ---------------------------------------------------------------------------

func (s *Server) handleStartRun(w http.ResponseWriter, r *http.Request) {
	var req StartRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.WorkflowID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "workflow_id is required")
		return
	}
	if req.Context == nil {
		req.Context = map[string]any{}
	}

	run, err := s.startWorkflowRunInternal(r.Context(), req.WorkflowID, req.TicketID, req.Context)
	if err != nil {
		s.logger.Error("start run failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to start workflow run")
		return
	}

	writeJSON(w, http.StatusCreated, run)
}

func (s *Server) handleListRuns(w http.ResponseWriter, r *http.Request) {
	page, limit, offset := parsePagination(r)
	workflowID := r.URL.Query().Get("workflow_id")
	ticketID := r.URL.Query().Get("ticket_id")
	status := r.URL.Query().Get("status")

	conditions := []string{}
	args := []any{}
	argIdx := 1

	if workflowID != "" {
		conditions = append(conditions, fmt.Sprintf("wr.workflow_id = $%d", argIdx))
		args = append(args, workflowID)
		argIdx++
	}
	if ticketID != "" {
		conditions = append(conditions, fmt.Sprintf("wr.ticket_id = $%d", argIdx))
		args = append(args, ticketID)
		argIdx++
	}
	if status != "" {
		conditions = append(conditions, fmt.Sprintf("wr.status = $%d", argIdx))
		args = append(args, status)
		argIdx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}

	var total int
	_ = s.db.QueryRow(r.Context(), fmt.Sprintf("SELECT count(*) FROM workflow_runs wr %s", where), args...).Scan(&total)

	args = append(args, limit, offset)
	q := fmt.Sprintf(
		`SELECT wr.id, wr.workflow_id, wr.ticket_id, wr.current_stage_id, wr.status, wr.context, wr.started_at, wr.completed_at
		 FROM workflow_runs wr %s ORDER BY wr.started_at DESC LIMIT $%d OFFSET $%d`,
		where, argIdx, argIdx+1)

	rows, err := s.db.Query(r.Context(), q, args...)
	if err != nil {
		s.logger.Error("list runs failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to list runs")
		return
	}
	defer rows.Close()

	var runs []WorkflowRun
	for rows.Next() {
		run, err := scanRunRow(rows)
		if err != nil {
			s.logger.Error("scan run failed", "error", err)
			continue
		}
		// Fetch current stage details
		if run.CurrentStageID != nil {
			st, err := s.getStageByID(r.Context(), *run.CurrentStageID)
			if err == nil {
				run.CurrentStage = st
			}
		}
		// Fetch workflow name
		_ = s.db.QueryRow(r.Context(), "SELECT name FROM workflows WHERE id = $1", run.WorkflowID).Scan(&run.WorkflowName)
		runs = append(runs, run)
	}
	if runs == nil {
		runs = []WorkflowRun{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": runs,
		"pagination": map[string]int{
			"page":  page,
			"limit": limit,
			"total": total,
		},
	})
}

func (s *Server) handleGetRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	row := s.db.QueryRow(r.Context(),
		`SELECT id, workflow_id, ticket_id, current_stage_id, status, context, started_at, completed_at
		 FROM workflow_runs WHERE id = $1`, id)
	run, err := scanRunRow(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Workflow run not found")
			return
		}
		s.logger.Error("get run failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get run")
		return
	}

	// Current stage
	if run.CurrentStageID != nil {
		st, err := s.getStageByID(r.Context(), *run.CurrentStageID)
		if err == nil {
			run.CurrentStage = st
		}
	}

	// Workflow name
	_ = s.db.QueryRow(r.Context(), "SELECT name FROM workflows WHERE id = $1", run.WorkflowID).Scan(&run.WorkflowName)

	// History
	histRows, err := s.db.Query(r.Context(),
		`SELECT h.id, h.run_id, h.stage_id, COALESCE(ws.name, ''), h.action, h.actor_id, h.comment, h.metadata, h.occurred_at
		 FROM workflow_run_history h
		 LEFT JOIN workflow_stages ws ON ws.id = h.stage_id
		 WHERE h.run_id = $1 ORDER BY h.occurred_at DESC`, id)
	if err == nil {
		defer histRows.Close()
		for histRows.Next() {
			h, err := scanHistoryRow(histRows)
			if err == nil {
				run.History = append(run.History, h)
			}
		}
	}
	if run.History == nil {
		run.History = []WorkflowRunHistory{}
	}

	writeJSON(w, http.StatusOK, run)
}

func (s *Server) handleRunAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req RunActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.Action == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "action is required")
		return
	}

	userID := getUserID(r)
	roles := getUserRoles(r)

	ctx := r.Context()

	// Fetch run
	row := s.db.QueryRow(ctx,
		`SELECT id, workflow_id, ticket_id, current_stage_id, status, context, started_at, completed_at
		 FROM workflow_runs WHERE id = $1`, id)
	run, err := scanRunRow(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Workflow run not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get run")
		return
	}

	if run.Status != "active" {
		writeError(w, http.StatusBadRequest, "INVALID_STATE", "Run is not active")
		return
	}

	if run.CurrentStageID == nil {
		writeError(w, http.StatusBadRequest, "INVALID_STATE", "Run has no current stage")
		return
	}

	// Fetch current stage
	stage, err := s.getStageByID(ctx, *run.CurrentStageID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get current stage")
		return
	}

	// Validate action for stage type
	validActions := map[string][]string{
		"approval": {"approve", "reject", "kickback"},
		"action":   {"complete"},
		"timer":    {"complete", "timeout"},
	}
	allowed, ok := validActions[stage.StageType]
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_ACTION",
			fmt.Sprintf("Stage type '%s' does not support actions", stage.StageType))
		return
	}
	actionValid := false
	for _, a := range allowed {
		if a == req.Action {
			actionValid = true
			break
		}
	}
	if !actionValid {
		writeError(w, http.StatusBadRequest, "INVALID_ACTION",
			fmt.Sprintf("Action '%s' not valid for stage type '%s'", req.Action, stage.StageType))
		return
	}

	// Validate user role
	requiredRole, _ := stage.Config["required_role"].(string)
	if requiredRole != "" && !hasRole(roles, requiredRole) {
		writeError(w, http.StatusForbidden, "INSUFFICIENT_ROLE",
			fmt.Sprintf("Requires role '%s'", requiredRole))
		return
	}

	// Record the action
	var comment *string
	if req.Comment != "" {
		comment = &req.Comment
	}
	s.recordHistory(ctx, run.ID, stage.ID, req.Action, &userID, comment, nil)

	// Determine trigger and advance
	var trigger string
	switch req.Action {
	case "approve":
		trigger = "on_approve"
		s.publishEvent("workflow.approved", map[string]any{
			"run_id":     run.ID,
			"stage_name": stage.Name,
			"actor_id":   userID,
			"ticket_id":  run.TicketID,
		})
	case "reject":
		trigger = "on_reject"
		s.publishEvent("workflow.rejected", map[string]any{
			"run_id":     run.ID,
			"stage_name": stage.Name,
			"actor_id":   userID,
			"ticket_id":  run.TicketID,
		})
	case "kickback":
		trigger = "on_kickback"
		s.publishEvent("workflow.kickback", map[string]any{
			"run_id":     run.ID,
			"stage_name": stage.Name,
			"actor_id":   userID,
			"ticket_id":  run.TicketID,
		})
	case "complete":
		trigger = "on_complete"
	case "timeout":
		trigger = "on_timeout"
	}

	// If a specific target stage is given for kickback/reject
	var nextStage *WorkflowStage
	if req.TargetStageID != nil && (req.Action == "reject" || req.Action == "kickback") {
		nextStage, err = s.getStageByID(ctx, *req.TargetStageID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_TARGET", "Target stage not found")
			return
		}
	} else {
		nextStage, err = s.resolveNextStage(ctx, run.WorkflowID, stage.ID, trigger)
		if err != nil {
			s.logger.Warn("resolve next stage failed", "error", err)
		}
	}

	if err := s.advanceToStage(ctx, &run, nextStage, &userID); err != nil {
		s.logger.Error("advance failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to advance run")
		return
	}

	// Process auto stages at new position
	s.processAutoStage(ctx, &run)

	// If kickback to an action stage, reset ticket status to draft
	if (req.Action == "reject" || req.Action == "kickback") && nextStage != nil && nextStage.StageType == "action" {
		if run.TicketID != nil {
			_, _ = s.db.Exec(ctx, `UPDATE tickets SET status = 'draft' WHERE id = $1`, *run.TicketID)
		}
	}

	// Return updated run
	updatedRow := s.db.QueryRow(ctx,
		`SELECT id, workflow_id, ticket_id, current_stage_id, status, context, started_at, completed_at
		 FROM workflow_runs WHERE id = $1`, id)
	updatedRun, err := scanRunRow(updatedRow)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated run")
		return
	}
	if updatedRun.CurrentStageID != nil {
		st, _ := s.getStageByID(ctx, *updatedRun.CurrentStageID)
		updatedRun.CurrentStage = st
	}
	_ = s.db.QueryRow(ctx, "SELECT name FROM workflows WHERE id = $1", updatedRun.WorkflowID).Scan(&updatedRun.WorkflowName)

	writeJSON(w, http.StatusOK, updatedRun)
}

func (s *Server) handleAbortRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	userID := getUserID(r)

	result, err := s.db.Exec(r.Context(),
		`UPDATE workflow_runs SET status = 'aborted', completed_at = NOW()
		 WHERE id = $1 AND status = 'active'`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to abort run")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Active run not found")
		return
	}

	// Get current stage for history
	var currentStageID *string
	_ = s.db.QueryRow(r.Context(), "SELECT current_stage_id FROM workflow_runs WHERE id = $1", id).Scan(&currentStageID)
	if currentStageID != nil {
		s.recordHistory(r.Context(), id, *currentStageID, "aborted", &userID, nil, nil)
	}

	s.publishEvent("workflow.run_aborted", map[string]any{"run_id": id, "actor_id": userID})
	writeJSON(w, http.StatusOK, map[string]string{"status": "aborted"})
}

func (s *Server) handleGetRunHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	rows, err := s.db.Query(r.Context(),
		`SELECT h.id, h.run_id, h.stage_id, COALESCE(ws.name, ''), h.action, h.actor_id, h.comment, h.metadata, h.occurred_at
		 FROM workflow_run_history h
		 LEFT JOIN workflow_stages ws ON ws.id = h.stage_id
		 WHERE h.run_id = $1 ORDER BY h.occurred_at DESC`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get history")
		return
	}
	defer rows.Close()

	var history []WorkflowRunHistory
	for rows.Next() {
		h, err := scanHistoryRow(rows)
		if err != nil {
			continue
		}
		history = append(history, h)
	}
	if history == nil {
		history = []WorkflowRunHistory{}
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": history})
}

func (s *Server) handleUpdateRunContext(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req UpdateRunContextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}

	contextBytes, _ := json.Marshal(req.Context)
	result, err := s.db.Exec(r.Context(),
		`UPDATE workflow_runs SET context = context || $1 WHERE id = $2 AND status = 'active'`,
		contextBytes, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update context")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Active run not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

// ---------------------------------------------------------------------------
// NATS subscription for ticket events
// ---------------------------------------------------------------------------

func (s *Server) subscribeTicketEvents() {
	if s.nc == nil {
		return
	}

	_, err := s.nc.Subscribe("ticket.status_changed", func(msg *nats.Msg) {
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(msg.Data, &envelope); err != nil {
			s.logger.Warn("failed to parse ticket event envelope", "error", err)
			return
		}

		var data struct {
			From        string `json:"from"`
			To          string `json:"to"`
			TicketID    string `json:"ticket_id"`
			OperationID string `json:"operation_id"`
		}
		if err := json.Unmarshal(envelope.Data, &data); err != nil {
			s.logger.Warn("failed to parse ticket status_changed data", "error", err)
			return
		}

		// Only handle submit transition
		if data.To != "submitted" {
			return
		}

		if data.TicketID == "" {
			// Try to extract from resource_id field
			var alt struct {
				ResourceID string `json:"resource_id"`
			}
			_ = json.Unmarshal(envelope.Data, &alt)
			data.TicketID = alt.ResourceID
		}

		if data.TicketID == "" {
			return
		}

		ctx := context.Background()

		// Check if ticket already has a workflow run
		var existingRunID *string
		_ = s.db.QueryRow(ctx, "SELECT workflow_run_id FROM tickets WHERE id = $1", data.TicketID).Scan(&existingRunID)
		if existingRunID != nil {
			return // Already has a run
		}

		// Determine workflow
		var workflowID string
		if data.OperationID != "" {
			var opWfID *string
			_ = s.db.QueryRow(ctx, "SELECT workflow_id FROM operations WHERE id = $1", data.OperationID).Scan(&opWfID)
			if opWfID != nil {
				workflowID = *opWfID
			}
		}
		if workflowID == "" {
			workflowID, _ = s.getDefaultWorkflowID(ctx)
		}
		if workflowID == "" {
			return
		}

		// Build context from ticket
		var riskLevel int
		var ticketType string
		_ = s.db.QueryRow(ctx,
			"SELECT COALESCE(t.priority, 'medium'), COALESCE(t.ticket_type, 'general') FROM tickets t WHERE t.id = $1",
			data.TicketID).Scan(&ticketType, &ticketType)
		// Get risk from operation if available
		if data.OperationID != "" {
			_ = s.db.QueryRow(ctx, "SELECT risk_level FROM operations WHERE id = $1", data.OperationID).Scan(&riskLevel)
		}

		runCtx := map[string]any{
			"ticket_id":    data.TicketID,
			"ticket_type":  ticketType,
			"operation_id": data.OperationID,
			"risk_level":   riskLevel,
		}

		run, err := s.startWorkflowRunInternal(ctx, workflowID, &data.TicketID, runCtx)
		if err != nil {
			s.logger.Warn("failed to start workflow run for ticket", "error", err, "ticket_id", data.TicketID)
			return
		}

		s.logger.Info("auto-started workflow run for ticket",
			"run_id", run.ID,
			"ticket_id", data.TicketID,
			"workflow_id", workflowID)
	})

	if err != nil {
		s.logger.Warn("failed to subscribe to ticket.status_changed", "error", err)
	} else {
		s.logger.Info("subscribed to ticket.status_changed")
	}
}

// ---------------------------------------------------------------------------
// Escalation ticker
// ---------------------------------------------------------------------------

func (s *Server) runEscalationTicker(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.checkEscalations(ctx)
		}
	}
}

func (s *Server) checkEscalations(ctx context.Context) {
	rows, err := s.db.Query(ctx, `
		SELECT wr.id, wr.workflow_id, wr.ticket_id, wr.current_stage_id, wr.status, wr.context, wr.started_at, wr.completed_at,
		       ws.config,
		       (SELECT MAX(occurred_at) FROM workflow_run_history WHERE run_id = wr.id AND stage_id = wr.current_stage_id AND action = 'entered') AS entered_at
		FROM workflow_runs wr
		JOIN workflow_stages ws ON ws.id = wr.current_stage_id
		WHERE wr.status = 'active'
		  AND ws.stage_type = 'approval'
		  AND ws.config->>'escalation_timeout_minutes' IS NOT NULL`)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var run WorkflowRun
		var contextData, configData []byte
		var startedAt time.Time
		var completedAt *time.Time
		var enteredAt *time.Time

		err := rows.Scan(&run.ID, &run.WorkflowID, &run.TicketID, &run.CurrentStageID,
			&run.Status, &contextData, &startedAt, &completedAt, &configData, &enteredAt)
		if err != nil {
			continue
		}
		run.Context = parseJSONB(contextData)
		run.StartedAt = startedAt.UTC().Format(time.RFC3339)
		config := parseJSONB(configData)

		if enteredAt == nil {
			continue
		}

		timeoutMinutes, ok := toFloat64(config["escalation_timeout_minutes"])
		if !ok || timeoutMinutes <= 0 {
			continue
		}

		deadline := enteredAt.Add(time.Duration(timeoutMinutes) * time.Minute)
		if time.Now().Before(deadline) {
			continue
		}

		// Stage has timed out — escalate
		s.logger.Info("escalating overdue stage", "run_id", run.ID, "stage_id", *run.CurrentStageID)
		s.recordHistory(ctx, run.ID, *run.CurrentStageID, "escalated", nil, strPtr("Auto-escalated due to timeout"), nil)

		s.publishEvent("workflow.escalated", map[string]any{
			"run_id":   run.ID,
			"stage_id": run.CurrentStageID,
		})

		// Try escalate trigger, fall back to on_timeout, fall back to on_approve
		next, err := s.resolveNextStage(ctx, run.WorkflowID, *run.CurrentStageID, "on_escalate")
		if err != nil || next == nil {
			next, err = s.resolveNextStage(ctx, run.WorkflowID, *run.CurrentStageID, "on_timeout")
		}
		if err != nil || next == nil {
			next, err = s.resolveNextStage(ctx, run.WorkflowID, *run.CurrentStageID, "on_approve")
		}
		if err == nil && next != nil {
			_ = s.advanceToStage(ctx, &run, next, nil)
			s.processAutoStage(ctx, &run)
		}
	}
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

func (s *Server) Start(ctx context.Context) {
	mux := http.NewServeMux()

	// Health
	mux.HandleFunc("GET /health", s.handleHealth)

	// Operations CRUD
	mux.HandleFunc("POST /api/v1/operations", s.handleCreateOperation)
	mux.HandleFunc("GET /api/v1/operations", s.handleListOperations)
	mux.HandleFunc("GET /api/v1/operations/{id}", s.handleGetOperation)
	mux.HandleFunc("PATCH /api/v1/operations/{id}", s.handleUpdateOperation)
	mux.HandleFunc("POST /api/v1/operations/{id}/transition", s.handleTransitionOperation)
	mux.HandleFunc("GET /api/v1/operations/{id}/members", s.handleListMembers)
	mux.HandleFunc("POST /api/v1/operations/{id}/members", s.handleAddMember)
	mux.HandleFunc("DELETE /api/v1/operations/{id}/members/{userId}", s.handleRemoveMember)

	// Workflow Definition CRUD
	mux.HandleFunc("POST /api/v1/workflows", s.handleCreateWorkflow)
	mux.HandleFunc("GET /api/v1/workflows", s.handleListWorkflows)
	mux.HandleFunc("GET /api/v1/workflows/{id}", s.handleGetWorkflow)
	mux.HandleFunc("PUT /api/v1/workflows/{id}", s.handleUpdateWorkflow)
	mux.HandleFunc("DELETE /api/v1/workflows/{id}", s.handleDeleteWorkflow)
	mux.HandleFunc("POST /api/v1/workflows/{id}/clone", s.handleCloneWorkflow)

	// Workflow Runs
	mux.HandleFunc("POST /api/v1/workflow-runs", s.handleStartRun)
	mux.HandleFunc("GET /api/v1/workflow-runs", s.handleListRuns)
	mux.HandleFunc("GET /api/v1/workflow-runs/{id}", s.handleGetRun)
	mux.HandleFunc("POST /api/v1/workflow-runs/{id}/action", s.handleRunAction)
	mux.HandleFunc("POST /api/v1/workflow-runs/{id}/abort", s.handleAbortRun)
	mux.HandleFunc("GET /api/v1/workflow-runs/{id}/history", s.handleGetRunHistory)
	mux.HandleFunc("PATCH /api/v1/workflow-runs/{id}/context", s.handleUpdateRunContext)

	// Subscribe to ticket events
	s.subscribeTicketEvents()

	// Start escalation ticker
	go s.runEscalationTicker(ctx)

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

	ctx, cancel := context.WithCancel(context.Background())

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		cancel()
		if nc != nil {
			nc.Close()
		}
		pool.Close()
		os.Exit(0)
	}()

	server.Start(ctx)
}
