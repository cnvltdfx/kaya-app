# Deploying Kool Kaya Kitchen to AWS

A quick guide to deploying the app with the Terraform in this folder. It creates a VPC, a NAT instance, an ALB, an EC2 Auto Scaling group running the app's Docker image from ECR, RDS for MySQL, and an S3 reports bucket, all in `ap-southeast-1`.

It's sized for an AWS **Free plan** account, so it differs from the architecture diagram in two places:

| Diagram | Here | Why |
|---|---|---|
| NAT Gateway | NAT instance (`t3.micro`) | A NAT Gateway isn't free (about US$43/month) |
| Aurora MySQL Serverless v2 | RDS MySQL `db.t4g.micro`, single-AZ, 1-day backups | The Free plan only allows Aurora "express configuration" clusters, which Terraform can't create |

After upgrading to a paid plan, you can switch back to the diagram's design.

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

All app data lives in RDS, so any number of instances can run. For a cheap demo or test, run one. Edit `terraform.tfvars`:

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
(cd infra/lambdas/order-worker && npm ci --omit=dev)   # the order worker's zip bundles mysql2
(cd infra/lambdas/order-expirer && npm ci --omit=dev)  # so does the order expirer's
(cd infra/lambdas/data-archiver && npm ci --omit=dev)  # the archiver's zip bundles mysql2 and hyparquet-writer
(cd infra/lambdas/report-dashboard && npm ci --omit=dev)  # so does the report dashboard's
cd infra/terraform
terraform apply
```

This takes about 10–15 minutes; the database is the slowest part.

## 5. Open the app

```sh
terraform output -raw site_url       # the storefront, through CloudFront and the WAF
terraform output -raw alb_dns_name   # the API directly, until step 11 locks the ALB down
```

- Storefront: `https://<site_url>`. The apply uploads `frontend/` to S3; CloudFront serves it and sends `/api/*` to the ALB. A new distribution takes a few minutes to deploy before the URL answers.
- Health check: `http://<alb_dns_name>/health` should return `{"status":"ok"}`.
- API: `http://<alb_dns_name>/api/...`. The ALB serves only the API, so its root URL returns `{"error":"Not found."}`.

The first instance takes a few minutes to become healthy after the apply finishes.

### Staff and admin users

Everyone signs in through Amazon Cognito. Customers sign up themselves. The seeded demo passwords don't work in AWS, and accounts from before Cognito aren't linked: signing up with one of those emails retires the old row, which keeps its orders for reporting.

Create staff with a real email address, because Cognito sends the temporary password there. Use the group `staff` or `admin`:

```sh
POOL=$(terraform output -raw cognito_user_pool_id)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username person@example.com \
  --user-attributes Name=email,Value=person@example.com Name=email_verified,Value=true Name=name,Value="Person Name"
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username person@example.com --group-name admin
```

The role is read at each login, so a group change applies the next time that person signs in. To cut someone off straight away, remove them from the group or disable them in Cognito, then delete their rows from the `sessions` table: their Kaya session otherwise lasts up to 7 days.

Cognito's default sender has a low daily email limit. Move to SES (`email_configuration` in `cognito.tf`) before real traffic.

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

Back office → Reports works as before and lists the scheduled runs too. Every instance reads the same database, so the reports are complete whichever instance the Lambda picks.

QuickSight is paid. On the Free plan, use the [free dashboard](#free-dashboard-no-quicksight) instead.

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

### Free dashboard (no QuickSight)

QuickSight bills per user, so `reporting.tf` also builds a dashboard that runs on the Free plan:

EventBridge Scheduler → report-dashboard Lambda (in the VPC) → MySQL → S3 reports bucket

- **Schedule:** daily at 00:30 Singapore time, when the QuickSight refresh would run (`report_dashboard_schedule`). It uses the reports' scheduler role.
- **Report dashboard** (`infra/lambdas/report-dashboard`): reads paid orders from the last 180 days, and the stock levels, straight from the database (read-only). It needs neither the API servers nor the CSV reports.
- **Output:** one HTML page with everything inlined, written twice to the reports bucket: `reports/dashboard/YYYY/MM/DD/dashboard-<time>.html` for each run, and `reports/dashboard/latest.html`, always the newest. The page holds no customer names, emails or addresses.
- **In the page:**
  - A **Sales** sheet, filtered by period (today, or the last 7, 30 or 90 days, each compared with the period before) and by market.
  - Revenue, orders, average order value, units and customers, each with its change and a trend line.
  - Revenue by day, market and product, item sales by product and market, payment methods, fulfilment, order status and promo codes.
  - An **Inventory** sheet: stock levels, low and out-of-stock products, and days of cover.
  - Tooltips, every chart as a table, and the viewer's light or dark mode.

Step 4 creates it with everything else. On a stack that's already up, run `(cd infra/lambdas/report-dashboard && npm ci --omit=dev)` from the repo root, then `terraform apply` here. It doesn't need a new image. To make the first dashboard now instead of at 00:30:

```sh
aws lambda invoke --function-name "$(terraform output -raw report_dashboard_function)" build/dashboard-invoke.json
```

Then open it in one of two ways:

- **Console:** S3 → the reports bucket (`terraform output -raw reports_bucket`) → `reports/dashboard/latest.html` → **Open**.
- **Terminal:** run the command that `terraform output -raw report_dashboard_link_command` prints. It gives a link that works for an hour.

For a demo, refresh it more often: `report_dashboard_schedule = "rate(15 minutes)"` in `terraform.tfvars`. Tests: `npm install && npm test` in `infra/lambdas/report-dashboard`; one test file needs local MySQL (`docker compose up -d` in `backend/`).

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

## 9. Order processing

`orders.tf` creates the decoupled order pipeline as part of step 4: an SQS order queue with a dead-letter queue, an order-worker Lambda, an SNS order-events topic, an email-sender Lambda, an order-expirer Lambda on a schedule, and an optional SES sender identity.

1. At checkout the API reserves stock and saves the order as `pending_payment`.
2. Once payment goes through, the API sends `{"orderId":"KK100123","outcome":"paid"}` to the queue (`ORDER_QUEUE_URL`).
3. The worker, in the private app subnet, settles the order in the database and publishes an order event to SNS. It reaches Secrets Manager and SNS through the NAT instance.
4. The email sender, outside the VPC, emails the customer through SES. Staff subscribed to the topic get `rejected` events (money received for an already-cancelled order) to refund by hand.
5. Every 5 minutes (`order_expiry_schedule`) the order expirer finds orders still `pending_payment` more than `order_payment_timeout_minutes` (default 30) after checkout, such as a PayNow order the customer never paid. It sends `expired` for each one, and the worker cancels the order, returns its stock and emails the customer. If the payment did arrive but the API couldn't queue it, the expirer sends `paid` instead. A failed run emails the ops alerts list.

The order worker and the order expirer bundle `mysql2`, so run `npm ci --omit=dev` in `infra/lambdas/order-worker` and `infra/lambdas/order-expirer` before every `terraform apply` (Terraform zips the folders as they are). Without it they fail with `Cannot find package 'mysql2'`. All three Lambdas have tests: `npm install && npm test` in each folder; the worker's and the expirer's need local MySQL (`docker compose up -d` in `backend/`).

Optional settings in `terraform.tfvars`:

```hcl
ses_from_address  = "orders@example.com"  # SES emails a verification link to this address
staff_alert_email = "staff@example.com"   # SNS emails a subscription confirmation; click it
```

New SES accounts are in the **sandbox**: they can only send to verified addresses until you request production access in the SES console. So while testing, place orders from an app account whose email is verified too (using the sender address for both is simplest).

A Gmail (or other webmail) sender works but lands in **spam**: SES can't sign mail as `gmail.com`, so it fails the recipient's DMARC check. For reliable delivery, verify a domain you control in SES with Easy DKIM (three DNS records) and send from an address on it. The staff alerts come from SNS's own address and arrive normally.

Smoke test: place an order in the app with the test card `4242 4242 4242 4242`. The order page shows "Confirming your payment…", then "Processing" a few seconds later. Then check both Lambdas' logs, and send a test email straight through SNS:

```sh
aws logs tail /aws/lambda/kool-kaya-kitchen-order-worker --since 5m
aws sns publish --topic-arn "$(terraform output -raw order_events_topic_arn)" \
  --message '{"orderId":"KK100001","status":"confirmed","orderStatus":"processing","paymentStatus":"paid","email":"you@example.com","customerName":"Test","currency":"SGD","total":12,"items":[{"name":"Classic Pandan Kaya","qty":1}]}' \
  --message-attributes '{"status":{"DataType":"String","StringValue":"confirmed"}}'
aws logs tail /aws/lambda/kool-kaya-kitchen-email-sender --since 5m
```

## 10. Data archival

`archive.tf` creates the archival pipeline as part of step 4: an EventBridge Scheduler schedule, a data-archiver Lambda, and a private archive bucket.

1. At 03:00 SGT on the 15th of each month, the schedule invokes the archiver.
2. The archiver, in the private app subnet, picks closed orders (`delivered` or `cancelled`) created more than `archive_order_age_days` ago, 500 at a time, oldest first.
3. For each batch it writes four Parquet files to `orders/archived_on=<date>/batch-<first order id>/`: `orders`, `order_items`, `order_status_history` and `payments`. The files are stored in Intelligent-Tiering and encrypted with the project KMS key.
4. Once the upload succeeds, it deletes those orders from the database in the same transaction. If anything fails, the batch rolls back and the orders wait for the next run.
5. The bucket's lifecycle rule moves the files to Glacier Flexible Retrieval after `archive_glacier_after_days` and deletes them after `archive_expire_after_days`. Both are counted from upload.

If a run fails, or the scheduler can't invoke the Lambda, an alarm emails the ops alerts list (`alert_emails`).

| Variable | Default | Demo (`demo.tfvars.example`) |
|---|---|---|
| `archive_schedule` | `cron(0 3 15 * ? *)` (03:00 SGT on the 15th) | `rate(15 minutes)` |
| `archive_order_age_days` | `730` (2 years) | `7` |
| `archive_glacier_after_days` | `365` (1 year) | `1` |
| `archive_expire_after_days` | `1825` (5 years) | `2` |

For a demo, copy `demo.tfvars.example` to `demo.tfvars` and apply both files: `terraform apply -var-file=terraform.tfvars -var-file=demo.tfvars`. The archive itself can be shown within minutes. Glacier and deletion can't: S3 lifecycle rules count in whole days and run about once a day, so files reach Glacier 1–2 days after upload and are deleted a day later.

Like the order worker, the archiver bundles its dependencies, so run `npm ci --omit=dev` in `infra/lambdas/data-archiver` before `terraform apply`. Its tests need local MySQL: `npm install && npm test`.

Smoke test, without waiting for the schedule:

```sh
aws lambda invoke --function-name "$(terraform output -raw data_archiver_function)" /dev/stdout
# {"orders":12,"batches":1,"complete":true,"runDate":"2026-11-15","orderAgeDays":7}
aws s3 ls "s3://$(terraform output -raw archive_bucket)/orders/" --recursive
aws s3api head-object --bucket "$(terraform output -raw archive_bucket)" --key <a key from above>   # StorageClass, and later the Glacier transition
```

The files can be queried in place with Athena (restore them first once they are in Glacier), or read with any Parquet tool after downloading.

## 11. CloudFront, WAF and locking down the ALB

`cdn.tf` hosts `frontend/` in a private S3 bucket behind CloudFront (origin access control) and routes `/api/*` to the ALB. `waf.tf` attaches a WAF web ACL in us-east-1 (CloudFront's WAF must live there) with five rules: the AWS IP reputation list, a rate limit on `/api/auth/` (100 requests per IP per 5 minutes), a site-wide rate limit (2,000), the core rule set and the SQL injection rule set. Shield Standard protects CloudFront against network-layer DDoS automatically; Shield Advanced isn't available on the Free plan.

CloudFront's flat-rate plans (which bundle the WAF) can't be used on a Free plan account, so the WAF is billed pay-as-you-go from your credits.

Roll it out in this order so nobody gets locked out:

1. **Apply with the defaults** (`waf_mode = "count"`, ALB still open). Open `site_url` and click through the shop, log in, check out and use the back office.
2. **Lock the ALB to CloudFront.** In `terraform.tfvars` set `restrict_alb_to_cloudfront = true`, apply, then start an instance refresh (step 7) so the API trusts the extra proxy hop for client IPs (`TRUST_PROXY_HOPS=2`). Now the ALB accepts only CloudFront's IP ranges carrying the secret `X-Origin-Verify` header, and `http://<alb_dns_name>/api/...` returns 403. The `/health` check from the ALB itself is unaffected.
3. **Review the WAF for a few days.** WAF console (region: Global / us-east-1) → `kool-kaya-kitchen-cdn` → Traffic overview, or CloudWatch Logs in us-east-1, log group `aws-waf-logs-kool-kaya-kitchen`. Look for counted matches on legitimate traffic.
4. **Switch to blocking:** set `waf_mode = "block"` and apply.

### Deploy a frontend change

```sh
cd infra/terraform
terraform apply                                   # uploads changed files from frontend/
eval "$(terraform output -raw frontend_invalidate_command)"   # optional: drop edge copies now
```

`index.html` and `config.js` revalidate on every request; other JS and CSS are cached for 5 minutes, images for a day. Without the invalidation, changes appear on their own within that time. (In PowerShell, copy the command from `terraform output frontend_invalidate_command` instead of using `eval`.)

### Custom domain (later)

With Route 53 and a domain: request an ACM certificate in **us-east-1** for CloudFront (add it as an alias on the distribution), and one in ap-southeast-1 for the ALB. Set `acm_certificate_arn` and `alb_origin_domain` (a name on the ALB certificate, e.g. `origin.example.com`, pointing at the ALB) so CloudFront reaches the ALB over HTTPS. Until then, the CloudFront → ALB leg is plain HTTP.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| ALB returns 502/503; targets unhealthy | The image wasn't pushed before step 4, or the container is crashing. Check `docker logs` and `cloud-init-output.log`. |
| Instances keep being replaced | Same as above: the ALB health check (`/health`) fails after the 3-minute grace period. |
| Can't connect with Session Manager | Wait about 5 minutes after boot for the instance to register. It needs outbound access through the NAT instance. |
| Instances can't pull the image or register with SSM | Check that the NAT instance (`terraform output nat_instance_id`) is running. If it was stopped or replaced, reboot the API instances. |
| `FreeTierRestrictionError` | A setting exceeds Free plan limits. Paste the error and adjust that variable; for example, `db_backup_retention_days` must stay low. |
| Report Lambda fails with `No healthy in-service instance` | The API instance isn't healthy yet. Check the ASG and the ALB target health. |
| Report Lambda fails with `fetch failed` / `ECONNREFUSED` | The instance runs an image without the report port. Push the new image and start an instance refresh (step 7). |
| `site_url` returns 403 for a page | The file isn't in `frontend/` (CloudFront can't list the bucket, so missing files return 403), or the distribution is still deploying. |
| `/api/...` returns 403 `{"error":"Forbidden."}` through CloudFront | The request reached the ALB without the right `X-Origin-Verify` header. Run `terraform apply` so the distribution and the ALB rule hold the same value. |
| Legitimate requests blocked with a WAF 403 | Find the rule in the WAF logs (us-east-1), then raise the rate limit or set `waf_mode = "count"` while you adjust it. |
| Logins all share one rate limit after step 11.2 | The instances still run with `TRUST_PROXY_HOPS=1`. Start an instance refresh (step 7). |
| QuickSight data source fails to create | `reports/quicksight/sales.csv` doesn't exist yet (generate the first reports), or the new IAM role hadn't propagated. Run `terraform apply` again. |
| Dashboard Lambda fails with `Cannot find package 'mysql2'` | Run `npm ci --omit=dev` in `infra/lambdas/report-dashboard`, then `terraform apply`. |
| The dashboard shows few orders older than a week | The data archiver has moved closed orders out of the database: with `demo.tfvars`, every delivered or cancelled order more than 7 days old. |

## Cost and teardown

These run 24/7: the **ALB**, the **RDS instance**, the **NAT instance**, the API instance(s), and public IPv4 addresses. Most fall under the Free plan's allowances or credits, but the free EC2 hours (750/month) cover only one instance running all month. The NAT instance plus one API instance already use about 1,500 hours, so the extra comes out of your credits. The KMS key (about US$1/month) and Secrets Manager secret (about US$0.40/month) are small extras. The WAF costs about US$10/month (US$5 for the web ACL, US$1 per rule) plus US$0.60 per million requests; CloudFront traffic at this size fits in its always-free allowance (1 TB and 10 million requests a month). QuickSight bills per user from the day it's enabled; cancel the subscription in the QuickSight console when you're done, because `terraform destroy` only removes the dataset and data source. The free dashboard in section 8 adds one short Lambda run a day, which the always-free Lambda and EventBridge Scheduler allowances cover. Destroy everything when you're not using it.

```sh
# 1. In terraform.tfvars, allow deleting the database and the non-empty bucket:
#      db_deletion_protection       = false
#      reports_bucket_force_destroy = true
#      archive_bucket_force_destroy = true
terraform apply

# 2. Delete all images in ECR (destroy fails while the repository has any, including untagged ones):
#    ECR console → kool-kaya-kitchen → select all → Delete

# 3. Destroy
terraform destroy
```

The destroy can pause for up to about 20 minutes while AWS releases the report Lambda's network interfaces in the app subnet; that's normal.

RDS leaves a final snapshot named `kool-kaya-kitchen-db-final`. Delete it in the RDS console if you don't need it, because it costs money and a second destroy fails while a snapshot with that name exists. The KMS key is scheduled for deletion after 30 days.
