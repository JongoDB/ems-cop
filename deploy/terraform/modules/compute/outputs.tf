output "low_enclave_instance_ids" {
  description = "Low-enclave EC2 instance IDs"
  value       = aws_instance.low_enclave[*].id
}

output "low_enclave_private_ips" {
  description = "Low-enclave private IP addresses"
  value       = aws_instance.low_enclave[*].private_ip
}

output "high_enclave_instance_ids" {
  description = "High-enclave EC2 instance IDs"
  value       = aws_instance.high_enclave[*].id
}

output "high_enclave_private_ips" {
  description = "High-enclave private IP addresses"
  value       = aws_instance.high_enclave[*].private_ip
}

output "cti_zone_instance_ids" {
  description = "CTI zone EC2 instance IDs"
  value       = aws_instance.cti_zone[*].id
}

output "cti_zone_private_ips" {
  description = "CTI zone private IP addresses"
  value       = aws_instance.cti_zone[*].private_ip
}

output "key_pair_name" {
  description = "SSH key pair name"
  value       = aws_key_pair.ems.key_name
}
