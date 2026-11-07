output "alb_dns_name" {
  description = "CloudFront's /api/* origin. Browsable directly until restrict_alb_to_cloudfront is enabled."
  value       = aws_lb.app.dns_name
}

output "site_url" {
  description = "The storefront and API through CloudFront and the WAF."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "cognito_user_pool_id" {
  description = "Create staff and admin users in this pool (see README.md)."
  value       = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  description = "Managed Login sign-in pages."
  value       = local.cognito_domain
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

output "frontend_invalidate_command" {
  description = "Run after an apply that changed frontend/ to drop cached copies at the edge right away (otherwise they expire within 5 minutes, or a day for images)."
  value       = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.main.id} --paths \"/*\""
}

output "waf_web_acl" {
  description = "WAF web ACL (us-east-1). Logs: the CloudWatch log group named aws-waf-logs-<project_name> in us-east-1."
  value       = aws_wafv2_web_acl.cdn.name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "image_push_commands" {
  description = "Build and push the backend API image from the repo root."
  value       = <<-EOT
    aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${split("/", aws_ecr_repository.app.repository_url)[0]}
    docker build -t ${aws_ecr_repository.app.repository_url}:${var.image_tag} backend
    docker push ${aws_ecr_repository.app.repository_url}:${var.image_tag}
  EOT
}

output "asg_name" {
  description = "Use with: aws ec2 describe-instances --filters Name=tag:aws:autoscaling:groupName,Values=<asg_name>, then aws ssm start-session --target <instance-id>."
  value       = aws_autoscaling_group.app.name
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "db_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "nat_instance_id" {
  value = aws_instance.nat.id
}

output "reports_bucket" {
  value = aws_s3_bucket.reports.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "order_queue_url" {
  value = aws_sqs_queue.orders.url
}

output "order_events_topic_arn" {
  value = aws_sns_topic.order_events.arn
}

output "order_worker_function" {
  value = aws_lambda_function.order_worker.function_name
}

output "order_expirer_function" {
  value = aws_lambda_function.order_expirer.function_name
}

output "email_sender_function" {
  value = aws_lambda_function.email_sender.function_name
}

output "report_generator_function" {
  value = aws_lambda_function.report_generator.function_name
}

output "report_dashboard_function" {
  value = aws_lambda_function.report_dashboard.function_name
}

output "report_dashboard_link_command" {
  description = "Prints a link to the latest dashboard that works for an hour (the reports bucket is private)."
  value       = "aws s3 presign s3://${aws_s3_bucket.reports.bucket}/${local.report_dashboard_latest_key} --expires-in 3600 --region ${var.aws_region}"
}

output "archive_bucket" {
  value = aws_s3_bucket.archive.bucket
}

output "data_archiver_function" {
  value = aws_lambda_function.data_archiver.function_name
}
