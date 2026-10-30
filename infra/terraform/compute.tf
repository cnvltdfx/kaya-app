# API servers: launch template + Auto Scaling group in the private app subnet (AZ A),
# with a stopped warm pool, target tracking, predictive and scheduled scaling.

locals {
  # Known up front so the launch template's user data can name the ASG without a cycle.
  asg_name         = "${var.project_name}-api"
  launch_hook_name = "wait-for-app"
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_launch_template" "app" {
  name_prefix   = "${var.project_name}-app-"
  image_id      = data.aws_ssm_parameter.al2023_ami.value
  instance_type = var.instance_type

  vpc_security_group_ids = [aws_security_group.app.id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.app.arn
  }

  # IMDSv2 only. Hop limit 2 so the AWS SDK inside the Docker container can reach IMDS.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_type           = "gp3"
      volume_size           = var.root_volume_size
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    region        = var.aws_region
    registry      = split("/", aws_ecr_repository.app.repository_url)[0]
    image         = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    app_port      = var.app_port
    reports_port  = local.reports_port
    s3_bucket     = aws_s3_bucket.reports.bucket
    kms_key_id    = aws_kms_key.main.arn
    db_host       = aws_db_instance.main.address
    db_name       = var.db_name
    db_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
    asg_name      = local.asg_name
    hook_name     = local.launch_hook_name
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.project_name}-api" }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.project_name}-api" }
  }
}

resource "aws_autoscaling_group" "app" {
  name                      = local.asg_name
  vpc_zone_identifier       = [aws_subnet.app.id]
  min_size                  = var.asg_min_size
  max_size                  = var.asg_max_size
  desired_capacity          = var.asg_min_size
  health_check_type         = "ELB"
  health_check_grace_period = 180
  target_group_arns         = [aws_lb_target_group.app.arn]
  default_instance_warmup   = 120

  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
  }

  # Roll instances whenever the launch template changes (new AMI, user data, image tag).
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }

  # Hold each launch (into the warm pool or into service) until user data reports the app
  # healthy. Without this, the ASG stops warm-pool instances before user data finishes.
  initial_lifecycle_hook {
    name                 = local.launch_hook_name
    lifecycle_transition = "autoscaling:EC2_INSTANCE_LAUNCHING"
    default_result       = "ABANDON"
    heartbeat_timeout    = 600
  }

  # Pre-initialised, stopped instances: scale-out skips the OS boot and image pull.
  warm_pool {
    pool_state = "Stopped"
    min_size   = var.warm_pool_min_size

    instance_reuse_policy {
      reuse_on_scale_in = true
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.project_name}-api"
    propagate_at_launch = true
  }

  lifecycle {
    # Scaling policies own the desired capacity after creation.
    ignore_changes = [desired_capacity]
  }
}

# ---- Scaling policies

resource "aws_autoscaling_policy" "cpu_target" {
  name                   = "cpu-target-tracking"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = var.cpu_target_percent

    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
  }
}

resource "aws_autoscaling_policy" "request_target" {
  name                   = "alb-requests-target-tracking"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = var.requests_per_target

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.app.arn_suffix}/${aws_lb_target_group.app.arn_suffix}"
    }
  }
}

resource "aws_autoscaling_policy" "predictive" {
  name                   = "cpu-predictive"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "PredictiveScaling"

  predictive_scaling_configuration {
    mode                   = var.predictive_scaling_mode
    scheduling_buffer_time = 300

    metric_specification {
      target_value = var.cpu_target_percent

      predefined_metric_pair_specification {
        predefined_metric_type = "ASGCPUUtilization"
      }
    }
  }
}

# Scheduled capacity for known sales/promotions, e.g. 11.11.
resource "aws_autoscaling_schedule" "sales" {
  for_each = var.scheduled_scaling_actions

  autoscaling_group_name = aws_autoscaling_group.app.name
  scheduled_action_name  = each.key
  recurrence             = each.value.recurrence
  start_time             = each.value.start_time
  end_time               = each.value.end_time
  time_zone              = "Asia/Singapore"
  min_size               = each.value.min_size
  max_size               = each.value.max_size
  desired_capacity       = each.value.desired_capacity
}
