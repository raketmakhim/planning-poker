# Planning Poker

A minimal, single-session Planning Poker app. There are no accounts and no rooms. Everyone who opens the site lands on the same board, picks a display name, and votes on a Fibonacci scale (`1, 2, 3, 5, 8, 13, 21, ?`). Votes stay hidden until someone hits **Reveal**.

It runs entirely on serverless AWS: a single Lambda function behind a public Function URL, one DynamoDB item for state, and a static React frontend on S3 + CloudFront. There are no always-on servers, no containers, and no WebSockets. The frontend polls the API every 1.5 seconds.

## Architecture

```
Browser --HTTP poll/POST--> Lambda Function URL --> DynamoDB (single item)
Browser <--HTTPS------------ CloudFront <-- S3 (static frontend build)
```

- `backend/index.py`: one Lambda function, hand-routed by path and method. Reads and writes a single DynamoDB item.
- `frontend/`: React (Vite). Polls the API and renders the voting board.
- `infra/`: Terraform for all AWS resources (DynamoDB, IAM, Lambda, Function URL, S3, CloudFront).

See [CLAUDE.md](CLAUDE.md) for a deeper architecture breakdown, including the identity model and presence handling.

## Setup

You'll need an AWS account, the AWS CLI configured with credentials, Terraform, and Node.js.

### 1. Create a Terraform state bucket

This is a one-time, manual step. It's the bucket Terraform itself uses to store state, so it can't be created by Terraform.

```
aws s3api create-bucket --bucket <your-unique-bucket-name> --region <your-region> --create-bucket-configuration LocationConstraint=<your-region>
aws s3api put-bucket-versioning --bucket <your-unique-bucket-name> --versioning-configuration Status=Enabled
```

### 2. Configure the backend and variables

Copy the example files and fill in your own values:

```
cp infra/backend.hcl.example infra/backend.hcl
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

`frontend_bucket_name` in `terraform.tfvars` must be a globally unique S3 bucket name, for example `<your-project>-frontend-<your-aws-account-id>`.

### 3. Deploy everything

One command builds the infra and the frontend:

```
.\deploy.ps1
```

This runs `terraform init` and `apply` (creating DynamoDB, IAM, Lambda, S3, and CloudFront), then builds and uploads the frontend, invalidates the CloudFront cache, and prints the live URL.

### 4. Point the frontend at your Lambda Function URL

Once you have it:

```
cp frontend/.env.example frontend/.env
```

Fill in `VITE_API_URL` with the `function_url` Terraform output, then run `.\deploy.ps1` again to rebuild with it.

## Cost

Negligible. DynamoDB is on-demand, and CloudFront and S3 both have generous free tiers. A typical session (a handful of people, a couple of hours) costs a fraction of a cent.

## License

MIT
