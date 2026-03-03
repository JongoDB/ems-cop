# EMS-COP Database Module
# RDS PostgreSQL 16 (multi-AZ for prod), ElastiCache Redis, ClickHouse on EC2

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ════════════════════════════════════════════
#  RDS Subnet Group
# ════════════════════════════════════════════
resource "aws_db_subnet_group" "ems" {
  name       = "${var.environment}-ems-cop-db-subnet"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-db-subnet"
  })
}

# ════════════════════════════════════════════
#  Database Security Group
# ════════════════════════════════════════════
resource "aws_security_group" "database" {
  name_prefix = "${var.environment}-ems-db-"
  vpc_id      = var.vpc_id
  description = "EMS-COP database security group"

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.app_security_group_ids
    description     = "PostgreSQL from app servers"
  }

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.app_security_group_ids
    description     = "Redis from app servers"
  }

  ingress {
    from_port       = 8123
    to_port         = 8123
    protocol        = "tcp"
    security_groups = var.app_security_group_ids
    description     = "ClickHouse HTTP from app servers"
  }

  ingress {
    from_port       = 9000
    to_port         = 9000
    protocol        = "tcp"
    security_groups = var.app_security_group_ids
    description     = "ClickHouse native from app servers"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-db-sg"
  })
}

# ════════════════════════════════════════════
#  RDS PostgreSQL 16
# ════════════════════════════════════════════
resource "aws_db_instance" "postgres" {
  identifier     = "${var.environment}-ems-cop-postgres"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.postgres_instance_class

  allocated_storage     = var.postgres_storage_gb
  max_allocated_storage = var.postgres_max_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "ems"
  username = "ems_admin"
  password = var.postgres_password

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.ems.name
  vpc_security_group_ids = [aws_security_group.database.id]

  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  deletion_protection = var.environment == "production"
  skip_final_snapshot = var.environment != "production"

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-postgres"
  })
}

# ════════════════════════════════════════════
#  ElastiCache Redis
# ════════════════════════════════════════════
resource "aws_elasticache_subnet_group" "ems" {
  name       = "${var.environment}-ems-cop-redis-subnet"
  subnet_ids = var.subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.environment}-ems-redis"
  description          = "EMS-COP Redis cluster"

  node_type            = var.redis_node_type
  num_cache_clusters   = var.multi_az ? 2 : 1
  port                 = 6379
  parameter_group_name = "default.redis7"
  engine_version       = "7.0"

  subnet_group_name  = aws_elasticache_subnet_group.ems.name
  security_group_ids = [aws_security_group.database.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_password

  automatic_failover_enabled = var.multi_az

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-redis"
  })
}

# ════════════════════════════════════════════
#  ClickHouse on EC2 (self-hosted)
# ════════════════════════════════════════════
resource "aws_instance" "clickhouse" {
  ami                    = var.ami_id
  instance_type          = var.clickhouse_instance_type
  key_name               = var.key_pair_name
  subnet_id              = var.subnet_ids[0]
  vpc_security_group_ids = [aws_security_group.database.id]

  root_block_device {
    volume_size = var.clickhouse_storage_gb
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-clickhouse"
    Role = "clickhouse"
  })
}
