# Personal World Model runbook


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Operator guide for the Personal World Model (PWM): how a research run moves
through the system, where its evidence lands in Cloud Logging, how to read the
three states that page people (provider 403, owner 429, stuck pending), what
the owner sees meanwhile, how to ship frontend-only during a provider outage,
and the alert to create. Product and engineering context lives in
[personal-world-model.md](../one/personal-world-model.md).

Nothing here reads owner content. Lifecycle logs carry codes and counts only;
the sealed job state (draft, sources, identity) is only readable with the
owner's request-scoped chat key and never appears in logs.

UAT uses Azure GPT-5 mini for planning and structured reporting, with Tavily
Search after explicit Azure/Tavily consent. The keyless UAT search trial has a
shared rate limit; a 429 must fail visibly rather than trigger a paid fallback.
Findings remain in the owner-key encrypted review inbox until explicit discard
or account deletion. Legacy Google/Bing checkpoints keep 24-hour cleanup. Production remains on Vertex. The Google-specific
provider refusal and project checks below apply to Vertex; first identify the
serving provider when investigating UAT.

All Azure stages share the manifest-owned PWM instruction. Discovery uses medium
search context with a 6,000-token output ceiling and at most two tool calls per
invocation; final reporting has a 16,384-token ceiling. These are ceilings, not
required output lengths. Bing can bill several internal requests per invocation;
the durable ledger records its actual returned count. The planner sees admitted
public source titles/URLs and candidate labels, with no owner review decisions.
The strict Responses JSON schema wraps internal results without changing the
public HTTP/SSE shapes. Host Pydantic and receipt validation still apply.

The no-traffic UAT candidate probe uses the real gateway and primary deployment
with the production assessment, finding, planner and report schemas and six
synthetic attribution cases, including degree/repository overclaims, merge
authorship, namesakes and correctly attributed self-reports. Its secret-free job
uses disposable process-only settings to load the runtime contracts; those keys
cannot validate application tokens or decrypt owner records. It makes no Bing
query and reads no owner records. Its policy hash binds the result to the
image's instruction and evidence contract. It checks decisions and receipt semantics,
while allowing schema-valid prose paraphrases. Failure diagnostics contain only
authored case IDs or contract field names. This is a bounded semantic regression,
not proof of arbitrary-person research accuracy. Citation receipts remain
view-only research, without independently fetched source bodies or automatic
identity verification. Check the exact release receipt before claiming readiness.

## Quick status

```bash
python3 scripts/ops/pwm_uat_status.py --env uat --hours 2
python3 scripts/ops/pwm_uat_status.py --env uat --hours 6 --json
```

[`scripts/ops/pwm_uat_status.py`](../../../scripts/ops/pwm_uat_status.py) is
read-only and uses the operator's existing `gcloud` auth. It prints the serving
backend revision and its `GENAI_GOOGLE_CLOUD_PROJECT`, the run lifecycle
counts, `/ensure` and `/jobs` HTTP status counts (429s included), provider 403
counts, a collapsed timeline, and one verdict line:

| Verdict | Meaning |
| --- | --- |
| `Research can run` | Runs started or finished in the window and nothing newer blocks them. |
| `Provider blocked (403) since <time>` | The managed model refused with 403 and no run has succeeded since. Billing or project access, not product code. |
| `Owner is rate limited` | `/ensure` or `/jobs` answered 429 after the last run start; the owner's tabs are asking too often. |
| `Idle` | No PWM lifecycle lines in the window. |

## How a run moves

1. **Sign in and unlock.** The pane (Profile -> Personal World Model) and the
   app shell both mount `useWorldModelResearch`; one tab per owner wins a Web
   Lock and becomes the driver (`lib/services/world-model-research-service.ts`).
2. **Ensure.** The driver POSTs `/api/one/world-model/ensure` at most once a
   minute. `WorldModelJobs.ensure` enrols a first-time owner (research is on by
   default once setup disclosed it), then logs one `one.pwm_decision op=ensure`
   line: `refused`, `recently_prepared` (a run finished within 7 days),
   `saved`, or `start` / `enrolled_start`.
3. **Start.** `start` logs `one.pwm_decision op=start` with the outcome:
   `started` or `resumed` (a lease was taken), `reused` / `reused_pending`
   (a usable draft or a live lease already exists), `cooldown` (60 s after a
   failure), `budget_starts` (hourly start budget spent), `capacity_busy`,
   `lost_race`, `changed`, `refused`. `starts_hour`, `searches_used` and
   `model_calls_used` on every decision line say how much of the draft's budget
   is gone (UAT Azure: 8 searches, 16 model calls; Vertex: 32 and 128).
4. **Slices and checkpoints.** The worker logs `one.pwm_started` and runs the
   specialist with Google Search for one slice (240 s, job timeout 270 s,
   lease 300 s). Every attempt is charged to the sealed state before the
   provider call and progress is checkpointed through `on_progress`, so a
   slice that stops mid-way keeps its searches and sources. When a slice ends
   with work left, `GET /jobs` answers `pending` with `restart_required=true`;
   the next `/ensure` resumes it (`resumed=True` on the started line).
5. **Finish.** `one.pwm_finished status=<offered|low_confidence|unavailable|
   insufficient_identity|disabled>` closes the run with the searches and model
   calls spent in that slice. A failure also logs `one.pwm_failed` first, with
   `stage`, exception class names, `provider_code` and `provider_status`.
6. **Feed and email.** A committed draft wakes the notification worker; Cloud
   Scheduler job `pwm-notifications-uat` POSTs
   `/api/internal/pwm-notifications/drain` every minute, which writes the Feed
   item and sends the content-free ready email. `pwm.email_failed` and
   `pwm.notification_drain_failed` are the only warnings that path logs.

Revisions older than the `one.pwm_` prefix log the same runs as
`one.magic_discovery_started|finished|failed` without `provider_code`; the
status script reads both and marks the older form.

## Where the logs are

| What | Where | Filter |
| --- | --- | --- |
| Run lifecycle | Cloud Run service `consent-protocol`, project `hushh-pda-uat` (production: `hushh-pda`), region `us-central1` | `textPayload:"one.pwm_"` |
| Provider failures | same service, loggers `google_adk.*` after the redaction filter | `textPayload:"SDK failure"` |
| HTTP status of `/ensure`, `/jobs`, `/preferences` | `run.googleapis.com/requests` on `consent-protocol` and `hushh-webapp` | `httpRequest.requestUrl:"/world-model/"` |
| Notification drain | `consent-protocol` request logs | `httpRequest.requestUrl:"/pwm-notifications/drain"` |

Exact queries (add `--freshness=2h` or any window; `--limit` defaults to 20):

```bash
# Run lifecycle, newest first
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="consent-protocol" AND textPayload:"one.pwm_"' \
  --project hushh-pda-uat --freshness=2h --limit=50 --format='value(timestamp,severity,textPayload)'

# Provider refusals (403) and quota (429) from the managed model
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="consent-protocol" AND textPayload:"SDK failure" AND (textPayload:"status_code=403" OR textPayload:"status_code=429")' \
  --project hushh-pda-uat --freshness=2h --limit=20 --format='value(timestamp,textPayload)'

# Owner-side rate limiting and other HTTP errors on the PWM routes
gcloud logging read 'resource.type="cloud_run_revision" AND logName:"requests" AND httpRequest.requestUrl:"/world-model/" AND httpRequest.status>=400' \
  --project hushh-pda-uat --freshness=2h --limit=50 --format='value(timestamp,resource.labels.service_name,httpRequest.requestMethod,httpRequest.requestUrl,httpRequest.status)'

# Serving revision and the model project it talks to
gcloud run services describe consent-protocol --project hushh-pda-uat --region us-central1 \
  --format='value(status.traffic,spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -E 'revisionName|percent|GENAI_GOOGLE_CLOUD_PROJECT|HUSHH_GENAI_AUTH_MODE'
```

The `job=` value on lifecycle lines is redacted at the handler; there is no
owner reference in these lines by design. To follow one owner, use the time
window around their `/ensure` request instead.

## Reading the three states

**Provider 403.** `one.pwm_failed ... provider_code=403 provider_status=PERMISSION_DENIED`
(older revisions: `cause_type=ClientError` plus adjacent
`SDK failure type=ClientError status_code=403 status=PERMISSION_DENIED` lines)
and `one.pwm_finished status=unavailable`. The model project named by
`GENAI_GOOGLE_CLOUD_PROJECT` refuses the service account: billing suspended,
project switched, or Vertex AI API/IAM missing. Nothing in this repo fixes it;
restore the project and confirm with the status script. Until then every
`/ensure` burns one hourly start, so expect `decision=budget_starts` and
`decision=cooldown` lines once the owner's tab keeps retrying.

**Owner 429.** `POST /ensure` is limited to 60/hour and `GET /jobs` to
30/minute per owner (`api/routes/one/world_model.py`). The driver tab already
backs off on 429; more than a handful in an hour means several driving tabs or
an old frontend. Nothing is lost: the sealed state and its budget stay as they
were, and the next admitted `/ensure` resumes.

**Pending for long.** `GET /jobs` answering `pending` for more than one slice
(about five minutes) without a new `one.pwm_started` line requires checking
the paired `/ensure` response. A pending lease may have lost its worker when
an instance was replaced mid-slice; it expires after 300 s and `/ensure`
reclaims it (`decision=resumed`). `one.pwm_checkpoint_unavailable` means the
terminal write failed; the draft is discarded and the next `/ensure` starts
clean.
If repeated `POST /ensure` calls instead return fast 503s and no new
`one.pwm_started` appears, inspect the service failure before blaming the
provider. A Vertex checkpoint's 160-slot ledger cannot be read as Azure's
24-slot ledger. The owner-authorized `/ensure` path migrates a recognized old
provider checkpoint to a fresh provider ledger, retaining the three-starts-per-
hour counter. Never clear the encrypted row manually to make a retry work.

## What the owner sees

| Backend state | Pane |
| --- | --- |
| `pending` / `paused` | "Preparing your model" with checkpoint progress when present. After five minutes without a new checkpoint, the pane says research has not updated and offers Try again. |
| `offered` with undecided details | "Ready to review" and the count to confirm; Yes / No / Edit / Remove per detail; an uncertain person is shown as a possible match, never blank. |
| `offered`, all decided | "Up to date". |
| `saved` | "Nothing to review right now"; the next check is days away. |
| `unavailable` (403 included) | "Couldn't finish preparing your model." with Retry. The owner cannot tell a provider outage from a transient error, so tell them when it is the former. |
| `insufficient_identity` | Asks for a name and a verified email or phone. |
| `not_ready` / `disabled` / `consent_required` | Finish setup / not available / research is off with a turn-on action. |

## Frontend-only deploy during a provider outage

A backend deploy runs a live-model readiness probe; while the model project
answers 403 that probe fails and the workflow rolls back both halves. Ship
pane and client changes alone:

```bash
gh workflow run deploy-uat.yml -f scope=frontend -f sha=<green main sha>
gh run list --workflow deploy-uat.yml --limit 3 --json databaseId,status,conclusion,headSha,url
python3 .agents/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py --project hushh-pda-uat --service hushh-webapp --format text
```

Use `scope=frontend` only when the delta since the deployed backend SHA is
frontend-only (see `.agents/skills/uat-scoped-deploy/`); queue the backend
half for after the model project is restored. Never deploy backend changes
to work around the probe.

## Alert to create

Page on provider refusals as soon as a run reports one. Create the policy
with the Monitoring API from a file; do not run this during an incident
review, create it once per project and reuse it:

```bash
cat > /tmp/pwm-provider-403.json <<'JSON'
{
  "displayName": "PWM provider 403 (UAT)",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "one.pwm_failed provider_code=403",
      "conditionMatchedLog": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"consent-protocol\" AND severity>=WARNING AND textPayload:\"one.pwm_failed\" AND textPayload:\"provider_code=403\""
      }
    }
  ],
  "alertStrategy": {
    "notificationRateLimit": { "period": "3600s" },
    "autoClose": "1800s"
  },
  "notificationChannels": ["projects/hushh-pda-uat/notificationChannels/<channel-id>"],
  "documentation": {
    "content": "The managed model refused a Personal World Model run with 403. Check billing and IAM on the project named by GENAI_GOOGLE_CLOUD_PROJECT, then run scripts/ops/pwm_uat_status.py --env uat --hours 2. Runbook: docs/reference/operations/pwm-runbook.md",
    "mimeType": "text/markdown"
  }
}
JSON
gcloud alpha monitoring policies create --project hushh-pda-uat --policy-from-file=/tmp/pwm-provider-403.json
```

Find the channel id with
`gcloud alpha monitoring channels list --project hushh-pda-uat --format='value(name,displayName)'`.
For production, swap the project and the display name.
