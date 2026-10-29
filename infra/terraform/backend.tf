# Shared state in the Kaya account, so everyone applies against the same state.
# The bucket is created once by hand (see README "Shared state"); use_lockfile needs Terraform 1.10+.

terraform {
  backend "s3" {
    bucket       = "kool-kaya-kitchen-tfstate-634993259271"
    key          = "kool-kaya-kitchen/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}
