# EMS-COP Staging Environment Variables
aws_region         = "us-east-1"
availability_zones = ["us-east-1a", "us-east-1b"]
vpc_cidr           = "10.0.0.0/16"
ems_version        = "0.17.0"

# REQUIRED: Set these values
# ami_id               = "ami-xxxxxxxxx"
# ssh_public_key       = "ssh-rsa AAAA..."
# ssh_allowed_cidrs    = ["10.0.0.0/8"]
# postgres_password_low  = "change-me-staging-low"
# postgres_password_high = "change-me-staging-high"
# redis_password_low     = "change-me-staging-low"
# redis_password_high    = "change-me-staging-high"
