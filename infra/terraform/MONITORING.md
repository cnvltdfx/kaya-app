# Monitoring

Owners: Kristin & Aleksandra. Everything is in `monitoring.tf`.

Matches the "Monitoring" box in the architecture diagram:

```
CloudWatch metrics & alarms ──> SNS ops alerts (kool-kaya-kitchen-ops-alerts) ──> email to staff
```

(The other CloudWatch arrow in the diagram, "CPU / Request trigger scale in / out", is the Auto Scaling policies in `compute.tf`.)

## Alarms

| Component | Alarm | Fires when |
|---|---|---|
| Load balancer | `alb-no-healthy-hosts` | No healthy API server for 3 minutes (site down) |
| Load balancer | `api-5xx` | API servers return 5+ server errors in 5 min |
| Load balancer | `alb-5xx` | Load balancer itself returns 5+ 502/503/504 in 5 min |
| Load balancer | `api-latency-p95` | p95 response time > 1 s for 10 min |
| API servers (EC2) | `api-cpu-high` | Average CPU > 80% for 15 min |
| Database | `db-cpu-high` | CPU > 80% for 15 min |
| Database | `db-storage-low` | Less than 2 GB free |
| NAT | `nat-status-check` | NAT fails its status check (private servers lose internet access) |

Every alarm sends an email when it fires and again when it recovers (OK).

Thresholds are variables at the top of `monitoring.tf` (`alarm_cpu_percent`, `alarm_p95_latency_seconds`, `alarm_5xx_count`, `alarm_db_free_storage_gb`).

No other files are changed.

## Deploy

1. Add the staff emails to `terraform.tfvars`:
   ```hcl
   alert_emails = ["staff1@example.com", "staff2@example.com"]
   ```
2. `terraform apply` as usual (state is shared in S3, see `backend.tf`).
3. Everyone in `alert_emails` gets "AWS Notification - Subscription Confirmation". **Click Confirm**, or no alarm emails arrive.

To change who gets alerts later, edit `alert_emails` and run `terraform apply` again.

## Testing (for the report, take screenshots)

- **Any alarm, instantly:** force an alarm state
  ```bash
  aws cloudwatch set-alarm-state --region ap-southeast-1 \
    --alarm-name kool-kaya-kitchen-api-cpu-high \
    --state-value ALARM --state-reason "Test alert"
  ```
  An email should arrive within a minute. It goes back to OK on the next evaluation.
- **Site down:** stop the API container through Session Manager (`sudo systemctl stop kaya-api`). `alb-no-healthy-hosts` fires after about 3 minutes, and the Auto Scaling group replaces the instance.

## Cost

8 alarms, all within the CloudWatch free tier (10 alarms). SNS email is free for the first 1,000 emails a month.
