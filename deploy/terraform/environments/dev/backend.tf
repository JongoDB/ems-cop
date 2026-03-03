# Terraform Backend — Dev
# For local dev, use local backend. For shared dev, use S3.

# terraform {
#   backend "s3" {
#     bucket         = "ems-cop-terraform-state"
#     key            = "dev/terraform.tfstate"
#     region         = "us-east-1"
#     encrypt        = true
#     dynamodb_table = "ems-cop-terraform-locks"
#   }
# }
