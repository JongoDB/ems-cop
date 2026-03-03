variable "environment" {
  description = "Environment name"
  type        = string
}

variable "domain_name" {
  description = "Domain name for EMS-COP (e.g., ems-cop.example.com)"
  type        = string
}

variable "create_zone" {
  description = "Whether to create a new Route53 hosted zone"
  type        = bool
  default     = true
}

variable "existing_zone_id" {
  description = "Existing Route53 zone ID (if create_zone is false)"
  type        = string
  default     = ""
}

variable "low_alb_dns_name" {
  description = "Low-side ALB DNS name"
  type        = string
  default     = ""
}

variable "low_alb_zone_id" {
  description = "Low-side ALB zone ID"
  type        = string
  default     = ""
}

variable "high_alb_dns_name" {
  description = "High-side ALB DNS name"
  type        = string
  default     = ""
}

variable "high_alb_zone_id" {
  description = "High-side ALB zone ID"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
