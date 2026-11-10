# Deploy runbook: full demo stack

Step-by-step commands to deploy everything in this folder for a live demo: the scaling stack, WAF in block mode, fast order expiry and fast archival. [README.md](README.md) explains each part in more detail; this file is the order to run it in.

Commands are PowerShell (Windows), run from `infra/terraform` unless a step says otherwise.

## What gets deployed

| Feature | Setting for this demo |
|---|---|
| Network | VPC `10.0.0.0/16`, public subnets in AZ A and B, one private app subnet (AZ A), data subnets in A and B, one `t3.micro` NAT instance |
| API servers | `t3.micro`, Auto Scaling **min 1 / max 3**, **warm pool 2**, scales on 1,000 requests per server per minute or 50% CPU, predictive scaling **ForecastOnly** |
| Scheduled scaling | **11.11 sale**: 4–10 servers from 06:00 SGT 11 Nov, then 2–6 from 00:00 SGT 13 Nov (see [the warning](#scheduled-scaling-read-before-11-nov)) |
| Load balancer | HTTP, **only reachable from CloudFront** (`restrict_alb_to_cloudfront = true`) |
| CloudFront + WAF | Storefront from private S3; `/api/*` to the ALB. WAF in **block** mode: IP reputation, login limit 100 and site limit 2,000 per IP per 5 minutes, core rules, SQL injection. Your load-test IP skips the site limit only |
| Database | RDS MySQL `db.t4g.micro`, 20 GiB, single AZ, KMS-encrypted, 1-day backups, deletion protection on |
| Sign-in | Cognito Managed Login, `staff` and `admin` groups |
| Orders | SQS queue + DLQ, order worker, SNS events, SES email from `leandroakk@gmail.com`, staff alerts to `wenkang.hoo@gmail.com`. **Unpaid orders expire after 1 minute** |
| Reporting | Sales and inventory CSVs daily at 00:05 SGT and Mondays at 00:10, plus the **free HTML dashboard rebuilt every 15 minutes**. No QuickSight |
| Archival | **Every 15 minutes**, closed orders older than **7 days**, Glacier after 1 day, deleted after 2 days |
| Monitoring | Dashboard `kool-kaya-kitchen-ops`, alarms emailed to both Gmail addresses |

## 0. Before you start (do this days ahead)

1. **Tools:** AWS CLI v2, Terraform 1.10+, Docker Desktop, Node.js 22+, and k6 (`winget install k6`) for the load test.
2. **Quotas** (Service Quotas console, `ap-southeast-1`). The 11.11 schedule runs up to 10 servers:
   - Amazon EC2 → *Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances*: at least **22 vCPUs** (10 servers + NAT, 2 each).
   - AWS Lambda → *Concurrent executions*: the new-account default is 10. Request 1,000 if you want the SQS burst to fan out.
3. **Tell the team.** The Terraform state is shared, so anyone who applies with a different `terraform.tfvars` undoes these settings. Use the same file as everyone else for the demo period.

## 1. Sign in and initialise

Use whichever AWS CLI profile points at the Kaya account (`aws configure list-profiles`). If it's not `default`, set it for the terminal, e.g. `$env:AWS_PROFILE = "kaya"`.

```powershell
aws sts get-caller-identity          # Account must be 634993259271
cd infra/terraform
terraform init
```

## 2. Settings

Find your public IPv4 address for the load-test exemption:

```powershell
(Invoke-RestMethod https://checkip.amazonaws.com).Trim()
```

Make `terraform.tfvars` match this. Lines marked `# demo` differ from production; [step 12](#12-after-the-demo) puts them back.

```hcl
aws_region    = "ap-southeast-1"
instance_type = "t3.micro"

asg_min_size       = 1
asg_max_size       = 3
warm_pool_min_size = 2

predictive_scaling_mode = "ForecastOnly"

scheduled_scaling_actions = {
  "1111-sale-start" = { start_time = "2026-11-10T22:00:00Z", min_size = 4, max_size = 10, desired_capacity = 4 }  # 06:00 SGT 11 Nov
  "1111-sale-end"   = { start_time = "2026-11-12T16:00:00Z", min_size = 2, max_size = 6, desired_capacity = 2 }   # 00:00 SGT 13 Nov
}

restrict_alb_to_cloudfront = true

# WAF
waf_mode            = "block"
waf_rate_limit      = 2000
waf_auth_rate_limit = 100
waf_load_test_ips   = ["<your-ip>/32"]   # demo: skips the site-wide limit only

# Order processing
ses_from_address  = "leandroakk@gmail.com"
staff_alert_email = "wenkang.hoo@gmail.com"

# Monitoring
alert_emails = ["leandroakk@gmail.com", "wenkang.hoo@gmail.com"]

# Reporting
report_dashboard_schedule = "rate(15 minutes)"   # demo (production: daily 00:30, delete the line)

# Data archival
archive_schedule             = "rate(15 minutes)"   # demo (production: "cron(0 3 15 * ? *)")
archive_order_age_days       = 7                    # demo (production: 730)
archive_glacier_after_days   = 1                    # demo (production: 365)
archive_expire_after_days    = 2                    # demo (production: 1825)
archive_bucket_force_destroy = true                 # demo

# Checkout expiry
order_payment_timeout_minutes = 1                   # demo (production: 30)
order_expiry_schedule         = "rate(1 minute)"    # demo (production: "rate(5 minutes)")
```

The archival settings go straight in `terraform.tfvars`, so you don't need `demo.tfvars` and every apply picks them up.

## 3. Image repository and app image

The instances pull the image as they boot, so the image has to exist before the servers do.

```powershell
terraform apply '-target=aws_ecr_repository.app'
```

From the **repo root**, build and push:

On Windows, `docker login` to ECR fails (`400 Bad Request`, `The stub received bad data`, then `no basic auth credentials` on push). Docker Desktop saves logins in Windows Credential Manager, which can't hold a token as long as ECR's (about 2,600 characters). So write the token into a separate Docker config instead. It's valid for 12 hours; rerun the `$tok`, `$auth` and `WriteAllText` lines to refresh it.

```powershell
cd ../..
$reg = "634993259271.dkr.ecr.ap-southeast-1.amazonaws.com"
$cfg = "$env:USERPROFILE\.docker-ecr"
New-Item -ItemType Directory -Force $cfg | Out-Null
$tok  = aws ecr get-login-password --region ap-southeast-1
$auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("AWS:$tok"))
[IO.File]::WriteAllText("$cfg\config.json", (@{ auths = @{ $reg = @{ auth = $auth } } } | ConvertTo-Json -Depth 4))

docker build -t "$reg/kool-kaya-kitchen:latest" backend
docker --config $cfg push "$reg/kool-kaya-kitchen:latest"
aws ecr list-images --repository-name kool-kaya-kitchen --region ap-southeast-1   # must list "latest"
```

The config lives in your user folder, outside the repo, so it can't be committed. On macOS or Linux, the normal `aws ecr get-login-password | docker login --username AWS --password-stdin $reg` works.

## 4. Lambda dependencies and the full apply

From any folder in the repo (the loop finds the repo root itself):

```powershell
$root = git rev-parse --show-toplevel
foreach ($fn in 'order-worker','order-expirer','data-archiver','report-dashboard') { npm ci --omit=dev --prefix "$root/infra/lambdas/$fn" }
cd "$root/infra/terraform"
terraform plan -out tfplan
```

Read the plan before applying. Check that:
- it creates `aws_wafv2_ip_set.load_test[0]` and two `aws_autoscaling_schedule.sales` entries;
- it doesn't destroy `aws_db_instance.main`.

```powershell
terraform apply tfplan
```

This takes about 10–15 minutes; the database is the slowest part. Then allow a few more minutes for the CloudFront distribution to deploy and the first server to become healthy.

## 5. Confirm the emails

AWS sends confirmation emails. Nothing reaches those addresses until each link is clicked:

| Inbox | Email | Enables |
|---|---|---|
| leandroakk@gmail.com | "AWS Notification - Subscription Confirmation" | Ops alarms |
| wenkang.hoo@gmail.com | "AWS Notification - Subscription Confirmation" (two of them) | Ops alarms, and rejected-order alerts |
| leandroakk@gmail.com | "Amazon Web Services – Email Address Verification Request" (SES) | Order emails |

SES starts in the sandbox, so it only emails verified addresses. Place demo orders from an account that uses `leandroakk@gmail.com`. A Gmail sender lands in spam, so check the spam folder on the day.

## 6. Check that it's up

```powershell
$SITE = terraform output -raw site_url
curl.exe -s "$SITE/api/catalog/categories"        # JSON list of categories
aws elbv2 describe-target-health --target-group-arn (aws elbv2 describe-target-groups --names kool-kaya-kitchen-tg --query "TargetGroups[0].TargetGroupArn" --output text) --query "TargetHealthDescriptions[].TargetHealth.State"   # ["healthy"]
aws autoscaling describe-warm-pool --auto-scaling-group-name kool-kaya-kitchen-api --query "Instances[].LifecycleState"   # 2 x "Warmed:Stopped"
```

Open `$SITE` in a browser and click through the shop.

## 7. User accounts

Customers, staff and admins all sign in through Cognito Managed Login. The role comes from the Cognito group: `admin`, `staff`, or no group, which means a customer.

### Admin and staff users

```powershell
$POOL = terraform output -raw cognito_user_pool_id
aws cognito-idp admin-create-user --user-pool-id $POOL --username leandroakk@gmail.com --user-attributes Name=email,Value=leandroakk@gmail.com Name=email_verified,Value=true "Name=name,Value=Leandro"
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username leandroakk@gmail.com --group-name admin
```

Cognito emails a temporary password. Sign in on the site and set a new one. Repeat with `--group-name staff` for staff accounts.

### Customer accounts

Customers need no setup and no group. Self sign-up is on (`allow_admin_create_user_only = false`), and the API creates the customer record on first sign-in.

**Self sign-up (the normal path):**

1. Open `$SITE`, click **Sign in**, then **Sign up** on the Managed Login page.
2. Enter an email, a name and a password (8+ characters, at least one lowercase letter and one number).
3. Cognito emails a verification code. Enter it, and you're signed in as a customer.

Cognito sends this email itself, so it isn't limited by the SES sandbox (it does have a daily cap).

**Create a customer yourself** (for a demo account you want ready beforehand):

```powershell
aws cognito-idp admin-create-user --user-pool-id $POOL --username wittlefarmer1@gmail.com --user-attributes Name=email,Value=wittlefarmer1@gmail.com Name=email_verified,Value=true "Name=name,Value=Demo Customer" --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id $POOL --username wittlefarmer1@gmail.com --password "Demo1234" --permanent
```

Don't add the user to any group. `SUPPRESS` skips the temporary-password email, and `--permanent` means no forced password change at first sign-in.

**Order emails go to verified addresses only.** SES is still in the sandbox, so a customer whose address isn't verified places orders normally but gets no confirmation or "expired" email. For the demo, either sign in as a customer using `leandroakk@gmail.com` (already verified), or verify the address first:

```powershell
aws ses verify-email-identity --email-address wittlefarmer1@gmail.com --region ap-southeast-1
```

The owner of that address must click the link AWS sends. Or ask AWS to move SES out of the sandbox days ahead (SES console → Account dashboard → **Request production access**).

**Check and manage customers:**

```powershell
aws cognito-idp list-users --user-pool-id $POOL --query "Users[].[Username,UserStatus]" --output table
aws cognito-idp admin-disable-user --user-pool-id $POOL --username wittlefarmer1@gmail.com   # block sign-in
aws cognito-idp admin-delete-user  --user-pool-id $POOL --username wittlefarmer1@gmail.com   # remove the account
```

A customer must not reach the back office. [Step 8](#8-check-each-feature) tests this.

## 8. Check each feature

### Customer accounts

1. Sign up as a new customer (step 7) and confirm you land back on the shop, signed in.
2. Confirm the customer can place an order and see it under their own orders.
3. Confirm the customer has no back office access: the Back office link is missing, and `/api/admin/*` requests return 403.
4. Sign in as the admin and confirm the new customer's orders appear in the back office.

### Orders and checkout expiry

1. Place an order with the test card `4242 4242 4242 4242`. The order page shows "Confirming your payment…", then "Processing". The confirmation email arrives (check spam).
2. Place a PayNow order and don't pay. Within about 2 minutes it's cancelled, its stock goes back, and the "expired" email arrives.

```powershell
aws logs tail /aws/lambda/kool-kaya-kitchen-order-worker --since 10m
aws logs tail /aws/lambda/kool-kaya-kitchen-email-sender --since 10m
```

### Reports and dashboard

Run both instead of waiting for midnight:

```powershell
'{"reports":[{"type":"sales","days":1},{"type":"inventory"}]}' | Set-Content -NoNewline build/report-payload.json
aws lambda invoke --function-name (terraform output -raw report_generator_function) --payload fileb://build/report-payload.json build/report-invoke.json
aws lambda invoke --function-name (terraform output -raw report_dashboard_function) build/dashboard-invoke.json
aws s3 ls "s3://$(terraform output -raw reports_bucket)/reports/" --recursive
Invoke-Expression (terraform output -raw report_dashboard_link_command)   # link to latest.html, valid 1 hour
```

Back office → Reports lists the generated reports.

The dashboard rebuilds itself every 15 minutes, so demo orders appear in `latest.html` within 15 minutes. Run the dashboard invoke above to refresh it on the spot. Each run also leaves a dated copy under `reports/dashboard/YYYY/MM/DD/`, about 96 a day.

### Archival

The archiver runs every 15 minutes. On its first run it moves seeded orders that are delivered or cancelled and more than 7 days old. To run it now:

```powershell
aws lambda invoke --function-name (terraform output -raw data_archiver_function) build/archive-invoke.json; Get-Content build/archive-invoke.json
aws s3 ls "s3://$(terraform output -raw archive_bucket)/orders/" --recursive
```

Expect `{"orders":<n>,"batches":...,"complete":true,...}` and four Parquet files per batch. Archived orders leave the database, so the dashboard and back office show fewer old orders afterwards. Glacier (1–2 days) and deletion (a day later) can't be shown live. Show them with `aws s3api head-object` on a file the next day (`StorageClass`).

### Scheduled scaling (show in the console)

EC2 → Auto Scaling groups → `kool-kaya-kitchen-api` → **Automatic scaling** tab → **Scheduled actions**. It lists `1111-sale-start` and `1111-sale-end` with their times in Asia/Singapore. The same tab shows the target tracking policies and the predictive scaling forecast.

### Monitoring

CloudWatch → Dashboards → `kool-kaya-kitchen-ops`. Alarms: CloudWatch → Alarms, all prefixed `kool-kaya-kitchen`.

## 9. Security demo

Run these from your machine. Your IP is exempt from the site-wide limit only, so every other rule still blocks you.

```powershell
$SITE = terraform output -raw site_url
$ALB  = terraform output -raw alb_dns_name

# 1. SQL injection: blocked at the edge before reaching the API
curl.exe -s -o NUL -w "%{http_code}`n" "$SITE/api/catalog/products?q=1%27%20OR%20%271%27%3D%271"   # 403

# 2. The load balancer can't be reached directly: its security group admits only CloudFront
curl.exe -s --max-time 10 -o NUL -w "%{http_code}`n" "http://$ALB/api/catalog/categories"   # 000 (timeout)

# 3. Login brute force: more than 100 requests to /api/auth/ in 5 minutes from one IP
1..150 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " -X POST "$SITE/api/auth/login" -H "content-type: application/json" -d "{}" }
# The first codes are the API's own answers, then 403s once WAF has counted past 100 (it can take a minute or so to kick in).
```

Step 3 blocks **all** `/api/auth/` requests from your IP for a few minutes, including your own sign-in. Run it last, or from a phone hotspot.

Show the blocks: WAF & Shield console (region **Global / us-east-1**) → Web ACLs → `kool-kaya-kitchen-cdn` → **Traffic overview** and **Sampled requests**. Logs are in CloudWatch Logs, us-east-1, log group `aws-waf-logs-kool-kaya-kitchen`.

Also worth showing: S3 buckets block all public access, the database isn't publicly accessible and is KMS-encrypted, servers run in a private subnet without SSH (Session Manager only), and IMDSv2 is required.

## 10. Load test

Follow [infra/loadtest/DEMO.md](../loadtest/DEMO.md), with two changes for block mode:

- Force IPv4, because the WAF exemption is IPv4 only and CloudFront also answers on IPv6:
  ```powershell
  cd ../loadtest; npm ci
  k6 run --dns "policy=onlyIPv4" -e SITE=$SITE asg-load.js
  ```
- Check the morning of the demo that your IP is still the one in `waf_load_test_ips`. Venue Wi-Fi gives you a different one: update the setting and apply (see the warning below before applying after 11 Nov).

The ASG scales 1 → 3 about 6 minutes after k6 starts. k6's `status 200` checks should be close to 100%. If you see 403s, your IP isn't the exempt one.

## Scheduled scaling: read before 11 Nov

The 11.11 actions are real, so they will fire:

- **06:00 SGT 11 Nov:** the group goes to 4–10 servers. Scaling beyond 3 servers is billed, and the warm pool grows to fill the new maximum.
- **00:00 SGT 13 Nov:** it goes to 2–6. It does **not** go back to 1–3 by itself.

Two Terraform effects follow:

1. **Any apply between the two times resets the group to 1–3** mid-sale, because Terraform owns `min_size` and `max_size`. Don't apply during the sale unless you mean to end it.
2. **After an action fires, AWS deletes it**, and the next plan tries to create it again with a past start time, which fails. After 06:00 SGT 11 Nov, delete the `1111-sale-start` line before applying. After 00:00 SGT 13 Nov, delete both lines (or set `scheduled_scaling_actions = {}`), then apply. That apply also puts the group back to 1–3.

If the demo is after 11 Nov and you only need the actions to *show* in the console, move both dates later than the demo.

## 11. Deploy a change on the day

- **Backend:** rebuild and push (step 3), then `aws autoscaling start-instance-refresh --auto-scaling-group-name kool-kaya-kitchen-api`.
- **Frontend:** `terraform plan -out tfplan`, then `terraform apply tfplan`, then `Invoke-Expression (terraform output -raw frontend_invalidate_command)`.
- **Settings:** edit `terraform.tfvars`, then plan and apply. Run the Lambda `npm ci` loop (step 4) first if anyone cleaned the folders.

## 12. After the demo

Put the production values back in `terraform.tfvars`, then plan and apply:

```hcl
waf_load_test_ips             = []                    # or delete the line
# delete report_dashboard_schedule (back to daily at 00:30)
archive_schedule              = "cron(0 3 15 * ? *)"
archive_order_age_days        = 730
archive_glacier_after_days    = 365
archive_expire_after_days     = 1825
order_payment_timeout_minutes = 30
order_expiry_schedule         = "rate(5 minutes)"
scheduled_scaling_actions     = {}                    # once the sale is over
```

Keep `waf_mode = "block"`. Run the k6 test only with an exempt IP.

## Teardown

```powershell
# In terraform.tfvars:
#   db_deletion_protection       = false
#   reports_bucket_force_destroy = true
#   archive_bucket_force_destroy = true   (already set for the demo)
terraform apply
# ECR console -> kool-kaya-kitchen -> select all images -> Delete
terraform destroy
```

Afterwards, delete the RDS snapshot `kool-kaya-kitchen-db-final` in the RDS console. It costs money, and a second destroy fails while it exists. The destroy can pause about 20 minutes while AWS releases the Lambdas' network interfaces.

## Cost while it runs

These run 24/7 and are billed (or use credits) beyond the Free plan allowance:
- the ALB, RDS, the NAT instance, and each API server (one server plus the NAT already uses about 1,500 of the 750 free hours a month);
- the WAF, about US$10/month plus US$0.60 per million requests;
- the KMS key, about US$1/month;
- the Secrets Manager secret, about US$0.40/month.

Warm-pool servers cost only their EBS volumes while stopped. The 11.11 window adds 4–10 servers for two days, then 2 until you remove the schedule. Destroy the stack when the demo is over.
