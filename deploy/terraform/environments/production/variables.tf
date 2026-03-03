variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "availability_zones" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "ami_id" {
  type = string
}

variable "ems_version" {
  type    = string
  default = "0.17.0"
}

variable "ssh_public_key" {
  type = string
}

variable "ssh_allowed_cidrs" {
  type    = list(string)
  default = []
}

variable "postgres_password_low" {
  type      = string
  sensitive = true
}

variable "postgres_password_high" {
  type      = string
  sensitive = true
}

variable "redis_password_low" {
  type      = string
  sensitive = true
}

variable "redis_password_high" {
  type      = string
  sensitive = true
}

variable "certificate_arn_low" {
  description = "ACM certificate ARN for low-side HTTPS"
  type        = string
}

variable "certificate_arn_high" {
  description = "ACM certificate ARN for high-side HTTPS"
  type        = string
}

variable "domain_name" {
  description = "Domain name for EMS-COP"
  type        = string
  default     = "ems-cop.example.com"
}

variable "create_dns_zone" {
  type    = bool
  default = true
}

variable "existing_zone_id" {
  type    = string
  default = ""
}
