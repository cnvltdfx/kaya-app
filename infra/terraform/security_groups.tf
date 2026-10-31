# ALB <- internet (or CloudFront only), App <- ALB + report Lambda (report port only), DB <- App.

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = var.restrict_alb_to_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb"
  description = "Application Load Balancer"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-alb-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each = toset(local.https_enabled ? ["80", "443"] : ["80"])

  security_group_id = aws_security_group.alb.id
  description       = var.restrict_alb_to_cloudfront ? "HTTP(S) from CloudFront" : "HTTP(S) from internet"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = var.restrict_alb_to_cloudfront ? null : "0.0.0.0/0"
  prefix_list_id    = var.restrict_alb_to_cloudfront ? data.aws_ec2_managed_prefix_list.cloudfront[0].id : null
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To API servers"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "app" {
  name        = "${var.project_name}-app"
  description = "API server instances (no inbound SSH; use SSM Session Manager)"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-app-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "From ALB"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_report_generator" {
  security_group_id            = aws_security_group.app.id
  description                  = "Private report port from the report generator Lambda"
  ip_protocol                  = "tcp"
  from_port                    = local.reports_port
  to_port                      = local.reports_port
  referenced_security_group_id = aws_security_group.report_generator.id
}

# Outbound HTTPS via NAT for ECR, SSM, S3, Secrets Manager, KMS, and Stripe.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "report_generator" {
  name        = "${var.project_name}-report-generator"
  description = "Report generator Lambda"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-report-generator-sg" }
}

resource "aws_vpc_security_group_egress_rule" "report_generator_to_app" {
  security_group_id            = aws_security_group.report_generator.id
  description                  = "To the API servers' private report port"
  ip_protocol                  = "tcp"
  from_port                    = local.reports_port
  to_port                      = local.reports_port
  referenced_security_group_id = aws_security_group.app.id
}

# HTTPS via NAT for the Auto Scaling and EC2 APIs.
resource "aws_vpc_security_group_egress_rule" "report_generator_https" {
  security_group_id = aws_security_group.report_generator.id
  description       = "HTTPS to AWS APIs"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "nat" {
  name        = "${var.project_name}-nat"
  description = "NAT instance"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-nat-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "nat_from_app" {
  security_group_id = aws_security_group.nat.id
  description       = "Outbound traffic from the private app subnet"
  ip_protocol       = "-1"
  cidr_ipv4         = var.app_subnet_cidr
}

resource "aws_vpc_security_group_egress_rule" "nat_all" {
  security_group_id = aws_security_group.nat.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "db" {
  name        = "${var.project_name}-db"
  description = "Aurora MySQL"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-db-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "MySQL from API servers"
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  referenced_security_group_id = aws_security_group.app.id
}
