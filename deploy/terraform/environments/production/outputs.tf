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

output "low_alb_dns" {
  value = module.lb_low.alb_dns_name
}

output "high_alb_dns" {
  value = module.lb_high.alb_dns_name
}

output "low_fqdn" {
  value = module.dns.low_fqdn
}

output "high_fqdn" {
  value = module.dns.high_fqdn
}

output "postgres_low_endpoint" {
  value = module.database_low.postgres_endpoint
}

output "postgres_high_endpoint" {
  value = module.database_high.postgres_endpoint
}

output "nameservers" {
  value = module.dns.nameservers
}
