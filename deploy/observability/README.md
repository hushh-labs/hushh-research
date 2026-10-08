# Capacity observability reconciliation

Run the narrow reconciler separately for UAT and production. It reads current
Cloud Logging and Cloud Monitoring state and prints a plan by default. It does
not enable APIs or change IAM, BigQuery, Cloud Run jobs, or Scheduler jobs.

```bash
python3 deploy/observability/reconcile_capacity.py \
  --project PROJECT_ID --sql-instance INSTANCE_NAME
```

Review the plan, then repeat with `--apply`. The default recipients are
`manish@hushh.ai`, `ankit@hushh.ai`, and `kushal@hushh.ai`, because the Cloud
Identity operator cannot create `eng@hush1one.com`. Use a repeated `--email`
for each recipient when overriding this list. Reconcile one project at a
time and verify the channel and policy names afterward. Existing duplicate
channels or policy display names cause a hard failure instead of deletion.

Incident purpose is authored in each policy template. Backend 5xx, sustained
short-read latency, acquisition timeout, critical SQL capacity, account-mail
failure and information-health anomalies remain enabled at ERROR severity,
with the configured recipients and opening/recovery notifications. No reminder
strategy is installed. Genuine-failure thresholds are unchanged.

Unexpected-error count duplicates backend 5xx coverage. Early pool wait and SQL
connection warnings have no separate operator action. These three policies are
disabled and have no notification channels; their metrics and dashboard remain.
Removing email alone would still create incidents and is insufficient. Both the
broad setup script and the narrow command use this same reconciler, including
severity, delivery strategy and enabled-state drift detection. `OBS_ALERT_EMAIL`
in the broad setup overrides recipients with one address; leaving it unset uses
the three defaults above. Unmanaged security/consent policies are not altered.

Before applying, capture the current policy JSON for rollback and verify backend
5xx coverage against request-summary server errors. Read back policies after the
apply, run the same plan again, and require no policy changes. Restore the captured
policy configuration if coverage is incomplete. Do not inject application errors
to prove a production notification.

The short-read latency distribution covers `GET /api/one/location/state` and
`GET /api/consent/center/summary`, which have explicit SQL query budgets in the
backend middleware. Streams and unrelated routes are excluded. Pool wait is
the accumulated wait recorded in each backend `request.summary` text log.
Cloud SQL connections are summed across the metric's database label for the
selected instance. The SQL metric can lag by about three minutes, so retain
live database checks during a deployment.

Before relying on email alerts, ensure the group accepts mail from
`alerting-noreply@google.com`. Prove delivery with a temporary alert policy
that deliberately triggers on a safe test condition; remove that policy after
the email arrives. Cloud Monitoring does not provide an email-channel test
button. Keep that delivery proof separate from reconciliation so routine runs
cannot create test incidents.
