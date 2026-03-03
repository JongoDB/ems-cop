output "s3_bucket_id" {
  description = "S3 bucket ID"
  value       = aws_s3_bucket.ems.id
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.ems.arn
}

output "s3_bucket_domain" {
  description = "S3 bucket domain name"
  value       = aws_s3_bucket.ems.bucket_domain_name
}

output "clickhouse_volume_id" {
  description = "ClickHouse EBS volume ID"
  value       = aws_ebs_volume.clickhouse_data.id
}

output "nats_volume_id" {
  description = "NATS EBS volume ID"
  value       = aws_ebs_volume.nats_data.id
}
