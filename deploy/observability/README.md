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
strategy is installed. Request-failure thresholds are unchanged.

SQL thresholds derive from `config/runtime-capacity.json`: warning at 70% and
critical at 85% of the selected environment's connection ceiling. Production's
complete `connection_policy` is 400 maximum, 300 admission and 30 administrative
reserve; UAT retains 1000/800/100. An absent override inherits the complete root
policy; an incomplete override fails closed. Both setup entrypoints use the same
reconciler. Unprofiled projects and mismatched SQL instances fail before any
cloud call. Production warning/critical thresholds are 280/340, with warning
remaining diagnostic only; UAT remains 700/850.

Before a production release, retire obsolete zero-traffic tags and revisions with
the existing healthy-release retention helper, preserving serving and rollback
revisions. Deletion must wait for its recorded request-timeout drain deadline;
tag removal alone does not prove that admitted requests have stopped.
The capacity check still requires an explicit live SQL flag matching the profile,
and counts every retained database revision, candidate, workers and overlapping
jobs in both environments. With the
current production pools, three backend revisions, one worker candidate and the
readiness job require 292 connections including reserve. Additional reachable
revisions or jobs can block admission and must not be ignored.

A connection ceiling is not a throughput or memory guarantee. Check recent CPU,
memory, active connections and query memory before changing SQL flags; retain a
fresh backup and record restart readiness and rollback. The 2026-10-10 candidate
uses the existing 3.75 GiB tier, whose prior 24-hour peaks were 48% CPU and 49%
memory. At 292 budgeted connections, idle connection overhead alone can approach
876 MB; complex concurrent queries consume additional memory. Observe serving
traffic after the change and halt further scaling if headroom deteriorates.
See Google's [memory guidance](https://docs.cloud.google.com/sql/docs/postgres/manage-memory-usage-best-practices)
and [restart requirements for flags](https://docs.cloud.google.com/sql/docs/postgres/flags).

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

Agent stream failures use the existing redacted terminal-turn telemetry. HTTP-success streams with model, connector, database or execution failures trigger one actionable ERROR policy on any failure in a five-minute window (aligned count above zero, no additional duration). Refusals, client disconnects and planned restarts do not count. No owner, thread or run identifier becomes a metric label. Both reconcilers preserve existing opening/recovery recipients.

Chat answer latency uses `first_answer_ms`, separately from first-visible tool or status activity. The dashboard compares answer samples with terminal-turn count and reports missing answers separately; missing timing marks never become zero-latency samples. Missing-answer count includes approval-only turns and is diagnostic, not an error alert. Azure model-call failures have a separate typed counter; content-free call logs include authentication, first output, total time and reasoning-token usage. Existing actionable terminal failure alerts retain their recipients.

Explicit Azure content-filter stops remain terminal errors with `error_class=refusal`,
`error_code=text.content.filtered` and model-call `error_kind=filtered`. They are
visible in content-free logs and terminal counts without paging as outages.
Token exhaustion, unknown incomplete reasons and provider failures remain actionable.
`provider_code` projects a closed diagnostic vocabulary for structured SDK errors;
provider messages and response bodies never enter the call log.

## Azure release probe timeouts

UAT reconciliation owns one counter and the enabled ERROR
policy `[Managed] Azure Release Probe Repeated Timeouts`. The source deployment
runs `azure-pwm-<build UUID>` jobs only in `hushh-pda-uat`, `us-central1`.
The counter selects their structured terminal failures with
`classification=provider_unavailable` and `error_type=TimeoutError` or
`APITimeoutError`. Stage records, successful probes, schema/security failures and
unrelated jobs do not count. Two terminal failures in ten minutes trigger one
aggregated incident with opening/recovery notices. No model prompts, owner
identifiers or custom metric labels are retained.

When the primary HTTP probe succeeds but a required capability fails, the single
terminal diagnostic preserves the failed child's classification, error class and
observed duration instead of replacing them with a generic runtime error. A
provider-only timeout remains visible to this terminal-only metric; mixed
application/configuration failures remain blocking and do not masquerade as a
provider-only timeout. Child rows do not increment the timeout counter themselves.

Failed capability rows may also carry a closed `failure_reason` for the authored
Live binding, transcription, response or provider-operation guards, or the One
root model, tool roster, clock selection or synthetic round trip. Exact built-in
exception types and static arguments select these codes; unknown failures use
`unlisted`. Raw exception text and provider/model content are never retained.
These codes distinguish failed checks; they do not establish the provider's
underlying cause or change release admission. The Live probe always settles its
recording task, including an already-completed failure, without replacing the
primary failure or extending its deadline.

The existing execution-bound `probe_history` keeps `primary_http` alongside
Azure-only `capability:<name>` failure rows. Each child has one failed attempt;
the closed capability/error vocabulary and duration bounds exclude raw provider
payloads, and no retry or recovery is inferred. Observed cancellation latency
may exceed the configured child deadline and is retained as measured. This
history is diagnostic evidence in the failed aggregate, not a passing capability
proof. The success-only uploaded release receipt still refuses failed builds,
failed aggregate steps and missing/failed provider selections.

Use the existing reconciler's narrow mode and repeat `--email` for each
already-enabled, verified notification channel recipient:

```bash
python3 deploy/observability/reconcile_capacity.py \
  --project hushh-pda-uat --release-probe-only \
  --email "$AZURE_PROBE_EXISTING_ALERT_EMAIL"
```

This mode reconciles only the timeout metric and its policy using existing
delivery channels. It requires no SQL instance and does not reconcile a dashboard.
Other provisioner flags, SQL configuration, non-UAT projects and `--console-only`
are rejected. The default run only prints a plan;
missing, disabled or explicitly unverified channels refuse delivery setup.
Review that only this metric and policy need creation before appending `--apply`,
then read them back and require an unchanged second plan. Production, provider,
auth and voice-only provisioner scopes retain their existing resources.

Retain each exact failed build/execution receipt, failure stage, elapsed time and
immutable source/image/configuration binding. Any authorized bounded retry uses
the same verified commit. A passing retry records recovery and does not establish
a permanent fix. Preserve serving traffic and every readiness, schema, security
and provider gate; do not increase deadlines to obtain a passing check. The policy
performs no retry. Log metrics begin at creation, and reconciled channel/policy
configuration does not prove inbox delivery. Do not inject probe failures to
prove notification delivery.

## One Voice provider and latency tracking

The reconciler also owns two distribution log metrics in the **backend deployment
project** (`hushh-pda-uat` for UAT): `obs_one_voice_latency_ms` for server phases,
and `obs_one_voice_client_perf_ms` for content-free client samples relayed by the
backend. Their metric labels are limited to phase or client metric, resolved
Vertex project, Live model, and Live region. Cloud Run's resource identifies the
serving revision. Session IDs, turn IDs, prompts, user data, and tool names are
not metric labels. `vertex_project=hushh-vertex-personal54` means inference is
routed to that Vertex project; it does **not** mean the logs or dashboard live
there. UAT routed to `hussh-511311` before 2026-10-15.

The managed dashboard plots five-minute, per-revision percentiles for server
`first_audio` p50/p95 and `tool` p95, plus client `endpointing_client` p95 and
`audio_receive_to_audible` p95. Server `first_audio` starts at the final input
transcript; client endpointing happens before that, and client audio-to-audible
happens after audio reaches the browser. These are different spans. Do not add
their p95 values and call the sum end-to-end p95. Compare the same phase,
revision, Vertex project, model, and region before and after a release. Record
sample counts alongside percentiles; p95 is directional below roughly 100
observations in a slice. Log-based metrics only count entries ingested after
their creation, so historical logs remain the baseline source for earlier
releases. No per-request Live billing labels are emitted, so these metrics
cannot calculate an exact voice-versus-chat credit split.

After UAT voice tests, run this in Logs Explorer for project `hushh-pda-uat` to
verify the serving binding and inspect timing rows. Add a
`resource.labels.revision_name` clause for an exact release slice:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="consent-protocol"
textPayload=~"one_voice[.](provider_binding|latency|client_perf)"
textPayload=~"provider=vertex_ai vertex_project=hushh-vertex-personal54 "
```

For a voice-only rollout, add `--voice-only` to the `reconcile_capacity.py`
command above. This reconciles the two voice metrics and managed dashboard
without reading or changing notification channels or alert policies. Run it
first in plan mode, then with `--apply`, then again in plan mode to require
`metric unchanged` and `dashboard unchanged`. The dashboard and metrics are
managed in the backend deployment project; the provider project is only a
bounded dimension of those observations.

## Auth availability

Use the same reconciler for auth availability without SQL, dashboard, IAM or
scheduler changes. It defaults to a read-only plan and disabled auth policies;
ordinary capacity reconciliation does not touch these policies. Monitoring
commands have a 60-second deadline. The auth path
reuses existing enabled email channels and refuses duplicates or an explicitly
unverified channel. It does not create another channel.

```bash
python3 deploy/observability/reconcile_capacity.py \
  --project hushh-pda-uat --auth-only --enable-auth-alerts \
  --email ankit@hushh.ai --email kushal@hushh.ai
```

Capture current policy JSON for rollback. Review this plan, append `--apply`,
read the selected managed policies back, then run the same plan again and require
`unchanged` for every metric and policy. Repeat separately for production with
`--project hushh-pda`. Removing `--enable-auth-alerts` and applying disables the
auth policies and clears their channels. It does not delete monitoring history.

`[Managed] Auth Service Failures` opens after at least three server failures in
five minutes across identity refresh, phone claim/finalization, test-phone
start/confirm, transfer prepare/confirm/status and vault bootstrap. Provider proof,
unlink, recovery and verified-notice failures use the same content-free metric.
For a phone transfer alert, inspect workflow/effect/notice states by opaque
operation ID. `dispatched` and `uncertain` are not retry permission: drain the
original worker and use the existing generation-bound mutation journal. A phone
being absent in a provider read is not proof that an earlier POST has stopped.
Never delete the previous account, clear the admission fence or replay an
uncertain unlink to silence an incident. Existing account recovery remains the
owner path while support resolves the uncertain receipt. It uses existing `request.summary` route
templates and `server_error` outcomes, so invalid OTPs, ownership conflicts and
ordinary client rate limits do not page. The incident aggregates revisions into
one series and sends opening/recovery notices without repeat reminders. Keep
the existing `[Managed] DB Pool Acquire Timeout` policy enabled and verify its
channels independently: it catches even one acquisition timeout, including a
`DATABASE_UNAVAILABLE` dependency failure before the auth spike threshold. Do
not run the broad setup script merely to add auth coverage.

`[Managed] Firebase Phone Provider Failures` covers direct Firebase phone send
and verify calls from web, iOS and Android. Both deployment environments share
Firebase project `hushh-pda`, so only that project's auth reconciliation manages
this policy; UAT reconciliation excludes it. It reuses the same notification
channels and enablement flag, with no extra log metric or dashboard.

The policy requires **both** at least ten HTTP 403/429/5xx responses in an aligned
five-minute window and a failure ratio above 20% sustained for five minutes.
Its numerator and denominator use identical five-minute sum/reduction settings
on `serviceruntime.googleapis.com/api/request_count`, scoped to Identity Toolkit
`SendVerificationCode` and `SignInWithPhoneNumber`. Ordinary wrong-code HTTP 400
responses are excluded. HTTP 403 permission/configuration failures count; provider failures represented
as HTTP 400, browser errors before a provider request and undelivered SMS remain
outside this signal. Low-volume failures below the ten-response floor do not page.
Google documents one-minute sampling and up to **30 minutes** of ingestion delay,
so this coverage is delayed rather than an immediate page. See the
[service-runtime metric descriptor](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z#gcp-serviceruntime)
and [ratio aggregation contract](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#MetricThreshold).

`[Managed] Auth Test Allowlist Health` consumes an explicit, content-free
publication from the existing protected-list checker:

```bash
python3 scripts/ops/verify_secret_list_invariants.py \
  --project hushh-pda-uat --emit-health-log
```

The checker keeps secret values in process memory and publishes only
`auth.test_allowlist.health`, `status` (`healthy`, `failed`, `unavailable`) and
a list count to `obs-auth-health`. Missing access, a failed previous-version read
and a wiped list cannot produce a healthy status. Each gcloud operation has a
45-second deadline. Publication failure returns a failed verification outcome,
without copying provider diagnostics. Normal deploy checks remain read-only
unless this flag is supplied.

`--check-phone-runtime` also observes `/health/ready` on the authenticated
Cloud Run service origin for `consent-protocol` in the selected governed project
and `us-central1`. It requires one explicit revision serving 100% of traffic,
accepts canonical legacy or regional Run URLs, disables redirects and bounds
the response to 16 KiB and the HTTP request to ten seconds. A fresh service
read must retain the same origin and revision. No caller URL, owner token,
phone number, OTP, challenge issuance or SMS request is involved.

When requested, `checks.phone_test_transport` must be `healthy`; this is computed
by the serving process's actual transport configuration rules, including the
existing UAT challenge-key fallback. Missing fields on older revisions,
malformed or failed HTTP responses and ambiguous or changed serving authority
produce `unavailable`. The same publication adds only `runtime_status`; its
overall `status` cannot be healthy unless both the protected lists and runtime
observation are healthy. This samples the responding process's prerequisites,
not every instance or a complete verification journey.

Runtime observation is staged independently in each GitHub environment through
`AUTH_PHONE_RUNTIME_HEALTH_ENABLED`, which defaults to `false`. While unset or
false, hourly and manual runs continue list-only checks and omit
`runtime_status`; they do not claim runtime coverage. First deploy the new
runtime response, then perform the bounded read-only check:

```bash
python3 scripts/ops/verify_secret_list_invariants.py \
  --project hushh-pda-uat --check-phone-runtime
```

After observing a healthy result, the release operator can set that environment's
variable to `true` and dispatch **Verify Protected Configuration**. Read back
only `message`, `status`, `checked_lists` and `runtime_status` from
`obs-auth-health`; require a healthy runtime observation before claiming it is
active. Repeat separately for production. Setting the environment variable back
to `false` restores list-only monitoring without removing its alerts. No second
dispatch control, scheduled workflow or notification channel is introduced.

The protected check is moving to the `protected-configuration-health` Cloud Run
Job and an authenticated hourly Cloud Scheduler target in each monitored project.
The existing GitHub schedule remains the fallback until consecutive cloud-scheduled
executions publish healthy count/status events. Retire that schedule only after
recording the live image, identities, execution names and delivery timestamps.

Use the existing checker, pinned SDK image and non-root container. The task has
one worker, no retries, a 600-second hard timeout and a 450-second checker deadline.
A conditional Storage generation lease expires after 900 seconds and fences
concurrent executions. A worker verifies its holder at the exact generation and
cannot delete a successor. The operations bucket contains only build inputs/logs
and opaque lease metadata; 14-day lifecycle rules bound build retention. It is
separate from owner Files storage.

`setup_auth_health.py` defaults to a read-only plan. Applying requires reviewed
Main source, verified `kushal@hushh.ai` ADC and a durable local `--receipt` ownership
journal. Never adopt a pre-existing service account, bucket, job or schedule by
name alone. Retries retain recorded workload identity IDs. Later reviewed source
updates reuse that same locked journal with explicit `--upgrade-from <recorded-sha>`;
builds are reconciled per operation and source revision. Atomic journal replacement
preserves repair authority on interruption. The checker gets only its declared secret-version permissions,
log publication, its lease bucket and optional service metadata observation.
The clock identity gets only job invocation. Existing runtime-check rollout stays
independent for UAT and production.

The pinned amd64 SDK image supplies its interpreter under
`/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3`; the health
entrypoint uses that path directly. Resource discovery uses native HTTP status:
only 404 permits creation, while denied or malformed observations refuse.

UAT's deployment-authority deny policy intentionally blocks administrators from
submitting Cloud Builds manually. Preserve that policy. For an existing recorded
health operation, dispatch **Verify Protected Configuration** from Main with
`health_build_operation` set to its opaque operation ID and
`health_action=build-image`. This image-only action uses the existing governed
UAT WIF identity. It never changes application services, IAM, jobs or schedules.
Its concurrency is separate from checks; neither clock nor manual checks cancel
it. The default with an empty operation input still runs the protected checks.

UAT also denies local `run.services.setIamPolicy`. Before runtime-enabled local
setup, use the same Main-only workflow with `health_action=runtime-access` and
`health_checker_unique_id` copied from that operation's durable journal. This
separate action checks the bucket operation and exact live checker identity,
then grants only `roles/run.viewer` on UAT's `consent-protocol` service and reads
it back. It preserves existing IAM bindings and never changes the deny policy,
project-wide viewer access, application revision or traffic. A lost response is
reconciled by reading the same binding; a replaced identity refuses. Local setup
verifies this existing permission instead of retrying a denied IAM write.


Read back the exact workflow source, actor, attempt, image-only artifact and
successful native Cloud Build before resuming the original local ownership
journal. Image reuse verifies the immutable source-object generation, bounded
archive contents and exact reviewed recipe against Main, including the
Dockerfile. Matching build tags alone never establish provenance. A missing
source archive requires explicit repair; do not infer successful qualification
from an image tag or rerun an unresolved build blindly.

```bash
python3 deploy/observability/setup_auth_health.py --project hushh-pda-uat
# After Main acceptance, operator journal path must be outside committed source:
python3 deploy/observability/setup_auth_health.py --project hushh-pda-uat \
  --check-phone-runtime --apply --receipt "${TMPDIR:-/tmp}/auth-health-uat.json"
```

Use a short two-minute schedule only for bounded qualification, then restore
`17 * * * *`. Read back the actual timer and at least two genuine scheduled
executions. Do not fabricate health events, inject production errors or infer
SMS delivery from list integrity. Preserve the three-hour missing-report alert
once its producer is qualified. `[Managed] Protected Configuration Job Failed`
uses the native failed-execution counter independently, covering startup/IAM,
lease/timeouts and non-phone-list failures even if phone-list health is intact.
It reuses the existing verified notification channels and has no reminder loop.

Production schema closure and capacity admission independently qualify the
reviewed list-only job incarnation through `auth_health_non_sql.py`. Its frozen
UID/specification, source-body hashes, native successful Cloud Build, immutable
source generation/archive SHA-256 and output image must all match. The reviewed
six-file source archive contains the pinned Dockerfile, build configuration and
four checker dependencies; the native build retains its hash after the temporary
GCS archive expires. A local receipt or a matching job name grants no exception.
The native-metadata test fixture restores its explicit source-SHA token before
parsing; its decoded metadata is unchanged. This avoids misclassifying the image
tag as a credential without adding secret-scanner exceptions.
Every active execution must retain that exact specification, and complete audit
history must bind the successful creation and each effective execution without
updates or overrides. The existing bounded history limit still fails closed.

This admits zero **additional direct SQL connections**: this exact list-only
program has no direct database pool or schema/phone issuer. It still writes its
Storage lease and health logs. Optional backend readiness requests would use the
backend's already reserved pool; enabling that flag or changing source, image,
UID, identity or specification requires fresh qualification. Database-issuer
snapshots retain all original database jobs, with this independently verified job
recorded separately. Terminal failed monitor executions retain their audit status
and failed count; this classification does not assert monitoring health. Keep the
existing failed-execution alert and fallback schedule until genuine healthy
scheduled executions are verified.

Apply only the auth policy subset through the existing reconciler. Preserve
backend and database alerting. A successful configuration plan is not live
execution or notification proof.

Read back only count/status fields when validating health logs. Test delivery
through the existing safe notification proof described above; never inject a
production auth error. These checks establish server availability and test-list
integrity. They do not prove that a real SMS arrives or that a complete phone
sign-in finishes. Keep that separate end-to-end proof on the existing authorized
reviewer fixture, with OTPs, phone numbers and tokens excluded from logs and
screenshots. No new credential-bearing synthetic loop or cron is installed here.
