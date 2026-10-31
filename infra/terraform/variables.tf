variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-southeast-1"
}

variable "project_name" {
  description = "Name prefix for all resources (lowercase, hyphens)."
  type        = string
  default     = "kool-kaya-kitchen"
}

# ---- Network

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs for AZ A and AZ B (ALB, NAT Gateway in A)."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "app_subnet_cidr" {
  description = "Private app subnet CIDR in AZ A (API servers)."
  type        = string
  default     = "10.0.10.0/24"
}

variable "data_subnet_cidrs" {
  description = "Private data subnet CIDRs for AZ A and AZ B (Aurora)."
  type        = list(string)
  default     = ["10.0.20.0/24", "10.0.21.0/24"]
}

# ---- Load balancer

variable "acm_certificate_arn" {
  description = "ACM certificate ARN for an HTTPS listener. Null = HTTP only."
  type        = string
  default     = null
}

variable "restrict_alb_to_cloudfront" {
  description = "Only accept ALB traffic from CloudFront's origin-facing IP ranges. Enable once CloudFront fronts /api/*."
  type        = bool
  default     = false
}

# ---- API servers

variable "instance_type" {
  description = "EC2 instance type for API servers."
  type        = string
  default     = "t3.micro"
}

variable "root_volume_size" {
  description = "Root EBS volume size in GiB for API servers and the NAT instance (Free plan covers 30 GiB in total)."
  type        = number
  default     = 8
}

variable "nat_instance_type" {
  description = "Instance type for the NAT instance (free-tier eligible)."
  type        = string
  default     = "t3.micro"
}

variable "app_port" {
  description = "Port the Node app listens on (matches the Dockerfile)."
  type        = number
  default     = 3000
}

variable "image_tag" {
  description = "ECR image tag the instances run."
  type        = string
  default     = "latest"
}

variable "asg_min_size" {
  description = "Minimum (and initial) number of API servers."
  type        = number
  default     = 2
}

variable "asg_max_size" {
  description = "Maximum number of API servers."
  type        = number
  default     = 6
}

variable "warm_pool_min_size" {
  description = "Number of stopped, pre-initialised instances kept in the warm pool."
  type        = number
  default     = 2
}

variable "cpu_target_percent" {
  description = "Target average CPU for target tracking and predictive scaling."
  type        = number
  default     = 50
}

variable "requests_per_target" {
  description = "Target ALB requests per instance (per minute) for request-count tracking."
  type        = number
  default     = 1000
}

variable "predictive_scaling_mode" {
  description = "ForecastOnly to evaluate forecasts first, ForecastAndScale to act on them."
  type        = string
  default     = "ForecastOnly"

  validation {
    condition     = contains(["ForecastOnly", "ForecastAndScale"], var.predictive_scaling_mode)
    error_message = "Must be ForecastOnly or ForecastAndScale."
  }
}

variable "scheduled_scaling_actions" {
  description = "Scheduled capacity changes for sales. Key = action name. recurrence cron runs in Asia/Singapore time; start_time/end_time are UTC (e.g. 2026-11-10T22:00:00Z)."
  type = map(object({
    min_size         = number
    max_size         = number
    desired_capacity = number
    recurrence       = optional(string)
    start_time       = optional(string)
    end_time         = optional(string)
  }))
  default = {}
}

# ---- Database

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "kaya"
}

variable "db_engine_version" {
  description = "MySQL engine version. Null = the RDS default."
  type        = string
  default     = null
}

variable "db_instance_class" {
  description = "RDS instance class. db.t3.micro and db.t4g.micro are on the Free plan."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS storage in GiB (Free plan covers 20)."
  type        = number
  default     = 20
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. Free plan accounts are limited (1 day works); raise after upgrading."
  type        = number
  default     = 1
}

variable "db_deletion_protection" {
  description = "Block deleting the database. Set false before terraform destroy."
  type        = bool
  default     = true
}

# ---- Storage

variable "reports_bucket_force_destroy" {
  description = "Allow terraform destroy to delete the reports bucket even if it contains objects."
  type        = bool
  default     = false
}

# ---- Order processing

variable "order_worker_timeout" {
  description = "Order worker Lambda timeout in seconds (the queue's visibility timeout is 6x this)."
  type        = number
  default     = 30
}

variable "ses_from_address" {
  description = "Sender address for order emails, verified as an SES identity. Null = no identity created."
  type        = string
  default     = null
}

variable "staff_alert_email" {
  description = "Staff address subscribed to rejected-order events. Null = no subscription. The address must confirm via the email SNS sends."
  type        = string
  default     = null
}

# ---- Reporting

variable "quicksight_user_arn" {
  description = "QuickSight user or group that owns the sales data source and dataset, e.g. arn:aws:quicksight:<identity-region>:<account>:user/default/<name>. Null = no QuickSight resources. Enable QuickSight and generate the first report before setting it."
  type        = string
  default     = null
}
