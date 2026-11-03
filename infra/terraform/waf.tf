# AWS WAF web ACL for the CloudFront distribution (cdn.tf). CloudFront web ACLs must live in
# us-east-1, hence the aws.us_east_1 provider. Five rules, in evaluation order:
#   0 AWS IP reputation list   2 site-wide rate limit   4 SQL injection (the API is backed by MySQL)
#   1 login rate limit         3 core rule set
# Shield Standard (layer 3/4 DDoS protection) is automatic on CloudFront at no cost; Shield
# Advanced isn't available on the Free plan and isn't needed at this size.
# Start with waf_mode = "count", review the logs for false positives, then switch to "block".

# ---- Variables

variable "waf_mode" {
  description = "count = rules only record matches (roll-out); block = rules block matching requests."
  type        = string
  default     = "count"

  validation {
    condition     = contains(["count", "block"], var.waf_mode)
    error_message = "Must be count or block."
  }
}

variable "waf_rate_limit" {
  description = "Requests per IP per 5 minutes across the whole site before the IP is blocked."
  type        = number
  default     = 2000
}

variable "waf_auth_rate_limit" {
  description = "Requests per IP per 5 minutes to /api/auth/ (login, sign-up, password reset) before the IP is blocked."
  type        = number
  default     = 100
}

variable "waf_log_retention_days" {
  description = "Days to keep WAF logs in CloudWatch Logs (us-east-1)."
  type        = number
  default     = 30
}

locals {
  waf_block = var.waf_mode == "block"

  # Managed rule groups, in priority order after the IP reputation list and the two rate limits.
  waf_managed_rule_groups = {
    "AWSManagedRulesCommonRuleSet" = { priority = 3, count_rules = ["SizeRestrictions_BODY"] }
    "AWSManagedRulesSQLiRuleSet"   = { priority = 4, count_rules = [] }
  }
}

# ---- Web ACL

resource "aws_wafv2_web_acl" "cdn" {
  provider = aws.us_east_1

  name        = "${var.project_name}-cdn"
  description = "Kool Kaya Kitchen storefront and API behind CloudFront"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "ip-reputation"
    priority = 0

    override_action {
      dynamic "none" {
        for_each = local.waf_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.waf_block ? [] : [1]
        content {}
      }
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "auth-rate-limit"
    priority = 1

    action {
      dynamic "block" {
        for_each = local.waf_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.waf_block ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_auth_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/auth/"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "auth-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "site-rate-limit"
    priority = 2

    action {
      dynamic "block" {
        for_each = local.waf_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = local.waf_block ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "site-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = local.waf_managed_rule_groups
    content {
      name     = rule.key
      priority = rule.value.priority

      override_action {
        dynamic "none" {
          for_each = local.waf_block ? [1] : []
          content {}
        }
        dynamic "count" {
          for_each = local.waf_block ? [] : [1]
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key

          # Count only, even in block mode. SizeRestrictions_BODY blocks bodies over 8 KB;
          # the API already caps JSON bodies at 100 KB, and admin product saves can exceed 8 KB.
          dynamic "rule_action_override" {
            for_each = rule.value.count_rules
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}-cdn"
    sampled_requests_enabled   = true
  }
}

# ---- Logging (the log group name must start with aws-waf-logs-)

resource "aws_cloudwatch_log_group" "waf" {
  provider = aws.us_east_1

  name              = "aws-waf-logs-${var.project_name}"
  retention_in_days = var.waf_log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "cdn" {
  provider = aws.us_east_1

  resource_arn            = aws_wafv2_web_acl.cdn.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # Keep bearer tokens out of the logs.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}
