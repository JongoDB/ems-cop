variable "environment" {
  description = "Environment name (dev, staging, production)"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "low_enclave_cidr" {
  description = "Low-enclave subnet CIDR"
  type        = string
  default     = "10.0.0.0/20"
}

variable "high_enclave_cidr" {
  description = "High-enclave subnet CIDR"
  type        = string
  default     = "10.0.16.0/20"
}

variable "cti_zone_cidr" {
  description = "CTI zone subnet CIDR"
  type        = string
  default     = "10.0.32.0/20"
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to SSH"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default     = {}
}
