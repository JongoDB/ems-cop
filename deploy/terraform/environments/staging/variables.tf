variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "availability_zones" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
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
