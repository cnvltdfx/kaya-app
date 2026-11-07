# Customer and staff identity. The storefront redirects to Cognito Managed Login; the API swaps the
# returned code for tokens and issues its own session (backend/src/lib/cognito.js). Staff are ordinary
# users in the staff or admin group, and the API reads the group at each login.

locals {
  cognito_domain       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
  cognito_redirect_uri = "https://${aws_cloudfront_distribution.main.domain_name}/"
}

resource "aws_cognito_user_pool" "main" {
  name                     = var.project_name
  user_pool_tier           = "ESSENTIALS" # Managed Login needs at least this tier
  deletion_protection      = var.db_deletion_protection ? "ACTIVE" : "INACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"

  username_configuration {
    case_sensitive = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  # Cognito's own sender: limited per day, but not subject to the SES sandbox.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_uppercase                = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }
}

# Public client: no secret, because the storefront is a static page. PKCE protects the code.
resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${var.project_name}-web"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = [local.cognito_redirect_uri]
  logout_urls                          = [local.cognito_redirect_uri]
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  domain                = "${var.project_name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}

# Managed Login shows an error page until the client has a branding style. This one is Cognito's default.
resource "aws_cognito_managed_login_branding" "web" {
  client_id                   = aws_cognito_user_pool_client.web.id
  user_pool_id                = aws_cognito_user_pool.main.id
  use_cognito_provided_values = true
}

resource "aws_cognito_user_group" "role" {
  for_each = toset(["staff", "admin"])

  name         = each.value
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Kaya back office: ${each.value}"
}
