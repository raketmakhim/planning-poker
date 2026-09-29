terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Bucket/region are account-specific, so they're not hardcoded here.
  # Provide them via: terraform init -backend-config=backend.hcl
  # (copy backend.hcl.example and fill in your own state bucket first)
  backend "s3" {
    key          = "planning-poker/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region
}
