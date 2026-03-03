variable "environment" {
  description = "Environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for database deployment"
  type        = list(string)
}

variable "app_security_group_ids" {
  description = "Security group IDs allowed to access databases"
  type        = list(string)
}

variable "postgres_instance_class" {
  description = "RDS instance class for PostgreSQL"
  type        = string
  default     = "db.t3.medium"
}

variable "postgres_storage_gb" {
  description = "Initial PostgreSQL storage in GB"
  type        = number
  default     = 20
}

variable "postgres_max_storage_gb" {
  description = "Maximum auto-scaling PostgreSQL storage in GB"
  type        = number
  default     = 100
}

variable "postgres_password" {
  description = "PostgreSQL master password"
  type        = string
  sensitive   = true
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.medium"
}

variable "redis_password" {
  description = "Redis auth token"
  type        = string
  sensitive   = true
}

variable "multi_az" {
  description = "Enable multi-AZ for HA"
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Number of days to retain backups"
  type        = number
  default     = 7
}

variable "ami_id" {
  description = "AMI ID for ClickHouse EC2 instance"
  type        = string
}

variable "clickhouse_instance_type" {
  description = "EC2 instance type for ClickHouse"
  type        = string
  default     = "t3.medium"
}

variable "clickhouse_storage_gb" {
  description = "ClickHouse root volume size in GB"
  type        = number
  default     = 50
}

variable "key_pair_name" {
  description = "SSH key pair name"
  type        = string
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
