output "postgres_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.postgres.endpoint
}

output "postgres_address" {
  description = "RDS PostgreSQL address (hostname)"
  value       = aws_db_instance.postgres.address
}

output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_port" {
  description = "ElastiCache Redis port"
  value       = aws_elasticache_replication_group.redis.port
}

output "clickhouse_private_ip" {
  description = "ClickHouse EC2 private IP"
  value       = aws_instance.clickhouse.private_ip
}

output "database_security_group_id" {
  description = "Database security group ID"
  value       = aws_security_group.database.id
}
