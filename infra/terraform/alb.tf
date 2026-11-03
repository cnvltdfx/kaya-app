resource "aws_lb" "app" {
  name                       = "${var.project_name}-alb"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [for s in aws_subnet.public : s.id]
  drop_invalid_header_fields = true

  tags = { Name = "${var.project_name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name                 = "${var.project_name}-tg"
  port                 = var.app_port
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  target_type          = "instance"
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# Without a certificate: HTTP serves the app. With one: HTTP redirects to HTTPS, which serves it.
# With restrict_alb_to_cloudfront the serving listener answers 403 unless the request carries
# CloudFront's X-Origin-Verify header (cdn.tf); the prefix list alone would admit any distribution.
locals {
  alb_default_forward = !var.restrict_alb_to_cloudfront
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = local.https_enabled ? "redirect" : (local.alb_default_forward ? "forward" : "fixed-response")
    target_group_arn = !local.https_enabled && local.alb_default_forward ? aws_lb_target_group.app.arn : null

    dynamic "redirect" {
      for_each = local.https_enabled ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    dynamic "fixed_response" {
      for_each = !local.https_enabled && !local.alb_default_forward ? [1] : []
      content {
        content_type = "application/json"
        message_body = "{\"error\":\"Forbidden.\"}"
        status_code  = "403"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.https_enabled ? 1 : 0

  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = local.alb_default_forward ? "forward" : "fixed-response"
    target_group_arn = local.alb_default_forward ? aws_lb_target_group.app.arn : null

    dynamic "fixed_response" {
      for_each = local.alb_default_forward ? [] : [1]
      content {
        content_type = "application/json"
        message_body = "{\"error\":\"Forbidden.\"}"
        status_code  = "403"
      }
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = local.https_enabled ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [terraform_data.origin_verify.output]
    }
  }
}
