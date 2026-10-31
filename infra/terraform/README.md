# Deploying Kool Kaya Kitchen to AWS

A quick guide to deploying the app with the Terraform in this folder. It creates a VPC, a NAT instance, an ALB, an EC2 Auto Scaling group running the app's Docker image from ECR, RDS for MySQL, and an S3 reports bucket, all in `ap-southeast-1`.

It's sized for an AWS **Free plan** account, so it differs from the architecture diagram in two places:

| Diagram | Here | Why |
|---|---|---|
| NAT Gateway | NAT instance (`t3.micro`) | A NAT Gateway isn't free (about US$43/month) |
| Aurora MySQL Serverless v2 | RDS MySQL `db.t4g.micro`, single-AZ, 1-day backups | The Free plan only allows Aurora "express configuration" clusters, which Terraform can't create |

After upgrading to a paid plan, you can switch back to the diagram's design.

## Before you start: run one instance

The app still keeps its data in a JSON file inside each container (`backend/src/lib/db.js`), not in the MySQL database. If more than one instance runs, each has its own users, sessions, carts and stock. Logins and MFA then fail at random, because the next request can land on a different instance. **Until the data layer moves to Aurora, run exactly one instance** (step 2 shows how).

Data also resets whenever the container restarts or the instance is replaced: the app seeds fresh demo data on startup. That's fine for a demo.

## 1. Install the tools

- An AWS account, and the **AWS CLI v2** signed in with admin rights (`aws configure` or `aws configure sso`). Check with `aws sts get-caller-identity`.
- **Terraform** 1.10 or later.
- **Docker** (Docker Desktop on Windows/Mac).
- Optional: the **Session Manager plugin** for the AWS CLI, for shell access from your terminal. Without it, use the AWS console instead (step 6).

## Shared state

Terraform state lives in the S3 bucket `kool-kaya-kitchen-tfstate-634993259271` (Kaya account, `ap-southeast-1`), set in `backend.tf`. Everyone on the team applies against that one state, and a lock file in the bucket stops two applies running at once. Don't keep a local `terraform.tfstate`.

Sign in to the Kaya account before any Terraform command, then check you're in the right account:

```powershell
$env:AWS_PROFILE = "kaya"
aws sts get-caller-identity   # Account should be 634993259271
terraform init
```

The bucket was created by hand (versioned, encrypted, public access blocked, HTTPS only) because Terraform can't store its state in a bucket it creates itself. Don't delete it with the rest of the stack.

## 2. Configure

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` for a single-instance demo:

```hcl
asg_min_size              = 1
asg_max_size              = 1
warm_pool_min_size        = 0
scheduled_scaling_actions = {}   # the example sale schedule would scale up to 4
```

## 3. Create the image repository and push the app

Instances pull the image as soon as they boot, so the image has to exist first. Otherwise they fail health checks and get replaced over and over.

```sh
terraform init
terraform apply '-target=aws_ecr_repository.app'
terraform output -raw image_push_commands
```

Keep the quotes around `-target=...`. Without them, PowerShell splits the argument at the dot and Terraform fails with `Invalid target "aws_ecr_repository"`.

Go to the **repo root** and run the three commands that were printed: ECR login, `docker build`, `docker push`. The image is built from `backend/` (the storefront in `frontend/` is not part of it). On an Apple Silicon Mac, add `--platform linux/amd64` to `docker build`, because the instances are x86.

Check that the push worked: `aws ecr list-images --repository-name kool-kaya-kitchen --region ap-southeast-1` should list `latest`. If it's empty, the instances never become healthy.

**On Windows PowerShell,** the printed login can fail with `400 Bad Request`, `The stub received bad data`, or `no basic auth credentials` on push. Use Docker Desktop's ECR credential helper instead, from the repo root:

```powershell
aws configure export-credentials --format powershell | Out-String | Invoke-Expression
$reg = "<account-id>.dkr.ecr.ap-southeast-1.amazonaws.com"
New-Item -ItemType Directory -Force .dockercfg | Out-Null
[IO.File]::WriteAllText("$PWD\.dockercfg\config.json", "{`"credHelpers`":{`"$reg`":`"ecr-login`"}}")
docker build -t "$reg/kool-kaya-kitchen:latest" backend
docker --config .dockercfg push "$reg/kool-kaya-kitchen:latest"
```

The first line copies your AWS session into the shell. The credential helper needs it if you signed in with `aws login` or SSO. Add `.dockercfg/` to `.gitignore` if you keep it.

## 4. Create everything else

```sh
cd infra/terraform
terraform apply
```

This takes about 10–15 minutes; the database is the slowest part.

## 5. Open the app

```sh
terraform output -raw alb_dns_name
```

- Health check: `http://<alb_dns_name>/health` should return `{"status":"ok"}`.
- Shop: `http://<alb_dns_name>/`

The first instance takes a few minutes to become healthy after the apply finishes.

**Demo accounts** (see the main README): `demo@koolkaya.sg` / `Demo@1234` logs straight in. Staff and admin accounts need an MFA code. The containers run with `NODE_ENV=production`, so the code isn't shown on screen. Read it on the instance instead (step 6):

```sh
sudo docker exec kaya-api cat /app/data/db.json | grep -o 'verification code is [0-9]*' | tail -1
```

## 6. Get a shell on the instance (no SSH)

Find the instance ID:

```sh
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names kool-kaya-kitchen-api --query "AutoScalingGroups[0].Instances[].InstanceId" --output text
```

Then do one of these:

- **Console:** EC2 → Instances → select the instance → **Connect** → **Session Manager**.
- **Terminal** (needs the plugin): `aws ssm start-session --target <instance-id>`

Useful commands once you're in:

| What | Command |
|---|---|
| App logs | `sudo docker logs -f kaya-api` |
| Service status | `sudo systemctl status kaya-api` |
| Boot script output | `sudo cat /var/log/cloud-init-output.log` |

## 7. Deploy a new version

Rebuild and push the image (step 3's commands), then replace the instances so they pull it:

```sh
aws autoscaling start-instance-refresh --auto-scaling-group-name kool-kaya-kitchen-api
```

## 8. Reports

`reporting.tf` builds the reporting pipeline from the architecture diagram:

EventBridge Scheduler → report-generator Lambda (in the VPC) → API server → S3 reports bucket → QuickSight

- **Schedules** (Singapore time):
  - Daily at 00:05: sales for the last day, plus inventory.
  - Mondays at 00:10: sales for the last 7 days.
- **Report generator** (`infra/lambdas/report-generator`): the sales data still lives inside the API server (`backend/src/lib/db.js`), not in the database.
  - The Lambda finds a healthy in-service instance and calls its private report port (3001). The ALB never routes to that port; only the Lambda's security group can reach it.
  - The app builds the CSV and JSON summary and uploads them to the reports bucket (`terraform output reports_bucket`) under `reports/`, encrypted with the project KMS key.
  - Once the data moves to Aurora, the Lambda should query it directly instead.
- **QuickSight feed:** each sales report also rewrites `reports/quicksight/sales.csv` with every paid order to date. The QuickSight dataset reads only that file, so overlapping daily, weekly and manual reports aren't double-counted. SPICE refreshes it daily at 00:30.

Back office → Reports works as before and lists the scheduled runs too. With more than one instance, the reports cover only the instance the Lambda picked (see "Before you start").

### Deploy the report generator

The report port is new app code, so build and push a new image first (step 3). Then:

```sh
terraform apply
```

The apply changes the instances' user data (it opens the report port), so the instance refresh replaces them. Once the new instance is healthy, generate the first reports instead of waiting for 00:05:

```sh
aws lambda invoke --function-name "$(terraform output -raw report_generator_function)" --cli-binary-format raw-in-base64-out --payload '{"reports":[{"type":"sales","days":1},{"type":"inventory"}]}' build/report-invoke.json
aws s3 ls "s3://$(terraform output -raw reports_bucket)/reports/" --recursive
```

### Set up QuickSight

Terraform creates the QuickSight data source, dataset and daily refresh only once `quicksight_user_arn` is set. Until then it skips them, so applies still work in accounts without QuickSight.

1. Enable QuickSight once in the console. You don't need to tick any S3 buckets there, because the data source reads the bucket with its own IAM role.
2. Generate the first reports (above), so `reports/quicksight/sales.csv` exists. QuickSight checks the file when it creates the data source.
3. Find your QuickSight user ARN. Use the region you signed up to QuickSight in, which may not be `ap-southeast-1`:
   ```sh
   aws quicksight list-users --aws-account-id 634993259271 --namespace default --region <quicksight-region>
   ```
4. Add it to `terraform.tfvars` and apply:
   ```hcl
   quicksight_user_arn = "arn:aws:quicksight:<quicksight-region>:634993259271:user/default/<name>"
   ```
5. Build the dashboard in QuickSight: Datasets → **Kool Kaya sales** → **Create analysis**.
   - For revenue, sum `line_total_sgd`. Don't sum `order_total_*`, which repeats on every line of an order.
   - For orders, use a distinct count of `order_id`.
   - Useful visuals: revenue by `market`, by `created_at_sgt` (aggregated by day), and by `product`.
   - **Publish** it as a dashboard and share it with staff.

## 9. Order processing (placeholders)

`orders.tf` creates the decoupled order pipeline: an SQS order queue with a dead-letter queue, an order-worker Lambda, an SNS order-events topic, an email-sender Lambda, and an optional SES sender identity. The Lambda code in `infra/lambdas/` is a stub that only logs; the app doesn't send to the queue yet. It doesn't use the VPC, DB or project KMS key, so it can be applied on its own (see below); the worker moves into the VPC once the DB exists.

Apply just this part:

```powershell
terraform apply '-target=aws_lambda_event_source_mapping.orders' '-target=aws_sns_topic_subscription.email_sender' '-target=aws_sns_topic_subscription.staff_email' '-target=aws_sesv2_email_identity.sender'
```

Optional settings in `terraform.tfvars`:

```hcl
ses_from_address  = "orders@example.com"  # SES emails a verification link to this address
staff_alert_email = "staff@example.com"   # SNS emails a subscription confirmation; click it
```

New SES accounts are in the **sandbox**: they can only send to verified addresses until you request production access in the SES console.

Smoke test after `terraform apply`:

```sh
aws sqs send-message --queue-url "$(terraform output -raw order_queue_url)" --message-body '{"orderId":"KK100001"}'
aws logs tail /aws/lambda/kool-kaya-kitchen-order-worker --since 5m
aws sns publish --topic-arn "$(terraform output -raw order_events_topic_arn)" --message '{"orderId":"KK100001","status":"confirmed"}'
aws logs tail /aws/lambda/kool-kaya-kitchen-email-sender --since 5m
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| ALB returns 502/503; targets unhealthy | The image wasn't pushed before step 4, or the container is crashing. Check `docker logs` and `cloud-init-output.log`. |
| Instances keep being replaced | Same as above: the ALB health check (`/health`) fails after the 3-minute grace period. |
| Can't connect with Session Manager | Wait about 5 minutes after boot for the instance to register. It needs outbound access through the NAT instance. |
| Instances can't pull the image or register with SSM | Check that the NAT instance (`terraform output nat_instance_id`) is running. If it was stopped or replaced, reboot the API instances. |
| `FreeTierRestrictionError` | A setting exceeds Free plan limits. Paste the error and adjust that variable; for example, `db_backup_retention_days` must stay low. |
| Logged out or "cart empty" at random | More than one instance is running. See "Before you start". |
| Report Lambda fails with `No healthy in-service instance` | The API instance isn't healthy yet. Check the ASG and the ALB target health. |
| Report Lambda fails with `fetch failed` / `ECONNREFUSED` | The instance runs an image without the report port. Push the new image and start an instance refresh (step 7). |
| QuickSight data source fails to create | `reports/quicksight/sales.csv` doesn't exist yet (generate the first reports), or the new IAM role hadn't propagated. Run `terraform apply` again. |

## Cost and teardown

These run 24/7: the **ALB**, the **RDS instance**, the **NAT instance**, the API instance(s), and public IPv4 addresses. Most fall under the Free plan's allowances or credits, but the free EC2 hours (750/month) cover only one instance running all month. The NAT instance plus one API instance already use about 1,500 hours, so the extra comes out of your credits. The KMS key (about US$1/month) and Secrets Manager secret (about US$0.40/month) are small extras. QuickSight bills per user from the day it's enabled; cancel the subscription in the QuickSight console when you're done, because `terraform destroy` only removes the dataset and data source. Destroy everything when you're not using it.

```sh
# 1. In terraform.tfvars, allow deleting the database and the non-empty bucket:
#      db_deletion_protection       = false
#      reports_bucket_force_destroy = true
terraform apply

# 2. Delete all images in ECR (destroy fails while the repository has any, including untagged ones):
#    ECR console → kool-kaya-kitchen → select all → Delete

# 3. Destroy
terraform destroy
```

The destroy can pause for up to about 20 minutes while AWS releases the report Lambda's network interfaces in the app subnet; that's normal.

RDS leaves a final snapshot named `kool-kaya-kitchen-db-final`. Delete it in the RDS console if you don't need it, because it costs money and a second destroy fails while a snapshot with that name exists. The KMS key is scheduled for deletion after 30 days.
