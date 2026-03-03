output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.ems.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID (for Route53 alias)"
  value       = aws_lb.ems.zone_id
}

output "alb_arn" {
  description = "ALB ARN"
  value       = aws_lb.ems.arn
}

output "target_group_arns" {
  description = "Map of service target group ARNs"
  value = {
    frontend     = aws_lb_target_group.frontend.arn
    auth         = aws_lb_target_group.auth.arn
    workflow     = aws_lb_target_group.workflow.arn
    ticket       = aws_lb_target_group.ticket.arn
    dashboard    = aws_lb_target_group.dashboard.arn
    c2_gateway   = aws_lb_target_group.c2_gateway.arn
    audit        = aws_lb_target_group.audit.arn
    notification = aws_lb_target_group.notification.arn
    endpoint     = aws_lb_target_group.endpoint.arn
    ws_relay     = aws_lb_target_group.ws_relay.arn
  }
}
