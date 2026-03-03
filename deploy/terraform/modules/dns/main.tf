# EMS-COP DNS Module
# Route53 hosted zone and records

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ════════════════════════════════════════════
#  Route53 Hosted Zone
# ════════════════════════════════════════════
resource "aws_route53_zone" "ems" {
  count = var.create_zone ? 1 : 0
  name  = var.domain_name

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-zone"
  })
}

locals {
  zone_id = var.create_zone ? aws_route53_zone.ems[0].zone_id : var.existing_zone_id
}

# ════════════════════════════════════════════
#  Low-Side Enclave Record
# ════════════════════════════════════════════
resource "aws_route53_record" "low" {
  count   = var.low_alb_dns_name != "" ? 1 : 0
  zone_id = local.zone_id
  name    = "low.${var.domain_name}"
  type    = "A"

  alias {
    name                   = var.low_alb_dns_name
    zone_id                = var.low_alb_zone_id
    evaluate_target_health = true
  }
}

# ════════════════════════════════════════════
#  High-Side Enclave Record
# ════════════════════════════════════════════
resource "aws_route53_record" "high" {
  count   = var.high_alb_dns_name != "" ? 1 : 0
  zone_id = local.zone_id
  name    = "high.${var.domain_name}"
  type    = "A"

  alias {
    name                   = var.high_alb_dns_name
    zone_id                = var.high_alb_zone_id
    evaluate_target_health = true
  }
}

# ════════════════════════════════════════════
#  Primary Domain (points to low-side by default)
# ════════════════════════════════════════════
resource "aws_route53_record" "primary" {
  count   = var.low_alb_dns_name != "" ? 1 : 0
  zone_id = local.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = var.low_alb_dns_name
    zone_id                = var.low_alb_zone_id
    evaluate_target_health = true
  }
}
