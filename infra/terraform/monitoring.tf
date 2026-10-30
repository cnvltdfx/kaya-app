# Monitoring (Kristin & Aleksandra)
#
# Matches the "Monitoring" box in the architecture diagram:
#   CloudWatch metrics & alarms -> SNS ops alerts -> email to staff
#
# Alarms watch the components in the diagram: load balancer, API servers (EC2),
# database and NAT. (Auto Scaling's CPU/request scaling is in compute.tf.)

# ---- Variables

variable "alert_emails" {
  description = "Staff emails that receive ops alerts. Each address must confirm the SNS subscription email."
  type        = list(string)
  default     = []
}

variable "alarm_cpu_percent" {
  description = "Average CPU above which the API server and database alarms fire."
  type        = number
  default     = 80
}

variable "alarm_p95_latency_seconds" {
  description = "Load balancer p95 response time above which the latency alarm fires."
  type        = number
  default     = 1
}

variable "alarm_5xx_count" {
  description = "Number of 5xx responses in 5 minutes that triggers the error alarms."
  type        = number
  default     = 5
}

variable "alarm_db_free_storage_gb" {
  description = "Free database storage (GB) below which the storage alarm fires."
  type        = number
  default     = 2
}

locals {
  alarm_actions = [aws_sns_topic.ops_alerts.arn]
}

# ---- SNS ops alerts

resource "aws_sns_topic" "ops_alerts" {
  name = "${var.project_name}-ops-alerts"
}

resource "aws_sns_topic_subscription" "ops_email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

# ---- Load balancer

# No healthy API servers: the site is down.
resource "aws_cloudwatch_metric_alarm" "alb_no_healthy_hosts" {
  alarm_name          = "${var.project_name}-alb-no-healthy-hosts"
  alarm_description   = "No healthy API servers behind the load balancer. The site is down."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Server errors returned by the API servers.
resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "${var.project_name}-api-5xx"
  alarm_description   = "API servers returned ${var.alarm_5xx_count}+ server errors (5xx) in 5 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.alarm_5xx_count
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Errors returned by the load balancer itself (502/503/504), usually because no server could answer.
resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name          = "${var.project_name}-alb-5xx"
  alarm_description   = "The load balancer returned ${var.alarm_5xx_count}+ errors (502/503/504) in 5 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.alarm_5xx_count
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# Slow responses.
resource "aws_cloudwatch_metric_alarm" "alb_latency_p95" {
  alarm_name          = "${var.project_name}-api-latency-p95"
  alarm_description   = "p95 response time above ${var.alarm_p95_latency_seconds}s for 10 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_p95_latency_seconds
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- API servers (EC2, Auto Scaling group)

resource "aws_cloudwatch_metric_alarm" "api_cpu_high" {
  alarm_name          = "${var.project_name}-api-cpu-high"
  alarm_description   = "API servers averaged above ${var.alarm_cpu_percent}% CPU for 15 minutes, even with auto scaling."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_cpu_percent
  treat_missing_data  = "notBreaching"

  dimensions = {
    AutoScalingGroupName = local.asg_name
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Database

resource "aws_cloudwatch_metric_alarm" "db_cpu_high" {
  alarm_name          = "${var.project_name}-db-cpu-high"
  alarm_description   = "Database above ${var.alarm_cpu_percent}% CPU for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_cpu_percent
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage_low" {
  alarm_name          = "${var.project_name}-db-storage-low"
  alarm_description   = "Database has less than ${var.alarm_db_free_storage_gb} GB free storage."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = var.alarm_db_free_storage_gb * 1024 * 1024 * 1024
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- NAT

# If NAT fails, the API servers lose outbound access (ECR, S3, Secrets Manager).
resource "aws_cloudwatch_metric_alarm" "nat_status_check" {
  alarm_name          = "${var.project_name}-nat-status-check"
  alarm_description   = "NAT failed its status checks. Private servers can't reach ECR, S3 or Secrets Manager."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    InstanceId = aws_instance.nat.id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Outputs

output "ops_alerts_topic_arn" {
  description = "SNS topic that receives all ops alarms."
  value       = aws_sns_topic.ops_alerts.arn
}
