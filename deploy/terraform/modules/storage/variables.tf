variable "environment" {
  description = "Environment name"
  type        = string
}

variable "enclave" {
  description = "Enclave identifier (low, high)"
  type        = string
}

variable "availability_zone" {
  description = "Availability zone for EBS volumes"
  type        = string
}

variable "clickhouse_volume_size" {
  description = "ClickHouse data volume size in GB"
  type        = number
  default     = 50
}

variable "nats_volume_size" {
  description = "NATS JetStream data volume size in GB"
  type        = number
  default     = 20
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
