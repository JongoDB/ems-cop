output "vpc_id" {
  value = module.networking.vpc_id
}

output "low_enclave_ips" {
  value = module.compute.low_enclave_private_ips
}

output "high_enclave_ips" {
  value = module.compute.high_enclave_private_ips
}

output "cti_zone_ips" {
  value = module.compute.cti_zone_private_ips
}

output "postgres_low_endpoint" {
  value = module.database_low.postgres_endpoint
}

output "postgres_high_endpoint" {
  value = module.database_high.postgres_endpoint
}
