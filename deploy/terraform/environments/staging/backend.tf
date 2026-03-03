# Terraform Backend — Staging

# terraform {
#   backend "s3" {
#     bucket         = "ems-cop-terraform-state"
#     key            = "staging/terraform.tfstate"
#     region         = "us-east-1"
#     encrypt        = true
#     dynamodb_table = "ems-cop-terraform-locks"
#   }
# }
