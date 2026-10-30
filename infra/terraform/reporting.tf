# Reporting: EventBridge Scheduler -> report-generator Lambda (VPC) -> S3 reports bucket -> QuickSight.
# The sales data still lives inside the API server (backend/src/lib/db.js), so the Lambda asks
# an in-service instance to build the reports on a private port that only the Lambda can reach;
# the app writes them to the bucket. Each sales report also rewrites reports/quicksight/sales.csv
# (all paid orders), the one file the QuickSight dataset reads. Once the data moves to Aurora,
# the Lambda queries it directly instead.

locals {
  report_generator_name = "${var.project_name}-report-generator"
  reports_port          = 3001 # private report port on the API servers; the ALB never routes to it

  # Cron in Asia/Singapore time. The daily run matches the app's old in-process 00:05 timer.
  report_schedules = {
    daily  = { cron = "cron(5 0 * * ? *)", input = jsonencode({ reports = [{ type = "sales", days = 1 }, { type = "inventory" }] }) }
    weekly = { cron = "cron(10 0 ? * MON *)", input = jsonencode({ reports = [{ type = "sales", days = 7 }] }) }
  }

  quicksight_enabled  = var.quicksight_user_arn != null
  quicksight_feed_key = "reports/quicksight/sales.csv" # written by backend/src/services/reports.js

  # Columns of the sales CSV (backend/src/services/reports.js). S3 CSV columns arrive as strings.
  sales_columns = [
    "order_id", "created_at_sgt", "market", "currency", "status", "fulfilment", "payment_method", "product",
    "qty", "unit_price_local", "unit_price_sgd", "order_total_local", "order_total_sgd", "promo_code",
  ]
  sales_casts = {
    created_at_sgt    = "DATETIME"
    qty               = "INTEGER"
    unit_price_local  = "DECIMAL"
    unit_price_sgd    = "DECIMAL"
    order_total_local = "DECIMAL"
    order_total_sgd   = "DECIMAL"
  }
}

# ---- Report generator: scheduled event -> private report port on an API server

data "archive_file" "report_generator" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/report-generator"
  output_path = "${path.module}/build/report-generator.zip"
}

resource "aws_cloudwatch_log_group" "report_generator" {
  name              = "/aws/lambda/${local.report_generator_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "report_generator" {
  function_name    = local.report_generator_name
  role             = aws_iam_role.report_generator.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.report_generator.output_path
  source_code_hash = data.archive_file.report_generator.output_base64sha256
  timeout          = 60
  memory_size      = 128

  # App subnet: reaches the API servers directly, and the AWS APIs through the NAT instance.
  vpc_config {
    subnet_ids         = [aws_subnet.app.id]
    security_group_ids = [aws_security_group.report_generator.id]
  }

  environment {
    variables = {
      ASG_NAME     = local.asg_name
      REPORTS_PORT = local.reports_port
    }
  }

  depends_on = [aws_cloudwatch_log_group.report_generator, aws_iam_role_policy_attachment.report_generator_vpc]
}

resource "aws_scheduler_schedule" "reports" {
  for_each = local.report_schedules

  name                         = "${var.project_name}-${each.key}-reports"
  schedule_expression          = each.value.cron
  schedule_expression_timezone = "Asia/Singapore"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.report_generator.arn
    role_arn = aws_iam_role.report_scheduler.arn
    input    = each.value.input
  }
}

# ---- QuickSight: S3 data source -> SPICE dataset, refreshed daily after the 00:05 report.
# Created only when quicksight_user_arn is set (QuickSight is enabled in the account by hand,
# and the feed file must exist first; see README "Reports").

resource "aws_s3_object" "quicksight_manifest" {
  count = local.quicksight_enabled ? 1 : 0

  bucket       = aws_s3_bucket.reports.id
  key          = "reports/quicksight/manifest.json"
  content_type = "application/json"
  content = jsonencode({
    fileLocations        = [{ URIs = ["s3://${aws_s3_bucket.reports.bucket}/${local.quicksight_feed_key}"] }]
    globalUploadSettings = { format = "CSV", delimiter = ",", textqualifier = "\"", containsHeader = "true" }
  })
}

resource "aws_quicksight_data_source" "reports" {
  count = local.quicksight_enabled ? 1 : 0

  data_source_id = "${var.project_name}-reports"
  name           = "Kool Kaya reports"
  type           = "S3"

  parameters {
    s3 {
      role_arn = aws_iam_role.quicksight_reports[0].arn

      manifest_file_location {
        bucket = aws_s3_bucket.reports.bucket
        key    = aws_s3_object.quicksight_manifest[0].key
      }
    }
  }

  permission {
    principal = var.quicksight_user_arn
    actions = [
      "quicksight:DescribeDataSource", "quicksight:DescribeDataSourcePermissions", "quicksight:PassDataSource",
      "quicksight:UpdateDataSource", "quicksight:DeleteDataSource", "quicksight:UpdateDataSourcePermissions",
    ]
  }

  # QuickSight reads the manifest and feed with the role on creation, so its policy must exist first.
  depends_on = [aws_iam_role_policy.quicksight_reports]
}

resource "aws_quicksight_data_set" "sales" {
  count = local.quicksight_enabled ? 1 : 0

  data_set_id = "${var.project_name}-sales"
  name        = "Kool Kaya sales"
  import_mode = "SPICE" # required for S3 sources

  physical_table_map {
    physical_table_map_id = "sales-csv"

    s3_source {
      data_source_arn = aws_quicksight_data_source.reports[0].arn

      dynamic "input_columns" {
        for_each = local.sales_columns
        content {
          name = input_columns.value
          type = "STRING"
        }
      }

      upload_settings {
        format          = "CSV"
        contains_header = true
        delimiter       = ","
        text_qualifier  = "DOUBLE_QUOTE"
        start_from_row  = 1
      }
    }
  }

  logical_table_map {
    logical_table_map_id = "sales"
    alias                = "sales"

    source {
      physical_table_id = "sales-csv"
    }

    dynamic "data_transforms" {
      for_each = local.sales_casts
      content {
        cast_column_type_operation {
          column_name     = data_transforms.key
          new_column_type = data_transforms.value
          format          = data_transforms.value == "DATETIME" ? "yyyy-MM-dd'T'HH:mm:ss" : null
        }
      }
    }

    # order_total_* repeats on every line of an order, so sum this for revenue instead.
    data_transforms {
      create_columns_operation {
        columns {
          column_id   = "line_total_sgd"
          column_name = "line_total_sgd"
          expression  = "{qty} * {unit_price_sgd}"
        }
      }
    }
  }

  permissions {
    principal = var.quicksight_user_arn
    actions = [
      "quicksight:DescribeDataSet", "quicksight:DescribeDataSetPermissions", "quicksight:PassDataSet",
      "quicksight:DescribeIngestion", "quicksight:ListIngestions", "quicksight:CreateIngestion", "quicksight:CancelIngestion",
      "quicksight:UpdateDataSet", "quicksight:DeleteDataSet", "quicksight:UpdateDataSetPermissions",
    ]
  }
}

resource "aws_quicksight_refresh_schedule" "sales" {
  count = local.quicksight_enabled ? 1 : 0

  data_set_id = aws_quicksight_data_set.sales[0].data_set_id
  schedule_id = "daily-after-report"

  schedule {
    refresh_type = "FULL_REFRESH"

    schedule_frequency {
      interval        = "DAILY"
      time_of_the_day = "00:30"
      timezone        = "Asia/Singapore"
    }
  }
}
