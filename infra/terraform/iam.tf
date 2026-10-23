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
