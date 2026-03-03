# EMS-COP Development Environment
# Single-enclave, small instances, minimal HA

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "ems-cop"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

# ════════════════════════════════════════════
#  Networking
# ════════════════════════════════════════════
module "networking" {
  source = "../../modules/networking"

  environment        = "dev"
  vpc_cidr           = var.vpc_cidr
  availability_zones = [var.availability_zone]
  ssh_allowed_cidrs  = var.ssh_allowed_cidrs

  tags = {
    Environment = "dev"
  }
}

# ════════════════════════════════════════════
#  Compute (single instances)
# ════════════════════════════════════════════
module "compute" {
  source = "../../modules/compute"

  environment = "dev"
  ami_id      = var.ami_id
  ems_version = var.ems_version

  ssh_public_key             = var.ssh_public_key
  low_instance_type          = "t3.medium"
  high_instance_type         = "t3.medium"
  cti_instance_type          = "t3.small"
  low_enclave_instance_count = 1
  high_enclave_instance_count = 0  # Dev uses single enclave
  cti_zone_instance_count    = 0

  low_enclave_subnet_ids  = module.networking.low_enclave_subnet_ids
  high_enclave_subnet_ids = module.networking.high_enclave_subnet_ids
  cti_zone_subnet_ids     = module.networking.cti_zone_subnet_ids
  low_enclave_sg_id       = module.networking.low_enclave_sg_id
  high_enclave_sg_id      = module.networking.high_enclave_sg_id
  cti_zone_sg_id          = module.networking.cti_zone_sg_id

  tags = {
    Environment = "dev"
  }
}

# ════════════════════════════════════════════
#  Database
# ════════════════════════════════════════════
module "database" {
  source = "../../modules/database"

  environment             = "dev"
  vpc_id                  = module.networking.vpc_id
  subnet_ids              = module.networking.low_enclave_subnet_ids
  app_security_group_ids  = [module.networking.low_enclave_sg_id]
  postgres_instance_class = "db.t3.micro"
  postgres_storage_gb     = 20
  postgres_password       = var.postgres_password
  redis_node_type         = "cache.t3.micro"
  redis_password          = var.redis_password
  multi_az                = false
  backup_retention_days   = 1
  ami_id                  = var.ami_id
  key_pair_name           = module.compute.key_pair_name

  tags = {
    Environment = "dev"
  }
}

# ════════════════════════════════════════════
#  Storage
# ════════════════════════════════════════════
module "storage" {
  source = "../../modules/storage"

  environment            = "dev"
  enclave                = "low"
  availability_zone      = var.availability_zone
  clickhouse_volume_size = 20
  nats_volume_size       = 10

  tags = {
    Environment = "dev"
  }
}
