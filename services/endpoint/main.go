package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"net"
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
	db         *pgxpool.Pool
	nc         *nats.Conn
	port       string
	logger     *slog.Logger
	httpServer *http.Server
}

type Network struct {
	ID               string   `json:"id"`
	OperationID      string   `json:"operation_id"`
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	CIDRRanges       []string `json:"cidr_ranges"`
	ImportSource     *string  `json:"import_source"`
	Metadata         any      `json:"metadata"`
	CreatedBy        *string  `json:"created_by"`
	CreatedAt        string   `json:"created_at"`
	UpdatedAt        string   `json:"updated_at"`
	NodeCount        int      `json:"node_count"`
	CompromisedCount int      `json:"compromised_count"`
}

type NetworkNode struct {
	ID         string   `json:"id"`
	NetworkID  string   `json:"network_id"`
	EndpointID *string  `json:"endpoint_id"`
	IPAddress  string   `json:"ip_address"`
	Hostname   string   `json:"hostname"`
	MACAddress *string  `json:"mac_address"`
	OS         string   `json:"os"`
	OSVersion  string   `json:"os_version"`
	Status     string   `json:"status"`
	NodeType   string   `json:"node_type"`
	PositionX  *float64 `json:"position_x"`
	PositionY  *float64 `json:"position_y"`
	Services   any      `json:"services"`
	Metadata   any      `json:"metadata"`
	CreatedAt  string   `json:"created_at"`
	UpdatedAt  string   `json:"updated_at"`
}

type NetworkEdge struct {
	ID           string  `json:"id"`
	NetworkID    string  `json:"network_id"`
	SourceNodeID string  `json:"source_node_id"`
	TargetNodeID string  `json:"target_node_id"`
	EdgeType     string  `json:"edge_type"`
	Label        *string `json:"label"`
	Confidence   float64 `json:"confidence"`
	DiscoveredBy string  `json:"discovered_by"`
	Metadata     any     `json:"metadata"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}

type TopologyResponse struct {
	Network Network       `json:"network"`
	Nodes   []NetworkNode `json:"nodes"`
	Edges   []NetworkEdge `json:"edges"`
}

// Request types

type CreateNetworkRequest struct {
	OperationID string   `json:"operation_id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	CIDRRanges  []string `json:"cidr_ranges"`
	Metadata    any      `json:"metadata"`
}

type UpdateNetworkRequest struct {
	Name        *string  `json:"name"`
	Description *string  `json:"description"`
	CIDRRanges  *[]string `json:"cidr_ranges"`
	Metadata    any      `json:"metadata"`
}

type CreateNodeRequest struct {
	EndpointID *string  `json:"endpoint_id"`
	IPAddress  string   `json:"ip_address"`
	Hostname   string   `json:"hostname"`
	MACAddress *string  `json:"mac_address"`
	OS         string   `json:"os"`
	OSVersion  string   `json:"os_version"`
	Status     string   `json:"status"`
	NodeType   string   `json:"node_type"`
	PositionX  *float64 `json:"position_x"`
	PositionY  *float64 `json:"position_y"`
	Services   any      `json:"services"`
	Metadata   any      `json:"metadata"`
}

type UpdateNodeRequest struct {
	EndpointID *string  `json:"endpoint_id"`
	IPAddress  *string  `json:"ip_address"`
	Hostname   *string  `json:"hostname"`
	MACAddress *string  `json:"mac_address"`
	OS         *string  `json:"os"`
	OSVersion  *string  `json:"os_version"`
	Status     *string  `json:"status"`
	NodeType   *string  `json:"node_type"`
	PositionX  *float64 `json:"position_x"`
	PositionY  *float64 `json:"position_y"`
	Services   any      `json:"services"`
	Metadata   any      `json:"metadata"`
}

type CreateEdgeRequest struct {
	SourceNodeID string  `json:"source_node_id"`
	TargetNodeID string  `json:"target_node_id"`
	EdgeType     string  `json:"edge_type"`
	Label        *string `json:"label"`
	Confidence   float64 `json:"confidence"`
	DiscoveredBy string  `json:"discovered_by"`
	Metadata     any     `json:"metadata"`
}

// Display schema types

type DisplaySchema struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	SchemaType string `json:"schema_type"`
	Definition any    `json:"definition"`
	IsDefault  bool   `json:"is_default"`
	CreatedBy  *string `json:"created_by"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type CreateDisplaySchemaRequest struct {
	Name       string `json:"name"`
	SchemaType string `json:"schema_type"`
	Definition any    `json:"definition"`
}

type UpdateDisplaySchemaRequest struct {
	Name       *string `json:"name"`
	SchemaType *string `json:"schema_type"`
	Definition any     `json:"definition"`
}

// Import parser types

type ImportParser struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Format      string `json:"format"`
	Version     int    `json:"version"`
	Definition  any    `json:"definition"`
	SampleData  string `json:"sample_data,omitempty"`
	IsDefault   bool   `json:"is_default"`
	CreatedBy   string `json:"created_by,omitempty"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type CreateImportParserRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Format      string `json:"format"`
	Definition  any    `json:"definition"`
	SampleData  string `json:"sample_data,omitempty"`
}

type UpdateImportParserRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Format      *string `json:"format"`
	Definition  any     `json:"definition"`
	SampleData  *string `json:"sample_data"`
}

// ---------------------------------------------------------------------------
// Valid enum values
// ---------------------------------------------------------------------------

var validNodeStatuses = map[string]bool{
	"discovered": true, "alive": true, "compromised": true, "offline": true,
}

var validNodeTypes = map[string]bool{
	"host": true, "router": true, "firewall": true, "server": true, "workstation": true, "unknown": true,
}

var validEdgeTypes = map[string]bool{
	"network_adjacency": true, "c2_callback": true, "c2_pivot": true,
	"lateral_movement": true, "tunnel": true, "port_forward": true,
}

var validDiscoveredBy = map[string]bool{
	"import": true, "scan": true, "c2_activity": true, "manual": true,
}

var validImportParserFormats = map[string]bool{
	"xml": true, "json": true, "csv": true, "tsv": true, "custom": true,
}

// ---------------------------------------------------------------------------
// Nmap XML structures
// ---------------------------------------------------------------------------

type NmapRun struct {
	XMLName xml.Name   `xml:"nmaprun"`
	Hosts   []NmapHost `xml:"host"`
}

type NmapHost struct {
	Status    NmapStatus    `xml:"status"`
	Addresses []NmapAddress `xml:"address"`
	Hostnames struct {
		Names []NmapHostname `xml:"hostname"`
	} `xml:"hostnames"`
	Ports struct {
		Ports []NmapPort `xml:"port"`
	} `xml:"ports"`
	OS struct {
		Matches []NmapOSMatch `xml:"osmatch"`
	} `xml:"os"`
	Trace NmapTrace `xml:"trace"`
}

type NmapStatus struct {
	State string `xml:"state,attr"`
}

type NmapAddress struct {
	Addr     string `xml:"addr,attr"`
	AddrType string `xml:"addrtype,attr"`
	Vendor   string `xml:"vendor,attr"`
}

type NmapHostname struct {
	Name string `xml:"name,attr"`
	Type string `xml:"type,attr"`
}

type NmapPort struct {
	Protocol string      `xml:"protocol,attr"`
	PortID   int         `xml:"portid,attr"`
	State    NmapState   `xml:"state"`
	Service  NmapService `xml:"service"`
}

type NmapState struct {
	State string `xml:"state,attr"`
}

type NmapService struct {
	Name    string `xml:"name,attr"`
	Product string `xml:"product,attr"`
	Version string `xml:"version,attr"`
	OSType  string `xml:"ostype,attr"`
}

type NmapOSMatch struct {
	Name     string `xml:"name,attr"`
	Accuracy int    `xml:"accuracy,attr"`
}

type NmapTrace struct {
	Hops []NmapHop `xml:"hop"`
}

type NmapHop struct {
	TTL    int    `xml:"ttl,attr"`
	IPAddr string `xml:"ipaddr,attr"`
	RTT    string `xml:"rtt,attr"`
	Host   string `xml:"host,attr"`
}

type ImportResult struct {
	Format       string `json:"format"`
	NodesCreated int    `json:"nodes_created"`
	NodesUpdated int    `json:"nodes_updated"`
	EdgesCreated int    `json:"edges_created"`
	TotalHosts   int    `json:"total_hosts"`
	HostsSkipped int    `json:"hosts_skipped"`
}

// ---------------------------------------------------------------------------
// Parser engine types
// ---------------------------------------------------------------------------

type ParserDefinition struct {
	Version        int                   `json:"version"`
	RootElement    string                `json:"root_element,omitempty"`
	HostElement    string                `json:"host_element,omitempty"`
	RootPath       string                `json:"root_path,omitempty"`
	CommentPrefix  string                `json:"comment_prefix,omitempty"`
	Separator      string                `json:"separator,omitempty"`
	HeaderLine     string                `json:"header_line,omitempty"`
	SkipWhen       []SkipCondition       `json:"skip_when,omitempty"`
	FieldMappings  []FieldMapping        `json:"field_mappings"`
	EdgeMappings   []EdgeMapping         `json:"edge_mappings,omitempty"`
	NodeTypeRules  []NodeTypeRule        `json:"node_type_rules"`
	CreatesEdges   bool                  `json:"creates_edges,omitempty"`
	EdgeGeneration *EdgeGenerationConfig `json:"edge_generation,omitempty"`
}

type SkipCondition struct {
	Field    string `json:"field"`
	Operator string `json:"operator"` // "equals", "contains", "not_equals"
	Value    string `json:"value"`
}

type FieldMapping struct {
	Source      string         `json:"source"`
	Target      string         `json:"target"`
	Filter      *FieldFilter   `json:"filter,omitempty"`
	Transform   string         `json:"transform,omitempty"` // to_integer, to_float, to_lowercase, to_uppercase
	Default     string         `json:"default,omitempty"`
	SubMappings []FieldMapping `json:"sub_mappings,omitempty"`
}

type FieldFilter struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type EdgeMapping struct {
	Source   string `json:"source"`
	SourceIP string `json:"source_ip"`
	TargetIP string `json:"target_ip"`
	EdgeType string `json:"edge_type"`
}

type NodeTypeRule struct {
	Field    string `json:"field"`
	Operator string `json:"operator"` // "contains", "equals", "port_open", "service_running"
	Value    string `json:"value"`
	NodeType string `json:"node_type"`
}

type EdgeGenerationConfig struct {
	Strategy string `json:"strategy"` // "subnet", "connection_log"
	SourceIP string `json:"source_ip,omitempty"`
	DestIP   string `json:"dest_ip,omitempty"`
}

// XMLElement is a generic tree representation of an XML document for the
// data-driven parser engine.
type XMLElement struct {
	Name     string
	Attrs    map[string]string
	Children []XMLElement
	Text     string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func maxBodyMiddleware(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}

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

func parseJSONB(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var m any
	if err := json.Unmarshal(raw, &m); err == nil {
		return m
	}
	return nil
}

func marshalJSONB(v any) []byte {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------

func scanNetwork(scanner interface{ Scan(dest ...any) error }) (Network, error) {
	var n Network
	var (
		cidrRanges   []string
		importSource *string
		createdBy    *string
		metadata     []byte
		createdAt    time.Time
		updatedAt    time.Time
	)
	err := scanner.Scan(
		&n.ID, &n.OperationID, &n.Name, &n.Description,
		&cidrRanges, &importSource, &metadata, &createdBy,
		&createdAt, &updatedAt, &n.NodeCount, &n.CompromisedCount,
	)
	if err != nil {
		return n, err
	}
	n.CIDRRanges = cidrRanges
	if n.CIDRRanges == nil {
		n.CIDRRanges = []string{}
	}
	n.ImportSource = importSource
	n.CreatedBy = createdBy
	n.Metadata = parseJSONB(metadata)
	n.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	n.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return n, nil
}

const networkSelectCols = `n.id, n.operation_id, n.name, n.description,
       n.cidr_ranges, n.import_source, n.metadata, n.created_by,
       n.created_at, n.updated_at,
       (SELECT count(*) FROM network_nodes WHERE network_id = n.id) AS node_count,
       (SELECT count(*) FROM network_nodes WHERE network_id = n.id AND status = 'compromised') AS compromised_count`

func scanNode(scanner interface{ Scan(dest ...any) error }) (NetworkNode, error) {
	var nd NetworkNode
	var (
		endpointID *string
		macAddress *string
		positionX  *float64
		positionY  *float64
		services   []byte
		metadata   []byte
		createdAt  time.Time
		updatedAt  time.Time
	)
	err := scanner.Scan(
		&nd.ID, &nd.NetworkID, &endpointID, &nd.IPAddress, &nd.Hostname,
		&macAddress, &nd.OS, &nd.OSVersion, &nd.Status, &nd.NodeType,
		&positionX, &positionY, &services, &metadata,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return nd, err
	}
	nd.EndpointID = endpointID
	nd.MACAddress = macAddress
	nd.PositionX = positionX
	nd.PositionY = positionY
	nd.Services = parseJSONB(services)
	nd.Metadata = parseJSONB(metadata)
	nd.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	nd.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return nd, nil
}

const nodeSelectCols = `id, network_id, endpoint_id, ip_address, hostname,
       mac_address, os, os_version, status, node_type,
       position_x, position_y, services, metadata,
       created_at, updated_at`

func scanEdge(scanner interface{ Scan(dest ...any) error }) (NetworkEdge, error) {
	var e NetworkEdge
	var (
		label     *string
		metadata  []byte
		createdAt time.Time
		updatedAt time.Time
	)
	err := scanner.Scan(
		&e.ID, &e.NetworkID, &e.SourceNodeID, &e.TargetNodeID,
		&e.EdgeType, &label, &e.Confidence, &e.DiscoveredBy, &metadata,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return e, err
	}
	e.Label = label
	e.Metadata = parseJSONB(metadata)
	e.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	e.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return e, nil
}

const edgeSelectCols = `id, network_id, source_node_id, target_node_id,
       edge_type, label, confidence, discovered_by, metadata,
       created_at, updated_at`

// ---------------------------------------------------------------------------
// Handlers — Health
// ---------------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	err := s.db.Ping(r.Context())
	status := "ok"
	if err != nil {
		status = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status, "service": "endpoint-service"})
}

// ---------------------------------------------------------------------------
// Handlers — Networks
// ---------------------------------------------------------------------------

func (s *Server) handleCreateNetwork(w http.ResponseWriter, r *http.Request) {
	var req CreateNetworkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.OperationID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "operation_id is required")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")
		return
	}

	cidrRanges := req.CIDRRanges
	if cidrRanges == nil {
		cidrRanges = []string{}
	}

	userID := getUserID(r)

	metadataBytes := marshalJSONB(req.Metadata)
	if metadataBytes == nil {
		metadataBytes = []byte("{}")
	}

	var netID string
	err := s.db.QueryRow(r.Context(),
		`INSERT INTO networks (operation_id, name, description, cidr_ranges, metadata, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		req.OperationID, req.Name, req.Description, cidrRanges, metadataBytes, userID).Scan(&netID)
	if err != nil {
		s.logger.Error("create network insert failed", "error", err)
		if strings.Contains(err.Error(), "foreign key") {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid operation_id")
			return
		}
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create network")
		return
	}

	fetchQuery := fmt.Sprintf(`SELECT %s FROM networks n WHERE n.id = $1`, networkSelectCols)
	row := s.db.QueryRow(r.Context(), fetchQuery, netID)
	net, err := scanNetwork(row)
	if err != nil {
		s.logger.Error("fetch created network failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch created network")
		return
	}

	s.publishEvent("network.created", net)
	writeJSON(w, http.StatusCreated, net)
}

func (s *Server) handleListNetworks(w http.ResponseWriter, r *http.Request) {
	operationID := r.URL.Query().Get("operation_id")
	if operationID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "operation_id query parameter is required")
		return
	}

	page, limit, offset := parsePagination(r)

	query := fmt.Sprintf(`SELECT %s FROM networks n
		WHERE n.operation_id = $1
		ORDER BY n.name
		LIMIT $2 OFFSET $3`, networkSelectCols)

	rows, err := s.db.Query(r.Context(), query, operationID, limit, offset)
	if err != nil {
		s.logger.Error("list networks query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to query networks")
		return
	}
	defer rows.Close()

	var nets []Network
	for rows.Next() {
		n, err := scanNetwork(rows)
		if err != nil {
			s.logger.Error("scan network failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan network")
			return
		}
		nets = append(nets, n)
	}
	if nets == nil {
		nets = []Network{}
	}

	var total int
	if err := s.db.QueryRow(r.Context(),
		"SELECT count(*) FROM networks WHERE operation_id = $1", operationID).Scan(&total); err != nil {
		s.logger.Error("count networks failed", "error", err)
		total = len(nets)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": nets,
		"pagination": map[string]int{
			"page":  page,
			"limit": limit,
			"total": total,
		},
	})
}

func (s *Server) handleGetNetwork(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	query := fmt.Sprintf(`SELECT %s FROM networks n WHERE n.id = $1`, networkSelectCols)
	row := s.db.QueryRow(r.Context(), query, id)
	net, err := scanNetwork(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Network not found")
			return
		}
		s.logger.Error("get network failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get network")
		return
	}

	writeJSON(w, http.StatusOK, net)
}

func (s *Server) handleUpdateNetwork(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req UpdateNetworkRequest
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
	if req.Description != nil {
		setClauses = append(setClauses, fmt.Sprintf("description = $%d", argIdx))
		args = append(args, *req.Description)
		argIdx++
	}
	if req.CIDRRanges != nil {
		setClauses = append(setClauses, fmt.Sprintf("cidr_ranges = $%d", argIdx))
		args = append(args, *req.CIDRRanges)
		argIdx++
	}
	if req.Metadata != nil {
		metaBytes := marshalJSONB(req.Metadata)
		setClauses = append(setClauses, fmt.Sprintf("metadata = $%d", argIdx))
		args = append(args, metaBytes)
		argIdx++
	}

	if len(setClauses) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "No fields to update")
		return
	}

	setClauses = append(setClauses, "updated_at = NOW()")

	query := fmt.Sprintf("UPDATE networks SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), argIdx)
	args = append(args, id)

	result, err := s.db.Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update network failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update network")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Network not found")
		return
	}

	fetchQuery := fmt.Sprintf(`SELECT %s FROM networks n WHERE n.id = $1`, networkSelectCols)
	row := s.db.QueryRow(r.Context(), fetchQuery, id)
	net, err := scanNetwork(row)
	if err != nil {
		s.logger.Error("fetch updated network failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated network")
		return
	}

	s.publishEvent("network.updated", net)
	writeJSON(w, http.StatusOK, net)
}

func (s *Server) handleDeleteNetwork(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	result, err := s.db.Exec(r.Context(), "DELETE FROM networks WHERE id = $1", id)
	if err != nil {
		s.logger.Error("delete network failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to delete network")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Network not found")
		return
	}

	s.publishEvent("network.deleted", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Handlers — Nodes
// ---------------------------------------------------------------------------

func (s *Server) handleListNodes(w http.ResponseWriter, r *http.Request) {
	networkID := r.PathValue("id")
	if networkID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "network id is required")
		return
	}

	page, limit, offset := parsePagination(r)
	statusFilter := r.URL.Query().Get("status")
	nodeTypeFilter := r.URL.Query().Get("node_type")

	query := fmt.Sprintf(`SELECT %s FROM network_nodes
		WHERE network_id = $1
		  AND ($2 = '' OR status = $2)
		  AND ($3 = '' OR node_type = $3)
		ORDER BY ip_address
		LIMIT $4 OFFSET $5`, nodeSelectCols)

	rows, err := s.db.Query(r.Context(), query, networkID, statusFilter, nodeTypeFilter, limit, offset)
	if err != nil {
		s.logger.Error("list nodes query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to query nodes")
		return
	}
	defer rows.Close()

	var nodes []NetworkNode
	for rows.Next() {
		nd, err := scanNode(rows)
		if err != nil {
			s.logger.Error("scan node failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan node")
			return
		}
		nodes = append(nodes, nd)
	}
	if nodes == nil {
		nodes = []NetworkNode{}
	}

	var total int
	if err := s.db.QueryRow(r.Context(),
		`SELECT count(*) FROM network_nodes
		 WHERE network_id = $1
		   AND ($2 = '' OR status = $2)
		   AND ($3 = '' OR node_type = $3)`,
		networkID, statusFilter, nodeTypeFilter).Scan(&total); err != nil {
		s.logger.Error("count nodes failed", "error", err)
		total = len(nodes)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": nodes,
		"pagination": map[string]int{
			"page":  page,
			"limit": limit,
			"total": total,
		},
	})
}

func (s *Server) handleCreateNode(w http.ResponseWriter, r *http.Request) {
	networkID := r.PathValue("id")
	if networkID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "network id is required")
		return
	}

	var req CreateNodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.IPAddress == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "ip_address is required")
		return
	}

	// Default status
	if req.Status == "" {
		req.Status = "discovered"
	}
	if !validNodeStatuses[req.Status] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			fmt.Sprintf("Invalid status. Must be one of: discovered, alive, compromised, offline"))
		return
	}

	// Default node_type
	if req.NodeType == "" {
		req.NodeType = "unknown"
	}
	if !validNodeTypes[req.NodeType] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			fmt.Sprintf("Invalid node_type. Must be one of: host, router, firewall, server, workstation, unknown"))
		return
	}

	servicesBytes := marshalJSONB(req.Services)
	if servicesBytes == nil {
		servicesBytes = []byte("[]")
	}
	metadataBytes := marshalJSONB(req.Metadata)
	if metadataBytes == nil {
		metadataBytes = []byte("{}")
	}

	query := fmt.Sprintf(`INSERT INTO network_nodes
		(network_id, endpoint_id, ip_address, hostname, mac_address, os, os_version,
		 status, node_type, position_x, position_y, services, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (network_id, ip_address) DO UPDATE SET
			endpoint_id = COALESCE(EXCLUDED.endpoint_id, network_nodes.endpoint_id),
			hostname = COALESCE(NULLIF(EXCLUDED.hostname, ''), network_nodes.hostname),
			mac_address = COALESCE(EXCLUDED.mac_address, network_nodes.mac_address),
			os = COALESCE(NULLIF(EXCLUDED.os, ''), network_nodes.os),
			os_version = COALESCE(NULLIF(EXCLUDED.os_version, ''), network_nodes.os_version),
			status = EXCLUDED.status,
			node_type = EXCLUDED.node_type,
			position_x = COALESCE(EXCLUDED.position_x, network_nodes.position_x),
			position_y = COALESCE(EXCLUDED.position_y, network_nodes.position_y),
			services = COALESCE(EXCLUDED.services, network_nodes.services),
			metadata = COALESCE(EXCLUDED.metadata, network_nodes.metadata),
			updated_at = NOW()
		RETURNING %s`, nodeSelectCols)

	row := s.db.QueryRow(r.Context(), query,
		networkID, req.EndpointID, req.IPAddress, req.Hostname, req.MACAddress,
		req.OS, req.OSVersion, req.Status, req.NodeType,
		req.PositionX, req.PositionY, servicesBytes, metadataBytes)

	nd, err := scanNode(row)
	if err != nil {
		s.logger.Error("create node failed", "error", err)
		if strings.Contains(err.Error(), "foreign key") {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid network_id or endpoint_id")
			return
		}
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create node")
		return
	}

	s.publishEvent("network.node_added", nd)
	writeJSON(w, http.StatusCreated, nd)
}

func (s *Server) handleUpdateNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	var req UpdateNodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}

	setClauses := []string{}
	args := []any{}
	argIdx := 1

	if req.EndpointID != nil {
		setClauses = append(setClauses, fmt.Sprintf("endpoint_id = $%d", argIdx))
		args = append(args, *req.EndpointID)
		argIdx++
	}
	if req.IPAddress != nil {
		setClauses = append(setClauses, fmt.Sprintf("ip_address = $%d", argIdx))
		args = append(args, *req.IPAddress)
		argIdx++
	}
	if req.Hostname != nil {
		setClauses = append(setClauses, fmt.Sprintf("hostname = $%d", argIdx))
		args = append(args, *req.Hostname)
		argIdx++
	}
	if req.MACAddress != nil {
		setClauses = append(setClauses, fmt.Sprintf("mac_address = $%d", argIdx))
		args = append(args, *req.MACAddress)
		argIdx++
	}
	if req.OS != nil {
		setClauses = append(setClauses, fmt.Sprintf("os = $%d", argIdx))
		args = append(args, *req.OS)
		argIdx++
	}
	if req.OSVersion != nil {
		setClauses = append(setClauses, fmt.Sprintf("os_version = $%d", argIdx))
		args = append(args, *req.OSVersion)
		argIdx++
	}
	if req.Status != nil {
		if !validNodeStatuses[*req.Status] {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
				"Invalid status. Must be one of: discovered, alive, compromised, offline")
			return
		}
		setClauses = append(setClauses, fmt.Sprintf("status = $%d", argIdx))
		args = append(args, *req.Status)
		argIdx++
	}
	if req.NodeType != nil {
		if !validNodeTypes[*req.NodeType] {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
				"Invalid node_type. Must be one of: host, router, firewall, server, workstation, unknown")
			return
		}
		setClauses = append(setClauses, fmt.Sprintf("node_type = $%d", argIdx))
		args = append(args, *req.NodeType)
		argIdx++
	}
	if req.PositionX != nil {
		setClauses = append(setClauses, fmt.Sprintf("position_x = $%d", argIdx))
		args = append(args, *req.PositionX)
		argIdx++
	}
	if req.PositionY != nil {
		setClauses = append(setClauses, fmt.Sprintf("position_y = $%d", argIdx))
		args = append(args, *req.PositionY)
		argIdx++
	}
	if req.Services != nil {
		servicesBytes := marshalJSONB(req.Services)
		setClauses = append(setClauses, fmt.Sprintf("services = $%d", argIdx))
		args = append(args, servicesBytes)
		argIdx++
	}
	if req.Metadata != nil {
		metaBytes := marshalJSONB(req.Metadata)
		setClauses = append(setClauses, fmt.Sprintf("metadata = $%d", argIdx))
		args = append(args, metaBytes)
		argIdx++
	}

	if len(setClauses) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "No fields to update")
		return
	}

	setClauses = append(setClauses, "updated_at = NOW()")

	query := fmt.Sprintf("UPDATE network_nodes SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), argIdx)
	args = append(args, id)

	result, err := s.db.Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update node failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update node")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Node not found")
		return
	}

	fetchQuery := fmt.Sprintf(`SELECT %s FROM network_nodes WHERE id = $1`, nodeSelectCols)
	row := s.db.QueryRow(r.Context(), fetchQuery, id)
	nd, err := scanNode(row)
	if err != nil {
		s.logger.Error("fetch updated node failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated node")
		return
	}

	s.publishEvent("network.node_updated", nd)
	writeJSON(w, http.StatusOK, nd)
}

func (s *Server) handleDeleteNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	result, err := s.db.Exec(r.Context(), "DELETE FROM network_nodes WHERE id = $1", id)
	if err != nil {
		s.logger.Error("delete node failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to delete node")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Node not found")
		return
	}

	s.publishEvent("network.node_deleted", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Handlers — Edges
// ---------------------------------------------------------------------------

func (s *Server) handleListEdges(w http.ResponseWriter, r *http.Request) {
	networkID := r.PathValue("id")
	if networkID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "network id is required")
		return
	}

	query := fmt.Sprintf(`SELECT %s FROM network_edges
		WHERE network_id = $1
		ORDER BY created_at`, edgeSelectCols)

	rows, err := s.db.Query(r.Context(), query, networkID)
	if err != nil {
		s.logger.Error("list edges query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to query edges")
		return
	}
	defer rows.Close()

	var edges []NetworkEdge
	for rows.Next() {
		e, err := scanEdge(rows)
		if err != nil {
			s.logger.Error("scan edge failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan edge")
			return
		}
		edges = append(edges, e)
	}
	if edges == nil {
		edges = []NetworkEdge{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": edges,
	})
}

func (s *Server) handleCreateEdge(w http.ResponseWriter, r *http.Request) {
	networkID := r.PathValue("id")
	if networkID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "network id is required")
		return
	}

	var req CreateEdgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.SourceNodeID == "" || req.TargetNodeID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "source_node_id and target_node_id are required")
		return
	}
	if req.EdgeType == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "edge_type is required")
		return
	}
	if !validEdgeTypes[req.EdgeType] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			"Invalid edge_type. Must be one of: network_adjacency, c2_callback, c2_pivot, lateral_movement, tunnel, port_forward")
		return
	}

	// Default discovered_by
	if req.DiscoveredBy == "" {
		req.DiscoveredBy = "manual"
	}
	if !validDiscoveredBy[req.DiscoveredBy] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			"Invalid discovered_by. Must be one of: import, scan, c2_activity, manual")
		return
	}

	// Default confidence
	if req.Confidence == 0 {
		req.Confidence = 1.0
	}
	if req.Confidence < 0 || req.Confidence > 1 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "confidence must be between 0 and 1")
		return
	}

	metadataBytes := marshalJSONB(req.Metadata)
	if metadataBytes == nil {
		metadataBytes = []byte("{}")
	}

	query := fmt.Sprintf(`INSERT INTO network_edges
		(network_id, source_node_id, target_node_id, edge_type, label, confidence, discovered_by, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING %s`, edgeSelectCols)

	row := s.db.QueryRow(r.Context(), query,
		networkID, req.SourceNodeID, req.TargetNodeID,
		req.EdgeType, req.Label, req.Confidence, req.DiscoveredBy, metadataBytes)

	e, err := scanEdge(row)
	if err != nil {
		s.logger.Error("create edge failed", "error", err)
		if strings.Contains(err.Error(), "foreign key") {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid network_id, source_node_id, or target_node_id")
			return
		}
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create edge")
		return
	}

	s.publishEvent("network.edge_added", e)
	writeJSON(w, http.StatusCreated, e)
}

func (s *Server) handleDeleteEdge(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	result, err := s.db.Exec(r.Context(), "DELETE FROM network_edges WHERE id = $1", id)
	if err != nil {
		s.logger.Error("delete edge failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to delete edge")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Edge not found")
		return
	}

	s.publishEvent("network.edge_deleted", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Handlers — Topology
// ---------------------------------------------------------------------------

func (s *Server) handleGetTopology(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "network id is required")
		return
	}

	ctx := r.Context()

	// Fetch network
	netQuery := fmt.Sprintf(`SELECT %s FROM networks n WHERE n.id = $1`, networkSelectCols)
	row := s.db.QueryRow(ctx, netQuery, id)
	net, err := scanNetwork(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Network not found")
			return
		}
		s.logger.Error("get network for topology failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get network")
		return
	}

	// Fetch all nodes
	nodeQuery := fmt.Sprintf(`SELECT %s FROM network_nodes WHERE network_id = $1 ORDER BY ip_address`, nodeSelectCols)
	nodeRows, err := s.db.Query(ctx, nodeQuery, id)
	if err != nil {
		s.logger.Error("get nodes for topology failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get nodes")
		return
	}
	defer nodeRows.Close()

	var nodes []NetworkNode
	for nodeRows.Next() {
		nd, err := scanNode(nodeRows)
		if err != nil {
			s.logger.Error("scan node for topology failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan node")
			return
		}
		nodes = append(nodes, nd)
	}
	if nodes == nil {
		nodes = []NetworkNode{}
	}

	// Fetch all edges
	edgeQuery := fmt.Sprintf(`SELECT %s FROM network_edges WHERE network_id = $1 ORDER BY created_at`, edgeSelectCols)
	edgeRows, err := s.db.Query(ctx, edgeQuery, id)
	if err != nil {
		s.logger.Error("get edges for topology failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get edges")
		return
	}
	defer edgeRows.Close()

	var edges []NetworkEdge
	for edgeRows.Next() {
		e, err := scanEdge(edgeRows)
		if err != nil {
			s.logger.Error("scan edge for topology failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan edge")
			return
		}
		edges = append(edges, e)
	}
	if edges == nil {
		edges = []NetworkEdge{}
	}

	writeJSON(w, http.StatusOK, TopologyResponse{
		Network: net,
		Nodes:   nodes,
		Edges:   edges,
	})
}

// ---------------------------------------------------------------------------
// Handlers — Import
// ---------------------------------------------------------------------------

func (s *Server) handleImportFile(w http.ResponseWriter, r *http.Request) {
	networkID := r.PathValue("id")
	parserID := r.URL.Query().Get("parser_id")

	// Verify network exists
	var netName string
	err := s.db.QueryRow(r.Context(), "SELECT name FROM networks WHERE id = $1", networkID).Scan(&netName)
	if err != nil {
		writeError(w, 404, "NOT_FOUND", "Network not found")
		return
	}

	// Parse multipart form (max 50MB)
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		writeError(w, 400, "BAD_REQUEST", "Invalid multipart form: "+err.Error())
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "BAD_REQUEST", "Missing 'file' field")
		return
	}
	defer file.Close()

	// Read file content
	data, err := io.ReadAll(file)
	if err != nil {
		writeError(w, 500, "INTERNAL", "Failed to read file")
		return
	}

	s.logger.Info("import file received", "network", networkID, "filename", header.Filename, "size", len(data))

	var result ImportResult
	var importErr error
	var importFormat string

	if parserID != "" {
		// Load parser from DB and execute
		var format string
		var defJSON []byte
		qErr := s.db.QueryRow(r.Context(),
			"SELECT format, definition FROM import_parsers WHERE id=$1", parserID).Scan(&format, &defJSON)
		if qErr != nil {
			writeError(w, 404, "NOT_FOUND", "Parser not found")
			return
		}
		var def ParserDefinition
		if err := json.Unmarshal(defJSON, &def); err != nil {
			writeError(w, 500, "INTERNAL", "Invalid parser definition: "+err.Error())
			return
		}
		result, importErr = s.executeParser(r.Context(), networkID, data, format, def)
		importFormat = format
	} else {
		// Auto-detect format
		peekLen := len(data)
		if peekLen > 500 {
			peekLen = 500
		}
		peek := string(data[:peekLen])

		var format string
		if bytes.Contains(data[:peekLen], []byte("<?xml")) || bytes.Contains(data[:peekLen], []byte("<")) && bytes.Contains(data[:peekLen], []byte(">")) {
			format = "xml"
		} else if len(data) > 0 && (data[0] == '{' || data[0] == '[') {
			format = "json"
		} else if strings.Contains(peek, "\t") {
			format = "tsv"
		} else {
			format = "csv"
		}

		// Try default parser for this format
		var defJSON []byte
		dbErr := s.db.QueryRow(r.Context(),
			"SELECT definition FROM import_parsers WHERE format=$1 AND is_default=true LIMIT 1", format).Scan(&defJSON)
		if dbErr == nil {
			var def ParserDefinition
			if json.Unmarshal(defJSON, &def) == nil {
				result, importErr = s.executeParser(r.Context(), networkID, data, format, def)
				importFormat = format
			}
		}

		// Fallback to hardcoded Nmap parser
		if importFormat == "" {
			if format == "xml" && bytes.Contains(data[:peekLen], []byte("<nmaprun")) {
				result, importErr = s.importNmapXML(r.Context(), networkID, data)
				importFormat = "nmap"
			} else {
				writeError(w, 400, "UNSUPPORTED_FORMAT",
					"No parser found for this format. Upload an XML (Nmap), JSON, or CSV/TSV file, or specify a parser_id.")
				return
			}
		}
	}

	if importErr != nil {
		s.logger.Error("import failed", "error", importErr)
		writeError(w, 500, "IMPORT_FAILED", importErr.Error())
		return
	}

	// Update network import_source
	_, _ = s.db.Exec(r.Context(), "UPDATE networks SET import_source = $1 WHERE id = $2", importFormat, networkID)

	// Publish event
	s.publishEvent("network.imported", map[string]any{
		"network_id":    networkID,
		"format":        importFormat,
		"nodes_created": result.NodesCreated,
		"nodes_updated": result.NodesUpdated,
		"edges_created": result.EdgesCreated,
	})

	writeJSON(w, 200, result)
}

func classifyNodeType(services []map[string]any, osName string, vendor string) string {
	portSet := make(map[int]bool)
	serviceSet := make(map[string]bool)
	for _, svc := range services {
		if p, ok := svc["port"].(float64); ok {
			portSet[int(p)] = true
		} else if p, ok := svc["port"].(int); ok {
			portSet[p] = true
		}
		if s, ok := svc["service"].(string); ok {
			serviceSet[strings.ToLower(s)] = true
		}
	}

	osLower := strings.ToLower(osName)
	vendorLower := strings.ToLower(vendor)

	// Router: BGP, OSPF, RIP
	if portSet[179] || portSet[89] || portSet[520] {
		return "router"
	}
	// Firewall: known vendors
	for _, fv := range []string{"cisco asa", "pfsense", "palo alto", "fortinet", "sonicwall", "checkpoint"} {
		if strings.Contains(osLower, fv) || strings.Contains(vendorLower, fv) {
			return "firewall"
		}
	}
	// Printer
	if portSet[631] || portSet[515] || portSet[9100] || serviceSet["ipp"] || serviceSet["printer"] {
		return "printer"
	}
	// VPN
	if portSet[1194] || (portSet[500] && portSet[4500]) || portSet[51820] {
		return "vpn"
	}
	// IoT
	if portSet[1883] || portSet[5683] || serviceSet["mqtt"] || serviceSet["coap"] {
		return "iot"
	}
	// Workstation: RDP/VNC + desktop OS
	desktopOs := strings.Contains(osLower, "windows") || strings.Contains(osLower, "mac")
	if (portSet[3389] || portSet[5900]) && desktopOs {
		return "workstation"
	}
	// Server
	serverPorts := []int{80, 443, 22, 3306, 5432, 27017, 6379, 8080, 8443, 9200}
	for _, sp := range serverPorts {
		if portSet[sp] {
			return "server"
		}
	}
	if serviceSet["http"] || serviceSet["https"] || serviceSet["ssh"] {
		return "server"
	}
	return "host"
}

// ---------------------------------------------------------------------------
// Generic Parser Engine
// ---------------------------------------------------------------------------

func (s *Server) executeParser(ctx context.Context, networkID string, data []byte, format string, def ParserDefinition) (ImportResult, error) {
	switch format {
	case "xml":
		return s.executeXMLParser(ctx, networkID, data, def)
	case "json":
		return s.executeJSONParser(ctx, networkID, data, def)
	case "csv", "tsv":
		return s.executeCSVParser(ctx, networkID, data, def)
	default:
		return ImportResult{}, fmt.Errorf("unsupported format: %s", format)
	}
}

// parseXMLTree parses raw XML bytes into a generic XMLElement tree.
func parseXMLTree(data []byte) (XMLElement, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var stack []XMLElement
	var root XMLElement
	rootSet := false

	for {
		tok, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return XMLElement{}, fmt.Errorf("xml decode: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			el := XMLElement{
				Name:  t.Name.Local,
				Attrs: make(map[string]string, len(t.Attr)),
			}
			for _, a := range t.Attr {
				el.Attrs[a.Name.Local] = a.Value
			}
			stack = append(stack, el)
		case xml.EndElement:
			if len(stack) == 0 {
				continue
			}
			finished := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if len(stack) > 0 {
				stack[len(stack)-1].Children = append(stack[len(stack)-1].Children, finished)
			} else {
				root = finished
				rootSet = true
			}
		case xml.CharData:
			text := strings.TrimSpace(string(t))
			if text != "" && len(stack) > 0 {
				stack[len(stack)-1].Text = text
			}
		}
	}

	if !rootSet {
		return XMLElement{}, fmt.Errorf("no root element found in XML")
	}
	return root, nil
}

// xmlFindChildren returns all direct children matching the given element name.
func xmlFindChildren(el XMLElement, name string) []XMLElement {
	var result []XMLElement
	for _, c := range el.Children {
		if c.Name == name {
			result = append(result, c)
		}
	}
	return result
}

// xmlNavigate walks a dot-separated path (e.g. "hostnames.hostname") and
// returns all matching elements.  Each segment may match multiple children,
// so the result is a flat list of all leaf matches.
func xmlNavigate(el XMLElement, path string) []XMLElement {
	parts := strings.Split(path, ".")
	current := []XMLElement{el}
	for _, p := range parts {
		var next []XMLElement
		for _, c := range current {
			next = append(next, xmlFindChildren(c, p)...)
		}
		current = next
		if len(current) == 0 {
			return nil
		}
	}
	return current
}

// xmlExtractValue extracts a string value from an XMLElement given a source
// specifier. The source may be:
//   - An attribute reference like "@attr"
//   - A dot-path to a child element
//   - A dot-path ending in "@attr" for a nested attribute
//
// If filter is provided, only elements matching the filter are considered.
func xmlExtractValue(el XMLElement, source string, filter *FieldFilter) string {
	// Direct attribute on the element itself
	if strings.HasPrefix(source, "@") {
		return el.Attrs[source[1:]]
	}

	// Check for embedded attribute reference: "addresses.address@addr"
	if idx := strings.LastIndex(source, "@"); idx > 0 {
		pathPart := source[:idx]
		attrName := source[idx+1:]
		// Remove trailing dot if present
		pathPart = strings.TrimSuffix(pathPart, ".")
		targets := xmlNavigate(el, pathPart)
		for _, t := range targets {
			if filter != nil && !xmlMatchFilter(t, filter) {
				continue
			}
			if v, ok := t.Attrs[attrName]; ok && v != "" {
				return v
			}
		}
		return ""
	}

	// Navigate to child element(s) and return text or first match
	targets := xmlNavigate(el, source)
	for _, t := range targets {
		if filter != nil && !xmlMatchFilter(t, filter) {
			continue
		}
		if t.Text != "" {
			return t.Text
		}
	}
	return ""
}

// xmlMatchFilter checks if an XMLElement matches a FieldFilter condition.
func xmlMatchFilter(el XMLElement, f *FieldFilter) bool {
	// The filter field may refer to an attribute (@attr) or a child element
	var val string
	if strings.HasPrefix(f.Field, "@") {
		val = el.Attrs[f.Field[1:]]
	} else {
		children := xmlNavigate(el, f.Field)
		if len(children) > 0 {
			val = children[0].Text
		}
	}

	switch f.Operator {
	case "equals":
		return val == f.Value
	case "not_equals":
		return val != f.Value
	case "contains":
		return strings.Contains(val, f.Value)
	default:
		return false
	}
}

// applyTransform applies a named transformation to a string value.
func applyTransform(value, transform string) string {
	switch transform {
	case "to_integer":
		if _, err := strconv.Atoi(value); err == nil {
			return value
		}
		return "0"
	case "to_float":
		if _, err := strconv.ParseFloat(value, 64); err == nil {
			return value
		}
		return "0"
	case "to_lowercase":
		return strings.ToLower(value)
	case "to_uppercase":
		return strings.ToUpper(value)
	default:
		return value
	}
}

// evaluateNodeTypeRules determines the node type for a record based on the
// parser definition's NodeTypeRules.  extracted is a map of target field →
// value pairs. Returns "host" if no rule matches.
func evaluateNodeTypeRules(rules []NodeTypeRule, extracted map[string]string, services []map[string]any) string {
	for _, rule := range rules {
		switch rule.Operator {
		case "equals":
			if extracted[rule.Field] == rule.Value {
				return rule.NodeType
			}
		case "contains":
			if strings.Contains(strings.ToLower(extracted[rule.Field]), strings.ToLower(rule.Value)) {
				return rule.NodeType
			}
		case "port_open":
			port, err := strconv.Atoi(rule.Value)
			if err != nil {
				continue
			}
			for _, svc := range services {
				if p, ok := svc["port"].(float64); ok && int(p) == port {
					return rule.NodeType
				}
				if p, ok := svc["port"].(int); ok && p == port {
					return rule.NodeType
				}
			}
		case "service_running":
			for _, svc := range services {
				if s, ok := svc["service"].(string); ok && strings.EqualFold(s, rule.Value) {
					return rule.NodeType
				}
			}
		}
	}
	return "host"
}

// evaluateSkipConditions checks if a record should be skipped.
func evaluateSkipConditions(conditions []SkipCondition, extracted map[string]string) bool {
	for _, cond := range conditions {
		val := extracted[cond.Field]
		switch cond.Operator {
		case "equals":
			if val == cond.Value {
				return true
			}
		case "not_equals":
			if val != cond.Value {
				return true
			}
		case "contains":
			if strings.Contains(val, cond.Value) {
				return true
			}
		}
	}
	return false
}

// upsertParsedNode inserts or updates a network node from extracted field data.
// Returns the node ID and whether it was newly created.
func (s *Server) upsertParsedNode(ctx context.Context, networkID string, extracted map[string]string, services []map[string]any, nodeType string) (string, bool, error) {
	ipAddr := extracted["ip_address"]
	if ipAddr == "" {
		return "", false, fmt.Errorf("ip_address is required")
	}

	hostname := extracted["hostname"]
	macAddr := extracted["mac_address"]
	osName := extracted["os"]
	if osName == "" {
		osName = "unknown"
	}
	osVersion := extracted["os_version"]
	status := extracted["status"]
	if status == "" {
		status = "alive"
	}
	if !validNodeStatuses[status] {
		status = "alive"
	}

	if services == nil {
		services = []map[string]any{}
	}
	servicesJSON, _ := json.Marshal(services)

	metadata := map[string]any{}
	if extracted["vendor"] != "" {
		metadata["mac_vendor"] = extracted["vendor"]
	}
	metadataJSON, _ := json.Marshal(metadata)

	var nodeID string
	err := s.db.QueryRow(ctx, `
		INSERT INTO network_nodes (network_id, ip_address, hostname, mac_address, os, os_version, status, node_type, services, metadata)
		VALUES ($1, $2, $3, NULLIF($4,''), $5, $6, $7, $8, $9::jsonb, $10::jsonb)
		ON CONFLICT (network_id, ip_address) DO UPDATE SET
			hostname = CASE WHEN EXCLUDED.hostname != '' THEN EXCLUDED.hostname ELSE network_nodes.hostname END,
			mac_address = COALESCE(EXCLUDED.mac_address, network_nodes.mac_address),
			os = CASE WHEN EXCLUDED.os != 'unknown' THEN EXCLUDED.os ELSE network_nodes.os END,
			os_version = CASE WHEN EXCLUDED.os_version != '' THEN EXCLUDED.os_version ELSE network_nodes.os_version END,
			services = EXCLUDED.services,
			metadata = network_nodes.metadata || EXCLUDED.metadata,
			updated_at = NOW()
		RETURNING id
	`, networkID, ipAddr, hostname, macAddr, osName, osVersion, status, nodeType, string(servicesJSON), string(metadataJSON)).Scan(&nodeID)
	if err != nil {
		return "", false, fmt.Errorf("upsert node %s: %w", ipAddr, err)
	}

	// Track enrichment source
	enrichment := map[string]any{
		"source":      "parser_engine",
		"imported_at": time.Now().UTC().Format(time.RFC3339),
	}
	enrichmentJSON, _ := json.Marshal(enrichment)
	_, _ = s.db.Exec(ctx, `
		UPDATE network_nodes SET
			metadata = jsonb_set(
				COALESCE(metadata, '{}'),
				'{enrichment_sources}',
				COALESCE(metadata->'enrichment_sources', '[]'::jsonb) || $1::jsonb
			)
		WHERE id = $2
	`, string(enrichmentJSON), nodeID)

	return nodeID, true, nil
}

// executeXMLParser processes XML data using a ParserDefinition.
func (s *Server) executeXMLParser(ctx context.Context, networkID string, data []byte, def ParserDefinition) (ImportResult, error) {
	root, err := parseXMLTree(data)
	if err != nil {
		return ImportResult{}, fmt.Errorf("parse XML: %w", err)
	}

	result := ImportResult{Format: "xml"}

	// Find host elements
	hostElement := def.HostElement
	if hostElement == "" {
		hostElement = "host"
	}

	var hosts []XMLElement
	if def.RootElement != "" && root.Name != def.RootElement {
		return ImportResult{}, fmt.Errorf("expected root element %q, got %q", def.RootElement, root.Name)
	}
	hosts = xmlNavigate(root, hostElement)
	result.TotalHosts = len(hosts)

	for _, host := range hosts {
		// Extract fields
		extracted := make(map[string]string)
		var services []map[string]any

		for _, fm := range def.FieldMappings {
			if fm.Target == "services" {
				// Handle services as a sub-mapping array
				services = s.extractXMLServices(host, fm)
				continue
			}
			val := xmlExtractValue(host, fm.Source, fm.Filter)
			if val == "" && fm.Default != "" {
				val = fm.Default
			}
			if fm.Transform != "" {
				val = applyTransform(val, fm.Transform)
			}
			extracted[fm.Target] = val
		}

		// Check skip conditions
		if evaluateSkipConditions(def.SkipWhen, extracted) {
			result.HostsSkipped++
			continue
		}

		if extracted["ip_address"] == "" {
			result.HostsSkipped++
			continue
		}

		// Classify node type
		nodeType := evaluateNodeTypeRules(def.NodeTypeRules, extracted, services)

		// Upsert node
		nodeID, _, err := s.upsertParsedNode(ctx, networkID, extracted, services, nodeType)
		if err != nil {
			s.logger.Error("parser engine: upsert node failed", "error", err)
			continue
		}
		_ = nodeID
		result.NodesCreated++
	}

	// Process edge mappings (e.g. traceroute hops)
	for _, em := range def.EdgeMappings {
		for _, host := range hosts {
			hopElements := xmlNavigate(host, em.Source)
			if len(hopElements) < 2 {
				continue
			}
			for i := 0; i < len(hopElements)-1; i++ {
				srcIP := hopElements[i].Attrs[em.SourceIP]
				dstIP := hopElements[i+1].Attrs[em.TargetIP]
				if srcIP == "" || dstIP == "" || srcIP == "*" || dstIP == "*" {
					continue
				}
				edgeType := em.EdgeType
				if edgeType == "" {
					edgeType = "network_adjacency"
				}
				srcNodeID := s.findOrCreateNode(ctx, networkID, srcIP, "router")
				dstNodeID := s.findOrCreateNode(ctx, networkID, dstIP, "")
				if srcNodeID != "" && dstNodeID != "" {
					if err := s.createEdgeIfNotExists(ctx, networkID, srcNodeID, dstNodeID, edgeType, 0.95, "import"); err == nil {
						result.EdgesCreated++
					}
				}
			}
		}
	}

	// Run subnet edge generation if configured
	if def.EdgeGeneration != nil && def.EdgeGeneration.Strategy == "subnet" {
		s.generateSubnetEdges(ctx, networkID)
	}

	return result, nil
}

// extractXMLServices handles the services sub-mapping for XML hosts.
func (s *Server) extractXMLServices(host XMLElement, fm FieldMapping) []map[string]any {
	var services []map[string]any

	// Navigate to the container of service items
	elements := xmlNavigate(host, fm.Source)
	for _, el := range elements {
		svc := make(map[string]any)
		for _, sub := range fm.SubMappings {
			val := xmlExtractValue(el, sub.Source, sub.Filter)
			if val == "" && sub.Default != "" {
				val = sub.Default
			}
			if sub.Transform != "" {
				val = applyTransform(val, sub.Transform)
			}
			// Convert numeric fields
			if sub.Transform == "to_integer" {
				if v, err := strconv.Atoi(val); err == nil {
					svc[sub.Target] = v
					continue
				}
			}
			svc[sub.Target] = val
		}
		if len(svc) > 0 {
			services = append(services, svc)
		}
	}
	return services
}

// executeJSONParser processes JSON data using a ParserDefinition.
func (s *Server) executeJSONParser(ctx context.Context, networkID string, data []byte, def ParserDefinition) (ImportResult, error) {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return ImportResult{}, fmt.Errorf("parse JSON: %w", err)
	}

	result := ImportResult{Format: "json"}

	// Navigate to root path
	items := jsonNavigateToArray(raw, def.RootPath)
	if items == nil {
		return ImportResult{}, fmt.Errorf("root_path %q did not resolve to an array", def.RootPath)
	}

	result.TotalHosts = len(items)

	for _, item := range items {
		obj, ok := item.(map[string]any)
		if !ok {
			result.HostsSkipped++
			continue
		}

		extracted := make(map[string]string)
		var services []map[string]any

		for _, fm := range def.FieldMappings {
			if fm.Target == "services" {
				services = extractJSONServices(obj, fm)
				continue
			}
			val := jsonExtractValue(obj, fm.Source)
			if val == "" && fm.Default != "" {
				val = fm.Default
			}
			if fm.Transform != "" {
				val = applyTransform(val, fm.Transform)
			}
			extracted[fm.Target] = val
		}

		if evaluateSkipConditions(def.SkipWhen, extracted) {
			result.HostsSkipped++
			continue
		}

		if extracted["ip_address"] == "" {
			result.HostsSkipped++
			continue
		}

		nodeType := evaluateNodeTypeRules(def.NodeTypeRules, extracted, services)

		_, _, err := s.upsertParsedNode(ctx, networkID, extracted, services, nodeType)
		if err != nil {
			s.logger.Error("parser engine JSON: upsert node failed", "error", err)
			continue
		}
		result.NodesCreated++
	}

	// Edge generation
	if def.EdgeGeneration != nil && def.EdgeGeneration.Strategy == "subnet" {
		s.generateSubnetEdges(ctx, networkID)
	}

	return result, nil
}

// jsonNavigateToArray walks a dot-separated path through nested maps/arrays
// and returns the result as a slice.
func jsonNavigateToArray(raw any, path string) []any {
	if path == "" {
		if arr, ok := raw.([]any); ok {
			return arr
		}
		// If the root is an object with a single array value, try that
		if obj, ok := raw.(map[string]any); ok {
			for _, v := range obj {
				if arr, ok := v.([]any); ok {
					return arr
				}
			}
		}
		return nil
	}

	parts := strings.Split(path, ".")
	current := raw
	for _, p := range parts {
		switch v := current.(type) {
		case map[string]any:
			current = v[p]
		default:
			return nil
		}
	}

	if arr, ok := current.([]any); ok {
		return arr
	}
	return nil
}

// jsonExtractValue extracts a string value from a JSON object using a
// dot-separated path.
func jsonExtractValue(obj map[string]any, source string) string {
	if source == "" {
		return ""
	}

	parts := strings.Split(source, ".")
	var current any = obj

	for _, p := range parts {
		switch v := current.(type) {
		case map[string]any:
			current = v[p]
		default:
			return ""
		}
	}

	switch v := current.(type) {
	case string:
		return v
	case float64:
		if v == float64(int(v)) {
			return strconv.Itoa(int(v))
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	case nil:
		return ""
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// extractJSONServices handles the services sub-mapping for JSON records.
func extractJSONServices(obj map[string]any, fm FieldMapping) []map[string]any {
	val := obj
	// Navigate to the source array
	parts := strings.Split(fm.Source, ".")
	var current any = val
	for _, p := range parts {
		switch v := current.(type) {
		case map[string]any:
			current = v[p]
		default:
			return nil
		}
	}

	arr, ok := current.([]any)
	if !ok {
		return nil
	}

	var services []map[string]any
	for _, item := range arr {
		itemObj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		svc := make(map[string]any)
		for _, sub := range fm.SubMappings {
			sv := jsonExtractValue(itemObj, sub.Source)
			if sv == "" && sub.Default != "" {
				sv = sub.Default
			}
			if sub.Transform == "to_integer" {
				if v, err := strconv.Atoi(sv); err == nil {
					svc[sub.Target] = v
					continue
				}
			}
			svc[sub.Target] = sv
		}
		if len(svc) > 0 {
			services = append(services, svc)
		}
	}
	return services
}

// executeCSVParser processes CSV/TSV data using a ParserDefinition.
func (s *Server) executeCSVParser(ctx context.Context, networkID string, data []byte, def ParserDefinition) (ImportResult, error) {
	format := "csv"
	separator := ','
	if def.Separator == "\t" || def.Separator == "tab" {
		separator = '\t'
		format = "tsv"
	} else if def.Separator != "" && len(def.Separator) == 1 {
		separator = rune(def.Separator[0])
	}

	result := ImportResult{Format: format}

	// Pre-filter: skip comment lines and blank lines
	var cleanLines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	commentPrefix := def.CommentPrefix
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if commentPrefix != "" && strings.HasPrefix(trimmed, commentPrefix) {
			continue
		}
		cleanLines = append(cleanLines, line)
	}

	if len(cleanLines) == 0 {
		return result, nil
	}

	// Parse using encoding/csv
	csvReader := csv.NewReader(strings.NewReader(strings.Join(cleanLines, "\n")))
	csvReader.Comma = separator
	csvReader.LazyQuotes = true
	csvReader.TrimLeadingSpace = true

	records, err := csvReader.ReadAll()
	if err != nil {
		return ImportResult{}, fmt.Errorf("parse CSV/TSV: %w", err)
	}

	if len(records) == 0 {
		return result, nil
	}

	// Determine header
	var headers []string
	if def.HeaderLine != "" {
		// Use explicit header definition
		headerReader := csv.NewReader(strings.NewReader(def.HeaderLine))
		headerReader.Comma = separator
		headerRow, err := headerReader.Read()
		if err == nil {
			headers = headerRow
		}
	}
	if headers == nil {
		// Use first row as header
		headers = records[0]
		records = records[1:]
	}

	// Normalize headers
	for i, h := range headers {
		headers[i] = strings.TrimSpace(h)
	}

	// Build column index
	colIndex := make(map[string]int, len(headers))
	for i, h := range headers {
		colIndex[h] = i
	}

	result.TotalHosts = len(records)

	for _, row := range records {
		extracted := make(map[string]string)
		var services []map[string]any

		for _, fm := range def.FieldMappings {
			if fm.Target == "services" {
				// For CSV, services can be a semicolon-delimited string in a single column
				idx, ok := colIndex[fm.Source]
				if ok && idx < len(row) {
					val := strings.TrimSpace(row[idx])
					if val != "" {
						// Try to parse as JSON array
						var svcList []map[string]any
						if json.Unmarshal([]byte(val), &svcList) == nil {
							services = svcList
						}
					}
				}
				continue
			}

			idx, ok := colIndex[fm.Source]
			if !ok || idx >= len(row) {
				if fm.Default != "" {
					extracted[fm.Target] = fm.Default
				}
				continue
			}
			val := strings.TrimSpace(row[idx])
			if val == "" && fm.Default != "" {
				val = fm.Default
			}
			if fm.Transform != "" {
				val = applyTransform(val, fm.Transform)
			}
			extracted[fm.Target] = val
		}

		if evaluateSkipConditions(def.SkipWhen, extracted) {
			result.HostsSkipped++
			continue
		}

		if extracted["ip_address"] == "" {
			result.HostsSkipped++
			continue
		}

		nodeType := evaluateNodeTypeRules(def.NodeTypeRules, extracted, services)

		_, _, err := s.upsertParsedNode(ctx, networkID, extracted, services, nodeType)
		if err != nil {
			s.logger.Error("parser engine CSV: upsert node failed", "error", err)
			continue
		}
		result.NodesCreated++
	}

	// Edge generation
	if def.EdgeGeneration != nil && def.EdgeGeneration.Strategy == "subnet" {
		s.generateSubnetEdges(ctx, networkID)
	}

	return result, nil
}

// ---------------------------------------------------------------------------
// Nmap XML import (legacy/fallback)
// ---------------------------------------------------------------------------

func (s *Server) importNmapXML(ctx context.Context, networkID string, data []byte) (ImportResult, error) {
	var nmapRun NmapRun
	if err := xml.Unmarshal(data, &nmapRun); err != nil {
		return ImportResult{}, fmt.Errorf("parse nmap XML: %w", err)
	}

	result := ImportResult{Format: "nmap", TotalHosts: len(nmapRun.Hosts)}

	for _, host := range nmapRun.Hosts {
		// Skip hosts that aren't "up"
		if host.Status.State != "up" {
			result.HostsSkipped++
			continue
		}

		// Extract IPv4 address
		var ipAddr, macAddr, vendor string
		for _, addr := range host.Addresses {
			switch addr.AddrType {
			case "ipv4", "ipv6":
				if ipAddr == "" {
					ipAddr = addr.Addr
				}
			case "mac":
				macAddr = addr.Addr
				vendor = addr.Vendor
			}
		}
		if ipAddr == "" {
			result.HostsSkipped++
			continue
		}

		// Extract hostname
		var hostname string
		for _, h := range host.Hostnames.Names {
			hostname = h.Name
			break
		}

		// Extract OS (highest accuracy match)
		var osName, osVersion string
		bestAccuracy := 0
		for _, m := range host.OS.Matches {
			if m.Accuracy > bestAccuracy {
				osName = m.Name
				bestAccuracy = m.Accuracy
			}
		}
		// Also check service OS type as fallback
		if osName == "" {
			for _, p := range host.Ports.Ports {
				if p.Service.OSType != "" {
					osName = p.Service.OSType
					break
				}
			}
		}
		if osName == "" {
			osName = "unknown"
		}

		// Extract services from open ports
		var services []map[string]any
		for _, p := range host.Ports.Ports {
			if p.State.State != "open" {
				continue
			}
			svc := map[string]any{
				"port":     p.PortID,
				"protocol": p.Protocol,
				"state":    p.State.State,
				"service":  p.Service.Name,
			}
			if p.Service.Product != "" {
				svc["product"] = p.Service.Product
			}
			if p.Service.Version != "" {
				svc["version"] = p.Service.Version
			}
			services = append(services, svc)
		}
		if services == nil {
			services = []map[string]any{}
		}

		servicesJSON, _ := json.Marshal(services)

		nodeType := classifyNodeType(services, osName, vendor)

		// Build metadata
		metadata := map[string]any{}
		if vendor != "" {
			metadata["mac_vendor"] = vendor
		}
		if bestAccuracy > 0 {
			metadata["os_accuracy"] = bestAccuracy
		}
		metadataJSON, _ := json.Marshal(metadata)

		// Upsert node (ON CONFLICT update)
		var nodeID string
		err := s.db.QueryRow(ctx, `
			INSERT INTO network_nodes (network_id, ip_address, hostname, mac_address, os, os_version, status, node_type, services, metadata)
			VALUES ($1, $2, $3, NULLIF($4,''), $5, $6, 'alive', $7, $8::jsonb, $9::jsonb)
			ON CONFLICT (network_id, ip_address) DO UPDATE SET
				hostname = CASE WHEN EXCLUDED.hostname != '' THEN EXCLUDED.hostname ELSE network_nodes.hostname END,
				mac_address = COALESCE(EXCLUDED.mac_address, network_nodes.mac_address),
				os = CASE WHEN EXCLUDED.os != 'unknown' THEN EXCLUDED.os ELSE network_nodes.os END,
				services = EXCLUDED.services,
				metadata = network_nodes.metadata || EXCLUDED.metadata,
				updated_at = NOW()
			RETURNING id
		`, networkID, ipAddr, hostname, macAddr, osName, osVersion, nodeType, string(servicesJSON), string(metadataJSON)).Scan(&nodeID)

		if err != nil {
			s.logger.Error("upsert node failed", "ip", ipAddr, "error", err)
			continue
		}

		// Track enrichment source
		enrichment := map[string]any{
			"source":         "nmap",
			"imported_at":    time.Now().UTC().Format(time.RFC3339),
			"fields_updated": []string{"ip_address", "hostname", "os", "services"},
		}
		enrichmentJSON, _ := json.Marshal(enrichment)
		_, _ = s.db.Exec(ctx, `
			UPDATE network_nodes SET
				metadata = jsonb_set(
					COALESCE(metadata, '{}'),
					'{enrichment_sources}',
					COALESCE(metadata->'enrichment_sources', '[]'::jsonb) || $1::jsonb
				)
			WHERE id = $2
		`, string(enrichmentJSON), nodeID)

		result.NodesCreated++
	}

	// Auto-generate edges from subnet CIDR ranges
	s.generateSubnetEdges(ctx, networkID)

	// Process traceroute data to infer network adjacency edges
	for _, host := range nmapRun.Hosts {
		if len(host.Trace.Hops) < 2 {
			continue
		}
		for i := 0; i < len(host.Trace.Hops)-1; i++ {
			srcIP := host.Trace.Hops[i].IPAddr
			dstIP := host.Trace.Hops[i+1].IPAddr
			if srcIP == "" || dstIP == "" || srcIP == "*" || dstIP == "*" {
				continue
			}
			srcNodeID := s.findOrCreateNode(ctx, networkID, srcIP, "router")
			dstNodeID := s.findOrCreateNode(ctx, networkID, dstIP, "")
			if srcNodeID != "" && dstNodeID != "" {
				_ = s.createEdgeIfNotExists(ctx, networkID, srcNodeID, dstNodeID, "network_adjacency", 0.95, "import")
			}
		}
	}

	return result, nil
}

// ---------------------------------------------------------------------------
// Edge + Node helpers for auto-generation
// ---------------------------------------------------------------------------

// createEdgeIfNotExists inserts a network edge if one does not already exist
// between the given source and target nodes in the specified network.
func (s *Server) createEdgeIfNotExists(ctx context.Context, networkID, srcID, dstID, edgeType string, confidence float64, discoveredBy string) error {
	var existingID string
	err := s.db.QueryRow(ctx,
		`SELECT id FROM network_edges WHERE network_id=$1 AND source_node_id=$2 AND target_node_id=$3`,
		networkID, srcID, dstID,
	).Scan(&existingID)
	if err == nil {
		// Edge already exists
		return nil
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO network_edges (network_id, source_node_id, target_node_id, edge_type, confidence, discovered_by)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, networkID, srcID, dstID, edgeType, confidence, discoveredBy)
	if err != nil {
		s.logger.Error("create edge failed", "src", srcID, "dst", dstID, "error", err)
		return fmt.Errorf("create edge: %w", err)
	}
	return nil
}

// generateSubnetEdges creates network_adjacency edges for nodes that share a
// subnet, based on the network's configured CIDR ranges.
func (s *Server) generateSubnetEdges(ctx context.Context, networkID string) {
	// 1. Query CIDR ranges for this network
	var cidrRanges []string
	err := s.db.QueryRow(ctx,
		`SELECT cidr_ranges FROM networks WHERE id=$1`, networkID,
	).Scan(&cidrRanges)
	if err != nil {
		s.logger.Warn("generateSubnetEdges: could not load CIDR ranges", "network_id", networkID, "error", err)
		return
	}
	if len(cidrRanges) == 0 {
		return
	}

	// 2. Load all nodes for this network
	type nodeInfo struct {
		ID       string
		IP       string
		NodeType string
	}
	rows, err := s.db.Query(ctx,
		`SELECT id, ip_address, node_type FROM network_nodes WHERE network_id=$1`, networkID,
	)
	if err != nil {
		s.logger.Error("generateSubnetEdges: query nodes failed", "error", err)
		return
	}
	defer rows.Close()

	var allNodes []nodeInfo
	for rows.Next() {
		var n nodeInfo
		if err := rows.Scan(&n.ID, &n.IP, &n.NodeType); err != nil {
			s.logger.Error("generateSubnetEdges: scan node failed", "error", err)
			continue
		}
		allNodes = append(allNodes, n)
	}

	// 3. For each CIDR range, group nodes whose IP falls within it
	for _, cidrStr := range cidrRanges {
		_, subnet, err := net.ParseCIDR(cidrStr)
		if err != nil {
			s.logger.Warn("generateSubnetEdges: invalid CIDR", "cidr", cidrStr, "error", err)
			continue
		}

		var subnetNodes []nodeInfo
		for _, n := range allNodes {
			ip := net.ParseIP(n.IP)
			if ip != nil && subnet.Contains(ip) {
				subnetNodes = append(subnetNodes, n)
			}
		}

		if len(subnetNodes) < 2 {
			continue
		}

		// 4. Find gateway node (router or firewall)
		var gatewayNode *nodeInfo
		for i, n := range subnetNodes {
			if n.NodeType == "router" || n.NodeType == "firewall" {
				gatewayNode = &subnetNodes[i]
				break
			}
		}

		if gatewayNode != nil {
			// Create edges from gateway to all other nodes in subnet
			for _, n := range subnetNodes {
				if n.ID == gatewayNode.ID {
					continue
				}
				_ = s.createEdgeIfNotExists(ctx, networkID, gatewayNode.ID, n.ID, "network_adjacency", 0.7, "import")
			}
		} else if len(subnetNodes) < 6 {
			// Star topology with first node as center
			center := subnetNodes[0]
			for _, n := range subnetNodes[1:] {
				_ = s.createEdgeIfNotExists(ctx, networkID, center.ID, n.ID, "network_adjacency", 0.7, "import")
			}
		}
		// If no gateway and >= 6 nodes, skip to avoid mesh explosion
	}

	s.logger.Info("generateSubnetEdges completed", "network_id", networkID)
}

// findOrCreateNode looks up a node by IP in the given network, creating it if
// it does not exist. Returns the node ID or empty string on failure.
func (s *Server) findOrCreateNode(ctx context.Context, networkID, ip, defaultType string) string {
	var nodeID string
	err := s.db.QueryRow(ctx,
		`SELECT id FROM network_nodes WHERE network_id=$1 AND ip_address=$2`,
		networkID, ip,
	).Scan(&nodeID)
	if err == nil {
		return nodeID
	}

	// Node not found — create it
	nodeType := defaultType
	if nodeType == "" {
		nodeType = "host"
	}

	err = s.db.QueryRow(ctx, `
		INSERT INTO network_nodes (network_id, ip_address, hostname, os, status, node_type, services, metadata)
		VALUES ($1, $2, '', 'unknown', 'discovered', $3, '[]'::jsonb, '{}'::jsonb)
		RETURNING id
	`, networkID, ip, nodeType).Scan(&nodeID)
	if err != nil {
		s.logger.Error("findOrCreateNode: insert failed", "ip", ip, "error", err)
		return ""
	}
	return nodeID
}

// ---------------------------------------------------------------------------
// Handlers — Display Schemas
// ---------------------------------------------------------------------------

func scanDisplaySchema(scanner interface{ Scan(dest ...any) error }) (DisplaySchema, error) {
	var ds DisplaySchema
	var (
		definition []byte
		createdBy  *string
		createdAt  time.Time
		updatedAt  time.Time
	)
	err := scanner.Scan(&ds.ID, &ds.Name, &ds.SchemaType, &definition, &ds.IsDefault, &createdBy, &createdAt, &updatedAt)
	if err != nil {
		return ds, err
	}
	ds.Definition = parseJSONB(definition)
	ds.CreatedBy = createdBy
	ds.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	ds.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return ds, nil
}

func (s *Server) handleListDisplaySchemas(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT id, name, schema_type, definition, is_default, created_by, created_at, updated_at
		 FROM display_schemas ORDER BY created_at DESC`)
	if err != nil {
		s.logger.Error("list display schemas failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to query display schemas")
		return
	}
	defer rows.Close()

	var schemas []DisplaySchema
	for rows.Next() {
		ds, err := scanDisplaySchema(rows)
		if err != nil {
			s.logger.Error("scan display schema failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan display schema")
			return
		}
		schemas = append(schemas, ds)
	}
	if schemas == nil {
		schemas = []DisplaySchema{}
	}

	writeJSON(w, http.StatusOK, schemas)
}

func (s *Server) handleGetDisplaySchema(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	row := s.db.QueryRow(r.Context(),
		`SELECT id, name, schema_type, definition, is_default, created_by, created_at, updated_at
		 FROM display_schemas WHERE id = $1`, id)
	ds, err := scanDisplaySchema(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Display schema not found")
			return
		}
		s.logger.Error("get display schema failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get display schema")
		return
	}

	writeJSON(w, http.StatusOK, ds)
}

func (s *Server) handleCreateDisplaySchema(w http.ResponseWriter, r *http.Request) {
	var req CreateDisplaySchemaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")
		return
	}
	if req.SchemaType == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "schema_type is required")
		return
	}

	definitionBytes := marshalJSONB(req.Definition)
	if definitionBytes == nil {
		definitionBytes = []byte("{}")
	}

	userID := getUserID(r)

	var dsID string
	err := s.db.QueryRow(r.Context(),
		`INSERT INTO display_schemas (name, schema_type, definition, is_default, created_by)
		 VALUES ($1, $2, $3, false, $4) RETURNING id`,
		req.Name, req.SchemaType, definitionBytes, userID).Scan(&dsID)
	if err != nil {
		s.logger.Error("create display schema failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create display schema")
		return
	}

	row := s.db.QueryRow(r.Context(),
		`SELECT id, name, schema_type, definition, is_default, created_by, created_at, updated_at
		 FROM display_schemas WHERE id = $1`, dsID)
	ds, err := scanDisplaySchema(row)
	if err != nil {
		s.logger.Error("fetch created display schema failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch created display schema")
		return
	}

	s.publishEvent("display_schema.created", ds)
	writeJSON(w, http.StatusCreated, ds)
}

func (s *Server) handleUpdateDisplaySchema(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Check if schema is a default — immutable
	var isDefault bool
	err := s.db.QueryRow(r.Context(),
		`SELECT is_default FROM display_schemas WHERE id = $1`, id).Scan(&isDefault)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Display schema not found")
			return
		}
		s.logger.Error("check display schema default failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to check display schema")
		return
	}
	if isDefault {
		writeError(w, http.StatusForbidden, "IMMUTABLE", "Default schemas cannot be modified. Clone it instead.")
		return
	}

	var req UpdateDisplaySchemaRequest
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
	if req.SchemaType != nil {
		setClauses = append(setClauses, fmt.Sprintf("schema_type = $%d", argIdx))
		args = append(args, *req.SchemaType)
		argIdx++
	}
	if req.Definition != nil {
		defBytes := marshalJSONB(req.Definition)
		setClauses = append(setClauses, fmt.Sprintf("definition = $%d", argIdx))
		args = append(args, defBytes)
		argIdx++
	}

	if len(setClauses) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "No fields to update")
		return
	}

	setClauses = append(setClauses, "updated_at = NOW()")

	query := fmt.Sprintf("UPDATE display_schemas SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), argIdx)
	args = append(args, id)

	result, err := s.db.Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update display schema failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update display schema")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Display schema not found")
		return
	}

	row := s.db.QueryRow(r.Context(),
		`SELECT id, name, schema_type, definition, is_default, created_by, created_at, updated_at
		 FROM display_schemas WHERE id = $1`, id)
	ds, err := scanDisplaySchema(row)
	if err != nil {
		s.logger.Error("fetch updated display schema failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated display schema")
		return
	}

	s.publishEvent("display_schema.updated", ds)
	writeJSON(w, http.StatusOK, ds)
}

func (s *Server) handleDeleteDisplaySchema(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Check if schema is a default — immutable
	var isDefault bool
	err := s.db.QueryRow(r.Context(),
		`SELECT is_default FROM display_schemas WHERE id = $1`, id).Scan(&isDefault)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Display schema not found")
			return
		}
		s.logger.Error("check display schema default failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to check display schema")
		return
	}
	if isDefault {
		writeError(w, http.StatusForbidden, "IMMUTABLE", "Default schemas cannot be modified. Clone it instead.")
		return
	}

	result, err := s.db.Exec(r.Context(), "DELETE FROM display_schemas WHERE id = $1", id)
	if err != nil {
		s.logger.Error("delete display schema failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to delete display schema")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Display schema not found")
		return
	}

	s.publishEvent("display_schema.deleted", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Handlers — Import Parsers
// ---------------------------------------------------------------------------

func scanImportParser(scanner interface{ Scan(dest ...any) error }) (ImportParser, error) {
	var p ImportParser
	var (
		definition []byte
		sampleData *string
		createdBy  *string
		createdAt  time.Time
		updatedAt  time.Time
	)
	err := scanner.Scan(&p.ID, &p.Name, &p.Description, &p.Format, &p.Version,
		&definition, &sampleData, &p.IsDefault, &createdBy, &createdAt, &updatedAt)
	if err != nil {
		return p, err
	}
	p.Definition = parseJSONB(definition)
	if sampleData != nil {
		p.SampleData = *sampleData
	}
	if createdBy != nil {
		p.CreatedBy = *createdBy
	}
	p.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	p.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return p, nil
}

const importParserSelectCols = `id, name, description, format, version, definition, sample_data, is_default, created_by, created_at, updated_at`

func (s *Server) handleListImportParsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		fmt.Sprintf(`SELECT %s FROM import_parsers ORDER BY created_at DESC`, importParserSelectCols))
	if err != nil {
		s.logger.Error("list import parsers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to query import parsers")
		return
	}
	defer rows.Close()

	var parsers []ImportParser
	for rows.Next() {
		p, err := scanImportParser(rows)
		if err != nil {
			s.logger.Error("scan import parser failed", "error", err)
			writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to scan import parser")
			return
		}
		parsers = append(parsers, p)
	}
	if parsers == nil {
		parsers = []ImportParser{}
	}

	writeJSON(w, http.StatusOK, parsers)
}

func (s *Server) handleGetImportParser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	row := s.db.QueryRow(r.Context(),
		fmt.Sprintf(`SELECT %s FROM import_parsers WHERE id = $1`, importParserSelectCols), id)
	p, err := scanImportParser(row)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Import parser not found")
			return
		}
		s.logger.Error("get import parser failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to get import parser")
		return
	}

	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleCreateImportParser(w http.ResponseWriter, r *http.Request) {
	var req CreateImportParserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "Failed to parse request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")
		return
	}
	if req.Format == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "format is required")
		return
	}
	if !validImportParserFormats[req.Format] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			"Invalid format. Must be one of: xml, json, csv, tsv, custom")
		return
	}

	definitionBytes := marshalJSONB(req.Definition)
	if definitionBytes == nil {
		definitionBytes = []byte("{}")
	}

	userID := getUserID(r)

	var sampleData *string
	if req.SampleData != "" {
		sampleData = &req.SampleData
	}

	var parserID string
	err := s.db.QueryRow(r.Context(),
		`INSERT INTO import_parsers (name, description, format, definition, sample_data, is_default, created_by)
		 VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
		req.Name, req.Description, req.Format, definitionBytes, sampleData, userID).Scan(&parserID)
	if err != nil {
		s.logger.Error("create import parser failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to create import parser")
		return
	}

	row := s.db.QueryRow(r.Context(),
		fmt.Sprintf(`SELECT %s FROM import_parsers WHERE id = $1`, importParserSelectCols), parserID)
	p, err := scanImportParser(row)
	if err != nil {
		s.logger.Error("fetch created import parser failed", "error", err)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch created import parser")
		return
	}

	s.publishEvent("import_parser.created", p)
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) handleUpdateImportParser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Check if parser is a default — immutable
	var isDefault bool
	err := s.db.QueryRow(r.Context(),
		`SELECT is_default FROM import_parsers WHERE id = $1`, id).Scan(&isDefault)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Import parser not found")
			return
		}
		s.logger.Error("check import parser default failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to check import parser")
		return
	}
	if isDefault {
		writeError(w, http.StatusForbidden, "IMMUTABLE", "Default parsers cannot be modified. Clone it instead.")
		return
	}

	var req UpdateImportParserRequest
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
	if req.Description != nil {
		setClauses = append(setClauses, fmt.Sprintf("description = $%d", argIdx))
		args = append(args, *req.Description)
		argIdx++
	}
	if req.Format != nil {
		if !validImportParserFormats[*req.Format] {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
				"Invalid format. Must be one of: xml, json, csv, tsv, custom")
			return
		}
		setClauses = append(setClauses, fmt.Sprintf("format = $%d", argIdx))
		args = append(args, *req.Format)
		argIdx++
	}
	if req.Definition != nil {
		defBytes := marshalJSONB(req.Definition)
		setClauses = append(setClauses, fmt.Sprintf("definition = $%d", argIdx))
		args = append(args, defBytes)
		argIdx++
	}
	if req.SampleData != nil {
		setClauses = append(setClauses, fmt.Sprintf("sample_data = $%d", argIdx))
		args = append(args, *req.SampleData)
		argIdx++
	}

	if len(setClauses) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "No fields to update")
		return
	}

	setClauses = append(setClauses, "updated_at = NOW()")

	query := fmt.Sprintf("UPDATE import_parsers SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), argIdx)
	args = append(args, id)

	result, err := s.db.Exec(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("update import parser failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to update import parser")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Import parser not found")
		return
	}

	row := s.db.QueryRow(r.Context(),
		fmt.Sprintf(`SELECT %s FROM import_parsers WHERE id = $1`, importParserSelectCols), id)
	p, err := scanImportParser(row)
	if err != nil {
		s.logger.Error("fetch updated import parser failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to fetch updated import parser")
		return
	}

	s.publishEvent("import_parser.updated", p)
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleDeleteImportParser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Check if parser is a default — immutable
	var isDefault bool
	err := s.db.QueryRow(r.Context(),
		`SELECT is_default FROM import_parsers WHERE id = $1`, id).Scan(&isDefault)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Import parser not found")
			return
		}
		s.logger.Error("check import parser default failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to check import parser")
		return
	}
	if isDefault {
		writeError(w, http.StatusForbidden, "IMMUTABLE", "Default parsers cannot be deleted.")
		return
	}

	result, err := s.db.Exec(r.Context(), "DELETE FROM import_parsers WHERE id = $1", id)
	if err != nil {
		s.logger.Error("delete import parser failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to delete import parser")
		return
	}
	if result.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Import parser not found")
		return
	}

	s.publishEvent("import_parser.deleted", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTestImportParser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id is required")
		return
	}

	// Verify parser exists
	var parserName string
	err := s.db.QueryRow(r.Context(),
		`SELECT name FROM import_parsers WHERE id = $1`, id).Scan(&parserName)
	if err != nil {
		if err.Error() == "no rows in result set" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Import parser not found")
			return
		}
		s.logger.Error("check import parser for test failed", "error", err, "id", id)
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "Failed to check import parser")
		return
	}

	// Parse multipart form (max 10MB for test files)
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid multipart form: "+err.Error())
		return
	}

	_, _, err = r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing 'file' field")
		return
	}

	// Stub response — actual parsing logic to be implemented later
	writeJSON(w, http.StatusOK, map[string]string{
		"preview":   "Test endpoint placeholder",
		"parser_id": id,
	})
}

// ---------------------------------------------------------------------------
// Server startup
// ── Endpoints (managed targets) ─────────────────────────────────────────

func (s *Server) handleListEndpoints(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT e.id, e.hostname, e.fqdn, e.ip_addresses, e.os, e.os_version,
		       e.architecture, e.environment, e.status, e.compliance_status,
		       e.tags, e.first_seen, e.last_seen
		FROM endpoints e
		ORDER BY e.hostname ASC`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "QUERY_FAILED", "message": err.Error()}})
		return
	}
	defer rows.Close()

	type Endpoint struct {
		ID               string    `json:"id"`
		Hostname         string    `json:"hostname"`
		FQDN             *string   `json:"fqdn"`
		IPAddresses      any       `json:"ip_addresses"`
		OS               string    `json:"os"`
		OSVersion        string    `json:"os_version"`
		Architecture     string    `json:"architecture"`
		Environment      string    `json:"environment"`
		Status           string    `json:"health_status"`
		ComplianceStatus string    `json:"compliance_status"`
		Tags             []string  `json:"tags"`
		FirstSeen        time.Time `json:"first_seen"`
		LastSeen         time.Time `json:"last_seen"`
	}

	var endpoints []Endpoint
	for rows.Next() {
		var ep Endpoint
		var ipJSON []byte
		var tags []string
		if err := rows.Scan(&ep.ID, &ep.Hostname, &ep.FQDN, &ipJSON, &ep.OS, &ep.OSVersion,
			&ep.Architecture, &ep.Environment, &ep.Status, &ep.ComplianceStatus,
			&tags, &ep.FirstSeen, &ep.LastSeen); err != nil {
			s.logger.Error("scan endpoint", "error", err)
			continue
		}
		json.Unmarshal(ipJSON, &ep.IPAddresses)
		ep.Tags = tags
		endpoints = append(endpoints, ep)
	}
	if endpoints == nil {
		endpoints = []Endpoint{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": endpoints})
}

func (s *Server) handleGetEndpoint(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	type Endpoint struct {
		ID               string    `json:"id"`
		Hostname         string    `json:"hostname"`
		FQDN             *string   `json:"fqdn"`
		IPAddresses      any       `json:"ip_addresses"`
		OS               string    `json:"os"`
		OSVersion        string    `json:"os_version"`
		Architecture     string    `json:"architecture"`
		Environment      string    `json:"environment"`
		Status           string    `json:"health_status"`
		ComplianceStatus string    `json:"compliance_status"`
		Tags             []string  `json:"tags"`
		FirstSeen        time.Time `json:"first_seen"`
		LastSeen         time.Time `json:"last_seen"`
	}

	var ep Endpoint
	var ipJSON []byte
	var tags []string
	err := s.db.QueryRow(r.Context(), `
		SELECT id, hostname, fqdn, ip_addresses, os, os_version,
		       architecture, environment, status, compliance_status,
		       tags, first_seen, last_seen
		FROM endpoints WHERE id = $1`, id).
		Scan(&ep.ID, &ep.Hostname, &ep.FQDN, &ipJSON, &ep.OS, &ep.OSVersion,
			&ep.Architecture, &ep.Environment, &ep.Status, &ep.ComplianceStatus,
			&tags, &ep.FirstSeen, &ep.LastSeen)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "NOT_FOUND", "message": "endpoint not found"}})
		return
	}
	json.Unmarshal(ipJSON, &ep.IPAddresses)
	ep.Tags = tags
	writeJSON(w, http.StatusOK, ep)
}

// ---------------------------------------------------------------------------

func (s *Server) Start() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.handleHealth)

	// Networks
	mux.HandleFunc("POST /api/v1/networks", s.handleCreateNetwork)
	mux.HandleFunc("GET /api/v1/networks", s.handleListNetworks)
	mux.HandleFunc("GET /api/v1/networks/{id}", s.handleGetNetwork)
	mux.HandleFunc("PATCH /api/v1/networks/{id}", s.handleUpdateNetwork)
	mux.HandleFunc("DELETE /api/v1/networks/{id}", s.handleDeleteNetwork)
	mux.HandleFunc("GET /api/v1/networks/{id}/topology", s.handleGetTopology)
	mux.HandleFunc("POST /api/v1/networks/{id}/import", s.handleImportFile)

	// Nodes
	mux.HandleFunc("GET /api/v1/networks/{id}/nodes", s.handleListNodes)
	mux.HandleFunc("POST /api/v1/networks/{id}/nodes", s.handleCreateNode)
	mux.HandleFunc("PATCH /api/v1/nodes/{id}", s.handleUpdateNode)
	mux.HandleFunc("DELETE /api/v1/nodes/{id}", s.handleDeleteNode)

	// Edges
	mux.HandleFunc("GET /api/v1/networks/{id}/edges", s.handleListEdges)
	mux.HandleFunc("POST /api/v1/networks/{id}/edges", s.handleCreateEdge)
	mux.HandleFunc("DELETE /api/v1/edges/{id}", s.handleDeleteEdge)

	// Display Schemas
	// Endpoints (managed targets from PostgreSQL endpoints table)
	mux.HandleFunc("GET /api/v1/endpoints", s.handleListEndpoints)
	mux.HandleFunc("GET /api/v1/endpoints/{id}", s.handleGetEndpoint)

	mux.HandleFunc("GET /api/v1/display-schemas", s.handleListDisplaySchemas)
	mux.HandleFunc("GET /api/v1/display-schemas/{id}", s.handleGetDisplaySchema)
	mux.HandleFunc("POST /api/v1/display-schemas", s.handleCreateDisplaySchema)
	mux.HandleFunc("PATCH /api/v1/display-schemas/{id}", s.handleUpdateDisplaySchema)
	mux.HandleFunc("DELETE /api/v1/display-schemas/{id}", s.handleDeleteDisplaySchema)

	// Import Parsers
	mux.HandleFunc("GET /api/v1/import-parsers", s.handleListImportParsers)
	mux.HandleFunc("GET /api/v1/import-parsers/{id}", s.handleGetImportParser)
	mux.HandleFunc("POST /api/v1/import-parsers", s.handleCreateImportParser)
	mux.HandleFunc("PATCH /api/v1/import-parsers/{id}", s.handleUpdateImportParser)
	mux.HandleFunc("DELETE /api/v1/import-parsers/{id}", s.handleDeleteImportParser)
	mux.HandleFunc("POST /api/v1/import-parsers/{id}/test", s.handleTestImportParser)

	handler := maxBodyMiddleware(1<<20, mux) // 1 MB

	s.httpServer = &http.Server{
		Addr:         fmt.Sprintf(":%s", s.port),
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.logger.Info("starting endpoint-service", "port", s.port)
	if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
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

	port := getEnv("SERVICE_PORT", "3008")
	server := &Server{db: pool, nc: nc, port: port, logger: logger}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if server.httpServer != nil {
			server.httpServer.Shutdown(shutdownCtx)
		}
		if nc != nil {
			nc.Close()
		}
		pool.Close()
	}()

	server.Start()
}
