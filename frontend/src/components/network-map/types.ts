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
