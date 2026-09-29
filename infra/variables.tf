variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-west-2"
}

variable "frontend_bucket_name" {
  description = "Globally-unique S3 bucket name for the frontend static site (e.g. \"<project>-frontend-<your-aws-account-id>\")"
  type        = string
}
