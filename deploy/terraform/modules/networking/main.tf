# EMS-COP Networking Module
# Creates VPC with 3 subnets: low-enclave, high-enclave, cti-zone
# Security groups and NACLs enforce enclave isolation

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ════════════════════════════════════════════
#  VPC
# ════════════════════════════════════════════
resource "aws_vpc" "ems" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-vpc"
  })
}

# ════════════════════════════════════════════
#  Internet Gateway (low-side internet access)
# ════════════════════════════════════════════
resource "aws_internet_gateway" "ems" {
  vpc_id = aws_vpc.ems.id

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-igw"
  })
}

# ════════════════════════════════════════════
#  Subnets
# ════════════════════════════════════════════
resource "aws_subnet" "low_enclave" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.ems.id
  cidr_block        = cidrsubnet(var.low_enclave_cidr, 4, count.index)
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-low-${var.availability_zones[count.index]}"
    Enclave = "low"
  })
}

resource "aws_subnet" "high_enclave" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.ems.id
  cidr_block        = cidrsubnet(var.high_enclave_cidr, 4, count.index)
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-high-${var.availability_zones[count.index]}"
    Enclave = "high"
  })
}

resource "aws_subnet" "cti_zone" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.ems.id
  cidr_block        = cidrsubnet(var.cti_zone_cidr, 4, count.index)
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-cti-${var.availability_zones[count.index]}"
    Enclave = "cti"
  })
}

# ════════════════════════════════════════════
#  NAT Gateway (for low-side internet access)
# ════════════════════════════════════════════
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-nat-eip"
  })
}

resource "aws_nat_gateway" "ems" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.low_enclave[0].id

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cop-nat"
  })

  depends_on = [aws_internet_gateway.ems]
}

# ════════════════════════════════════════════
#  Route Tables
# ════════════════════════════════════════════
resource "aws_route_table" "low_public" {
  vpc_id = aws_vpc.ems.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.ems.id
  }

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-low-public-rt"
  })
}

resource "aws_route_table" "high_private" {
  vpc_id = aws_vpc.ems.id

  # High-side has NO internet route — air-gapped
  tags = merge(var.tags, {
    Name = "${var.environment}-ems-high-private-rt"
  })
}

resource "aws_route_table" "cti_private" {
  vpc_id = aws_vpc.ems.id

  # CTI zone routes to NAT for NiFi updates only
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.ems.id
  }

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-cti-private-rt"
  })
}

resource "aws_route_table_association" "low" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.low_enclave[count.index].id
  route_table_id = aws_route_table.low_public.id
}

resource "aws_route_table_association" "high" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.high_enclave[count.index].id
  route_table_id = aws_route_table.high_private.id
}

resource "aws_route_table_association" "cti" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.cti_zone[count.index].id
  route_table_id = aws_route_table.cti_private.id
}

# ════════════════════════════════════════════
#  Security Groups
# ════════════════════════════════════════════
resource "aws_security_group" "low_enclave" {
  name_prefix = "${var.environment}-ems-low-"
  vpc_id      = aws_vpc.ems.id
  description = "Low-side enclave security group"

  # Allow inbound HTTP/HTTPS from internet
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP"
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS"
  }

  # Allow SSH from trusted CIDRs
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
    description = "SSH"
  }

  # Allow all internal low-enclave traffic
  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
    description = "Internal low-enclave"
  }

  # Allow CTI zone to reach low-side CTI relay
  ingress {
    from_port       = 3010
    to_port         = 3010
    protocol        = "tcp"
    security_groups = [aws_security_group.cti_zone.id]
    description     = "CTI relay from CTI zone"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-low-sg"
    Enclave = "low"
  })
}

resource "aws_security_group" "high_enclave" {
  name_prefix = "${var.environment}-ems-high-"
  vpc_id      = aws_vpc.ems.id
  description = "High-side enclave security group — no internet access"

  # NO inbound from internet — only from CTI zone and SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
    description = "SSH"
  }

  # Allow all internal high-enclave traffic
  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
    description = "Internal high-enclave"
  }

  # Allow CTI zone to reach high-side CTI relay
  ingress {
    from_port       = 3010
    to_port         = 3010
    protocol        = "tcp"
    security_groups = [aws_security_group.cti_zone.id]
    description     = "CTI relay from CTI zone"
  }

  # Restrict outbound — no internet
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
    description = "VPC-internal only"
  }

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-high-sg"
    Enclave = "high"
  })
}

resource "aws_security_group" "cti_zone" {
  name_prefix = "${var.environment}-ems-cti-"
  vpc_id      = aws_vpc.ems.id
  description = "CTI zone security group — bridges low and high enclaves"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
    description = "SSH"
  }

  # NiFi web UI (admin access only)
  ingress {
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
    description = "NiFi Web UI"
  }

  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
    description = "Internal CTI zone"
  }

  # CTI zone can reach both enclaves' CTI relay ports
  egress {
    from_port       = 3010
    to_port         = 3010
    protocol        = "tcp"
    security_groups = [aws_security_group.low_enclave.id, aws_security_group.high_enclave.id]
    description     = "CTI relay to enclaves"
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS outbound for updates"
  }

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-cti-sg"
    Enclave = "cti"
  })
}

# ════════════════════════════════════════════
#  NACLs — Enclave Isolation
# ════════════════════════════════════════════
resource "aws_network_acl" "high_enclave" {
  vpc_id     = aws_vpc.ems.id
  subnet_ids = aws_subnet.high_enclave[*].id

  # Deny all traffic from low-enclave subnets (except CTI relay via CTI zone)
  ingress {
    rule_no    = 100
    protocol   = "tcp"
    action     = "deny"
    cidr_block = var.low_enclave_cidr
    from_port  = 0
    to_port    = 65535
  }

  # Allow from CTI zone
  ingress {
    rule_no    = 200
    protocol   = "tcp"
    action     = "allow"
    cidr_block = var.cti_zone_cidr
    from_port  = 3010
    to_port    = 3010
  }

  # Allow internal high-enclave traffic
  ingress {
    rule_no    = 300
    protocol   = "-1"
    action     = "allow"
    cidr_block = var.high_enclave_cidr
    from_port  = 0
    to_port    = 0
  }

  # Allow SSH from admin
  ingress {
    rule_no    = 400
    protocol   = "tcp"
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 22
    to_port    = 22
  }

  # Allow ephemeral return traffic
  ingress {
    rule_no    = 900
    protocol   = "tcp"
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 65535
  }

  # Outbound — VPC only (no internet)
  egress {
    rule_no    = 100
    protocol   = "-1"
    action     = "allow"
    cidr_block = var.vpc_cidr
    from_port  = 0
    to_port    = 0
  }

  tags = merge(var.tags, {
    Name = "${var.environment}-ems-high-nacl"
  })
}
