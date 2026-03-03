# EMS-COP Compute Module
# EC2 instances or EKS cluster (variable-driven)

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ════════════════════════════════════════════
#  SSH Key Pair
# ════════════════════════════════════════════
resource "aws_key_pair" "ems" {
  key_name   = "${var.environment}-ems-cop-key"
  public_key = var.ssh_public_key

  tags = var.tags
}

# ════════════════════════════════════════════
#  IAM Instance Profile
# ════════════════════════════════════════════
resource "aws_iam_role" "ems_instance" {
  name = "${var.environment}-ems-cop-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ems_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ems_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ems" {
  name = "${var.environment}-ems-cop-instance-profile"
  role = aws_iam_role.ems_instance.name

  tags = var.tags
}

# ════════════════════════════════════════════
#  EC2 Instances — Low Enclave
# ════════════════════════════════════════════
resource "aws_instance" "low_enclave" {
  count = var.low_enclave_instance_count

  ami                    = var.ami_id
  instance_type          = var.low_instance_type
  key_name               = aws_key_pair.ems.key_name
  iam_instance_profile   = aws_iam_instance_profile.ems.name
  subnet_id              = var.low_enclave_subnet_ids[count.index % length(var.low_enclave_subnet_ids)]
  vpc_security_group_ids = [var.low_enclave_sg_id]

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = base64encode(templatefile("${path.module}/../../templates/user-data.sh.tpl", {
    environment = var.environment
    enclave     = "low"
    ems_version = var.ems_version
  }))

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-low-${count.index + 1}"
    Enclave = "low"
  })
}

# ════════════════════════════════════════════
#  EC2 Instances — High Enclave
# ════════════════════════════════════════════
resource "aws_instance" "high_enclave" {
  count = var.high_enclave_instance_count

  ami                    = var.ami_id
  instance_type          = var.high_instance_type
  key_name               = aws_key_pair.ems.key_name
  iam_instance_profile   = aws_iam_instance_profile.ems.name
  subnet_id              = var.high_enclave_subnet_ids[count.index % length(var.high_enclave_subnet_ids)]
  vpc_security_group_ids = [var.high_enclave_sg_id]

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-high-${count.index + 1}"
    Enclave = "high"
  })
}

# ════════════════════════════════════════════
#  EC2 Instances — CTI Zone
# ════════════════════════════════════════════
resource "aws_instance" "cti_zone" {
  count = var.cti_zone_instance_count

  ami                    = var.ami_id
  instance_type          = var.cti_instance_type
  key_name               = aws_key_pair.ems.key_name
  iam_instance_profile   = aws_iam_instance_profile.ems.name
  subnet_id              = var.cti_zone_subnet_ids[count.index % length(var.cti_zone_subnet_ids)]
  vpc_security_group_ids = [var.cti_zone_sg_id]

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-cti-${count.index + 1}"
    Enclave = "cti"
  })
}
