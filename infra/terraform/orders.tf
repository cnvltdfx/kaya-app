# Decoupled order processing (placeholder wiring; Lambda code in infra/lambdas is stubbed).
# API -> SQS order queue (+ DLQ) -> order-worker Lambda
#     -> SNS order-events -> email-sender Lambda -> SES; staff get rejected orders by email.
# Standalone for now: no VPC, DB or project KMS key, so it can be applied on its own.
# Once the DB exists, attach the worker to the VPC (app subnet + a SG allowed into the DB)
# and pass it the DB host, name and secret ARN.

locals {
  order_worker_name = "${var.project_name}-order-worker"
  email_sender_name = "${var.project_name}-email-sender"
}

# ---- Queue

resource "aws_sqs_queue" "orders_dlq" {
  name                      = "${var.project_name}-orders-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "orders" {
  name                       = "${var.project_name}-orders"
  visibility_timeout_seconds = var.order_worker_timeout * 6
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.orders_dlq.arn
    maxReceiveCount     = 5
  })
}

# ---- Order events topic

resource "aws_sns_topic" "order_events" {
  name              = "${var.project_name}-order-events"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "staff_email" {
  count = var.staff_alert_email == null ? 0 : 1

  topic_arn     = aws_sns_topic.order_events.arn
  protocol      = "email"
  endpoint      = var.staff_alert_email
  filter_policy = jsonencode({ status = ["rejected"] })
}

# ---- Lambda packages

data "archive_file" "order_worker" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/order-worker"
  output_path = "${path.module}/build/order-worker.zip"
}

data "archive_file" "email_sender" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/email-sender"
  output_path = "${path.module}/build/email-sender.zip"
}

# ---- Order worker: SQS -> confirm order in the DB -> publish order event

resource "aws_cloudwatch_log_group" "order_worker" {
  name              = "/aws/lambda/${local.order_worker_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "order_worker" {
  function_name    = local.order_worker_name
  role             = aws_iam_role.order_worker.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.order_worker.output_path
  source_code_hash = data.archive_file.order_worker.output_base64sha256
  timeout          = var.order_worker_timeout
  memory_size      = 256

  environment {
    variables = {
      ORDER_EVENTS_TOPIC_ARN = aws_sns_topic.order_events.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.order_worker, aws_iam_role_policy_attachment.order_worker_logs]
}

resource "aws_lambda_event_source_mapping" "orders" {
  event_source_arn        = aws_sqs_queue.orders.arn
  function_name           = aws_lambda_function.order_worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  # The worker role needs SQS receive permission before the mapping can be created.
  depends_on = [aws_iam_role_policy.order_worker]
}

# ---- Email sender: SNS order event -> SES email

resource "aws_cloudwatch_log_group" "email_sender" {
  name              = "/aws/lambda/${local.email_sender_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "email_sender" {
  function_name    = local.email_sender_name
  role             = aws_iam_role.email_sender.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.email_sender.output_path
  source_code_hash = data.archive_file.email_sender.output_base64sha256
  timeout          = 15
  memory_size      = 128

  environment {
    variables = {
      SES_FROM_ADDRESS = coalesce(var.ses_from_address, "unset")
    }
  }

  depends_on = [aws_cloudwatch_log_group.email_sender, aws_iam_role_policy_attachment.email_sender_logs, aws_iam_role_policy.email_sender]
}

resource "aws_lambda_permission" "email_sender_sns" {
  statement_id  = "AllowOrderEvents"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.email_sender.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.order_events.arn
}

resource "aws_sns_topic_subscription" "email_sender" {
  topic_arn = aws_sns_topic.order_events.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.email_sender.arn

  depends_on = [aws_lambda_permission.email_sender_sns]
}

# ---- SES sender identity (new accounts are in the SES sandbox: recipients must be verified too)

resource "aws_sesv2_email_identity" "sender" {
  count = var.ses_from_address == null ? 0 : 1

  email_identity = var.ses_from_address
}
