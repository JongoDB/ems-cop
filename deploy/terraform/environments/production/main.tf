# EMS-COP Production Environment
# Dual-enclave, large instances, full HA, multi-AZ

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
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

# ════════════════════════════════════════════
#  Networking
# ════════════════════════════════════════════
module "networking" {
  source = "../../modules/networking"

  environment        = "production"
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
  ssh_allowed_cidrs  = var.ssh_allowed_cidrs

  tags = {
    Environment = "production"
  }
}

# ════════════════════════════════════════════
#  Compute (HA — multiple instances per enclave)
# ════════════════════════════════════════════
module "compute" {
  source = "../../modules/compute"

  environment = "production"
  ami_id      = var.ami_id
  ems_version = var.ems_version

  ssh_public_key              = var.ssh_public_key
  low_instance_type           = "m6i.xlarge"
  high_instance_type          = "m6i.xlarge"
  cti_instance_type           = "m6i.large"
  low_enclave_instance_count  = 2
  high_enclave_instance_count = 2
  cti_zone_instance_count     = 1
  root_volume_size            = 100

  low_enclave_subnet_ids  = module.networking.low_enclave_subnet_ids
  high_enclave_subnet_ids = module.networking.high_enclave_subnet_ids
  cti_zone_subnet_ids     = module.networking.cti_zone_subnet_ids
  low_enclave_sg_id       = module.networking.low_enclave_sg_id
  high_enclave_sg_id      = module.networking.high_enclave_sg_id
  cti_zone_sg_id          = module.networking.cti_zone_sg_id

  tags = {
    Environment = "production"
  }
}

# ════════════════════════════════════════════
#  Database — Low Enclave (multi-AZ)
# ════════════════════════════════════════════
module "database_low" {
  source = "../../modules/database"

  environment             = "production"
  vpc_id                  = module.networking.vpc_id
  subnet_ids              = module.networking.low_enclave_subnet_ids
  app_security_group_ids  = [module.networking.low_enclave_sg_id]
  postgres_instance_class = "db.r6i.large"
  postgres_storage_gb     = 100
  postgres_max_storage_gb = 500
  postgres_password       = var.postgres_password_low
  redis_node_type         = "cache.r6g.large"
  redis_password          = var.redis_password_low
  multi_az                = true
  backup_retention_days   = 30
  ami_id                  = var.ami_id
  key_pair_name           = module.compute.key_pair_name
  clickhouse_instance_type = "r6i.large"
  clickhouse_storage_gb   = 200

  tags = {
    Environment = "production"
    Enclave     = "low"
  }
}

# ════════════════════════════════════════════
#  Database — High Enclave (multi-AZ)
# ════════════════════════════════════════════
module "database_high" {
  source = "../../modules/database"

  environment             = "production-high"
  vpc_id                  = module.networking.vpc_id
  subnet_ids              = module.networking.high_enclave_subnet_ids
  app_security_group_ids  = [module.networking.high_enclave_sg_id]
  postgres_instance_class = "db.r6i.large"
  postgres_storage_gb     = 100
  postgres_max_storage_gb = 500
  postgres_password       = var.postgres_password_high
  redis_node_type         = "cache.r6g.large"
  redis_password          = var.redis_password_high
  multi_az                = true
  backup_retention_days   = 30
  ami_id                  = var.ami_id
  key_pair_name           = module.compute.key_pair_name
  clickhouse_instance_type = "r6i.large"
  clickhouse_storage_gb   = 200

  tags = {
    Environment = "production"
    Enclave     = "high"
  }
}

# ════════════════════════════════════════════
#  Load Balancers
# ════════════════════════════════════════════
module "lb_low" {
  source = "../../modules/load-balancer"

  environment       = "production"
  enclave           = "low"
  vpc_id            = module.networking.vpc_id
  subnet_ids        = module.networking.low_enclave_subnet_ids
  security_group_id = module.networking.low_enclave_sg_id
  certificate_arn   = var.certificate_arn_low

  tags = {
    Environment = "production"
    Enclave     = "low"
  }
}

module "lb_high" {
  source = "../../modules/load-balancer"

  environment       = "production"
  enclave           = "high"
  vpc_id            = module.networking.vpc_id
  subnet_ids        = module.networking.high_enclave_subnet_ids
  security_group_id = module.networking.high_enclave_sg_id
  certificate_arn   = var.certificate_arn_high

  tags = {
    Environment = "production"
    Enclave     = "high"
  }
}

# ════════════════════════════════════════════
#  DNS
# ════════════════════════════════════════════
module "dns" {
  source = "../../modules/dns"

  environment       = "production"
  domain_name       = var.domain_name
  create_zone       = var.create_dns_zone
  existing_zone_id  = var.existing_zone_id
  low_alb_dns_name  = module.lb_low.alb_dns_name
  low_alb_zone_id   = module.lb_low.alb_zone_id
  high_alb_dns_name = module.lb_high.alb_dns_name
  high_alb_zone_id  = module.lb_high.alb_zone_id

  tags = {
    Environment = "production"
  }
}

# ════════════════════════════════════════════
#  Storage
# ════════════════════════════════════════════
module "storage_low" {
  source = "../../modules/storage"

  environment            = "production"
  enclave                = "low"
  availability_zone      = var.availability_zones[0]
  clickhouse_volume_size = 200
  nats_volume_size       = 50

  tags = {
    Environment = "production"
    Enclave     = "low"
  }
}

module "storage_high" {
  source = "../../modules/storage"

  environment            = "production"
  enclave                = "high"
  availability_zone      = var.availability_zones[0]
  clickhouse_volume_size = 200
  nats_volume_size       = 50

  tags = {
    Environment = "production"
    Enclave     = "high"
  }
}
