# EMS-COP Staging Environment
# Dual-enclave, medium instances, basic HA

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
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# ════════════════════════════════════════════
#  Networking
# ════════════════════════════════════════════
module "networking" {
  source = "../../modules/networking"

  environment        = "staging"
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
  ssh_allowed_cidrs  = var.ssh_allowed_cidrs

  tags = {
    Environment = "staging"
  }
}

# ════════════════════════════════════════════
#  Compute (dual-enclave)
# ════════════════════════════════════════════
module "compute" {
  source = "../../modules/compute"

  environment = "staging"
  ami_id      = var.ami_id
  ems_version = var.ems_version

  ssh_public_key              = var.ssh_public_key
  low_instance_type           = "t3.large"
  high_instance_type          = "t3.large"
  cti_instance_type           = "t3.medium"
  low_enclave_instance_count  = 1
  high_enclave_instance_count = 1
  cti_zone_instance_count     = 1

  low_enclave_subnet_ids  = module.networking.low_enclave_subnet_ids
  high_enclave_subnet_ids = module.networking.high_enclave_subnet_ids
  cti_zone_subnet_ids     = module.networking.cti_zone_subnet_ids
  low_enclave_sg_id       = module.networking.low_enclave_sg_id
  high_enclave_sg_id      = module.networking.high_enclave_sg_id
  cti_zone_sg_id          = module.networking.cti_zone_sg_id

  tags = {
    Environment = "staging"
  }
}

# ════════════════════════════════════════════
#  Database — Low Enclave
# ════════════════════════════════════════════
module "database_low" {
  source = "../../modules/database"

  environment             = "staging"
  vpc_id                  = module.networking.vpc_id
  subnet_ids              = module.networking.low_enclave_subnet_ids
  app_security_group_ids  = [module.networking.low_enclave_sg_id]
  postgres_instance_class = "db.t3.medium"
  postgres_storage_gb     = 50
  postgres_password       = var.postgres_password_low
  redis_node_type         = "cache.t3.medium"
  redis_password          = var.redis_password_low
  multi_az                = false
  backup_retention_days   = 7
  ami_id                  = var.ami_id
  key_pair_name           = module.compute.key_pair_name

  tags = {
    Environment = "staging"
    Enclave     = "low"
  }
}

# ════════════════════════════════════════════
#  Database — High Enclave
# ════════════════════════════════════════════
module "database_high" {
  source = "../../modules/database"

  environment             = "staging-high"
  vpc_id                  = module.networking.vpc_id
  subnet_ids              = module.networking.high_enclave_subnet_ids
  app_security_group_ids  = [module.networking.high_enclave_sg_id]
  postgres_instance_class = "db.t3.medium"
  postgres_storage_gb     = 50
  postgres_password       = var.postgres_password_high
  redis_node_type         = "cache.t3.medium"
  redis_password          = var.redis_password_high
  multi_az                = false
  backup_retention_days   = 7
  ami_id                  = var.ami_id
  key_pair_name           = module.compute.key_pair_name

  tags = {
    Environment = "staging"
    Enclave     = "high"
  }
}

# ════════════════════════════════════════════
#  Storage
# ════════════════════════════════════════════
module "storage_low" {
  source = "../../modules/storage"

  environment       = "staging"
  enclave           = "low"
  availability_zone = var.availability_zones[0]

  tags = {
    Environment = "staging"
    Enclave     = "low"
  }
}

module "storage_high" {
  source = "../../modules/storage"

  environment       = "staging"
  enclave           = "high"
  availability_zone = var.availability_zones[0]

  tags = {
    Environment = "staging"
    Enclave     = "high"
  }
}
