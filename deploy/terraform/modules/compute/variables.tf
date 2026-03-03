variable "environment" {
  description = "Environment name"
  type        = string
}

variable "ems_version" {
  description = "EMS-COP version to deploy"
  type        = string
  default     = "0.17.0"
}

variable "ami_id" {
  description = "AMI ID for EC2 instances (Ubuntu 22.04 LTS recommended)"
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
}

variable "low_instance_type" {
  description = "EC2 instance type for low-enclave"
  type        = string
  default     = "t3.medium"
}

variable "high_instance_type" {
  description = "EC2 instance type for high-enclave"
  type        = string
  default     = "t3.medium"
}

variable "cti_instance_type" {
  description = "EC2 instance type for CTI zone"
  type        = string
  default     = "t3.medium"
}

variable "low_enclave_instance_count" {
  description = "Number of low-enclave instances"
  type        = number
  default     = 1
}

variable "high_enclave_instance_count" {
  description = "Number of high-enclave instances"
  type        = number
  default     = 1
}

variable "cti_zone_instance_count" {
  description = "Number of CTI zone instances"
  type        = number
  default     = 1
}

variable "root_volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 50
}

variable "low_enclave_subnet_ids" {
  description = "Subnet IDs for low-enclave instances"
  type        = list(string)
}

variable "high_enclave_subnet_ids" {
  description = "Subnet IDs for high-enclave instances"
  type        = list(string)
}

variable "cti_zone_subnet_ids" {
  description = "Subnet IDs for CTI zone instances"
  type        = list(string)
}

variable "low_enclave_sg_id" {
  description = "Security group ID for low-enclave"
  type        = string
}

variable "high_enclave_sg_id" {
  description = "Security group ID for high-enclave"
  type        = string
}

variable "cti_zone_sg_id" {
  description = "Security group ID for CTI zone"
  type        = string
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
