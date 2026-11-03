# Monitoring

Owners: Kristin & Aleksandra. Everything is in `monitoring.tf`.

Matches the "Monitoring" box in the architecture diagram:

```
CloudWatch metrics & alarms ──> SNS ops alerts (kool-kaya-kitchen-ops-alerts) ──> email to staff
```

(The other CloudWatch arrow in the diagram, "CPU / Request trigger scale in / out", is the Auto Scaling policies in `compute.tf`.)

## How it works

- **CloudWatch** is AWS's monitoring service. It collects numbers (metrics) from every service automatically, like EC2 CPU, load balancer requests and errors, or free database storage, every 1 to 5 minutes.
- A **CloudWatch alarm** watches one metric against a threshold, for example "average CPU above 80% for 15 minutes". When the threshold is crossed, the alarm goes into the ALARM state.
- The alarm then sends a message to the **SNS ops alerts topic**. SNS emails everyone subscribed to it (the addresses in `alert_emails`).
- When the metric goes back to normal, the alarm returns to OK and sends a second email.

So CloudWatch does the watching and deciding, and SNS does the notifying.

## Alarms

### Ours (`monitoring.tf`)

| Component | Alarm | Fires when | Why it matters |
|---|---|---|---|
| Load balancer | `alb-no-healthy-hosts` | No healthy API server for 3 minutes | The site is down; customers can't open it |
| Load balancer | `api-5xx` | API servers return 5+ server errors (5xx) in 5 min | Something is wrong in the app itself, like a bug or no database connection |
| Load balancer | `alb-5xx` | Load balancer itself returns 5+ 502/503/504 in 5 min | Usually the servers are too slow to answer or all overloaded |
| Load balancer | `api-latency-p95` | Slowest 5% of requests take over 1 s for 10 min | The site is getting slow for customers |
| API servers (EC2) | `api-cpu-high` | Average CPU > 80% for 15 min | Auto Scaling has added servers and they still can't keep up |
| Database | `db-cpu-high` | CPU > 80% for 15 min | An overloaded database slows down the whole site |
| Database | `db-storage-low` | Less than 2 GB free | When it fills up, new orders can't be saved |
| NAT | `nat-status-check` | NAT fails its status check | Private servers lose access to ECR, S3 and Secrets Manager, and new servers can't start |

Thresholds are variables at the top of `monitoring.tf` (`alarm_cpu_percent`, `alarm_p95_latency_seconds`, `alarm_5xx_count`, `alarm_db_free_storage_gb`).

### Other alarms that use the same topic

Other parts of the system send their alarms to the ops alerts topic too, through `local.alarm_actions`:

| File | Alarm | Fires when |
|---|---|---|
| `orders.tf` | `order-expirer-errors` | The order expirer Lambda fails; unpaid orders keep their stock reserved until it runs again |
| `archive.tf` | `data-archiver-errors` | The monthly data archiver Lambda fails (nothing is lost; the next run retries) |
| `archive.tf` | `archive-schedule-dlq` | The scheduler couldn't invoke the archiver at all |

## Dashboard

`kool-kaya-kitchen-ops` is one CloudWatch dashboard for the whole system, laid out like the architecture diagram. Open it with the link from `terraform output ops_dashboard_url`.

| Row | Graphs |
|---|---|
| Alarm status | All 11 alarms above, green (OK) or red (ALARM) |
| Website (load balancer) | Requests per minute, 5xx errors, response time (p50 and p95), healthy and unhealthy servers |
| Servers and database | CPU for API servers, database and NAT; database connections; free database storage (GB) |
| Order processing | Orders waiting in the queue and failed orders (DLQ), oldest order waiting, runs and errors for the order worker, email sender and order expirer |
| Reporting and data archival | Daily runs and errors for the report generator and the data archiver, missed archive schedules |

Graphs that have an alarm show the alarm threshold as a horizontal line.

## How the code works

`monitoring.tf` has five parts:

1. **Variables**: `alert_emails` and the alarm thresholds. Change a threshold by changing its `default`.
2. **SNS topic and subscriptions**: `aws_sns_topic.ops_alerts`, plus one email subscription per address in `alert_emails` (`for_each`).
3. **Alarms**: 8 `aws_cloudwatch_metric_alarm` blocks, all in the same format. For example:
   ```hcl
   resource "aws_cloudwatch_metric_alarm" "api_cpu_high" {
     namespace           = "AWS/EC2"              # which service
     metric_name         = "CPUUtilization"       # which number
     statistic           = "Average"
     period              = 300                    # every 5 minutes
     evaluation_periods  = 3                      # 3 in a row = 15 minutes
     comparison_operator = "GreaterThanThreshold"
     threshold           = var.alarm_cpu_percent  # 80
     dimensions          = { AutoScalingGroupName = local.asg_name }  # which resource
     alarm_actions       = local.alarm_actions    # fires -> SNS topic
     ok_actions          = local.alarm_actions    # recovers -> SNS topic
   }
   ```
   Read it as: every 5 minutes, check the API servers' average CPU; if it's above 80% three times in a row, notify the ops alerts topic.
4. **Dashboard**: `aws_cloudwatch_dashboard.ops`, built from the same resources, so it always points at the right load balancer, database, queues and Lambdas.
5. **Outputs**: `ops_alerts_topic_arn` and `ops_dashboard_url`.

No other files need changing.

## Deploy

1. Add the staff emails to `terraform.tfvars`:
   ```hcl
   alert_emails = ["staff1@example.com", "staff2@example.com"]
   ```
2. `terraform apply` as usual (state is shared in S3, see `backend.tf`).
3. Everyone in `alert_emails` gets "AWS Notification - Subscription Confirmation". **Click Confirm**, or no alarm emails arrive.

Without `alert_emails`, the topic and alarms are still created, but nobody gets the emails. To change who gets alerts later, edit `alert_emails` and run `terraform apply` again.

To check who is subscribed: AWS console → SNS → Topics → `kool-kaya-kitchen-ops-alerts` → Subscriptions (status must be Confirmed).

## Testing (for the report, take screenshots)

- **Any alarm, instantly:** force an alarm state
  ```bash
  aws cloudwatch set-alarm-state --region ap-southeast-1 \
    --alarm-name kool-kaya-kitchen-api-cpu-high \
    --state-value ALARM --state-reason "Test alert"
  ```
  An email should arrive within a minute, and the alarm shows red on the dashboard. It goes back to OK on the next evaluation.
- **Site down:** stop the API container through Session Manager (`sudo systemctl stop kaya-api`). `alb-no-healthy-hosts` fires after about 3 minutes, the healthy servers graph drops, and the Auto Scaling group replaces the instance.

## Cost

- Alarms: 11 in total use the topic. The CloudWatch free tier covers 10, so expect about US$0.10 a month.
- Dashboard: 1 dashboard with about 26 metrics, within the free tier (3 dashboards, 50 metrics each).
- SNS email: free for the first 1,000 emails a month.
