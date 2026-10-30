# Least-privilege instance role for the API servers.

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${var.project_name}-api-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager shell access (replaces SSH).
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Pull the app image.
resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ReportsReadWrite"
    actions   = ["s3:PutObject", "s3:PutObjectTagging", "s3:GetObject"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
  }

  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "CompleteLaunchHook"
    actions   = ["autoscaling:CompleteLifecycleAction"]
    resources = ["arn:aws:autoscaling:${var.aws_region}:${data.aws_caller_identity.current.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.asg_name}"]
  }

  statement {
    sid       = "UseProjectKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }

  statement {
    sid       = "SendOrderMessages"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.orders.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "api-access"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project_name}-api-profile"
  role = aws_iam_role.app.name
}

# NAT instance: Session Manager access only.
resource "aws_iam_role" "nat" {
  name               = "${var.project_name}-nat-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "nat_ssm" {
  role       = aws_iam_role.nat.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat" {
  name = "${var.project_name}-nat-profile"
  role = aws_iam_role.nat.name
}

# ---- Order processing Lambdas

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "order_worker" {
  name               = "${var.project_name}-order-worker-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Switch to AWSLambdaVPCAccessExecutionRole when the worker moves into the VPC.
resource "aws_iam_role_policy_attachment" "order_worker_logs" {
  role       = aws_iam_role.order_worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "order_worker" {
  statement {
    sid       = "ConsumeOrderQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.orders.arn]
  }

  statement {
    sid       = "PublishOrderEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.order_events.arn]
  }
}

resource "aws_iam_role_policy" "order_worker" {
  name   = "order-worker-access"
  role   = aws_iam_role.order_worker.id
  policy = data.aws_iam_policy_document.order_worker.json
}

resource "aws_iam_role" "email_sender" {
  name               = "${var.project_name}-email-sender-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "email_sender_logs" {
  role       = aws_iam_role.email_sender.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "email_sender" {
  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail"]
    resources = var.ses_from_address == null ? ["*"] : ["arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*"]
  }
}

resource "aws_iam_role_policy" "email_sender" {
  name   = "email-sender-access"
  role   = aws_iam_role.email_sender.id
  policy = data.aws_iam_policy_document.email_sender.json
}

# ---- Reporting

resource "aws_iam_role" "report_generator" {
  name               = "${var.project_name}-report-generator-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Logs, plus the network interfaces a VPC-attached function needs.
resource "aws_iam_role_policy_attachment" "report_generator_vpc" {
  role       = aws_iam_role.report_generator.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "report_generator" {
  # Describe calls don't support resource-level permissions.
  statement {
    sid       = "FindApiServer"
    actions   = ["autoscaling:DescribeAutoScalingGroups", "ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "report_generator" {
  name   = "report-generator-access"
  role   = aws_iam_role.report_generator.id
  policy = data.aws_iam_policy_document.report_generator.json
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "report_scheduler" {
  name               = "${var.project_name}-report-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "report_scheduler" {
  statement {
    sid       = "InvokeReportGenerator"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.report_generator.arn]
  }
}

resource "aws_iam_role_policy" "report_scheduler" {
  name   = "report-scheduler-access"
  role   = aws_iam_role.report_scheduler.id
  policy = data.aws_iam_policy_document.report_scheduler.json
}

# QuickSight reads the feed with this role instead of its account-wide service role, which has
# no access to the project KMS key.
data "aws_iam_policy_document" "quicksight_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["quicksight.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "quicksight_reports" {
  count = local.quicksight_enabled ? 1 : 0

  name               = "${var.project_name}-quicksight-reports-role"
  assume_role_policy = data.aws_iam_policy_document.quicksight_assume.json
}

data "aws_iam_policy_document" "quicksight_reports" {
  statement {
    sid       = "ListReportsBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.reports.arn]
  }

  statement {
    sid       = "ReadQuickSightFeed"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/quicksight/*"]
  }

  statement {
    sid       = "DecryptReports"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "quicksight_reports" {
  count = local.quicksight_enabled ? 1 : 0

  name   = "quicksight-reports-access"
  role   = aws_iam_role.quicksight_reports[0].id
  policy = data.aws_iam_policy_document.quicksight_reports.json
}
