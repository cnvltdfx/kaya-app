# Customer-managed key for data at rest: Aurora, the DB secret, the reports bucket and ECR.
# (EBS volumes use the AWS-managed aws/ebs key so the Auto Scaling service-linked role
# needs no extra key policy.)

resource "aws_kms_key" "main" {
  description             = "${var.project_name} encryption at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project_name}"
  target_key_id = aws_kms_key.main.key_id
}
