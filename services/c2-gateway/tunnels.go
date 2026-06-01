// EMS-COP C2 Gateway — Tunnel Manager
// Persists tunnel state in Postgres, drives provider RPCs to create/close
// the underlying network paths, and streams throughput telemetry into
// ClickHouse. NATS pub/sub is used for cross-service notifications and
// audit fan-out.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// TunnelDB is the persisted shape of a tunnel as returned by the manager.
// It mirrors the c2_tunnels Postgres table.
type TunnelDB struct {
	ID             string         `json:"id"`
	OperationID    *string        `json:"operation_id,omitempty"`
	Provider       string         `json:"provider"`
	TunnelType     string         `json:"tunnel_type"`
	SrcSessionID   string         `json:"src_session_id"`
	SrcImplantName *string        `json:"src_implant_name,omitempty"`
	DstHost        *string        `json:"dst_host,omitempty"`
	DstPort        *int           `json:"dst_port,omitempty"`
	ListenHost     *string        `json:"listen_host,omitempty"`
	ListenPort     *int           `json:"listen_port,omitempty"`
	ParentTunnelID *string        `json:"parent_tunnel_id,omitempty"`
	Status         string         `json:"status"`
	Classification string         `json:"classification"`
	ErrorMessage   *string        `json:"error_message,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	CreatedBy      *string        `json:"created_by,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	ClosedAt       *time.Time     `json:"closed_at,omitempty"`
}

// ThroughputSample is one (bytes_in, bytes_out) measurement.
type ThroughputSample struct {
	Timestamp time.Time `json:"timestamp"`
	BytesIn   uint64    `json:"bytes_in"`
	BytesOut  uint64    `json:"bytes_out"`
}

// validTunnelTypes mirrors the Postgres CHECK constraint.
var validTunnelTypes = map[string]bool{
	"portfwd_local":  true,
	"portfwd_remote": true,
	"socks5":         true,
	"pivot_relay":    true,
}

// validClassifications matches what the audit subsystem expects.
var validTunnelClassifications = map[string]bool{
	"UNCLASSIFIED": true,
	"UNCLASS":      true,
	"CUI":          true,
	"SECRET":       true,
}

// TunnelManager owns tunnel lifecycle: persistence, provider dispatch,
// audit/event publication, and throughput recording.
type TunnelManager struct {
	db          *pgxpool.Pool
	nc          *nats.Conn
	registry    *ProviderRegistry
	logger      *slog.Logger
	chHTTP      string // optional ClickHouse HTTP endpoint (e.g. http://clickhouse:8123)
	chDatabase  string
	chUser      string
	chPassword  string
	httpClient  *http.Client
	subscribeMu sync.Mutex
	subscribed  map[string]bool // provider name → already subscribed
}

// NewTunnelManager wires the manager to its backends. db / nc / registry
// may be nil — the manager degrades gracefully in tests.
func NewTunnelManager(db *pgxpool.Pool, nc *nats.Conn, registry *ProviderRegistry, logger *slog.Logger) *TunnelManager {
	return &TunnelManager{
		db:         db,
		nc:         nc,
		registry:   registry,
		logger:     logger,
		httpClient: &http.Client{Timeout: 10 * time.Second},
		subscribed: make(map[string]bool),
	}
}

// WithClickHouse enables throughput logging. host should NOT include scheme.
// Pass "" to disable.
func (m *TunnelManager) WithClickHouse(httpURL, database, user, password string) *TunnelManager {
	m.chHTTP = strings.TrimRight(httpURL, "/")
	m.chDatabase = database
	if m.chDatabase == "" {
		m.chDatabase = "ems_audit"
	}
	m.chUser = user
	m.chPassword = password
	return m
}

// ── Validation ──────────────────────────────

func (m *TunnelManager) validateSpec(spec TunnelSpec) error {
	if spec.Provider == "" {
		return errors.New("provider is required")
	}
	if !validTunnelTypes[spec.Type] {
		return fmt.Errorf("invalid tunnel type %q (allowed: portfwd_local, portfwd_remote, socks5, pivot_relay)", spec.Type)
	}
	if spec.SrcSessionID == "" {
		return errors.New("src_session_id is required")
	}
	if spec.Classification != "" && !validTunnelClassifications[spec.Classification] {
		return fmt.Errorf("invalid classification %q", spec.Classification)
	}
	return nil
}

// ── Persistence helpers ─────────────────────

const tunnelSelectColumns = `id, operation_id, provider, tunnel_type, src_session_id, src_implant_name,
	dst_host, dst_port, listen_host, listen_port, parent_tunnel_id, status, classification,
	error_message, metadata, created_by, created_at, updated_at, closed_at`

// scanTunnel reads a single row in the tunnelSelectColumns order.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanTunnel(row rowScanner) (TunnelDB, error) {
	var t TunnelDB
	var metadataRaw []byte
	if err := row.Scan(
		&t.ID,
		&t.OperationID,
		&t.Provider,
		&t.TunnelType,
		&t.SrcSessionID,
		&t.SrcImplantName,
		&t.DstHost,
		&t.DstPort,
		&t.ListenHost,
		&t.ListenPort,
		&t.ParentTunnelID,
		&t.Status,
		&t.Classification,
		&t.ErrorMessage,
		&metadataRaw,
		&t.CreatedBy,
		&t.CreatedAt,
		&t.UpdatedAt,
		&t.ClosedAt,
	); err != nil {
		return TunnelDB{}, err
	}
	if len(metadataRaw) > 0 {
		_ = json.Unmarshal(metadataRaw, &t.Metadata)
	}
	return t, nil
}

// List returns tunnels matching the filter, ordered by created_at desc.
func (m *TunnelManager) List(ctx context.Context, filter TunnelFilter) ([]TunnelDB, error) {
	if m.db == nil {
		return nil, errors.New("database not configured")
	}

	q := `SELECT ` + tunnelSelectColumns + ` FROM c2_tunnels WHERE 1=1`
	args := []any{}
	idx := 1
	if filter.OperationID != "" {
		q += fmt.Sprintf(" AND operation_id = $%d", idx)
		args = append(args, filter.OperationID)
		idx++
	}
	if filter.Provider != "" {
		q += fmt.Sprintf(" AND provider = $%d", idx)
		args = append(args, filter.Provider)
		idx++
	}
	if filter.Type != "" {
		q += fmt.Sprintf(" AND tunnel_type = $%d", idx)
		args = append(args, filter.Type)
		idx++
	}
	if filter.Status != "" {
		q += fmt.Sprintf(" AND status = $%d", idx)
		args = append(args, filter.Status)
		idx++
	}
	if filter.SrcSessionID != "" {
		q += fmt.Sprintf(" AND src_session_id = $%d", idx)
		args = append(args, filter.SrcSessionID)
		idx++
	}
	q += ` ORDER BY created_at DESC LIMIT 500`

	rows, err := m.db.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query tunnels: %w", err)
	}
	defer rows.Close()

	out := make([]TunnelDB, 0)
	for rows.Next() {
		t, err := scanTunnel(rows)
		if err != nil {
			return nil, fmt.Errorf("scan tunnel: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns a single tunnel by ID.
func (m *TunnelManager) Get(ctx context.Context, id string) (TunnelDB, error) {
	if m.db == nil {
		return TunnelDB{}, errors.New("database not configured")
	}
	row := m.db.QueryRow(ctx, `SELECT `+tunnelSelectColumns+` FROM c2_tunnels WHERE id = $1`, id)
	return scanTunnel(row)
}

// Create inserts a pending tunnel row, calls the provider, and updates the
// row to active or error before returning. NATS audit event published on
// success.
func (m *TunnelManager) Create(ctx context.Context, spec TunnelSpec, actor string) (TunnelDB, error) {
	if err := m.validateSpec(spec); err != nil {
		return TunnelDB{}, err
	}
	if m.db == nil {
		return TunnelDB{}, errors.New("database not configured")
	}

	classification := spec.Classification
	if classification == "" {
		classification = "UNCLASSIFIED"
	}

	// 1) Insert pending row
	insertQ := `INSERT INTO c2_tunnels
		(operation_id, provider, tunnel_type, src_session_id, src_implant_name,
		 dst_host, dst_port, listen_host, listen_port, parent_tunnel_id,
		 status, classification, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12)
		RETURNING ` + tunnelSelectColumns

	var operationID any
	if spec.OperationID != "" {
		operationID = spec.OperationID
	}
	var parent any
	if spec.ParentTunnelID != "" {
		parent = spec.ParentTunnelID
	}
	srcImplant := nilIfEmpty(spec.SrcImplantName)
	dstHost := nilIfEmpty(spec.DstHost)
	listenHost := nilIfEmpty(spec.ListenHost)
	createdBy := nilIfEmpty(actor)

	row := m.db.QueryRow(ctx, insertQ,
		operationID, spec.Provider, spec.Type, spec.SrcSessionID, srcImplant,
		dstHost, nilIfZero(spec.DstPort), listenHost, nilIfZero(spec.ListenPort), parent,
		classification, createdBy,
	)
	t, err := scanTunnel(row)
	if err != nil {
		return TunnelDB{}, fmt.Errorf("insert tunnel: %w", err)
	}

	// 2) Dispatch to provider
	provider := m.resolveProvider(spec.Provider)
	if provider == nil {
		_ = m.markError(ctx, t.ID, "provider not registered")
		return t, fmt.Errorf("provider %q not registered", spec.Provider)
	}

	if _, perr := provider.CreateTunnel(ctx, spec); perr != nil {
		_ = m.markError(ctx, t.ID, perr.Error())
		t.Status = "error"
		errMsg := perr.Error()
		t.ErrorMessage = &errMsg
		// Still publish + return: caller knows about the error via err.
		m.publishEvent("c2.tunnels.create_failed", t)
		return t, fmt.Errorf("provider create_tunnel: %w", perr)
	}

	// 3) Mark active
	if updated, uerr := m.markStatus(ctx, t.ID, "active", nil); uerr == nil {
		t = updated
	}

	// 4) Audit + event fan-out
	m.publishEvent("c2.tunnels.created", t)
	m.publishAudit("c2.tunnel_created", actor, t)

	return t, nil
}

// Delete asks the provider to close the tunnel, then marks the row closed.
//
// The transition pending|active → closing is performed atomically with a
// conditional UPDATE so concurrent Delete callers do not double-fire the
// provider RPC or re-publish audit events. If another caller already moved
// the row to closing/closed, the loser short-circuits and returns the
// current row state without touching the provider.
func (m *TunnelManager) Delete(ctx context.Context, id string, actor string) (TunnelDB, error) {
	if m.db == nil {
		return TunnelDB{}, errors.New("database not configured")
	}

	t, err := m.Get(ctx, id)
	if err != nil {
		return TunnelDB{}, err
	}

	// Conditionally claim the close. CommandTag.RowsAffected() == 0 means
	// somebody else already closed (or is closing) this tunnel.
	tag, err := m.db.Exec(ctx,
		`UPDATE c2_tunnels SET status='closing', updated_at=NOW()
		 WHERE id = $1 AND status NOT IN ('closed', 'closing')`,
		id)
	if err != nil {
		return t, fmt.Errorf("claim tunnel close: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Idempotent: tunnel is already closing/closed. Return the current
		// row state and skip provider dispatch + republishing.
		current, gerr := m.Get(ctx, id)
		if gerr != nil {
			return t, nil
		}
		return current, nil
	}

	provider := m.resolveProvider(t.Provider)
	if provider != nil {
		if perr := provider.DeleteTunnel(ctx, id); perr != nil {
			m.logger.Warn("provider DeleteTunnel error (continuing to close DB row)", "id", id, "error", perr)
		}
	}

	closedAt := time.Now().UTC()
	updateQ := `UPDATE c2_tunnels SET status='closed', closed_at=$1, updated_at=NOW() WHERE id=$2 RETURNING ` + tunnelSelectColumns
	row := m.db.QueryRow(ctx, updateQ, closedAt, id)
	updated, err := scanTunnel(row)
	if err != nil {
		return t, fmt.Errorf("mark closed: %w", err)
	}

	m.publishEvent("c2.tunnels.deleted", updated)
	m.publishAudit("c2.tunnel_deleted", actor, updated)
	return updated, nil
}

// markStatus updates status and (optionally) error_message.
func (m *TunnelManager) markStatus(ctx context.Context, id, status string, errMsg *string) (TunnelDB, error) {
	q := `UPDATE c2_tunnels SET status=$1, error_message=$2, updated_at=NOW() WHERE id=$3 RETURNING ` + tunnelSelectColumns
	row := m.db.QueryRow(ctx, q, status, errMsg, id)
	return scanTunnel(row)
}

func (m *TunnelManager) markError(ctx context.Context, id, msg string) error {
	q := `UPDATE c2_tunnels SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2`
	_, err := m.db.Exec(ctx, q, msg, id)
	return err
}

func (m *TunnelManager) resolveProvider(name string) C2Provider {
	if m.registry == nil {
		return nil
	}
	return m.registry.Get(name)
}

// ── Throughput (ClickHouse) ─────────────────

// RecordThroughput writes a single (bytes_in, bytes_out) sample for a
// tunnel. Falls through silently if ClickHouse is not configured.
func (m *TunnelManager) RecordThroughput(ctx context.Context, tunnelID string, bytesIn, bytesOut uint64) error {
	if m.chHTTP == "" {
		return nil
	}

	t, err := m.Get(ctx, tunnelID)
	if err != nil {
		return fmt.Errorf("lookup tunnel: %w", err)
	}

	op := ""
	if t.OperationID != nil {
		op = *t.OperationID
	}

	// Use ClickHouse JSONEachRow insert via HTTP.
	body := map[string]any{
		"timestamp":      time.Now().UTC().Format("2006-01-02 15:04:05.000"),
		"tunnel_id":      tunnelID,
		"operation_id":   op,
		"provider":       t.Provider,
		"tunnel_type":    t.TunnelType,
		"bytes_in":       bytesIn,
		"bytes_out":      bytesOut,
		"classification": t.Classification,
	}
	bodyJSON, _ := json.Marshal(body)

	q := url.Values{}
	q.Set("query", fmt.Sprintf("INSERT INTO %s.c2_tunnel_throughput FORMAT JSONEachRow", m.chDatabase))
	if m.chDatabase != "" {
		q.Set("database", m.chDatabase)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.chHTTP+"/?"+q.Encode(),
		strings.NewReader(string(bodyJSON)))
	if err != nil {
		return fmt.Errorf("build clickhouse request: %w", err)
	}
	if m.chUser != "" {
		req.SetBasicAuth(m.chUser, m.chPassword)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("clickhouse insert: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("clickhouse insert returned %d", resp.StatusCode)
	}
	return nil
}

// QueryThroughput returns throughput samples for a tunnel between from..to.
// granularity is one of "raw", "minute", "hour" (default "raw").
func (m *TunnelManager) QueryThroughput(ctx context.Context, tunnelID string, from, to time.Time, granularity string) ([]ThroughputSample, error) {
	if m.chHTTP == "" {
		return nil, errors.New("clickhouse not configured")
	}

	if to.IsZero() {
		to = time.Now().UTC()
	}
	if from.IsZero() {
		from = to.Add(-1 * time.Hour)
	}

	var query string
	switch granularity {
	case "minute":
		query = fmt.Sprintf(`
			SELECT toStartOfMinute(timestamp) AS ts, sum(bytes_in) AS bin, sum(bytes_out) AS bout
			FROM %s.c2_tunnel_throughput
			WHERE tunnel_id = '%s' AND timestamp BETWEEN '%s' AND '%s'
			GROUP BY ts ORDER BY ts FORMAT JSONEachRow`,
			m.chDatabase, sanitizeID(tunnelID), from.UTC().Format("2006-01-02 15:04:05"), to.UTC().Format("2006-01-02 15:04:05"))
	case "hour":
		query = fmt.Sprintf(`
			SELECT toStartOfHour(timestamp) AS ts, sum(bytes_in) AS bin, sum(bytes_out) AS bout
			FROM %s.c2_tunnel_throughput
			WHERE tunnel_id = '%s' AND timestamp BETWEEN '%s' AND '%s'
			GROUP BY ts ORDER BY ts FORMAT JSONEachRow`,
			m.chDatabase, sanitizeID(tunnelID), from.UTC().Format("2006-01-02 15:04:05"), to.UTC().Format("2006-01-02 15:04:05"))
	default:
		query = fmt.Sprintf(`
			SELECT timestamp AS ts, bytes_in AS bin, bytes_out AS bout
			FROM %s.c2_tunnel_throughput
			WHERE tunnel_id = '%s' AND timestamp BETWEEN '%s' AND '%s'
			ORDER BY timestamp FORMAT JSONEachRow`,
			m.chDatabase, sanitizeID(tunnelID), from.UTC().Format("2006-01-02 15:04:05"), to.UTC().Format("2006-01-02 15:04:05"))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.chHTTP, strings.NewReader(query))
	if err != nil {
		return nil, fmt.Errorf("build clickhouse query: %w", err)
	}
	if m.chUser != "" {
		req.SetBasicAuth(m.chUser, m.chPassword)
	}

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("clickhouse query: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("clickhouse query returned %d", resp.StatusCode)
	}

	out := make([]ThroughputSample, 0)
	dec := json.NewDecoder(resp.Body)
	for dec.More() {
		var raw struct {
			TS   string `json:"ts"`
			Bin  uint64 `json:"bin"`
			Bout uint64 `json:"bout"`
		}
		if err := dec.Decode(&raw); err != nil {
			break
		}
		ts, _ := time.Parse("2006-01-02 15:04:05.000", raw.TS)
		if ts.IsZero() {
			ts, _ = time.Parse("2006-01-02 15:04:05", raw.TS)
		}
		out = append(out, ThroughputSample{Timestamp: ts, BytesIn: raw.Bin, BytesOut: raw.Bout})
	}
	return out, nil
}

// sanitizeID strips any single-quote / semicolon characters from a UUID
// before embedding into a ClickHouse query. UUIDs never legitimately
// contain those characters.
func sanitizeID(id string) string {
	return strings.NewReplacer("'", "", ";", "", "\\", "", "\n", "", "\r", "").Replace(id)
}

// ── Provider event subscription ─────────────

// StartSubscriptions launches a background goroutine for each enabled
// provider that consumes its TunnelEvent stream and re-publishes events
// to NATS. Safe to call multiple times — already-subscribed providers
// are skipped.
func (m *TunnelManager) StartSubscriptions(ctx context.Context) {
	if m.registry == nil {
		return
	}

	for _, st := range m.registry.List() {
		name := st.Name
		m.subscribeMu.Lock()
		if m.subscribed[name] {
			m.subscribeMu.Unlock()
			continue
		}
		m.subscribed[name] = true
		m.subscribeMu.Unlock()

		provider := m.registry.Get(name)
		if provider == nil {
			continue
		}

		go func(name string, p C2Provider) {
			ch, err := p.SubscribeTunnels(ctx, TunnelFilter{})
			if err != nil {
				m.logger.Warn("subscribe tunnels failed", "provider", name, "error", err)
				return
			}
			for ev := range ch {
				m.publishEvent("c2.tunnels.event", TunnelDB{
					ID:           ev.Tunnel.ID,
					Provider:     ev.Tunnel.Provider,
					TunnelType:   ev.Tunnel.Type,
					SrcSessionID: ev.Tunnel.SrcSessionID,
					Status:       ev.Tunnel.Status,
				})
			}
			m.logger.Info("provider tunnel subscription closed", "provider", name)
		}(name, provider)
	}
}

// ── NATS publishing ─────────────────────────

func (m *TunnelManager) publishEvent(subject string, t TunnelDB) {
	if m.nc == nil {
		return
	}
	payload, err := json.Marshal(t)
	if err != nil {
		m.logger.Warn("marshal tunnel event", "error", err)
		return
	}
	if err := m.nc.Publish(subject, payload); err != nil {
		m.logger.Warn("publish tunnel event", "subject", subject, "error", err)
	}
}

// publishAudit emits a compact audit record matching the schema used by
// publishAuditWithClassification in main.go.
func (m *TunnelManager) publishAudit(eventType, actor string, t TunnelDB) {
	if m.nc == nil {
		return
	}
	classification := t.Classification
	if classification == "" {
		classification = "UNCLASSIFIED"
	}
	details := map[string]any{
		"tunnel_id":      t.ID,
		"provider":       t.Provider,
		"tunnel_type":    t.TunnelType,
		"src_session_id": t.SrcSessionID,
		"dst_host":       t.DstHost,
		"dst_port":       t.DstPort,
		"listen_port":    t.ListenPort,
		"status":         t.Status,
	}
	detailsJSON, _ := json.Marshal(details)
	event := AuditEvent{
		EventType:      eventType,
		ActorID:        actor,
		ActorUsername:  actor,
		ResourceType:   "c2_tunnel",
		ResourceID:     t.ID,
		Action:         eventType,
		Details:        string(detailsJSON),
		Classification: classification,
		Timestamp:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	data, _ := json.Marshal(event)
	if err := m.nc.Publish(eventType, data); err != nil {
		m.logger.Warn("publish tunnel audit", "subject", eventType, "error", err)
	}
}

// ── Helpers ─────────────────────────────────

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nilIfZero(n int) any {
	if n == 0 {
		return nil
	}
	return n
}
