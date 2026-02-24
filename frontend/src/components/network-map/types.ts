export interface NetworkNodeRecord {
  id: string
  network_id: string
  endpoint_id: string | null
  ip_address: string
  hostname: string
  mac_address: string | null
  os: string
  os_version: string
  status: string
  node_type: string
  position_x: number | null
  position_y: number | null
  services: ServiceEntry[] | null
  metadata: unknown
  created_at: string
  updated_at: string
}

export interface ServiceEntry {
  port: number
  protocol: string
  service: string
  product: string
  version: string
}

export interface VulnEntry {
  cve_id: string
  title: string
  description?: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  cvss: number
  exploit_available: boolean
  status: 'unverified' | 'confirmed' | 'exploited' | 'mitigated' | 'accepted_risk'
  detected_by?: string
  exploits?: ExploitEntry[]
  attack_notes?: string
  timeline?: TimelineEntry[]
}

export interface ExploitEntry {
  type: 'metasploit' | 'exploitdb' | 'poc_url' | 'custom'
  reference: string
  url?: string
  verified: boolean
  notes?: string
}

export interface TimelineEntry {
  action: string
  timestamp: string
  actor?: string
}

export interface InterfaceEntry {
  name: string
  mac: string
  ips: string[]
  vlan?: number
  state: string
}
