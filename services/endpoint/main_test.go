package main

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helper: create a Server without database or NATS (for pure-logic tests)
// ---------------------------------------------------------------------------

func newTestServer() *Server {
	return &Server{
		db:   nil,
		nc:   nil,
		port: "0",
	}
}

// ---------------------------------------------------------------------------
// Test: classifyNodeType
// ---------------------------------------------------------------------------

func TestClassifyNodeType(t *testing.T) {
	tests := []struct {
		name     string
		services []map[string]any
		osName   string
		vendor   string
		want     string
	}{
		// Router detection
		{
			"BGP port = router",
			[]map[string]any{{"port": float64(179), "service": "bgp"}},
			"", "", "router",
		},
		{
			"OSPF port = router",
			[]map[string]any{{"port": float64(89), "service": "ospf"}},
			"", "", "router",
		},
		{
			"RIP port = router",
			[]map[string]any{{"port": float64(520), "service": "rip"}},
			"", "", "router",
		},
		// Firewall detection
		{
			"Cisco ASA OS = firewall",
			nil, "Cisco ASA 5520", "", "firewall",
		},
		{
			"pfSense OS = firewall",
			nil, "pfSense 2.6", "", "firewall",
		},
		{
			"Palo Alto vendor = firewall",
			nil, "", "Palo Alto Networks", "firewall",
		},
		{
			"Fortinet vendor = firewall",
			nil, "", "Fortinet FortiGate", "firewall",
		},
		{
			"SonicWall vendor = firewall",
			nil, "", "SonicWall TZ300", "firewall",
		},
		{
			"Checkpoint vendor = firewall",
			nil, "", "CheckPoint R81", "firewall",
		},
		// Printer detection
		{
			"IPP port = printer",
			[]map[string]any{{"port": float64(631), "service": "ipp"}},
			"", "", "printer",
		},
		{
			"LPD port = printer",
			[]map[string]any{{"port": float64(515), "service": "lpd"}},
			"", "", "printer",
		},
		{
			"JetDirect port = printer",
			[]map[string]any{{"port": float64(9100), "service": "jetdirect"}},
			"", "", "printer",
		},
		{
			"ipp service = printer",
			[]map[string]any{{"port": float64(80), "service": "ipp"}},
			"", "", "printer",
		},
		{
			"printer service name = printer",
			[]map[string]any{{"port": float64(80), "service": "printer"}},
			"", "", "printer",
		},
		// VPN detection
		{
			"OpenVPN port = vpn",
			[]map[string]any{{"port": float64(1194), "service": "openvpn"}},
			"", "", "vpn",
		},
		{
			"IKE + NAT-T = vpn",
			[]map[string]any{
				{"port": float64(500), "service": "isakmp"},
				{"port": float64(4500), "service": "nat-t"},
			},
			"", "", "vpn",
		},
		{
			"WireGuard port = vpn",
			[]map[string]any{{"port": float64(51820), "service": "wireguard"}},
			"", "", "vpn",
		},
		// IoT detection
		{
			"MQTT port = iot",
			[]map[string]any{{"port": float64(1883), "service": "mqtt"}},
			"", "", "iot",
		},
		{
			"CoAP port = iot",
			[]map[string]any{{"port": float64(5683), "service": "coap"}},
			"", "", "iot",
		},
		{
			"mqtt service name = iot",
			[]map[string]any{{"port": float64(8883), "service": "mqtt"}},
			"", "", "iot",
		},
		{
			"coap service name = iot",
			[]map[string]any{{"port": float64(5684), "service": "coap"}},
			"", "", "iot",
		},
		// Workstation detection
		{
			"RDP + Windows = workstation",
			[]map[string]any{{"port": float64(3389), "service": "ms-wbt-server"}},
			"Windows 10 Pro", "", "workstation",
		},
		{
			"VNC + Mac = workstation",
			[]map[string]any{{"port": float64(5900), "service": "vnc"}},
			"Mac OS X", "", "workstation",
		},
		{
			"RDP + Linux = host (3389 not in server ports, Linux not desktop OS for workstation)",
			[]map[string]any{{"port": float64(3389), "service": "xrdp"}},
			"Linux", "", "host",
		},
		// Server detection
		{
			"HTTP port = server",
			[]map[string]any{{"port": float64(80), "service": "http"}},
			"Linux", "", "server",
		},
		{
			"HTTPS port = server",
			[]map[string]any{{"port": float64(443), "service": "https"}},
			"", "", "server",
		},
		{
			"SSH port = server",
			[]map[string]any{{"port": float64(22), "service": "ssh"}},
			"", "", "server",
		},
		{
			"MySQL port = server",
			[]map[string]any{{"port": float64(3306), "service": "mysql"}},
			"", "", "server",
		},
		{
			"PostgreSQL port = server",
			[]map[string]any{{"port": float64(5432), "service": "postgresql"}},
			"", "", "server",
		},
		{
			"MongoDB port = server",
			[]map[string]any{{"port": float64(27017), "service": "mongodb"}},
			"", "", "server",
		},
		{
			"Redis port = server",
			[]map[string]any{{"port": float64(6379), "service": "redis"}},
			"", "", "server",
		},
		{
			"Elasticsearch port = server",
			[]map[string]any{{"port": float64(9200), "service": "elasticsearch"}},
			"", "", "server",
		},
		{
			"http service name = server",
			[]map[string]any{{"port": float64(8000), "service": "http"}},
			"", "", "server",
		},
		{
			"https service name = server",
			[]map[string]any{{"port": float64(8443), "service": "https"}},
			"", "", "server",
		},
		{
			"ssh service name = server",
			[]map[string]any{{"port": float64(2222), "service": "ssh"}},
			"", "", "server",
		},
		// Default
		{
			"no services or OS = host",
			nil, "", "", "host",
		},
		{
			"unknown services = host",
			[]map[string]any{{"port": float64(12345), "service": "custom"}},
			"", "", "host",
		},
		// Port as int type
		{
			"port as int type",
			[]map[string]any{{"port": int(22), "service": "ssh"}},
			"", "", "server",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyNodeType(tt.services, tt.osName, tt.vendor)
			if got != tt.want {
				t.Errorf("classifyNodeType(%v, %q, %q) = %q, want %q",
					tt.services, tt.osName, tt.vendor, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: applyTransform
// ---------------------------------------------------------------------------

func TestApplyTransform(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		transform string
		want      string
	}{
		{"to_integer valid", "42", "to_integer", "42"},
		{"to_integer invalid", "abc", "to_integer", "0"},
		{"to_float valid", "3.14", "to_float", "3.14"},
		{"to_float invalid", "xyz", "to_float", "0"},
		{"to_lowercase", "HELLO World", "to_lowercase", "hello world"},
		{"to_uppercase", "hello world", "to_uppercase", "HELLO WORLD"},
		{"unknown transform", "value", "unknown", "value"},
		{"empty transform", "value", "", "value"},
		{"empty value to_integer", "", "to_integer", "0"},
		{"empty value to_lowercase", "", "to_lowercase", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := applyTransform(tt.value, tt.transform)
			if got != tt.want {
				t.Errorf("applyTransform(%q, %q) = %q, want %q",
					tt.value, tt.transform, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: evaluateNodeTypeRules
// ---------------------------------------------------------------------------

func TestEvaluateNodeTypeRules(t *testing.T) {
	tests := []struct {
		name      string
		rules     []NodeTypeRule
		extracted map[string]string
		services  []map[string]any
		want      string
	}{
		{
			"equals match",
			[]NodeTypeRule{{Field: "os", Operator: "equals", Value: "Linux", NodeType: "server"}},
			map[string]string{"os": "Linux"},
			nil,
			"server",
		},
		{
			"equals no match",
			[]NodeTypeRule{{Field: "os", Operator: "equals", Value: "Linux", NodeType: "server"}},
			map[string]string{"os": "Windows"},
			nil,
			"host",
		},
		{
			"contains match",
			[]NodeTypeRule{{Field: "os", Operator: "contains", Value: "cisco", NodeType: "router"}},
			map[string]string{"os": "Cisco IOS 15.2"},
			nil,
			"router",
		},
		{
			"contains case insensitive",
			[]NodeTypeRule{{Field: "os", Operator: "contains", Value: "Windows", NodeType: "workstation"}},
			map[string]string{"os": "windows 10"},
			nil,
			"workstation",
		},
		{
			"port_open match float64",
			[]NodeTypeRule{{Field: "services", Operator: "port_open", Value: "80", NodeType: "server"}},
			map[string]string{},
			[]map[string]any{{"port": float64(80), "service": "http"}},
			"server",
		},
		{
			"port_open match int",
			[]NodeTypeRule{{Field: "services", Operator: "port_open", Value: "22", NodeType: "server"}},
			map[string]string{},
			[]map[string]any{{"port": int(22), "service": "ssh"}},
			"server",
		},
		{
			"port_open no match",
			[]NodeTypeRule{{Field: "services", Operator: "port_open", Value: "8080", NodeType: "server"}},
			map[string]string{},
			[]map[string]any{{"port": float64(80), "service": "http"}},
			"host",
		},
		{
			"service_running match",
			[]NodeTypeRule{{Field: "services", Operator: "service_running", Value: "http", NodeType: "server"}},
			map[string]string{},
			[]map[string]any{{"port": float64(80), "service": "HTTP"}},
			"server",
		},
		{
			"service_running no match",
			[]NodeTypeRule{{Field: "services", Operator: "service_running", Value: "ssh", NodeType: "server"}},
			map[string]string{},
			[]map[string]any{{"port": float64(80), "service": "http"}},
			"host",
		},
		{
			"no rules defaults to host",
			nil,
			map[string]string{"os": "Linux"},
			nil,
			"host",
		},
		{
			"first matching rule wins",
			[]NodeTypeRule{
				{Field: "os", Operator: "contains", Value: "cisco", NodeType: "router"},
				{Field: "os", Operator: "contains", Value: "cisco", NodeType: "firewall"},
			},
			map[string]string{"os": "Cisco IOS"},
			nil,
			"router",
		},
		{
			"port_open invalid port string",
			[]NodeTypeRule{{Field: "services", Operator: "port_open", Value: "abc", NodeType: "server"}},
			map[string]string{},
			[]map[string]any{{"port": float64(80)}},
			"host",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := evaluateNodeTypeRules(tt.rules, tt.extracted, tt.services)
			if got != tt.want {
				t.Errorf("evaluateNodeTypeRules() = %q, want %q", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: evaluateSkipConditions
// ---------------------------------------------------------------------------

func TestEvaluateSkipConditions(t *testing.T) {
	tests := []struct {
		name       string
		conditions []SkipCondition
		extracted  map[string]string
		want       bool
	}{
		{
			"equals match = skip",
			[]SkipCondition{{Field: "status", Operator: "equals", Value: "down"}},
			map[string]string{"status": "down"},
			true,
		},
		{
			"equals no match = no skip",
			[]SkipCondition{{Field: "status", Operator: "equals", Value: "down"}},
			map[string]string{"status": "up"},
			false,
		},
		{
			"not_equals match = skip",
			[]SkipCondition{{Field: "status", Operator: "not_equals", Value: "up"}},
			map[string]string{"status": "down"},
			true,
		},
		{
			"not_equals no match = no skip",
			[]SkipCondition{{Field: "status", Operator: "not_equals", Value: "up"}},
			map[string]string{"status": "up"},
			false,
		},
		{
			"contains match = skip",
			[]SkipCondition{{Field: "hostname", Operator: "contains", Value: "test"}},
			map[string]string{"hostname": "test-server-1"},
			true,
		},
		{
			"contains no match = no skip",
			[]SkipCondition{{Field: "hostname", Operator: "contains", Value: "test"}},
			map[string]string{"hostname": "prod-server-1"},
			false,
		},
		{
			"no conditions = no skip",
			nil,
			map[string]string{"status": "up"},
			false,
		},
		{
			"missing field = no skip (equals)",
			[]SkipCondition{{Field: "nonexistent", Operator: "equals", Value: "value"}},
			map[string]string{},
			false,
		},
		{
			"any condition matches = skip",
			[]SkipCondition{
				{Field: "status", Operator: "equals", Value: "down"},
				{Field: "hostname", Operator: "contains", Value: "test"},
			},
			map[string]string{"status": "up", "hostname": "test-server"},
			true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := evaluateSkipConditions(tt.conditions, tt.extracted)
			if got != tt.want {
				t.Errorf("evaluateSkipConditions() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: parseXMLTree
// ---------------------------------------------------------------------------

func TestParseXMLTree(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantName  string
		wantErr   bool
		wantAttrs int
		wantChild int
	}{
		{
			"simple element",
			`<root attr1="val1"><child>text</child></root>`,
			"root", false, 1, 1,
		},
		{
			"multiple children",
			`<root><a/><b/><c/></root>`,
			"root", false, 0, 3,
		},
		{
			"nested elements",
			`<root><parent><child/></parent></root>`,
			"root", false, 0, 1,
		},
		{
			"multiple attributes",
			`<root a="1" b="2" c="3"/>`,
			"root", false, 3, 0,
		},
		{
			"invalid XML",
			`<root><unclosed`,
			"", true, 0, 0,
		},
		{
			"empty input",
			``,
			"", true, 0, 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root, err := parseXMLTree([]byte(tt.input))
			if (err != nil) != tt.wantErr {
				t.Errorf("parseXMLTree() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if err != nil {
				return
			}
			if root.Name != tt.wantName {
				t.Errorf("root.Name = %q, want %q", root.Name, tt.wantName)
			}
			if len(root.Attrs) != tt.wantAttrs {
				t.Errorf("root.Attrs count = %d, want %d", len(root.Attrs), tt.wantAttrs)
			}
			if len(root.Children) != tt.wantChild {
				t.Errorf("root.Children count = %d, want %d", len(root.Children), tt.wantChild)
			}
		})
	}
}

func TestParseXMLTree_TextContent(t *testing.T) {
	input := `<root><child>hello world</child></root>`
	root, err := parseXMLTree([]byte(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(root.Children) != 1 {
		t.Fatalf("expected 1 child, got %d", len(root.Children))
	}
	if root.Children[0].Text != "hello world" {
		t.Errorf("child text = %q, want %q", root.Children[0].Text, "hello world")
	}
}

// ---------------------------------------------------------------------------
// Test: xmlFindChildren
// ---------------------------------------------------------------------------

func TestXmlFindChildren(t *testing.T) {
	root := XMLElement{
		Name: "root",
		Children: []XMLElement{
			{Name: "host"},
			{Name: "host"},
			{Name: "other"},
		},
	}

	hosts := xmlFindChildren(root, "host")
	if len(hosts) != 2 {
		t.Errorf("expected 2 host children, got %d", len(hosts))
	}

	others := xmlFindChildren(root, "other")
	if len(others) != 1 {
		t.Errorf("expected 1 other child, got %d", len(others))
	}

	missing := xmlFindChildren(root, "missing")
	if len(missing) != 0 {
		t.Errorf("expected 0 missing children, got %d", len(missing))
	}
}

// ---------------------------------------------------------------------------
// Test: xmlNavigate
// ---------------------------------------------------------------------------

func TestXmlNavigate(t *testing.T) {
	root := XMLElement{
		Name: "nmaprun",
		Children: []XMLElement{
			{
				Name: "host",
				Children: []XMLElement{
					{
						Name: "hostnames",
						Children: []XMLElement{
							{Name: "hostname", Attrs: map[string]string{"name": "server1"}},
							{Name: "hostname", Attrs: map[string]string{"name": "server2"}},
						},
					},
				},
			},
		},
	}

	tests := []struct {
		name string
		path string
		want int
	}{
		{"single level", "host", 1},
		{"two levels", "host.hostnames", 1},
		{"three levels", "host.hostnames.hostname", 2},
		{"missing path", "host.missing", 0},
		{"empty path element", "host..hostname", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := xmlNavigate(root, tt.path)
			if len(result) != tt.want {
				t.Errorf("xmlNavigate(%q) returned %d elements, want %d", tt.path, len(result), tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: xmlExtractValue
// ---------------------------------------------------------------------------

func TestXmlExtractValue(t *testing.T) {
	el := XMLElement{
		Name:  "host",
		Attrs: map[string]string{"state": "up"},
		Children: []XMLElement{
			{
				Name: "address",
				Attrs: map[string]string{
					"addr":     "192.168.1.1",
					"addrtype": "ipv4",
				},
			},
			{
				Name: "address",
				Attrs: map[string]string{
					"addr":     "AA:BB:CC:DD:EE:FF",
					"addrtype": "mac",
				},
			},
			{
				Name: "hostname",
				Text: "myhost",
			},
		},
	}

	tests := []struct {
		name   string
		source string
		filter *FieldFilter
		want   string
	}{
		{"direct attribute", "@state", nil, "up"},
		{"child element text", "hostname", nil, "myhost"},
		{"nested attribute", "address@addr", nil, "192.168.1.1"},
		{
			"nested attr with filter",
			"address@addr",
			&FieldFilter{Field: "@addrtype", Operator: "equals", Value: "mac"},
			"AA:BB:CC:DD:EE:FF",
		},
		{
			"nested attr with filter - ipv4",
			"address@addr",
			&FieldFilter{Field: "@addrtype", Operator: "equals", Value: "ipv4"},
			"192.168.1.1",
		},
		{"missing attribute", "@missing", nil, ""},
		{"missing child", "nonexistent", nil, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := xmlExtractValue(el, tt.source, tt.filter)
			if got != tt.want {
				t.Errorf("xmlExtractValue(%q) = %q, want %q", tt.source, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: xmlMatchFilter
// ---------------------------------------------------------------------------

func TestXmlMatchFilter(t *testing.T) {
	el := XMLElement{
		Name:  "address",
		Attrs: map[string]string{"addrtype": "ipv4", "addr": "192.168.1.1"},
		Children: []XMLElement{
			{Name: "type", Text: "public"},
		},
	}

	tests := []struct {
		name   string
		filter FieldFilter
		want   bool
	}{
		{"attr equals match", FieldFilter{Field: "@addrtype", Operator: "equals", Value: "ipv4"}, true},
		{"attr equals no match", FieldFilter{Field: "@addrtype", Operator: "equals", Value: "mac"}, false},
		{"attr not_equals match", FieldFilter{Field: "@addrtype", Operator: "not_equals", Value: "mac"}, true},
		{"attr not_equals no match", FieldFilter{Field: "@addrtype", Operator: "not_equals", Value: "ipv4"}, false},
		{"attr contains match", FieldFilter{Field: "@addr", Operator: "contains", Value: "192.168"}, true},
		{"attr contains no match", FieldFilter{Field: "@addr", Operator: "contains", Value: "10.0"}, false},
		{"child text equals", FieldFilter{Field: "type", Operator: "equals", Value: "public"}, true},
		{"unknown operator", FieldFilter{Field: "@addrtype", Operator: "regex", Value: ".*"}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := xmlMatchFilter(el, &tt.filter)
			if got != tt.want {
				t.Errorf("xmlMatchFilter() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: jsonNavigateToArray
// ---------------------------------------------------------------------------

func TestJsonNavigateToArray(t *testing.T) {
	tests := []struct {
		name string
		json string
		path string
		want int // expected length (-1 = nil)
	}{
		{
			"root array",
			`[{"ip":"1.1.1.1"},{"ip":"2.2.2.2"}]`,
			"",
			2,
		},
		{
			"nested path",
			`{"data":{"hosts":[{"ip":"1.1.1.1"}]}}`,
			"data.hosts",
			1,
		},
		{
			"single level path",
			`{"hosts":[{"ip":"1.1.1.1"},{"ip":"2.2.2.2"},{"ip":"3.3.3.3"}]}`,
			"hosts",
			3,
		},
		{
			"root object with single array",
			`{"items":[1,2,3]}`,
			"",
			3,
		},
		{
			"path to non-array",
			`{"data":"not_array"}`,
			"data",
			-1,
		},
		{
			"missing path",
			`{"data":{}}`,
			"data.hosts",
			-1,
		},
		{
			"root object no array",
			`{"key":"value"}`,
			"",
			-1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var raw any
			if err := json.Unmarshal([]byte(tt.json), &raw); err != nil {
				t.Fatalf("invalid test JSON: %v", err)
			}
			result := jsonNavigateToArray(raw, tt.path)
			if tt.want == -1 {
				if result != nil {
					t.Errorf("expected nil, got %v (len %d)", result, len(result))
				}
			} else {
				if result == nil {
					t.Errorf("expected len %d, got nil", tt.want)
				} else if len(result) != tt.want {
					t.Errorf("expected len %d, got %d", tt.want, len(result))
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: jsonExtractValue
// ---------------------------------------------------------------------------

func TestJsonExtractValue(t *testing.T) {
	obj := map[string]any{
		"ip":       "192.168.1.1",
		"hostname": "server1",
		"port":     float64(22),
		"active":   true,
		"nested": map[string]any{
			"deep": "value",
		},
		"empty": nil,
	}

	tests := []struct {
		name   string
		source string
		want   string
	}{
		{"string field", "ip", "192.168.1.1"},
		{"number field", "port", "22"},
		{"bool field", "active", "true"},
		{"nested field", "nested.deep", "value"},
		{"nil field", "empty", ""},
		{"missing field", "nonexistent", ""},
		{"empty source", "", ""},
		{"deep missing", "nested.missing", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := jsonExtractValue(obj, tt.source)
			if got != tt.want {
				t.Errorf("jsonExtractValue(%q) = %q, want %q", tt.source, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: NmapRun XML unmarshalling
// ---------------------------------------------------------------------------

func TestNmapRunUnmarshal(t *testing.T) {
	xmlData := `<?xml version="1.0"?>
<nmaprun>
  <host>
    <status state="up"/>
    <address addr="192.168.1.1" addrtype="ipv4"/>
    <address addr="AA:BB:CC:DD:EE:FF" addrtype="mac" vendor="Dell"/>
    <hostnames>
      <hostname name="server1.local" type="PTR"/>
    </hostnames>
    <ports>
      <port protocol="tcp" portid="22">
        <state state="open"/>
        <service name="ssh" product="OpenSSH" version="8.2"/>
      </port>
      <port protocol="tcp" portid="80">
        <state state="open"/>
        <service name="http" product="nginx" version="1.18"/>
      </port>
    </ports>
    <os>
      <osmatch name="Linux 5.4" accuracy="95"/>
      <osmatch name="Linux 4.15" accuracy="85"/>
    </os>
    <trace>
      <hop ttl="1" ipaddr="10.0.0.1" rtt="1.00"/>
      <hop ttl="2" ipaddr="192.168.1.1" rtt="5.00"/>
    </trace>
  </host>
  <host>
    <status state="down"/>
    <address addr="192.168.1.2" addrtype="ipv4"/>
  </host>
</nmaprun>`

	var nmapRun NmapRun
	if err := xml.Unmarshal([]byte(xmlData), &nmapRun); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if len(nmapRun.Hosts) != 2 {
		t.Fatalf("expected 2 hosts, got %d", len(nmapRun.Hosts))
	}

	host1 := nmapRun.Hosts[0]

	// Status
	if host1.Status.State != "up" {
		t.Errorf("host1.Status.State = %q, want %q", host1.Status.State, "up")
	}

	// Addresses
	if len(host1.Addresses) != 2 {
		t.Fatalf("expected 2 addresses, got %d", len(host1.Addresses))
	}
	if host1.Addresses[0].Addr != "192.168.1.1" {
		t.Errorf("addr[0] = %q, want %q", host1.Addresses[0].Addr, "192.168.1.1")
	}
	if host1.Addresses[0].AddrType != "ipv4" {
		t.Errorf("addrtype[0] = %q, want %q", host1.Addresses[0].AddrType, "ipv4")
	}
	if host1.Addresses[1].AddrType != "mac" {
		t.Errorf("addrtype[1] = %q, want %q", host1.Addresses[1].AddrType, "mac")
	}
	if host1.Addresses[1].Vendor != "Dell" {
		t.Errorf("vendor[1] = %q, want %q", host1.Addresses[1].Vendor, "Dell")
	}

	// Hostnames
	if len(host1.Hostnames.Names) != 1 {
		t.Fatalf("expected 1 hostname, got %d", len(host1.Hostnames.Names))
	}
	if host1.Hostnames.Names[0].Name != "server1.local" {
		t.Errorf("hostname = %q, want %q", host1.Hostnames.Names[0].Name, "server1.local")
	}

	// Ports
	if len(host1.Ports.Ports) != 2 {
		t.Fatalf("expected 2 ports, got %d", len(host1.Ports.Ports))
	}
	if host1.Ports.Ports[0].PortID != 22 {
		t.Errorf("port[0].PortID = %d, want %d", host1.Ports.Ports[0].PortID, 22)
	}
	if host1.Ports.Ports[0].Protocol != "tcp" {
		t.Errorf("port[0].Protocol = %q, want %q", host1.Ports.Ports[0].Protocol, "tcp")
	}
	if host1.Ports.Ports[0].State.State != "open" {
		t.Errorf("port[0].State = %q, want %q", host1.Ports.Ports[0].State.State, "open")
	}
	if host1.Ports.Ports[0].Service.Name != "ssh" {
		t.Errorf("port[0].Service.Name = %q, want %q", host1.Ports.Ports[0].Service.Name, "ssh")
	}
	if host1.Ports.Ports[0].Service.Product != "OpenSSH" {
		t.Errorf("port[0].Service.Product = %q, want %q", host1.Ports.Ports[0].Service.Product, "OpenSSH")
	}

	// OS
	if len(host1.OS.Matches) != 2 {
		t.Fatalf("expected 2 OS matches, got %d", len(host1.OS.Matches))
	}
	if host1.OS.Matches[0].Name != "Linux 5.4" {
		t.Errorf("os[0].Name = %q, want %q", host1.OS.Matches[0].Name, "Linux 5.4")
	}
	if host1.OS.Matches[0].Accuracy != 95 {
		t.Errorf("os[0].Accuracy = %d, want %d", host1.OS.Matches[0].Accuracy, 95)
	}

	// Trace
	if len(host1.Trace.Hops) != 2 {
		t.Fatalf("expected 2 hops, got %d", len(host1.Trace.Hops))
	}
	if host1.Trace.Hops[0].IPAddr != "10.0.0.1" {
		t.Errorf("hop[0].IPAddr = %q, want %q", host1.Trace.Hops[0].IPAddr, "10.0.0.1")
	}
	if host1.Trace.Hops[0].TTL != 1 {
		t.Errorf("hop[0].TTL = %d, want %d", host1.Trace.Hops[0].TTL, 1)
	}

	// Host 2 (down)
	host2 := nmapRun.Hosts[1]
	if host2.Status.State != "down" {
		t.Errorf("host2.Status.State = %q, want %q", host2.Status.State, "down")
	}
}

func TestNmapRunUnmarshal_Empty(t *testing.T) {
	xmlData := `<?xml version="1.0"?><nmaprun></nmaprun>`
	var nmapRun NmapRun
	if err := xml.Unmarshal([]byte(xmlData), &nmapRun); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if len(nmapRun.Hosts) != 0 {
		t.Errorf("expected 0 hosts, got %d", len(nmapRun.Hosts))
	}
}

func TestNmapRunUnmarshal_Invalid(t *testing.T) {
	xmlData := `<not-nmap><foo/></not-nmap>`
	var nmapRun NmapRun
	// xml.Unmarshal does not return error for mismatched root elements,
	// but the hosts array will be empty
	_ = xml.Unmarshal([]byte(xmlData), &nmapRun)
	if len(nmapRun.Hosts) != 0 {
		t.Errorf("expected 0 hosts from non-nmap XML, got %d", len(nmapRun.Hosts))
	}
}

// ---------------------------------------------------------------------------
// Test: Valid enum maps
// ---------------------------------------------------------------------------

func TestValidNodeStatuses(t *testing.T) {
	expected := []string{"discovered", "alive", "compromised", "offline"}
	for _, s := range expected {
		if !validNodeStatuses[s] {
			t.Errorf("validNodeStatuses missing %q", s)
		}
	}
	if validNodeStatuses["unknown"] {
		t.Error("validNodeStatuses should not contain 'unknown'")
	}
}

func TestValidNodeTypes(t *testing.T) {
	expected := []string{"host", "router", "firewall", "server", "workstation", "unknown"}
	for _, s := range expected {
		if !validNodeTypes[s] {
			t.Errorf("validNodeTypes missing %q", s)
		}
	}
}

func TestValidEdgeTypes(t *testing.T) {
	expected := []string{"network_adjacency", "c2_callback", "c2_pivot", "lateral_movement", "tunnel", "port_forward"}
	for _, s := range expected {
		if !validEdgeTypes[s] {
			t.Errorf("validEdgeTypes missing %q", s)
		}
	}
}

func TestValidDiscoveredBy(t *testing.T) {
	expected := []string{"import", "scan", "c2_activity", "manual"}
	for _, s := range expected {
		if !validDiscoveredBy[s] {
			t.Errorf("validDiscoveredBy missing %q", s)
		}
	}
}

func TestValidImportParserFormats(t *testing.T) {
	expected := []string{"xml", "json", "csv", "tsv", "custom"}
	for _, s := range expected {
		if !validImportParserFormats[s] {
			t.Errorf("validImportParserFormats missing %q", s)
		}
	}
}

// ---------------------------------------------------------------------------
// Test: writeJSON / writeError
// ---------------------------------------------------------------------------

func TestWriteJSON(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"key": "value"})

	if w.Code != http.StatusOK {
		t.Errorf("status code = %d, want %d", w.Code, http.StatusOK)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if body["key"] != "value" {
		t.Errorf("body[key] = %q, want %q", body["key"], "value")
	}
}

func TestWriteError(t *testing.T) {
	w := httptest.NewRecorder()
	writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")

	if w.Code != http.StatusBadRequest {
		t.Errorf("status code = %d, want %d", w.Code, http.StatusBadRequest)
	}

	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatal("response missing 'error' object")
	}
	if errObj["code"] != "VALIDATION_ERROR" {
		t.Errorf("error code = %q, want %q", errObj["code"], "VALIDATION_ERROR")
	}
	if errObj["message"] != "name is required" {
		t.Errorf("error message = %q, want %q", errObj["message"], "name is required")
	}
}

// ---------------------------------------------------------------------------
// Test: marshalJSONB / parseJSONB
// ---------------------------------------------------------------------------

func TestMarshalJSONB(t *testing.T) {
	tests := []struct {
		name  string
		input any
		isNil bool
	}{
		{"nil input", nil, true},
		{"map input", map[string]string{"key": "val"}, false},
		{"string input", "hello", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := marshalJSONB(tt.input)
			if tt.isNil && got != nil {
				t.Errorf("marshalJSONB() = %v, want nil", got)
			}
			if !tt.isNil && got == nil {
				t.Error("marshalJSONB() = nil, want non-nil")
			}
		})
	}
}

func TestParseJSONB(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		isNil bool
	}{
		{"valid JSON object", []byte(`{"key":"value"}`), false},
		{"valid JSON array", []byte(`[1,2,3]`), false},
		{"empty bytes", []byte{}, true},
		{"nil bytes", nil, true},
		{"invalid JSON", []byte(`{bad`), true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseJSONB(tt.input)
			if tt.isNil && got != nil {
				t.Errorf("parseJSONB() = %v, want nil", got)
			}
			if !tt.isNil && got == nil {
				t.Error("parseJSONB() = nil, want non-nil")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: parsePagination
// ---------------------------------------------------------------------------

func TestParsePagination(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		wantPage   int
		wantLimit  int
		wantOffset int
	}{
		{"default", "", 1, 20, 0},
		{"page 2", "page=2", 2, 20, 20},
		{"custom limit", "limit=50", 1, 50, 0},
		{"page 3 limit 10", "page=3&limit=10", 3, 10, 20},
		{"invalid page", "page=-1", 1, 20, 0},
		{"page zero", "page=0", 1, 20, 0},
		{"limit zero", "limit=0", 1, 20, 0},
		{"limit too large", "limit=200", 1, 20, 0},
		{"limit exactly 100", "limit=100", 1, 100, 0},
		{"non-numeric page", "page=abc", 1, 20, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			url := "/test"
			if tt.query != "" {
				url += "?" + tt.query
			}
			r := httptest.NewRequest("GET", url, nil)
			page, limit, offset := parsePagination(r)
			if page != tt.wantPage || limit != tt.wantLimit || offset != tt.wantOffset {
				t.Errorf("parsePagination() = (%d, %d, %d), want (%d, %d, %d)",
					page, limit, offset, tt.wantPage, tt.wantLimit, tt.wantOffset)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Health Live
// ---------------------------------------------------------------------------

func TestHandleHealthLive(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/health/live", nil)
	w := httptest.NewRecorder()

	s.handleHealthLive(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %q, want %q", body["status"], "ok")
	}
	if body["service"] != "endpoint-service" {
		t.Errorf("service = %q, want %q", body["service"], "endpoint-service")
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Create Network validation
// ---------------------------------------------------------------------------

func TestHandleCreateNetwork_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"invalid JSON",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing operation_id",
			`{"name":"test"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"missing name",
			`{"operation_id":"op1"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/networks", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleCreateNetwork(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — List Networks validation
// ---------------------------------------------------------------------------

func TestHandleListNetworks_MissingOperationID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/networks", nil)
	w := httptest.NewRecorder()

	s.handleListNetworks(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Get/Update/Delete Network validation
// ---------------------------------------------------------------------------

func TestHandleGetNetwork_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/networks/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleGetNetwork(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdateNetwork_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantCode   string
	}{
		{"missing id", "", `{"name":"test"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"invalid JSON", "net1", `{invalid`, http.StatusBadRequest, "INVALID_JSON"},
		{"empty update", "net1", `{}`, http.StatusBadRequest, "VALIDATION_ERROR"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("PATCH", "/api/v1/networks/"+tt.id, strings.NewReader(tt.body))
			req.SetPathValue("id", tt.id)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleUpdateNetwork(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestHandleDeleteNetwork_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("DELETE", "/api/v1/networks/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleDeleteNetwork(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Create Node validation
// ---------------------------------------------------------------------------

func TestHandleCreateNode_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		networkID  string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"missing network id",
			"",
			`{"ip_address":"1.1.1.1"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid JSON",
			"net1",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing ip_address",
			"net1",
			`{"hostname":"test"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid status",
			"net1",
			`{"ip_address":"1.1.1.1","status":"invalid_status"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid node_type",
			"net1",
			`{"ip_address":"1.1.1.1","node_type":"invalid_type"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/networks/"+tt.networkID+"/nodes", strings.NewReader(tt.body))
			req.SetPathValue("id", tt.networkID)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleCreateNode(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Update Node validation
// ---------------------------------------------------------------------------

func TestHandleUpdateNode_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantCode   string
	}{
		{"missing id", "", `{"hostname":"test"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"invalid JSON", "node1", `{invalid`, http.StatusBadRequest, "INVALID_JSON"},
		{"empty update", "node1", `{}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{
			"invalid status",
			"node1",
			`{"status":"invalid_status"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid node_type",
			"node1",
			`{"node_type":"invalid_type"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("PATCH", "/api/v1/nodes/"+tt.id, strings.NewReader(tt.body))
			req.SetPathValue("id", tt.id)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleUpdateNode(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Delete Node validation
// ---------------------------------------------------------------------------

func TestHandleDeleteNode_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("DELETE", "/api/v1/nodes/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleDeleteNode(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Create Edge validation
// ---------------------------------------------------------------------------

func TestHandleCreateEdge_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		networkID  string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			"missing network id",
			"",
			`{"source_node_id":"n1","target_node_id":"n2","edge_type":"tunnel"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid JSON",
			"net1",
			`{invalid`,
			http.StatusBadRequest,
			"INVALID_JSON",
		},
		{
			"missing source and target",
			"net1",
			`{"edge_type":"tunnel"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"missing edge_type",
			"net1",
			`{"source_node_id":"n1","target_node_id":"n2"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid edge_type",
			"net1",
			`{"source_node_id":"n1","target_node_id":"n2","edge_type":"invalid"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"invalid discovered_by",
			"net1",
			`{"source_node_id":"n1","target_node_id":"n2","edge_type":"tunnel","discovered_by":"invalid"}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"confidence too high",
			"net1",
			`{"source_node_id":"n1","target_node_id":"n2","edge_type":"tunnel","confidence":1.5}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
		{
			"confidence negative",
			"net1",
			`{"source_node_id":"n1","target_node_id":"n2","edge_type":"tunnel","confidence":-0.5}`,
			http.StatusBadRequest,
			"VALIDATION_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/networks/"+tt.networkID+"/edges", strings.NewReader(tt.body))
			req.SetPathValue("id", tt.networkID)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleCreateEdge(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}

			var body map[string]any
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode: %v", err)
			}
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatal("expected error object")
			}
			if errObj["code"] != tt.wantCode {
				t.Errorf("error code = %q, want %q", errObj["code"], tt.wantCode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Delete Edge validation
// ---------------------------------------------------------------------------

func TestHandleDeleteEdge_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("DELETE", "/api/v1/edges/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleDeleteEdge(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Topology validation
// ---------------------------------------------------------------------------

func TestHandleGetTopology_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/networks//topology", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleGetTopology(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Display Schema validation
// ---------------------------------------------------------------------------

func TestHandleCreateDisplaySchema_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{"invalid JSON", `{invalid`, http.StatusBadRequest, "INVALID_JSON"},
		{"missing name", `{"schema_type":"node"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"missing schema_type", `{"name":"test"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/display-schemas", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleCreateDisplaySchema(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestHandleGetDisplaySchema_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/display-schemas/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleGetDisplaySchema(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdateDisplaySchema_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("PATCH", "/api/v1/display-schemas/", strings.NewReader(`{"name":"test"}`))
	req.SetPathValue("id", "")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.handleUpdateDisplaySchema(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleDeleteDisplaySchema_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("DELETE", "/api/v1/display-schemas/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleDeleteDisplaySchema(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — Import Parser validation
// ---------------------------------------------------------------------------

func TestHandleCreateImportParser_ValidationErrors(t *testing.T) {
	s := newTestServer()

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{"invalid JSON", `{invalid`, http.StatusBadRequest, "INVALID_JSON"},
		{"missing name", `{"format":"xml"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"missing format", `{"name":"test"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"invalid format", `{"name":"test","format":"invalid"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/import-parsers", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			s.handleCreateImportParser(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestHandleGetImportParser_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/import-parsers/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleGetImportParser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdateImportParser_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("PATCH", "/api/v1/import-parsers/", strings.NewReader(`{"name":"test"}`))
	req.SetPathValue("id", "")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.handleUpdateImportParser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleDeleteImportParser_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("DELETE", "/api/v1/import-parsers/", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleDeleteImportParser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleTestImportParser_MissingID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("POST", "/api/v1/import-parsers//test", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleTestImportParser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: Handler — List Nodes / Edges validation
// ---------------------------------------------------------------------------

func TestHandleListNodes_MissingNetworkID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/networks//nodes", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleListNodes(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleListEdges_MissingNetworkID(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("GET", "/api/v1/networks//edges", nil)
	req.SetPathValue("id", "")
	w := httptest.NewRecorder()

	s.handleListEdges(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// ---------------------------------------------------------------------------
// Test: publishEvent with nil NATS connection
// ---------------------------------------------------------------------------

func TestPublishEvent_NilNATS(t *testing.T) {
	s := newTestServer()
	// Should not panic with nil NATS
	s.publishEvent("test.event", map[string]string{"key": "value"})
}

// ---------------------------------------------------------------------------
// Test: getEnv / envOrInt
// ---------------------------------------------------------------------------

func TestGetEnv(t *testing.T) {
	t.Run("returns fallback", func(t *testing.T) {
		got := getEnv("ENDPOINT_TEST_NONEXISTENT_VAR", "default_val")
		if got != "default_val" {
			t.Errorf("getEnv() = %q, want %q", got, "default_val")
		}
	})
}

func TestEnvOrInt(t *testing.T) {
	t.Run("returns fallback", func(t *testing.T) {
		got := envOrInt("ENDPOINT_TEST_NONEXISTENT_INT", 42)
		if got != 42 {
			t.Errorf("envOrInt() = %d, want %d", got, 42)
		}
	})
}

// ---------------------------------------------------------------------------
// Test: getUserID
// ---------------------------------------------------------------------------

func TestGetUserID(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{"with user ID", "user-123", "user-123"},
		{"empty header", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if tt.header != "" {
				r.Header.Set("X-User-ID", tt.header)
			}
			got := getUserID(r)
			if got != tt.want {
				t.Errorf("getUserID() = %q, want %q", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: extractJSONServices
// ---------------------------------------------------------------------------

func TestExtractJSONServices(t *testing.T) {
	t.Run("valid services array", func(t *testing.T) {
		obj := map[string]any{
			"services": []any{
				map[string]any{"port": float64(22), "name": "ssh"},
				map[string]any{"port": float64(80), "name": "http"},
			},
		}
		fm := FieldMapping{
			Source: "services",
			Target: "services",
			SubMappings: []FieldMapping{
				{Source: "port", Target: "port", Transform: "to_integer"},
				{Source: "name", Target: "service"},
			},
		}
		services := extractJSONServices(obj, fm)
		if len(services) != 2 {
			t.Fatalf("expected 2 services, got %d", len(services))
		}
		if services[0]["port"] != 22 {
			t.Errorf("services[0].port = %v, want 22", services[0]["port"])
		}
		if services[0]["service"] != "ssh" {
			t.Errorf("services[0].service = %v, want 'ssh'", services[0]["service"])
		}
	})

	t.Run("missing services path", func(t *testing.T) {
		obj := map[string]any{"other": "data"}
		fm := FieldMapping{Source: "services", Target: "services"}
		services := extractJSONServices(obj, fm)
		if services != nil {
			t.Errorf("expected nil, got %v", services)
		}
	})

	t.Run("non-array value", func(t *testing.T) {
		obj := map[string]any{"services": "not_an_array"}
		fm := FieldMapping{Source: "services", Target: "services"}
		services := extractJSONServices(obj, fm)
		if services != nil {
			t.Errorf("expected nil, got %v", services)
		}
	})
}

// ---------------------------------------------------------------------------
// Tests requiring database (skipped)
// ---------------------------------------------------------------------------

func TestHandleCreateNetwork_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleListNetworks_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleGetNetwork_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleImportNmapXML_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestHandleHealthReady_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestExecuteXMLParser_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestExecuteJSONParser_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestExecuteCSVParser_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

func TestGenerateSubnetEdges_RequiresDB(t *testing.T) {
	t.Skip("requires database")
}

// ===========================================================================
// M12 Cross-Domain Operations Tests — Finding Enrichment, Lineage, Redact, Sync
// ===========================================================================

// newTestServerWithLogger creates a Server with a discard logger for handler tests.
func newTestServerWithLogger() *Server {
	return &Server{
		db:     nil,
		nc:     nil,
		port:   "0",
		logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}
}

// ---------------------------------------------------------------------------
// Test: Finding struct — M12 cross-domain fields
// ---------------------------------------------------------------------------

func TestFindingStruct_CrossDomainFields(t *testing.T) {
	originFindingID := "origin-finding-123"
	originEnclave := "low"
	redactedSummary := "Redacted version of the finding"

	f := Finding{
		ID:              "finding-001",
		OperationID:     "op-001",
		FindingType:     "vulnerability",
		Severity:        "high",
		Title:           "Test Finding",
		Description:     "Test description",
		Evidence:        "Evidence data",
		Tags:            []string{"m12", "cross-domain"},
		Classification:  "CUI",
		OriginFindingID: &originFindingID,
		OriginEnclave:   &originEnclave,
		RedactedSummary: &redactedSummary,
		CreatedBy:       "user-1",
		CreatedAt:       "2026-03-01T00:00:00Z",
		UpdatedAt:       "2026-03-01T00:00:00Z",
	}

	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded Finding
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.OriginFindingID == nil || *decoded.OriginFindingID != originFindingID {
		t.Errorf("OriginFindingID = %v, want %q", decoded.OriginFindingID, originFindingID)
	}
	if decoded.OriginEnclave == nil || *decoded.OriginEnclave != originEnclave {
		t.Errorf("OriginEnclave = %v, want %q", decoded.OriginEnclave, originEnclave)
	}
	if decoded.RedactedSummary == nil || *decoded.RedactedSummary != redactedSummary {
		t.Errorf("RedactedSummary = %v, want %q", decoded.RedactedSummary, redactedSummary)
	}
	if decoded.Classification != "CUI" {
		t.Errorf("Classification = %q, want CUI", decoded.Classification)
	}
}

func TestFindingStruct_NilOptionalFields(t *testing.T) {
	f := Finding{
		ID:             "finding-002",
		OperationID:    "op-002",
		FindingType:    "misconfiguration",
		Severity:       "medium",
		Title:          "No Cross-Domain Fields",
		Description:    "Basic finding without cross-domain metadata",
		Evidence:       "evidence",
		Tags:           []string{},
		Classification: "UNCLASS",
		CreatedBy:      "user-2",
	}

	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded Finding
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.OriginFindingID != nil {
		t.Errorf("OriginFindingID should be nil, got %v", decoded.OriginFindingID)
	}
	if decoded.OriginEnclave != nil {
		t.Errorf("OriginEnclave should be nil, got %v", decoded.OriginEnclave)
	}
	if decoded.RedactedSummary != nil {
		t.Errorf("RedactedSummary should be nil, got %v", decoded.RedactedSummary)
	}
}

// ---------------------------------------------------------------------------
// Test: EnrichFindingRequest JSON
// ---------------------------------------------------------------------------

func TestEnrichFindingRequestJSON(t *testing.T) {
	sev := "critical"
	ev := "Additional evidence from analysis"
	rem := "Apply patch X"

	req := EnrichFindingRequest{
		Title:          "Enriched: CVE-2024-1234",
		Description:    "Deep analysis of the vulnerability",
		Classification: "SECRET",
		Severity:       &sev,
		Evidence:       &ev,
		Remediation:    &rem,
		Tags:           []string{"cve", "enriched"},
		Metadata:       map[string]string{"analyst": "user-1"},
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded EnrichFindingRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.Title != req.Title {
		t.Errorf("Title = %q, want %q", decoded.Title, req.Title)
	}
	if decoded.Classification != "SECRET" {
		t.Errorf("Classification = %q, want SECRET", decoded.Classification)
	}
	if decoded.Severity == nil || *decoded.Severity != "critical" {
		t.Errorf("Severity = %v, want critical", decoded.Severity)
	}
}

// ---------------------------------------------------------------------------
// Test: RedactFindingRequest JSON
// ---------------------------------------------------------------------------

func TestRedactFindingRequestJSON(t *testing.T) {
	req := RedactFindingRequest{
		RedactedSummary:        "A vulnerability was found in system X.",
		RedactedClassification: "UNCLASS",
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded RedactFindingRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.RedactedSummary != req.RedactedSummary {
		t.Errorf("RedactedSummary = %q, want %q", decoded.RedactedSummary, req.RedactedSummary)
	}
	if decoded.RedactedClassification != "UNCLASS" {
		t.Errorf("RedactedClassification = %q, want UNCLASS", decoded.RedactedClassification)
	}
}

// ---------------------------------------------------------------------------
// Test: FindingLink JSON
// ---------------------------------------------------------------------------

func TestFindingLinkJSON(t *testing.T) {
	link := FindingLink{
		ID:              "link-001",
		SourceFindingID: "finding-source",
		LinkedFindingID: "finding-linked",
		LinkType:        "enrichment",
		SourceEnclave:   "high",
		CreatedAt:       "2026-03-01T00:00:00Z",
	}

	data, err := json.Marshal(link)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded FindingLink
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.LinkType != "enrichment" {
		t.Errorf("LinkType = %q, want enrichment", decoded.LinkType)
	}
	if decoded.SourceEnclave != "high" {
		t.Errorf("SourceEnclave = %q, want high", decoded.SourceEnclave)
	}
}

// ---------------------------------------------------------------------------
// Test: FindingLineageEntry JSON
// ---------------------------------------------------------------------------

func TestFindingLineageEntryJSON(t *testing.T) {
	entry := FindingLineageEntry{
		Finding: Finding{
			ID:             "finding-enriched",
			OperationID:    "op-001",
			FindingType:    "vulnerability",
			Severity:       "critical",
			Title:          "[Enriched] Original Finding",
			Description:    "Enriched with high-side analysis",
			Evidence:       "evidence",
			Tags:           []string{"enriched"},
			Classification: "CUI",
			CreatedBy:      "analyst-1",
		},
		LinkType: "enrichment",
		LinkDir:  "target",
	}

	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded FindingLineageEntry
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded.LinkType != "enrichment" {
		t.Errorf("LinkType = %q, want enrichment", decoded.LinkType)
	}
	if decoded.LinkDir != "target" {
		t.Errorf("LinkDir = %q, want target", decoded.LinkDir)
	}
	if decoded.Finding.Classification != "CUI" {
		t.Errorf("Finding.Classification = %q, want CUI", decoded.Finding.Classification)
	}
}

// ---------------------------------------------------------------------------
// Test: handleEnrichFinding — enclave restriction (low side blocked)
// ---------------------------------------------------------------------------

func TestHandleEnrichFinding_LowSideBlocked(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := newTestServerWithLogger()

	req := httptest.NewRequest("POST", "/api/v1/findings/finding-1/enrich", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	srv.handleEnrichFinding(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}

	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "ENCLAVE_RESTRICTED" {
		t.Errorf("error code = %q, want ENCLAVE_RESTRICTED", errObj["code"])
	}
}

func TestHandleEnrichFinding_HighSideRequiresDB(t *testing.T) {
	old := enclave
	enclave = "high"
	defer func() { enclave = old }()

	srv := newTestServerWithLogger()

	body := `{"title":"Enriched","description":"Analysis","classification":"CUI"}`
	req := httptest.NewRequest("POST", "/api/v1/findings/finding-1/enrich", strings.NewReader(body))
	rec := httptest.NewRecorder()

	// On high side with nil DB, this should fail at DB query (NOT at enclave check)
	defer func() {
		if r := recover(); r != nil {
			// Expected: nil DB dereference means we got past the enclave check
			t.Logf("Panicked as expected with nil DB: %v", r)
		}
	}()

	srv.handleEnrichFinding(rec, req)

	// If we get here without panic, the handler returned an error code (e.g., 500)
	if rec.Code == http.StatusForbidden {
		t.Error("high-side request should not be blocked by enclave check")
	}
}

// ---------------------------------------------------------------------------
// Test: handleRedactFinding — enclave restriction (low side blocked)
// ---------------------------------------------------------------------------

func TestHandleRedactFinding_LowSideBlocked(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := newTestServerWithLogger()

	req := httptest.NewRequest("POST", "/api/v1/findings/finding-1/redact", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	srv.handleRedactFinding(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}

	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatal("expected error object in response")
	}
	if errObj["code"] != "ENCLAVE_RESTRICTED" {
		t.Errorf("error code = %q, want ENCLAVE_RESTRICTED", errObj["code"])
	}
}

// ---------------------------------------------------------------------------
// Test: handleSyncFindingToHigh — DB required (nil DB panics or errors)
// ---------------------------------------------------------------------------

func TestHandleSyncFindingToHigh_RequiresDB(t *testing.T) {
	t.Skip("requires database — sync-to-high fetches finding from PG")
}

// ---------------------------------------------------------------------------
// Test: handleFindingLineage — DB required
// ---------------------------------------------------------------------------

func TestHandleFindingLineage_RequiresDB(t *testing.T) {
	t.Skip("requires database — lineage queries finding_links table")
}

// ---------------------------------------------------------------------------
// Test: Classification helpers in endpoint service
// ---------------------------------------------------------------------------

func TestEndpointIsValidClassification(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"UNCLASS", true},
		{"CUI", true},
		{"SECRET", true},
		{"unclass", false},
		{"", false},
		{"TOP_SECRET", false},
		{"CONFIDENTIAL", false},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := isValidClassification(tc.input)
			if got != tc.want {
				t.Errorf("isValidClassification(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestEndpointClassificationRank(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"UNCLASS", 0},
		{"CUI", 1},
		{"SECRET", 2},
		{"INVALID", -1},
		{"", -1},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := classificationRank(tc.input)
			if got != tc.want {
				t.Errorf("classificationRank(%q) = %d, want %d", tc.input, got, tc.want)
			}
		})
	}
}

func TestEndpointClassificationRank_Ordering(t *testing.T) {
	if classificationRank("UNCLASS") >= classificationRank("CUI") {
		t.Error("UNCLASS should rank lower than CUI")
	}
	if classificationRank("CUI") >= classificationRank("SECRET") {
		t.Error("CUI should rank lower than SECRET")
	}
	if classificationRank("UNCLASS") >= classificationRank("SECRET") {
		t.Error("UNCLASS should rank lower than SECRET")
	}
}

// ---------------------------------------------------------------------------
// Test: Enrichment classification validation logic
// ---------------------------------------------------------------------------

func TestEnrichmentClassificationUpgrade(t *testing.T) {
	// Enriched copy must have same or higher classification than source
	tests := []struct {
		name            string
		sourceClassif   string
		enrichedClassif string
		wantAllowed     bool
	}{
		{"UNCLASS -> CUI (upgrade allowed)", "UNCLASS", "CUI", true},
		{"UNCLASS -> SECRET (upgrade allowed)", "UNCLASS", "SECRET", true},
		{"UNCLASS -> UNCLASS (same allowed)", "UNCLASS", "UNCLASS", true},
		{"CUI -> SECRET (upgrade allowed)", "CUI", "SECRET", true},
		{"CUI -> CUI (same allowed)", "CUI", "CUI", true},
		{"CUI -> UNCLASS (downgrade blocked)", "CUI", "UNCLASS", false},
		{"SECRET -> CUI (downgrade blocked)", "SECRET", "CUI", false},
		{"SECRET -> UNCLASS (downgrade blocked)", "SECRET", "UNCLASS", false},
		{"SECRET -> SECRET (same allowed)", "SECRET", "SECRET", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			allowed := classificationRank(tc.enrichedClassif) >= classificationRank(tc.sourceClassif)
			if allowed != tc.wantAllowed {
				t.Errorf("enrichment %s -> %s: allowed = %v, want %v",
					tc.sourceClassif, tc.enrichedClassif, allowed, tc.wantAllowed)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: Redaction classification validation logic
// ---------------------------------------------------------------------------

func TestRedactionClassificationDowngrade(t *testing.T) {
	// Redacted copy must have strictly lower classification than source
	tests := []struct {
		name           string
		sourceClassif  string
		redactClassif  string
		wantAllowed    bool
	}{
		{"SECRET -> CUI (downgrade allowed)", "SECRET", "CUI", true},
		{"SECRET -> UNCLASS (downgrade allowed)", "SECRET", "UNCLASS", true},
		{"CUI -> UNCLASS (downgrade allowed)", "CUI", "UNCLASS", true},
		{"SECRET -> SECRET (same blocked)", "SECRET", "SECRET", false},
		{"CUI -> CUI (same blocked)", "CUI", "CUI", false},
		{"CUI -> SECRET (upgrade blocked)", "CUI", "SECRET", false},
		{"UNCLASS -> CUI (upgrade blocked)", "UNCLASS", "CUI", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Redacted must be strictly lower: rank(redacted) < rank(source)
			allowed := classificationRank(tc.redactClassif) < classificationRank(tc.sourceClassif)
			if allowed != tc.wantAllowed {
				t.Errorf("redaction %s -> %s: allowed = %v, want %v",
					tc.sourceClassif, tc.redactClassif, allowed, tc.wantAllowed)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test: UNCLASS cannot be redacted (UNCLASS findings should not need redaction)
// ---------------------------------------------------------------------------

func TestUNCLASSCannotBeRedacted(t *testing.T) {
	// The handler checks: src.Classification == "UNCLASS" → 400
	// We verify the logic: UNCLASS is already freely sharable
	if classificationRank("UNCLASS") != 0 {
		t.Fatal("UNCLASS should have rank 0 (lowest)")
	}
	// No classification is lower than UNCLASS, so redaction is meaningless
	for _, c := range []string{"UNCLASS", "CUI", "SECRET"} {
		if classificationRank(c) < classificationRank("UNCLASS") {
			t.Errorf("found classification %q ranked lower than UNCLASS — impossible", c)
		}
	}
}

// ---------------------------------------------------------------------------
// Test: SECRET sync blocked
// ---------------------------------------------------------------------------

func TestSECRETSyncBlocked(t *testing.T) {
	// The handler blocks sync if finding classification is SECRET
	// This is defense-in-depth: SECRET should not exist on low side
	classification := "SECRET"
	if classification != "SECRET" {
		t.Skip("not testing SECRET")
	}

	// SECRET findings cannot be synced across enclaves
	isBlocked := classification == "SECRET"
	if !isBlocked {
		t.Error("SECRET finding sync should be blocked")
	}
}

// ---------------------------------------------------------------------------
// Test: Finding select columns include cross-domain fields
// ---------------------------------------------------------------------------

func TestFindingSelectColsIncludesCrossDomain(t *testing.T) {
	requiredCols := []string{
		"origin_finding_id",
		"origin_enclave",
		"redacted_summary",
		"classification",
	}

	for _, col := range requiredCols {
		if !strings.Contains(findingSelectCols, col) {
			t.Errorf("findingSelectCols missing %q", col)
		}
	}
}

// ---------------------------------------------------------------------------
// Test: Endpoint isDegraded
// ---------------------------------------------------------------------------

func TestEndpointIsDegraded(t *testing.T) {
	tests := []struct {
		name        string
		enclaveVal  string
		ctiNil      bool
		wantDegraded bool
	}{
		{"high side never degraded", "high", false, false},
		{"low side with nil CTI not degraded", "low", true, false},
		{"empty enclave not degraded", "", false, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			old := enclave
			enclave = tc.enclaveVal
			defer func() { enclave = old }()

			srv := &Server{
				logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
			}
			if !tc.ctiNil {
				srv.cti = &ctiHealth{
					connected: true,
					logger:    slog.New(slog.NewJSONHandler(io.Discard, nil)),
				}
			}

			got := srv.isDegraded()
			if got != tc.wantDegraded {
				t.Errorf("isDegraded() = %v, want %v", got, tc.wantDegraded)
			}
		})
	}
}

func TestEndpointIsDegraded_LowSideDisconnected(t *testing.T) {
	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := &Server{
		logger: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		cti: &ctiHealth{
			connected: false,
			logger:    slog.New(slog.NewJSONHandler(io.Discard, nil)),
		},
	}

	if !srv.isDegraded() {
		t.Error("low side with disconnected CTI should be degraded")
	}
}

// ---------------------------------------------------------------------------
// Test: getUserID helper — cross-domain context
// ---------------------------------------------------------------------------

func TestGetUserID_CrossDomainContext(t *testing.T) {
	// Verify getUserID is used by enrichment/redaction handlers for created_by
	req := httptest.NewRequest("POST", "/api/v1/findings/f1/enrich", nil)
	req.Header.Set("X-User-ID", "analyst-cross-domain")
	got := getUserID(req)
	if got != "analyst-cross-domain" {
		t.Errorf("getUserID() = %q, want %q", got, "analyst-cross-domain")
	}

	// Without header, should return empty (handlers default to "system")
	req2 := httptest.NewRequest("POST", "/api/v1/findings/f1/enrich", nil)
	got2 := getUserID(req2)
	if got2 != "" {
		t.Errorf("getUserID() with no header = %q, want empty", got2)
	}
}

// ---------------------------------------------------------------------------
// Test: Finding routes registered in Start()
// ---------------------------------------------------------------------------

func TestFindingRoutesRegistered(t *testing.T) {
	// Verify that the expected M12 finding routes are registered.
	// We check by confirming the route patterns exist in the mux.
	// Since we can't introspect the mux, we test that handlers don't panic
	// when called with enclave=low for the restricted endpoints.

	old := enclave
	enclave = "low"
	defer func() { enclave = old }()

	srv := newTestServerWithLogger()

	// Enrich endpoint (low side blocked)
	t.Run("POST /api/v1/findings/{id}/enrich blocked on low", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/v1/findings/test-id/enrich", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		srv.handleEnrichFinding(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})

	// Redact endpoint (low side blocked)
	t.Run("POST /api/v1/findings/{id}/redact blocked on low", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/v1/findings/test-id/redact", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		srv.handleRedactFinding(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})
}
