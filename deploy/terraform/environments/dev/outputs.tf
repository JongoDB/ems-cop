output "vpc_id" {
  description = "VPC ID"
  value       = module.networking.vpc_id
}

output "low_enclave_ips" {
  description = "Low-enclave instance IPs"
  value       = module.compute.low_enclave_private_ips
}

output "postgres_endpoint" {
  description = "PostgreSQL endpoint"
  value       = module.database.postgres_endpoint
}

output "redis_endpoint" {
  description = "Redis endpoint"
  value       = module.database.redis_endpoint
}

output "s3_bucket" {
  description = "S3 bucket name"
  value       = module.storage.s3_bucket_id
}
