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
  description = "Number of 5xx responses per alarm period that triggers the error alarms."
  type        = number
  default     = 5
}

variable "alarm_db_free_storage_gb" {
  description = "Free database storage (GB) below which the storage alarm fires."
  type        = number
  default     = 2
}

variable "dashboard_period_seconds" {
  description = "Granularity (seconds) of every CloudWatch dashboard graph. CloudWatch accepts 1, 5, 10, 30, or a multiple of 60."
  type        = number
  default     = 60
}

variable "alarm_period_seconds" {
  description = "Length (seconds) of each evaluation period for the error, latency, CPU and storage alarms. Must be a multiple of 60."
  type        = number
  default     = 300
}

variable "alarm_critical_period_seconds" {
  description = "Length (seconds) of each evaluation period for the site-down alarms (no healthy servers, NAT status). Must be a multiple of 60."
  type        = number
  default     = 60
}

locals {
  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  alarm_minutes = var.alarm_period_seconds / 60
  dash_period   = var.dashboard_period_seconds
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
  period              = var.alarm_critical_period_seconds
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
  alarm_description   = "API servers returned ${var.alarm_5xx_count}+ server errors (5xx) in ${local.alarm_minutes} min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = var.alarm_period_seconds
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
  alarm_description   = "The load balancer returned ${var.alarm_5xx_count}+ errors (502/503/504) in ${local.alarm_minutes} min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = var.alarm_period_seconds
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
  alarm_description   = "p95 response time above ${var.alarm_p95_latency_seconds}s for ${local.alarm_minutes * 2} min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = var.alarm_period_seconds
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
  alarm_description   = "API servers averaged above ${var.alarm_cpu_percent}% CPU for ${local.alarm_minutes * 3} min, even with auto scaling."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = var.alarm_period_seconds
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
  alarm_description   = "Database above ${var.alarm_cpu_percent}% CPU for ${local.alarm_minutes * 3} min."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = var.alarm_period_seconds
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
  period              = var.alarm_period_seconds
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
  period              = var.alarm_critical_period_seconds
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

# ---- Dashboard
#
# One CloudWatch dashboard for the whole system, laid out like the architecture diagram:
# website (load balancer) -> API servers and database -> order processing -> reporting
# and archival -> status of every alarm that sends to the ops alerts topic.
# Free tier: 3 dashboards with up to 50 metrics each; this one uses about 26.

locals {
  dash_region = var.aws_region
  alb_dim     = ["LoadBalancer", aws_lb.app.arn_suffix]
  tg_dims     = ["TargetGroup", aws_lb_target_group.app.arn_suffix, "LoadBalancer", aws_lb.app.arn_suffix]
  db_dim      = ["DBInstanceIdentifier", aws_db_instance.main.identifier]

  dashboard_alarms = [
    aws_cloudwatch_metric_alarm.alb_no_healthy_hosts.arn,
    aws_cloudwatch_metric_alarm.alb_target_5xx.arn,
    aws_cloudwatch_metric_alarm.alb_elb_5xx.arn,
    aws_cloudwatch_metric_alarm.alb_latency_p95.arn,
    aws_cloudwatch_metric_alarm.api_cpu_high.arn,
    aws_cloudwatch_metric_alarm.db_cpu_high.arn,
    aws_cloudwatch_metric_alarm.db_storage_low.arn,
    aws_cloudwatch_metric_alarm.nat_status_check.arn,
    aws_cloudwatch_metric_alarm.order_expirer_errors.arn,
    aws_cloudwatch_metric_alarm.data_archiver_errors.arn,
    aws_cloudwatch_metric_alarm.archive_schedule_dlq.arn,
  ]
}

resource "aws_cloudwatch_dashboard" "ops" {
  dashboard_name = "${var.project_name}-ops"

  dashboard_body = jsonencode({
    widgets = [
      # ---- Header
      {
        type = "text", x = 0, y = 0, width = 24, height = 2
        properties = {
          markdown = "# Kool Kaya Kitchen: operations\nWebsite traffic and errors, server and database health, order processing, reporting and archival. Alarms email the ops alerts list (`alert_emails`)."
        }
      },

      # ---- Alarm status (top, so problems are seen first)
      {
        type = "alarm", x = 0, y = 2, width = 24, height = 3
        properties = {
          title  = "Alarm status"
          alarms = local.dashboard_alarms
        }
      },

      # ---- Website (load balancer)
      {
        type       = "text", x = 0, y = 5, width = 24, height = 1
        properties = { markdown = "## Website (load balancer)" }
      },
      {
        type = "metric", x = 0, y = 6, width = 6, height = 6
        properties = {
          title   = "Requests"
          region  = local.dash_region
          view    = "timeSeries"
          stat    = "Sum"
          period  = local.dash_period
          metrics = [concat(["AWS/ApplicationELB", "RequestCount"], local.alb_dim, [{ label = "Requests" }])]
        }
      },
      {
        type = "metric", x = 6, y = 6, width = 6, height = 6
        properties = {
          title  = "Errors (5xx)"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Sum"
          period = local.dash_period
          metrics = [
            concat(["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count"], local.alb_dim, [{ label = "From API servers" }]),
            concat(["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count"], local.alb_dim, [{ label = "From load balancer" }]),
          ]
          annotations = { horizontal = [{ label = "Alarm", value = var.alarm_5xx_count }] }
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 6, height = 6
        properties = {
          title  = "Response time (seconds)"
          region = local.dash_region
          view   = "timeSeries"
          period = local.dash_period
          metrics = [
            concat(["AWS/ApplicationELB", "TargetResponseTime"], local.alb_dim, [{ stat = "p50", label = "p50 (typical)" }]),
            concat(["AWS/ApplicationELB", "TargetResponseTime"], local.alb_dim, [{ stat = "p95", label = "p95 (slowest 5%)" }]),
          ]
          annotations = { horizontal = [{ label = "Alarm", value = var.alarm_p95_latency_seconds }] }
        }
      },
      {
        type = "metric", x = 18, y = 6, width = 6, height = 6
        properties = {
          title  = "API servers behind the load balancer"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Minimum"
          period = local.dash_period
          metrics = [
            concat(["AWS/ApplicationELB", "HealthyHostCount"], local.tg_dims, [{ label = "Healthy" }]),
            concat(["AWS/ApplicationELB", "UnHealthyHostCount"], local.tg_dims, [{ label = "Unhealthy" }]),
          ]
        }
      },

      # ---- Servers and database
      {
        type       = "text", x = 0, y = 12, width = 24, height = 1
        properties = { markdown = "## Servers and database" }
      },
      {
        type = "metric", x = 0, y = 13, width = 8, height = 6
        properties = {
          title  = "CPU (%)"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Average"
          period = local.dash_period
          metrics = [
            ["AWS/EC2", "CPUUtilization", "AutoScalingGroupName", local.asg_name, { label = "API servers" }],
            concat(["AWS/RDS", "CPUUtilization"], local.db_dim, [{ label = "Database" }]),
            ["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.nat.id, { label = "NAT" }],
          ]
          annotations = { horizontal = [{ label = "Alarm", value = var.alarm_cpu_percent }] }
          yAxis       = { left = { min = 0, max = 100 } }
        }
      },
      {
        type = "metric", x = 8, y = 13, width = 8, height = 6
        properties = {
          title   = "Database connections"
          region  = local.dash_region
          view    = "timeSeries"
          stat    = "Maximum"
          period  = local.dash_period
          metrics = [concat(["AWS/RDS", "DatabaseConnections"], local.db_dim, [{ label = "Connections" }])]
        }
      },
      {
        type = "metric", x = 16, y = 13, width = 8, height = 6
        properties = {
          title  = "Database free storage (GB)"
          region = local.dash_region
          view   = "timeSeries"
          period = local.dash_period
          metrics = [
            [{ expression = "bytes / 1073741824", label = "Free storage (GB)", id = "gb" }],
            concat(["AWS/RDS", "FreeStorageSpace"], local.db_dim, [{ stat = "Minimum", id = "bytes", visible = false }]),
          ]
          annotations = { horizontal = [{ label = "Alarm", value = var.alarm_db_free_storage_gb }] }
        }
      },

      # ---- Order processing
      {
        type       = "text", x = 0, y = 19, width = 24, height = 1
        properties = { markdown = "## Order processing (SQS order queue, order worker, order expirer, email sender)" }
      },
      {
        type = "metric", x = 0, y = 20, width = 8, height = 6
        properties = {
          title  = "Order queue"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Maximum"
          period = local.dash_period
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.orders.name, { label = "Orders waiting" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.orders_dlq.name, { label = "Failed orders (DLQ)" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 20, width = 8, height = 6
        properties = {
          title  = "Oldest order waiting (seconds)"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Maximum"
          period = local.dash_period
          metrics = [
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.orders.name, { label = "Oldest order" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 20, width = 8, height = 6
        properties = {
          title  = "Order Lambdas: runs and errors"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Sum"
          period = local.dash_period
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.order_worker.function_name, { label = "Order worker runs" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.order_worker.function_name, { label = "Order worker errors" }],
            ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", aws_lambda_function.order_worker.function_name, { stat = "Maximum", yAxis = "right", label = "Order workers running at once (right)" }],
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.email_sender.function_name, { label = "Email sender runs" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.email_sender.function_name, { label = "Email sender errors" }],
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.order_expirer.function_name, { label = "Order expirer runs" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.order_expirer.function_name, { label = "Order expirer errors" }],
          ]
        }
      },

      # ---- Reporting and archival
      {
        type       = "text", x = 0, y = 26, width = 24, height = 1
        properties = { markdown = "## Reporting and data archival" }
      },
      {
        type = "metric", x = 0, y = 27, width = 12, height = 6
        properties = {
          title  = "Report generator: runs and errors"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Sum"
          period = local.dash_period
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.report_generator.function_name, { label = "Runs" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.report_generator.function_name, { label = "Errors" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 27, width = 12, height = 6
        properties = {
          title  = "Data archiver: runs and errors"
          region = local.dash_region
          view   = "timeSeries"
          stat   = "Sum"
          period = local.dash_period
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.data_archiver.function_name, { label = "Runs" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.data_archiver.function_name, { label = "Errors" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.archive_schedule_dlq.name, { stat = "Maximum", label = "Missed schedules (DLQ)" }],
          ]
        }
      },
    ]
  })
}

output "ops_dashboard_url" {
  description = "CloudWatch dashboard for the team."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.ops.dashboard_name}"
}
