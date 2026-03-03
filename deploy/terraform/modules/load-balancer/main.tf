# EMS-COP Load Balancer Module
# ALB with TLS termination, target groups for each service

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ════════════════════════════════════════════
#  Application Load Balancer
# ════════════════════════════════════════════
resource "aws_lb" "ems" {
  name               = "${var.environment}-ems-${var.enclave}-alb"
  internal           = var.enclave == "high"
  load_balancer_type = "application"
  security_groups    = [var.security_group_id]
  subnets            = var.subnet_ids

  enable_deletion_protection = var.environment == "production"

  tags = merge(var.tags, {
    Name    = "${var.environment}-ems-${var.enclave}-alb"
    Enclave = var.enclave
  })
}

# ════════════════════════════════════════════
#  HTTPS Listener
# ════════════════════════════════════════════
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.ems.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

# ════════════════════════════════════════════
#  HTTP -> HTTPS Redirect
# ════════════════════════════════════════════
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.ems.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ════════════════════════════════════════════
#  Target Groups
# ════════════════════════════════════════════
resource "aws_lb_target_group" "frontend" {
  name     = "${var.environment}-ems-${var.enclave}-fe"
  port     = 80
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }

  tags = merge(var.tags, { Service = "frontend" })
}

resource "aws_lb_target_group" "auth" {
  name     = "${var.environment}-ems-${var.enclave}-auth"
  port     = 3001
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }

  tags = merge(var.tags, { Service = "auth" })
}

resource "aws_lb_target_group" "workflow" {
  name     = "${var.environment}-ems-${var.enclave}-wf"
  port     = 3002
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "workflow-engine" })
}

resource "aws_lb_target_group" "ticket" {
  name     = "${var.environment}-ems-${var.enclave}-tkt"
  port     = 3003
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "ticket" })
}

resource "aws_lb_target_group" "dashboard" {
  name     = "${var.environment}-ems-${var.enclave}-dash"
  port     = 3004
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "dashboard" })
}

resource "aws_lb_target_group" "c2_gateway" {
  name     = "${var.environment}-ems-${var.enclave}-c2"
  port     = 3005
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "c2-gateway" })
}

resource "aws_lb_target_group" "audit" {
  name     = "${var.environment}-ems-${var.enclave}-aud"
  port     = 3006
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "audit" })
}

resource "aws_lb_target_group" "notification" {
  name     = "${var.environment}-ems-${var.enclave}-ntf"
  port     = 3007
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "notification" })
}

resource "aws_lb_target_group" "endpoint" {
  name     = "${var.environment}-ems-${var.enclave}-ep"
  port     = 3008
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  tags = merge(var.tags, { Service = "endpoint" })
}

resource "aws_lb_target_group" "ws_relay" {
  name     = "${var.environment}-ems-${var.enclave}-ws"
  port     = 3009
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path = "/health"
  }

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  tags = merge(var.tags, { Service = "ws-relay" })
}

# ════════════════════════════════════════════
#  Listener Rules (path-based routing)
# ════════════════════════════════════════════
resource "aws_lb_listener_rule" "auth" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.auth.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/auth/*"]
    }
  }
}

resource "aws_lb_listener_rule" "workflow" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.workflow.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/workflows/*", "/api/v1/workflow-runs/*", "/api/v1/operations/*"]
    }
  }
}

resource "aws_lb_listener_rule" "ticket" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ticket.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/tickets/*", "/api/v1/commands/*", "/api/v1/findings/*"]
    }
  }
}

resource "aws_lb_listener_rule" "dashboard" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 40

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/dashboards/*"]
    }
  }
}

resource "aws_lb_listener_rule" "c2" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 50

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.c2_gateway.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/c2/*"]
    }
  }
}

resource "aws_lb_listener_rule" "audit" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 60

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.audit.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/audit/*"]
    }
  }
}

resource "aws_lb_listener_rule" "notification" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 70

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.notification.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/notifications/*"]
    }
  }
}

resource "aws_lb_listener_rule" "endpoint" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 80

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.endpoint.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/endpoints/*", "/api/v1/networks/*", "/api/v1/nodes/*", "/api/v1/edges/*"]
    }
  }
}

resource "aws_lb_listener_rule" "ws" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 90

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ws_relay.arn
  }

  condition {
    path_pattern {
      values = ["/ws/*"]
    }
  }
}
