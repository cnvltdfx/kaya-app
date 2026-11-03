# Data archival: EventBridge Scheduler -> data-archiver Lambda (VPC) -> S3 archive bucket -> Glacier -> deleted.
# The Lambda moves closed orders (delivered or cancelled) older than archive_order_age_days out of MySQL
# into Parquet files, one per table, under orders/archived_on=<YYYY-MM-DD>/ (see infra/lambdas/data-archiver).
# The files start in Intelligent-Tiering; the bucket's lifecycle rule moves them to Glacier Flexible
# Retrieval after archive_glacier_after_days and deletes them after archive_expire_after_days, both
# counted from upload. All four timings are variables so a demo can shorten them (demo.tfvars.example).

# ---- Variables

variable "archive_schedule" {
  description = "When the archiver runs, in Asia/Singapore time: an EventBridge Scheduler cron() or rate() expression. Default: 03:00 on the 15th of every month."
  type        = string
  default     = "cron(0 3 15 * ? *)"

  validation {
    condition     = can(regex("^(cron|rate)\\(.+\\)$", var.archive_schedule))
    error_message = "archive_schedule must be a cron(...) or rate(...) expression."
  }
}

variable "archive_order_age_days" {
  description = "Closed orders created more than this many days ago are archived. Default: 2 years."
  type        = number
  default     = 730

  validation {
    condition     = var.archive_order_age_days >= 0 && floor(var.archive_order_age_days) == var.archive_order_age_days
    error_message = "archive_order_age_days must be a whole number, 0 or more."
  }
}

variable "archive_glacier_after_days" {
  description = "Days after upload before archive files move to Glacier Flexible Retrieval. Default: 1 year."
  type        = number
  default     = 365

  validation {
    condition     = var.archive_glacier_after_days >= 0 && floor(var.archive_glacier_after_days) == var.archive_glacier_after_days
    error_message = "archive_glacier_after_days must be a whole number, 0 or more."
  }
}

variable "archive_expire_after_days" {
  description = "Days after upload before archive files are deleted. Must be more than archive_glacier_after_days. Default: 5 years."
  type        = number
  default     = 1825

  validation {
    condition     = floor(var.archive_expire_after_days) == var.archive_expire_after_days && var.archive_expire_after_days > var.archive_glacier_after_days
    error_message = "archive_expire_after_days must be a whole number greater than archive_glacier_after_days."
  }
}

variable "archive_bucket_force_destroy" {
  description = "Allow terraform destroy to delete the archive bucket even if it contains objects."
  type        = bool
  default     = false
}

locals {
  data_archiver_name = "${var.project_name}-data-archiver"
}

# ---- Archive bucket

resource "aws_s3_bucket" "archive" {
  bucket        = "${var.project_name}-archive-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.archive_bucket_force_destroy
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket = aws_s3_bucket.archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

# No versioning: expiry must really delete the files, not leave noncurrent versions behind.
# The archiver can only put objects, never delete them.
resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  # The archive files are small; by default S3 skips transitions for objects under 128 KB.
  transition_default_minimum_object_size = "varies_by_storage_class"

  rule {
    id     = "glacier-then-delete"
    status = "Enabled"

    filter {
      prefix = "orders/"
    }

    transition {
      days          = var.archive_glacier_after_days
      storage_class = "GLACIER"
    }

    expiration {
      days = var.archive_expire_after_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "archive_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "archive" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.archive_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.archive]
}

# ---- Data archiver Lambda

data "archive_file" "data_archiver" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/data-archiver"
  output_path = "${path.module}/build/data-archiver.zip"
  excludes    = ["test"] # node_modules (mysql2, hyparquet-writer) is included: run `npm ci --omit=dev` there first
}

resource "aws_cloudwatch_log_group" "data_archiver" {
  name              = "/aws/lambda/${local.data_archiver_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "data_archiver" {
  function_name    = local.data_archiver_name
  role             = aws_iam_role.data_archiver.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.data_archiver.output_path
  source_code_hash = data.archive_file.data_archiver.output_base64sha256
  timeout          = 300 # stops starting new batches a minute before this; the next run continues
  memory_size      = 512

  vpc_config {
    subnet_ids         = [aws_subnet.app.id]
    security_group_ids = [aws_security_group.data_archiver.id]
  }

  environment {
    variables = {
      ARCHIVE_BUCKET         = aws_s3_bucket.archive.bucket
      ARCHIVE_ORDER_AGE_DAYS = var.archive_order_age_days
      ARCHIVE_BATCH_SIZE     = 500
      DB_HOST                = aws_db_instance.main.address
      DB_NAME                = var.db_name
      DB_SECRET_ARN          = aws_db_instance.main.master_user_secret[0].secret_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.data_archiver, aws_iam_role_policy_attachment.data_archiver_vpc]
}

# ---- Schedule (Scheduler retries failed deliveries, then drops the event in a DLQ)

resource "aws_sqs_queue" "archive_schedule_dlq" {
  name                      = "${var.project_name}-archive-schedule-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true
}

resource "aws_scheduler_schedule" "data_archiver" {
  name                         = "${var.project_name}-data-archive"
  schedule_expression          = var.archive_schedule
  schedule_expression_timezone = "Asia/Singapore"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.data_archiver.arn
    role_arn = aws_iam_role.archive_scheduler.arn

    retry_policy {
      maximum_retry_attempts       = 3
      maximum_event_age_in_seconds = 3600
    }

    dead_letter_config {
      arn = aws_sqs_queue.archive_schedule_dlq.arn
    }
  }
}

# ---- Alarms (to the ops alerts topic in monitoring.tf)

# A run failed (DB, S3 or timeout). Nothing is lost: the batch rolled back and the next run retries it.
resource "aws_cloudwatch_metric_alarm" "data_archiver_errors" {
  alarm_name          = "${var.project_name}-data-archiver-errors"
  alarm_description   = "The data archiver Lambda failed. Check its logs; unarchived orders stay in the database."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.data_archiver.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# The scheduler could not invoke the archiver at all.
resource "aws_cloudwatch_metric_alarm" "archive_schedule_dlq" {
  alarm_name          = "${var.project_name}-archive-schedule-dlq"
  alarm_description   = "A scheduled archive run could not be delivered to the Lambda. See the archive-schedule-dlq queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.archive_schedule_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
