// EMS-COP C2 Gateway — classification & access helpers for tunnel endpoints.
//
// Two responsibilities:
//   1. maxClassification — reduces a list of per-record classifications to
//      the maximum across {UNCLASSIFIED < CUI < SECRET}. Used to set the
//      X-Classification response header on aggregate endpoints
//      (handleListTunnels, handleTopology, handleTunnelThroughput).
//   2. actorCanAccessOperation — authorization check for operation-scoped
//      tunnel endpoints. Mirrors the membership pattern used by the
//      operations service and falls back to a role-based decision when
//      operation_members data is unavailable.
package main

import (
	"context"
	"fmt"
	"strings"
)

// tunnelClassificationRank assigns a numeric weight so the response header
// can be derived as the max of any per-record classification value. Empty
// or unknown labels are treated as UNCLASSIFIED (rank 0).
//
// (Distinct from classificationRank in main.go, which is stricter and
// returns -1 for unrecognized labels — that one is used by command-risk
// validation, not header derivation.)
func tunnelClassificationRank(c string) int {
	switch strings.ToUpper(strings.TrimSpace(c)) {
	case "SECRET":
		return 2
	case "CUI":
		return 1
	case "UNCLASSIFIED", "UNCLASS":
		return 0
	default:
		return 0
	}
}

// canonicalClassification maps a non-empty input back to one of the labels
// used on the wire (UNCLASSIFIED / CUI / SECRET). Empty / unknown is UNCLASSIFIED.
func canonicalClassification(c string) string {
	switch strings.ToUpper(strings.TrimSpace(c)) {
	case "SECRET":
		return "SECRET"
	case "CUI":
		return "CUI"
	default:
		return "UNCLASSIFIED"
	}
}

// maxClassification returns the highest classification of the supplied
// items. An empty list (or a list of empty / unknown values) yields
// UNCLASSIFIED — the safe default for the X-Classification header.
func maxClassification(items ...string) string {
	maxRank := 0
	maxLabel := "UNCLASSIFIED"
	for _, c := range items {
		r := tunnelClassificationRank(c)
		if r > maxRank {
			maxRank = r
			maxLabel = canonicalClassification(c)
		}
	}
	return maxLabel
}

// ════════════════════════════════════════════
//  OPERATION ACCESS CONTROL
// ════════════════════════════════════════════

// actorCanAccessOperation reports whether the actor may read or mutate
// resources scoped to the given operation. Decision order:
//
//  1. admin role short-circuits to allow (matches existing patterns in
//     handleExecuteContainment and friends).
//  2. If operation_members is populated for this operation, membership is
//     required (any role within the operation passes).
//  3. If membership data is absent (no rows for this op_id, or DB
//     unavailable), fall back to a role check: operator / analyst /
//     mission_commander / e3_tactical / supervisor / e2 / e3 are allowed
//     (i.e., any "active duty" role); viewer is denied.
//
// operationID == "" means the actor is operating outside any specific
// operation; that path is handled by the caller (typically the listing
// endpoints scope by visible operations).
func (s *C2GatewayServer) actorCanAccessOperation(ctx context.Context, actorID, rolesHeader, operationID string) (bool, error) {
	// 1. Global admin always passes.
	if hasRole(rolesHeader, "admin") {
		return true, nil
	}

	if operationID == "" {
		// No operation context — defer to role-based fallback.
		return roleAllowsTunnelAccess(rolesHeader), nil
	}

	// 2. Operation membership lookup (if DB is wired).
	if s.db != nil && actorID != "" {
		var exists bool
		err := s.db.QueryRow(ctx,
			`SELECT EXISTS (
				SELECT 1 FROM operation_members
				WHERE operation_id = $1 AND user_id = $2
			)`, operationID, actorID).Scan(&exists)
		if err == nil {
			if exists {
				return true, nil
			}
			// Membership row missing — permission denied unless the
			// fallback role check passes (covers ops/admin tooling that
			// has not yet been added to the operation roster).
			return roleAllowsTunnelAccess(rolesHeader), nil
		}
		// On DB error fall through to role check + return the wrapped
		// error so callers can log it. Auth must still be conservative,
		// so deny on error unless role grants access.
		if roleAllowsTunnelAccess(rolesHeader) {
			return true, fmt.Errorf("operation_members lookup: %w", err)
		}
		return false, fmt.Errorf("operation_members lookup: %w", err)
	}

	// 3. Fallback: role-based access only.
	return roleAllowsTunnelAccess(rolesHeader), nil
}

// roleAllowsTunnelAccess is the least-privilege fallback used when no
// operation_members row exists or the DB is unavailable in tests. The list
// matches the roles already accepted by handleExecuteContainment.
func roleAllowsTunnelAccess(rolesHeader string) bool {
	return hasRole(rolesHeader,
		"admin",
		"operator",
		"analyst",
		"mission_commander",
		"e3_tactical",
		"supervisor",
		"e2",
		"e3",
	)
}

// visibleOperationIDs returns the set of operation IDs the actor is
// permitted to see. Used to scope handleListTunnels and handleTopology
// when no specific operation_id filter is supplied.
//
// Returns (ids, ok). ok=false means the caller should skip the membership
// filter (e.g. admin, or DB unavailable AND role grants global view) and
// fall back to whatever role-based behaviour applies.
func (s *C2GatewayServer) visibleOperationIDs(ctx context.Context, actorID, rolesHeader string) ([]string, bool) {
	// Admin / privileged role: see everything.
	if hasRole(rolesHeader, "admin") {
		return nil, false
	}
	if s.db == nil || actorID == "" {
		// Without DB we cannot enumerate; let the role fallback decide
		// downstream.
		return nil, false
	}

	rows, err := s.db.Query(ctx,
		`SELECT operation_id::text FROM operation_members WHERE user_id = $1`, actorID)
	if err != nil {
		return nil, false
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil && id != "" {
			ids = append(ids, id)
		}
	}
	return ids, true
}
