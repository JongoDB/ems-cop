# Terraform Backend — Production
# S3 backend with DynamoDB locking is strongly recommended for production

# terraform {
#   backend "s3" {
#     bucket         = "ems-cop-terraform-state"
#     key            = "production/terraform.tfstate"
#     region         = "us-east-1"
#     encrypt        = true
#     dynamodb_table = "ems-cop-terraform-locks"
#   }
# }
