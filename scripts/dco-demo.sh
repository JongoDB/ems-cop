#!/usr/bin/env bash
# =============================================================================
# dco-demo.sh — EMS-COP M13 DCO/SOC Feature Demonstration Script
# =============================================================================
#
# Demonstrates the full DCO/SOC (Defensive Cyberspace Operations / Security
# Operations Center) workflow end-to-end:
#
#   1. Authentication (login, token extraction)
#   2. Alert ingest (critical/high/medium with MITRE ATT&CK techniques)
#   3. IOC (Indicator of Compromise) creation and listing
#   4. Alert escalation to incident
#   5. Direct incident creation
#   6. Incident lifecycle: draft -> triage -> investigation -> containment
#      -> remediation -> post_incident_review -> closed
#   7. Containment action execution (isolate_host, block_ip)
#   8. Playbook listing
#   9. Incident statistics
#
# Usage:
#   ./scripts/dco-demo.sh [--base-url URL]
#
# Options:
#   --base-url URL   Base URL for the EMS-COP API (default: https://localhost)
#   --help           Show this help message
#
# Prerequisites:
#   - curl (required)
#   - jq (recommended, falls back to grep-based parsing)
#   - EMS-COP stack running (docker compose up -d)
#
# Examples:
#   ./scripts/dco-demo.sh
#   ./scripts/dco-demo.sh --base-url https://ems-cop.local
#   ./scripts/dco-demo.sh --base-url http://localhost:18080
#
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="https://localhost"
CURL_OPTS=(-sk --max-time 15)
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# ---------------------------------------------------------------------------
# Color output
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="${2:?'--base-url requires a URL argument'}"
      shift 2
      ;;
    --help|-h)
      sed -n '3,36s/^# \?//p' "$0"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      echo "Use --help for usage information." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Check for jq availability
HAS_JQ=true
if ! command -v jq &>/dev/null; then
  HAS_JQ=false
  echo -e "${YELLOW}WARNING: jq not found. JSON parsing will use basic grep fallback.${NC}"
  echo -e "${YELLOW}Install jq for better output: apt-get install jq / brew install jq${NC}"
  echo ""
fi

header() {
  echo ""
  echo -e "${CYAN}${BOLD}=============================================================================${NC}"
  echo -e "${CYAN}${BOLD}  $1${NC}"
  echo -e "${CYAN}${BOLD}=============================================================================${NC}"
}

step() {
  echo ""
  echo -e "${CYAN}--- $1${NC}"
}

pass() {
  echo -e "  ${GREEN}PASS${NC}: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC}: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

skip() {
  echo -e "  ${YELLOW}SKIP${NC}: $1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

# Extract a field from JSON using jq, with grep fallback
json_field() {
  local json="$1"
  local field="$2"
  if $HAS_JQ; then
    echo "$json" | jq -r "$field" 2>/dev/null || echo ""
  else
    # Basic fallback: extract "field": "value" or "field": value
    echo "$json" | grep -oP "\"${field#.}\"\\s*:\\s*\"?\\K[^\",}]+" | head -1
  fi
}

# Perform an API call, capture response + HTTP code
# Usage: api_call METHOD PATH [DATA]
# Sets: RESPONSE, HTTP_CODE
api_call() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local url="${BASE_URL}${path}"

  local tmp
  tmp=$(mktemp)
  trap "rm -f '$tmp'" RETURN

  local curl_args=("${CURL_OPTS[@]}" -X "$method" -w "\n%{http_code}" -H "Content-Type: application/json")

  if [[ -n "${TOKEN:-}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${TOKEN}")
  fi

  if [[ -n "$data" ]]; then
    curl_args+=(-d "$data")
  fi

  local raw
  raw=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || true

  HTTP_CODE=$(echo "$raw" | tail -1)
  RESPONSE=$(echo "$raw" | sed '$d')
}

# Check if HTTP code is in expected range
check_status() {
  local expected="$1"
  local description="$2"
  if [[ "$HTTP_CODE" == "$expected" ]]; then
    pass "$description (HTTP $HTTP_CODE)"
  else
    fail "$description (expected HTTP $expected, got HTTP $HTTP_CODE)"
    if $HAS_JQ; then
      echo "    Response: $(echo "$RESPONSE" | jq -c . 2>/dev/null || echo "$RESPONSE" | head -c 200)"
    else
      echo "    Response: $(echo "$RESPONSE" | head -c 200)"
    fi
  fi
}

pretty_json() {
  if $HAS_JQ; then
    echo "$1" | jq . 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}EMS-COP M13 DCO/SOC Feature Demonstration${NC}"
echo -e "Target: ${BOLD}${BASE_URL}${NC}"
echo -e "Date:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# =====================================================================
# STEP 1: Authentication
# =====================================================================
header "STEP 1: Authentication"

step "Logging in as admin..."
api_call POST "/api/v1/auth/login" '{"username":"admin","password":"changeme"}'

if [[ "$HTTP_CODE" == "200" ]]; then
  TOKEN=$(json_field "$RESPONSE" ".access_token")
  if [[ -n "$TOKEN" && "$TOKEN" != "null" ]]; then
    pass "Login successful — token acquired (${#TOKEN} chars)"
  else
    fail "Login returned 200 but no access_token found in response"
    echo "    Response: $(echo "$RESPONSE" | head -c 300)"
    echo -e "${RED}Cannot proceed without authentication token. Exiting.${NC}"
    exit 1
  fi
else
  fail "Login failed (HTTP $HTTP_CODE)"
  echo "    Response: $(echo "$RESPONSE" | head -c 300)"
  echo -e "${RED}Cannot proceed without authentication token. Exiting.${NC}"
  exit 1
fi

# =====================================================================
# STEP 2: Ingest Alerts
# =====================================================================
header "STEP 2: Ingest SOC Alerts"

ALERT_IDS=()

step "2a. Ingest CRITICAL ransomware alert..."
api_call POST "/api/v1/endpoints/alerts/ingest" '{
  "source_system": "crowdstrike",
  "severity": "critical",
  "title": "Ransomware Detected: LockBit 3.0 Encryption Activity",
  "description": "Endpoint WKSTN-042 detected ransomware encryption behavior. Multiple files renamed with .lockbit extension. Volume shadow copies deleted. Matches LockBit 3.0 TTP profile.",
  "mitre_techniques": ["T1486", "T1490", "T1059.001"],
  "ioc_values": ["185.220.101.42", "lockbit3-payment.onion", "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"],
  "raw_payload": {
    "sensor_id": "CS-042",
    "detection_id": "DET-2024-88421",
    "process": "cmd.exe -> powershell.exe -> vssadmin.exe",
    "hostname": "WKSTN-042",
    "username": "jdoe"
  },
  "classification": "CUI"
}'
check_status "201" "Ingest critical ransomware alert"
ALERT_ID_1=$(json_field "$RESPONSE" ".id")
if [[ -n "$ALERT_ID_1" && "$ALERT_ID_1" != "null" ]]; then
  ALERT_IDS+=("$ALERT_ID_1")
  echo "    Alert ID: $ALERT_ID_1"
fi

step "2b. Ingest HIGH lateral movement alert..."
api_call POST "/api/v1/endpoints/alerts/ingest" '{
  "source_system": "elastic",
  "severity": "high",
  "title": "Lateral Movement via PsExec Detected",
  "description": "Suspicious remote service installation detected from WKSTN-042 to SRV-DC01. PsExec-style behavior with ADMIN$ share access. Possible credential reuse from compromised endpoint.",
  "mitre_techniques": ["T1570", "T1021.002", "T1569.002"],
  "ioc_values": ["10.10.5.42", "PSEXESVC.exe"],
  "raw_payload": {
    "source_ip": "10.10.5.42",
    "dest_ip": "10.10.5.10",
    "dest_host": "SRV-DC01",
    "service_name": "PSEXESVC",
    "event_id": 7045
  },
  "classification": "CUI"
}'
check_status "201" "Ingest high lateral movement alert"
ALERT_ID_2=$(json_field "$RESPONSE" ".id")
if [[ -n "$ALERT_ID_2" && "$ALERT_ID_2" != "null" ]]; then
  ALERT_IDS+=("$ALERT_ID_2")
  echo "    Alert ID: $ALERT_ID_2"
fi

step "2c. Ingest MEDIUM phishing alert..."
api_call POST "/api/v1/endpoints/alerts/ingest" '{
  "source_system": "splunk",
  "severity": "medium",
  "title": "Phishing Email — Credential Harvesting Link Clicked",
  "description": "User clicked a link in a phishing email that redirected to a credential harvesting page mimicking the internal SSO portal. DNS query to suspicious domain detected.",
  "mitre_techniques": ["T1566.002", "T1598.003"],
  "ioc_values": ["auth-portal-update.evil.com", "phish@malware-domain.net"],
  "raw_payload": {
    "email_subject": "Urgent: Password Reset Required",
    "sender": "phish@malware-domain.net",
    "recipient": "jsmith@corp.mil",
    "url_clicked": "https://auth-portal-update.evil.com/login",
    "user_agent": "Mozilla/5.0"
  },
  "classification": "UNCLASS"
}'
check_status "201" "Ingest medium phishing alert"
ALERT_ID_3=$(json_field "$RESPONSE" ".id")
if [[ -n "$ALERT_ID_3" && "$ALERT_ID_3" != "null" ]]; then
  ALERT_IDS+=("$ALERT_ID_3")
  echo "    Alert ID: $ALERT_ID_3"
fi

# =====================================================================
# STEP 3: List Alerts
# =====================================================================
header "STEP 3: List Alerts"

step "Fetching all alerts..."
api_call GET "/api/v1/endpoints/alerts"
check_status "200" "List alerts"

if $HAS_JQ; then
  ALERT_COUNT=$(echo "$RESPONSE" | jq '.data | length' 2>/dev/null || echo "?")
  TOTAL_COUNT=$(echo "$RESPONSE" | jq '.total // .pagination.total // (.data | length)' 2>/dev/null || echo "?")
  echo "    Alerts returned: $ALERT_COUNT (total: $TOTAL_COUNT)"
else
  echo "    Response length: ${#RESPONSE} bytes"
fi

# =====================================================================
# STEP 4: Create IOCs
# =====================================================================
header "STEP 4: Create Indicators of Compromise (IOCs)"

IOC_IDS=()

step "4a. Create IP IOC (C2 server)..."
api_call POST "/api/v1/endpoints/iocs" '{
  "ioc_type": "ip",
  "value": "185.220.101.42",
  "description": "LockBit 3.0 C2 server observed in ransomware campaign targeting DoD contractors. Active since 2024-01.",
  "source": "crowdstrike",
  "threat_level": "critical",
  "mitre_techniques": ["T1071.001", "T1573.002"],
  "tags": ["lockbit", "ransomware", "c2-infrastructure"],
  "classification": "CUI"
}'
check_status "201" "Create IP IOC"
IOC_ID_1=$(json_field "$RESPONSE" ".id")
if [[ -n "$IOC_ID_1" && "$IOC_ID_1" != "null" ]]; then
  IOC_IDS+=("$IOC_ID_1")
  echo "    IOC ID: $IOC_ID_1"
fi

step "4b. Create domain IOC (phishing infrastructure)..."
api_call POST "/api/v1/endpoints/iocs" '{
  "ioc_type": "domain",
  "value": "auth-portal-update.evil.com",
  "description": "Credential harvesting domain impersonating internal SSO portal. Part of targeted phishing campaign against military personnel.",
  "source": "splunk",
  "threat_level": "high",
  "mitre_techniques": ["T1566.002", "T1598.003"],
  "tags": ["phishing", "credential-harvesting", "social-engineering"],
  "classification": "CUI"
}'
check_status "201" "Create domain IOC"
IOC_ID_2=$(json_field "$RESPONSE" ".id")
if [[ -n "$IOC_ID_2" && "$IOC_ID_2" != "null" ]]; then
  IOC_IDS+=("$IOC_ID_2")
  echo "    IOC ID: $IOC_ID_2"
fi

# =====================================================================
# STEP 5: List IOCs
# =====================================================================
header "STEP 5: List IOCs"

step "Fetching all IOCs..."
api_call GET "/api/v1/endpoints/iocs"
check_status "200" "List IOCs"

if $HAS_JQ; then
  IOC_COUNT=$(echo "$RESPONSE" | jq '.data | length' 2>/dev/null || echo "?")
  echo "    IOCs returned: $IOC_COUNT"
else
  echo "    Response length: ${#RESPONSE} bytes"
fi

# =====================================================================
# STEP 6: Escalate Critical Alert to Incident
# =====================================================================
header "STEP 6: Escalate Critical Alert to Incident"

ESCALATED_TICKET_ID=""
if [[ -n "${ALERT_ID_1:-}" && "$ALERT_ID_1" != "null" ]]; then
  step "Escalating ransomware alert ${ALERT_ID_1} to incident..."
  api_call POST "/api/v1/endpoints/alerts/${ALERT_ID_1}/escalate" '{
    "title": "INC: Active Ransomware — LockBit 3.0 on WKSTN-042",
    "severity": "critical"
  }'
  check_status "201" "Escalate alert to incident"
  ESCALATED_TICKET_ID=$(json_field "$RESPONSE" ".ticket_id")
  if [[ -n "$ESCALATED_TICKET_ID" && "$ESCALATED_TICKET_ID" != "null" ]]; then
    echo "    Incident Ticket ID: $ESCALATED_TICKET_ID"
  fi
else
  skip "No alert ID available for escalation"
fi

# =====================================================================
# STEP 7: Create Incident Directly
# =====================================================================
header "STEP 7: Create Incident Ticket Directly"

DIRECT_INCIDENT_ID=""
step "Creating incident ticket for coordinated attack investigation..."
api_call POST "/api/v1/tickets" '{
  "title": "Coordinated Attack: Ransomware + Lateral Movement + Phishing",
  "description": "Multiple correlated alerts indicate a coordinated attack campaign. Initial access via phishing, lateral movement to domain controller, and ransomware deployment on WKSTN-042. Requires immediate incident response.",
  "priority": "critical",
  "ticket_type": "incident",
  "incident_severity": "critical",
  "alert_source": "elastic",
  "mitre_techniques": ["T1566.002", "T1570", "T1486", "T1490"],
  "containment_status": "none",
  "tags": ["coordinated-attack", "ransomware", "lateral-movement", "phishing"],
  "classification": "CUI"
}'
check_status "201" "Create incident ticket directly"

if $HAS_JQ; then
  DIRECT_INCIDENT_ID=$(echo "$RESPONSE" | jq -r '.data.id // .id' 2>/dev/null || echo "")
else
  DIRECT_INCIDENT_ID=$(json_field "$RESPONSE" "id")
fi

if [[ -n "$DIRECT_INCIDENT_ID" && "$DIRECT_INCIDENT_ID" != "null" ]]; then
  echo "    Incident ID: $DIRECT_INCIDENT_ID"
else
  fail "Could not extract incident ID from response"
  echo "    Response: $(echo "$RESPONSE" | head -c 300)"
fi

# =====================================================================
# STEP 8: Incident Lifecycle — Phase 1 (submit -> investigate -> contain)
# =====================================================================
header "STEP 8: Incident Lifecycle — Phase 1"

if [[ -n "${DIRECT_INCIDENT_ID:-}" && "$DIRECT_INCIDENT_ID" != "null" ]]; then

  step "8a. Submit incident (draft -> triage)..."
  api_call POST "/api/v1/tickets/${DIRECT_INCIDENT_ID}/transition" '{"action":"submit"}'
  check_status "200" "Transition: draft -> triage (submit)"
  if $HAS_JQ; then
    NEW_STATUS=$(echo "$RESPONSE" | jq -r '.data.status // .status' 2>/dev/null || echo "?")
    echo "    New status: $NEW_STATUS"
  fi

  step "8b. Begin investigation (triage -> investigation)..."
  api_call POST "/api/v1/tickets/${DIRECT_INCIDENT_ID}/transition" '{"action":"investigate"}'
  check_status "200" "Transition: triage -> investigation (investigate)"
  if $HAS_JQ; then
    NEW_STATUS=$(echo "$RESPONSE" | jq -r '.data.status // .status' 2>/dev/null || echo "?")
    echo "    New status: $NEW_STATUS"
  fi

  step "8c. Move to containment (investigation -> containment)..."
  api_call POST "/api/v1/tickets/${DIRECT_INCIDENT_ID}/transition" '{"action":"contain"}'
  check_status "200" "Transition: investigation -> containment (contain)"
  if $HAS_JQ; then
    NEW_STATUS=$(echo "$RESPONSE" | jq -r '.data.status // .status' 2>/dev/null || echo "?")
    echo "    New status: $NEW_STATUS"
  fi

else
  skip "No incident ID available for lifecycle transitions"
fi

# =====================================================================
# STEP 9: Execute Containment Actions
# =====================================================================
header "STEP 9: Execute Containment Actions"

CONTAINMENT_IDS=()

if [[ -n "${DIRECT_INCIDENT_ID:-}" && "$DIRECT_INCIDENT_ID" != "null" ]]; then

  step "9a. Isolate compromised host (WKSTN-042)..."
  api_call POST "/api/v1/c2/containment/execute" "{
    \"action_type\": \"isolate_host\",
    \"target\": {
      \"hostname\": \"WKSTN-042\",
      \"ip_address\": \"10.10.5.42\",
      \"agent_id\": \"CS-042\"
    },
    \"incident_ticket_id\": \"${DIRECT_INCIDENT_ID}\",
    \"playbook_execution_id\": \"\"
  }"
  check_status "201" "Execute containment: isolate_host"
  CONTAIN_ID_1=$(json_field "$RESPONSE" ".id")
  if [[ -n "$CONTAIN_ID_1" && "$CONTAIN_ID_1" != "null" ]]; then
    CONTAINMENT_IDS+=("$CONTAIN_ID_1")
    echo "    Containment Action ID: $CONTAIN_ID_1"
  fi

  step "9b. Block malicious C2 IP (185.220.101.42)..."
  api_call POST "/api/v1/c2/containment/execute" "{
    \"action_type\": \"block_ip\",
    \"target\": {
      \"ip_address\": \"185.220.101.42\",
      \"direction\": \"both\",
      \"reason\": \"LockBit 3.0 C2 server\"
    },
    \"incident_ticket_id\": \"${DIRECT_INCIDENT_ID}\",
    \"playbook_execution_id\": \"\"
  }"
  check_status "201" "Execute containment: block_ip"
  CONTAIN_ID_2=$(json_field "$RESPONSE" ".id")
  if [[ -n "$CONTAIN_ID_2" && "$CONTAIN_ID_2" != "null" ]]; then
    CONTAINMENT_IDS+=("$CONTAIN_ID_2")
    echo "    Containment Action ID: $CONTAIN_ID_2"
  fi

else
  skip "No incident ID available for containment actions"
fi

# =====================================================================
# STEP 10: List Containment Actions
# =====================================================================
header "STEP 10: List Containment Actions"

step "Fetching all containment actions..."
api_call GET "/api/v1/c2/containment/actions"
check_status "200" "List containment actions"

if $HAS_JQ; then
  CONTAIN_COUNT=$(echo "$RESPONSE" | jq '.data | length' 2>/dev/null || echo "?")
  echo "    Containment actions returned: $CONTAIN_COUNT"
else
  echo "    Response length: ${#RESPONSE} bytes"
fi

# =====================================================================
# STEP 11: Incident Lifecycle — Phase 2 (remediate -> review -> close)
# =====================================================================
header "STEP 11: Incident Lifecycle — Phase 2"

if [[ -n "${DIRECT_INCIDENT_ID:-}" && "$DIRECT_INCIDENT_ID" != "null" ]]; then

  step "11a. Begin remediation (containment -> remediation)..."
  api_call POST "/api/v1/tickets/${DIRECT_INCIDENT_ID}/transition" '{"action":"remediate"}'
  check_status "200" "Transition: containment -> remediation (remediate)"
  if $HAS_JQ; then
    NEW_STATUS=$(echo "$RESPONSE" | jq -r '.data.status // .status' 2>/dev/null || echo "?")
    echo "    New status: $NEW_STATUS"
  fi

  step "11b. Begin post-incident review (remediation -> post_incident_review)..."
  api_call POST "/api/v1/tickets/${DIRECT_INCIDENT_ID}/transition" '{"action":"review"}'
  check_status "200" "Transition: remediation -> post_incident_review (review)"
  if $HAS_JQ; then
    NEW_STATUS=$(echo "$RESPONSE" | jq -r '.data.status // .status' 2>/dev/null || echo "?")
    echo "    New status: $NEW_STATUS"
  fi

  step "11c. Close incident (post_incident_review -> closed)..."
  api_call POST "/api/v1/tickets/${DIRECT_INCIDENT_ID}/transition" '{"action":"close"}'
  check_status "200" "Transition: post_incident_review -> closed (close)"
  if $HAS_JQ; then
    NEW_STATUS=$(echo "$RESPONSE" | jq -r '.data.status // .status' 2>/dev/null || echo "?")
    echo "    New status: $NEW_STATUS"
  fi

else
  skip "No incident ID available for lifecycle transitions"
fi

# =====================================================================
# STEP 12: List Playbooks
# =====================================================================
header "STEP 12: List Playbooks"

step "Fetching all playbook definitions..."
api_call GET "/api/v1/workflows/playbooks"
check_status "200" "List playbooks"

if $HAS_JQ; then
  PB_COUNT=$(echo "$RESPONSE" | jq '.data | length' 2>/dev/null || echo "?")
  echo "    Playbooks returned: $PB_COUNT"
  echo ""
  echo "    Seed playbooks:"
  echo "$RESPONSE" | jq -r '.data[]? | "      - \(.name) [\(.trigger_conditions // "manual")] (\(.classification // "UNCLASS"))"' 2>/dev/null || true
else
  echo "    Response length: ${#RESPONSE} bytes"
fi

# =====================================================================
# STEP 13: Incident Statistics
# =====================================================================
header "STEP 13: Incident Statistics"

step "Fetching incident stats..."
api_call GET "/api/v1/tickets/incidents/stats"
check_status "200" "Get incident statistics"

if $HAS_JQ; then
  echo ""
  echo "    Statistics:"
  echo "$RESPONSE" | jq '{
    total_incidents: .total_incidents,
    by_severity: .by_severity,
    by_status: .by_status,
    mttd_hours: .mttd_hours,
    mttr_hours: .mttr_hours
  }' 2>/dev/null | sed 's/^/    /' || echo "    $(echo "$RESPONSE" | head -c 500)"
else
  echo "    Response: $(echo "$RESPONSE" | head -c 500)"
fi

# =====================================================================
# Summary
# =====================================================================
header "DEMO SUMMARY"

echo ""
echo -e "  ${BOLD}DCO/SOC Features Demonstrated:${NC}"
echo ""
echo "    1. Authentication"
echo "       - Logged in as admin, obtained JWT token"
echo ""
echo "    2. Alert Ingest (${#ALERT_IDS[@]} alerts)"
for i in "${!ALERT_IDS[@]}"; do
  echo "       - Alert $((i+1)): ${ALERT_IDS[$i]}"
done
echo ""
echo "    3. IOC Management (${#IOC_IDS[@]} IOCs created)"
for i in "${!IOC_IDS[@]}"; do
  echo "       - IOC $((i+1)): ${IOC_IDS[$i]}"
done
echo ""
echo "    4. Alert Escalation"
if [[ -n "${ESCALATED_TICKET_ID:-}" && "$ESCALATED_TICKET_ID" != "null" ]]; then
  echo "       - Escalated alert -> Incident: $ESCALATED_TICKET_ID"
else
  echo "       - (not available)"
fi
echo ""
echo "    5. Direct Incident Creation"
if [[ -n "${DIRECT_INCIDENT_ID:-}" && "$DIRECT_INCIDENT_ID" != "null" ]]; then
  echo "       - Incident: $DIRECT_INCIDENT_ID"
else
  echo "       - (not available)"
fi
echo ""
echo "    6. Incident Lifecycle"
echo "       draft -> triage -> investigation -> containment"
echo "       -> remediation -> post_incident_review -> closed"
echo ""
echo "    7. Containment Actions (${#CONTAINMENT_IDS[@]} executed)"
for i in "${!CONTAINMENT_IDS[@]}"; do
  echo "       - Action $((i+1)): ${CONTAINMENT_IDS[$i]}"
done
echo ""
echo "    8. Playbook Listing (seed playbooks)"
echo ""
echo "    9. Incident Statistics (MTTD/MTTR, severity breakdown)"
echo ""
echo -e "  ${BOLD}Results:${NC}"
echo -e "    ${GREEN}Passed: ${PASS_COUNT}${NC}"
echo -e "    ${RED}Failed: ${FAIL_COUNT}${NC}"
echo -e "    ${YELLOW}Skipped: ${SKIP_COUNT}${NC}"
echo ""

if [[ $FAIL_COUNT -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}All checks passed. M13 DCO/SOC features are operational.${NC}"
else
  echo -e "  ${YELLOW}${BOLD}Some checks failed. Review the output above for details.${NC}"
fi
echo ""

exit $FAIL_COUNT
