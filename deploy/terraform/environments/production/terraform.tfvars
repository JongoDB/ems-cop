# EMS-COP Production Environment Variables
# IMPORTANT: Use terraform.tfvars.enc (encrypted) or TF_VAR_ env vars for secrets
aws_region         = "us-east-1"
availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
vpc_cidr           = "10.0.0.0/16"
ems_version        = "0.17.0"
domain_name        = "ems-cop.example.com"
create_dns_zone    = true

# REQUIRED: Set these values via environment variables or encrypted tfvars
# ami_id                 = "ami-xxxxxxxxx"
# ssh_public_key         = "ssh-rsa AAAA..."
# ssh_allowed_cidrs      = ["10.0.0.0/8"]
# postgres_password_low  = "VAULT"
# postgres_password_high = "VAULT"
# redis_password_low     = "VAULT"
# redis_password_high    = "VAULT"
# certificate_arn_low    = "arn:aws:acm:..."
# certificate_arn_high   = "arn:aws:acm:..."
