output "zone_id" {
  description = "Route53 hosted zone ID"
  value       = local.zone_id
}

output "nameservers" {
  description = "Route53 nameservers (if zone was created)"
  value       = var.create_zone ? aws_route53_zone.ems[0].name_servers : []
}

output "low_fqdn" {
  description = "Low-side FQDN"
  value       = var.low_alb_dns_name != "" ? "low.${var.domain_name}" : ""
}

output "high_fqdn" {
  description = "High-side FQDN"
  value       = var.high_alb_dns_name != "" ? "high.${var.domain_name}" : ""
}
