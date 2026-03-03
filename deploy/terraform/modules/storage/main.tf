# EMS-COP Storage Module
# S3 bucket (MinIO replacement), EBS volumes for data services

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ════════════════════════════════════════════
#  S3 Bucket (replaces MinIO)
# ════════════════════════════════════════════
resource "aws_s3_bucket" "ems" {
  bucket = "${var.environment}-ems-cop-${var.enclave}-data"

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-cop-${var.enclave}-data"
    Enclave = var.enclave
  })
}

resource "aws_s3_bucket_versioning" "ems" {
  bucket = aws_s3_bucket.ems.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ems" {
  bucket = aws_s3_bucket.ems.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "ems" {
  bucket = aws_s3_bucket.ems.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "ems" {
  bucket = aws_s3_bucket.ems.id

  rule {
    id     = "evidence-retention"
    status = "Enabled"

    filter {
      prefix = "evidence/"
    }

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 365
      storage_class = "GLACIER"
    }
  }
}

# ════════════════════════════════════════════
#  S3 Prefixes (virtual folders for buckets)
# ════════════════════════════════════════════
resource "aws_s3_object" "evidence_prefix" {
  bucket  = aws_s3_bucket.ems.id
  key     = "evidence/"
  content = ""
}

resource "aws_s3_object" "attachments_prefix" {
  bucket  = aws_s3_bucket.ems.id
  key     = "attachments/"
  content = ""
}

# ════════════════════════════════════════════
#  EBS Volumes for Data Services
# ════════════════════════════════════════════
resource "aws_ebs_volume" "clickhouse_data" {
  availability_zone = var.availability_zone
  size              = var.clickhouse_volume_size
  type              = "gp3"
  encrypted         = true

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-clickhouse-data-${var.enclave}"
    Service = "clickhouse"
    Enclave = var.enclave
  })
}

resource "aws_ebs_volume" "nats_data" {
  availability_zone = var.availability_zone
  size              = var.nats_volume_size
  type              = "gp3"
  encrypted         = true

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-nats-data-${var.enclave}"
    Service = "nats"
    Enclave = var.enclave
  })
}
