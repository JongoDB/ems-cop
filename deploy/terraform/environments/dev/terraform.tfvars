# EMS-COP Dev Environment Variables
# Copy to terraform.tfvars and fill in values

aws_region        = "us-east-1"
availability_zone = "us-east-1a"
vpc_cidr          = "10.0.0.0/16"
ems_version       = "0.17.0"

# REQUIRED: Set these values
# ami_id          = "ami-xxxxxxxxx"  # Ubuntu 22.04 LTS
# ssh_public_key  = "ssh-rsa AAAA..."
# postgres_password = "change-me-dev"
# redis_password    = "change-me-dev"
