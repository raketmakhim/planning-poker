resource "aws_dynamodb_table" "session" {
  name         = "planning-poker-session"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
}
