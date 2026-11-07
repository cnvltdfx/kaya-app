# Storefront hosting: private S3 bucket (frontend/) -> CloudFront (OAC), with /api/* routed to the ALB.
# CloudFront is the single public entry point, protected by the WAF web ACL in waf.tf. The ALB
# only accepts requests that carry the X-Origin-Verify header CloudFront adds (alb.tf), and, with
# restrict_alb_to_cloudfront, only from CloudFront's origin-facing IP ranges (security_groups.tf).
# The storefront uses #/ routes, so no index.html fallback is needed (and a distribution-wide
# custom error response would also rewrite API 404s).

# ---- Variables

variable "cdn_price_class" {
  description = "CloudFront price class. PriceClass_200 includes the Asia-Pacific edges at lower cost than PriceClass_All."
  type        = string
  default     = "PriceClass_200"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cdn_price_class)
    error_message = "Must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "alb_origin_domain" {
  description = "DNS name covered by the ALB's certificate (e.g. origin.example.com) for HTTPS from CloudFront to the ALB. Null = CloudFront reaches the ALB by its own DNS name over HTTP. Must be set once acm_certificate_arn is."
  type        = string
  default     = null
}

variable "frontend_bucket_force_destroy" {
  description = "Allow terraform destroy to delete the frontend bucket even if it contains objects."
  type        = bool
  default     = true
}

locals {
  frontend_dir = "${path.module}/../../frontend"

  frontend_content_types = {
    html = "text/html; charset=utf-8"
    js   = "text/javascript; charset=utf-8"
    css  = "text/css; charset=utf-8"
    svg  = "image/svg+xml"
    webp = "image/webp"
    png  = "image/png"
    jpg  = "image/jpeg"
    ico  = "image/x-icon"
    json = "application/json"
  }

  # No hashed filenames, so keep text assets short-lived; index.html and config.js revalidate every time.
  frontend_cache_control = {
    "index.html" = "no-cache"
    "config.js"  = "no-cache"
  }
}

# Secret header value CloudFront sends to the ALB. Created once (uuid() is random on every plan,
# so later changes are ignored). Taint terraform_data.origin_verify to rotate it.
resource "terraform_data" "origin_verify" {
  input = uuid()

  lifecycle {
    ignore_changes = [input]
  }
}

# ---- Frontend bucket

resource "aws_s3_bucket" "frontend" {
  bucket        = "${var.project_name}-frontend-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.frontend_bucket_force_destroy
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, not the KMS key: the files are public through CloudFront anyway, and OAC reading
# SSE-KMS objects would need a key policy statement for CloudFront.
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"]

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

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# The storefront files, uploaded on apply. Content types are set here rather than guessed by the
# uploader (the AWS CLI on Windows can label .js as text/plain, which browsers refuse to run).
resource "aws_s3_object" "frontend" {
  for_each = setsubtract(fileset(local.frontend_dir, "**"), ["config.js"])

  bucket        = aws_s3_bucket.frontend.id
  key           = each.value
  source        = "${local.frontend_dir}/${each.value}"
  source_hash   = filemd5("${local.frontend_dir}/${each.value}")
  content_type  = lookup(local.frontend_content_types, lower(regex("[^.]*$", each.value)), "application/octet-stream")
  cache_control = lookup(local.frontend_cache_control, each.value, startswith(each.value, "img/") ? "public, max-age=86400" : "public, max-age=300")
}

# config.js is written here instead of copied from frontend/, so the storefront knows this deployment's
# settings. The PayNow countdown uses the same timeout as the order expirer.
resource "aws_s3_object" "frontend_config" {
  bucket        = aws_s3_bucket.frontend.id
  key           = "config.js"
  content_type  = local.frontend_content_types.js
  cache_control = local.frontend_cache_control["config.js"]
  content       = <<-JS
    window.KK_CONFIG = {
      apiBase: '',
      paymentTimeoutMinutes: ${var.order_payment_timeout_minutes},
      cognito: { domain: '${local.cognito_domain}', clientId: '${aws_cognito_user_pool_client.web.id}' },
    };
  JS
}

moved {
  from = aws_s3_object.frontend["config.js"]
  to   = aws_s3_object.frontend_config
}

# ---- CloudFront

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards every viewer header except Host, including Authorization, x-market and idempotency-key.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-frontend"
  description                       = "Storefront bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 responses carry no headers of their own, so this mirrors securityHeaders in
# backend/src/lib/security.js (API responses keep the app's headers).
resource "aws_cloudfront_response_headers_policy" "frontend" {
  name = "${var.project_name}-frontend-security"

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'"
      override                = true
    }
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  comment             = "${var.project_name} storefront and API"
  default_root_object = "index.html"
  price_class         = var.cdn_price_class
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  web_acl_id          = aws_wafv2_web_acl.cdn.arn

  origin {
    origin_id                = "frontend"
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    origin_id   = "api"
    domain_name = coalesce(var.alb_origin_domain, aws_lb.app.dns_name)

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = var.alb_origin_domain != null ? "https-only" : "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = terraform_data.origin_verify.output
    }
  }

  default_cache_behavior {
    target_origin_id           = "frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend.id
  }

  # https-only rather than redirect: a redirected POST would arrive as a GET.
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # The default *.cloudfront.net certificate until Route 53 and a us-east-1 ACM certificate are set up.
  viewer_certificate {
    cloudfront_default_certificate = true
  }

  lifecycle {
    precondition {
      condition     = !local.https_enabled || var.alb_origin_domain != null
      error_message = "With acm_certificate_arn set the ALB redirects HTTP to HTTPS, so set alb_origin_domain to a name on that certificate for CloudFront to connect to."
    }
  }
}
