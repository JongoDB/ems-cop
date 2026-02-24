package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
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

type ImportResult struct {
	Format       string `json:"format"`
	NodesCreated int    `json:"nodes_created"`
	NodesUpdated int    `json:"nodes_updated"`
	TotalHosts   int    `json:"total_hosts"`
	HostsSkipped int    `json:"hosts_skipped"`
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

	// Detect format and parse
	var result ImportResult
	peekLen := len(data)
	if peekLen > 500 {
		peekLen = 500
	}
	if bytes.Contains(data[:peekLen], []byte("<nmaprun")) {
		result, err = s.importNmapXML(r.Context(), networkID, data)
	} else {
		writeError(w, 400, "UNSUPPORTED_FORMAT", "Only Nmap XML format is currently supported. File must contain <nmaprun> root element.")
		return
	}

	if err != nil {
		s.logger.Error("import failed", "error", err)
		writeError(w, 500, "IMPORT_FAILED", err.Error())
		return
	}

	// Update network import_source
	s.db.Exec(r.Context(), "UPDATE networks SET import_source = 'nmap' WHERE id = $1", networkID)

	// Publish event
	s.publishEvent("network.imported", map[string]any{
		"network_id":    networkID,
		"format":        "nmap",
		"nodes_created": result.NodesCreated,
		"nodes_updated": result.NodesUpdated,
	})

	writeJSON(w, 200, result)
}

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

		// Determine node_type heuristic
		nodeType := "host"
		for _, svc := range services {
			name, _ := svc["service"].(string)
			switch name {
			case "http", "https", "ssh", "mysql", "postgresql", "mssql", "oracle", "mongodb":
				nodeType = "server"
			}
		}

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
		result.NodesCreated++
	}

	return result, nil
}

// ---------------------------------------------------------------------------
// Server startup
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

	s.logger.Info("starting endpoint-service", "port", s.port)
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

	port := getEnv("SERVICE_PORT", "3008")
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
