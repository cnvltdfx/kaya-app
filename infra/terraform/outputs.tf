output "alb_dns_name" {
  description = "Point CloudFront's /api/* origin here (or browse it directly for testing)."
  value       = aws_lb.app.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "image_push_commands" {
  description = "Build and push the app image from the repo root."
  value       = <<-EOT
    aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${split("/", aws_ecr_repository.app.repository_url)[0]}
    docker build -t ${aws_ecr_repository.app.repository_url}:${var.image_tag} .
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

output "email_sender_function" {
  value = aws_lambda_function.email_sender.function_name
}
