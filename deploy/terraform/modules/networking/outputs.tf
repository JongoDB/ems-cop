output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.ems.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = aws_vpc.ems.cidr_block
}

output "low_enclave_subnet_ids" {
  description = "Low-enclave subnet IDs"
  value       = aws_subnet.low_enclave[*].id
}

output "high_enclave_subnet_ids" {
  description = "High-enclave subnet IDs"
  value       = aws_subnet.high_enclave[*].id
}

output "cti_zone_subnet_ids" {
  description = "CTI zone subnet IDs"
  value       = aws_subnet.cti_zone[*].id
}

output "low_enclave_sg_id" {
  description = "Low-enclave security group ID"
  value       = aws_security_group.low_enclave.id
}

output "high_enclave_sg_id" {
  description = "High-enclave security group ID"
  value       = aws_security_group.high_enclave.id
}

output "cti_zone_sg_id" {
  description = "CTI zone security group ID"
  value       = aws_security_group.cti_zone.id
}

output "nat_gateway_ip" {
  description = "NAT Gateway public IP"
  value       = aws_eip.nat.public_ip
}
