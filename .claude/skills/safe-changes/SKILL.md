---
name: safe-changes
description: Pre-flight rules that stop a change in this repo from breaking an
  unrelated live feature. Use BEFORE editing any deploy config, secret, IAM
  policy, shared credential, or infrastructure resource, and before deploying.
  Each rule was written after a real incident; add a new one every time a
  mistake is found.
---

# Safe changes

**A change is only finished when the things you did NOT intend to change are proven still working — not assumed.**

---

## What this project actually is (verified live 2026-08-05)

Read this before the rules. Most of the rules only make sense against it.

### Environments

| | prod | UAT | dev |
|---|---|---|---|
| GCP project | `hushh-pda` | `hushh-pda-uat` | `hushh-pda-dev` |
| Project number | 1006304528804 | 745506018753 | 621416509462 |
| Backend service | `consent-protocol` | `consent-protocol` | `consent-protocol` |
| Frontend service | `hushh-webapp` | `hushh-webapp` | `hushh-webapp` |
| App origin | https://one.hushh.ai | https://uat.one.hushh.ai | https://dev.one.hushh.ai |
| API origin | https://api.hushh.ai | https://api.uat.hushh.ai | — |
| Cloud SQL | `hushh-pda:us-central1:hushh-vault-db` | `hushh-pda-uat:us-central1:hushh-uat-pg` | `hushh-pda-dev:us-central1:hushh-dev-pg` |

Region is `us-central1` everywhere. There is no Vercel project and no live
Supabase project — production was cut over from Supabase to Cloud SQL on
2026-07-28 (`scripts/ops/verify_live_environment.py:46`). The
`SUPABASE_MANAGEMENT_TOKEN` / `SUPABASE_PROJECT_REF_PROD` repo secrets are
residue: no workflow references them.

UAT carries three extra Cloud Run services (`hushh-ria-intelligence-api`,
`hushh-adk-playground`, `hushh-adk-openwebui`); prod and dev each carry a
`*-kai-redirect`.

### How it deploys

All three lanes are **manual `workflow_dispatch` only**, and all three refuse to
run unless dispatched from `main`:

- `.github/workflows/deploy-production.yml` — requires an exact green `main` SHA.
- `.github/workflows/deploy-uat.yml` — defaults to latest `origin/main`.
- `.github/workflows/deploy-dev.yml` — deploys `integration/pr-train` by default.
  The workflow *definition* comes from `main`; the *content* comes from the input ref.

Each calls Cloud Build with `deploy/backend.cloudbuild.yaml` and
`deploy/frontend.cloudbuild.yaml`. GitHub authenticates via Workload Identity
Federation as `github-actions-{prod,uat,dev}-deployer@<project>`.

### Runtime identities — these are NOT symmetric

| Service | prod | UAT | dev |
|---|---|---|---|
| `consent-protocol` | `consent-protocol-runtime@hushh-pda` | `consent-protocol-runtime@hushh-pda-uat` | `consent-protocol-runtime@hushh-pda-dev` |
| `hushh-webapp` | `hushh-webapp-runtime@hushh-pda` | `hushh-webapp-runtime@hushh-pda-uat` | **`621416509462-compute@developer.gserviceaccount.com`** |

`hushh-webapp-runtime` **does not exist in `hushh-pda-dev`**. The dev frontend
runs as the default compute service account. Any reasoning of the form "the
frontend runs as `hushh-webapp-runtime`" is false in dev.

### Where secrets live

Google Secret Manager, one copy per project, bound to Cloud Run with
`--set-secrets=NAME=SECRET:latest`. **Every binding uses `:latest`** — adding a
version is a live change to every consumer at its next start.

`roles/secretmanager.secretAccessor` is granted **at the project level**, not
per secret. Per-secret IAM policies are almost all empty. Consequence: a new
secret created in a project is automatically readable by that project's
runtimes — but a **cross-project** reference gets no coverage at all.

GitHub Actions holds only: `GCP_PROJECT_ID`, `GCP_SA_KEY`, `GCP_SA_KEY_UAT`,
`GH_SECURITY_ALERTS_TOKEN`, `SUPABASE_MANAGEMENT_TOKEN`,
`SUPABASE_PROJECT_REF_PROD`, plus `GCP_SA_KEY_DEV` on the `dev` environment.
`.env` files in the repo are examples only (`deploy/.env.*.example`).

### Shared credentials — the dangerous ones

| Shared thing | Consumers | What a careless change breaks |
|---|---|---|
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | backend Cloud Run, frontend Cloud Run, `SupportEmailService` (Gmail send via domain-wide delegation) | login/token verification **and** support email, in one move |
| `BACKEND_URL` (prod) | bound twice into the frontend, as `BACKEND_URL` **and** `DEVELOPER_API_URL` | the app and the developer/MCP surface together |
| `APP_SIGNING_KEY` | every consent token ever issued | rotating invalidates all live tokens |
| `VAULT_DATA_KEY` | every encrypted vault row | rotating makes stored data undecryptable |
| `consent-protocol-runtime@hushh-pda-uat` | `consent-protocol` **and** `hushh-ria-intelligence-api` | one IAM edit hits two UAT services |
| `621416509462-compute@developer.gserviceaccount.com` | dev frontend, `dev-kai-redirect`, Cloud Build | tightening it breaks the dev frontend |
| `projects/hushh-pda/topics/one-email-kyc-uat` | UAT push sub **and** dev push sub — a topic in the **prod** project | One Email KYC in both UAT and dev |

### Remote

`origin` → `https://github.com/hushh-labs/hushh-research.git`
`consent-upstream` → `https://github.com/hushh-labs/consent-protocol.git` (subtree source)

---

## Rules ledger

R1–R7 were carried into this repo from the hushhtech ledger on **2026-08-05**.
The incident line names the original failure class; the blast radius stated is
**this** repo's, verified live on that date. Later rules are this repo's own.

Rules are numbered sequentially and **never renumbered**, so they can be cited
as "R3" in review.

### R1 — Grant the read permission BEFORE binding a secret to a service

**Incident (2026-08-05, carried in — secret bound to a service before its runtime identity could read it).**
The deploy succeeded and the revision then crash-looped on startup, because the
container could not read a secret it was told to mount. Granting access early is
harmless; binding early is fatal. The identity that needs access is the
**consumer's runtime**, not the owner's and not the deployer's.

Here that has two specific shapes:

- **Environments have different identities.** The dev frontend runs as
  `621416509462-compute@developer.gserviceaccount.com`, not
  `hushh-webapp-runtime`. Doing prod and UAT and stopping leaves dev broken.
- **Project-level `secretAccessor` does not cross projects.** A same-project
  secret is already readable by that project's runtimes. A reference to another
  project — like the One Email topic living in `hushh-pda` while dev consumes it
  — has no such cover and must be granted explicitly.

**Rule.** Before adding a secret to a `--set-secrets` list, assert the consuming
runtime identity can read it, in *every* environment the config touches. Grant
with `add-iam-policy-binding` first, bind second.

**Check.**
```bash
for p in hushh-pda hushh-pda-uat hushh-pda-dev; do
  for s in consent-protocol hushh-webapp; do
    sa=$(gcloud run services describe "$s" --project="$p" --region=us-central1 \
      --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null)
    ok=$(gcloud projects get-iam-policy "$p" --flatten='bindings[].members' \
      --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:$sa" \
      --format='value(bindings.members)' 2>/dev/null)
    printf '%-16s %-18s %-62s %s\n' "$p" "$s" "$sa" \
      "$([ -n "$ok" ] && echo READER || echo NO-ACCESS)"
  done
done
```
Every row must end in `READER`.

### R2 — A feature with no consumer does not belong in the deploy pipeline

**Incident (2026-08-05, carried in — a shared credential was wired into the deploy config ahead of the code that would use it).**
It bought nothing and put a live-blast-radius credential into the startup path
of a service that had no use for it. Every secret in `--set-secrets` is a
startup dependency: if it is missing or unreadable, the revision does not boot.

`deploy/backend.cloudbuild.yaml` already encodes this. Optional secrets default
to `""` in `substitutions:` and the `add_secret` helper skips empties — the
mechanism exists precisely so unused credentials stay out of the runtime.

**Rule.** Wire a shared credential in the same change that first reads it, never
earlier. Leave the substitution `""` until then.

**Check.** Ask "what breaks today if I don't?" If nothing, don't. Then confirm
the name you are adding is actually read by code:
```bash
grep -rn "YOUR_SECRET_NAME" --include="*.py" --include="*.ts" --include="*.tsx" \
  consent-protocol hushh-webapp | grep -v node_modules | grep -viE 'test|spec|mock'
```
No non-test hit means no consumer — do not wire it.

### R3 — Only ever ADD access

**Incident (2026-08-05, carried in — a whole-policy write replaced existing readers.)**
`set-iam-policy` writes the policy you hand it and silently drops every binding
you left out. The readers you did not know about are exactly the ones that break.

Two extra traps specific to this repo:

- Every Cloud Run binding is `:latest`. `scripts/ops/upsert_gcp_secret.py` adds a
  **new version**, which becomes `:latest` for every consumer at next start.
  On `FIREBASE_ADMIN_CREDENTIALS_JSON` that is login *and* support email at once.
- `secretAccessor` is project-level, so a project-policy edit is never scoped to
  "just this secret" — it is every secret in the project.

**Rule.** Use `add-iam-policy-binding` only. Never `set-iam-policy`. Never
revoke, delete, disable, or rotate a credential unless asked for that exact
thing in those words.

**Check.** After any secret or IAM work, confirm readers are intact and no
version was added:
```bash
gcloud projects get-iam-policy hushh-pda --flatten='bindings[].members' \
  --filter='bindings.role:roles/secretmanager.secretAccessor' \
  --format='value(bindings.members)' | sort
gcloud secrets versions list FIREBASE_ADMIN_CREDENTIALS_JSON \
  --project=hushh-pda --format='table(name,state,createTime)' --limit=3
```
The member list must still contain all six prod readers; the newest version's
`createTime` must predate your work.

### R4 — Know which system you are in

**Incident (2026-08-05, carried in — a change landed in the wrong one of two similarly named systems.)**
Two things sharing a prefix are routinely completely separate systems with
separate credentials, and the one you did not touch is the one in production.

This repo has four live look-alike pairs:

1. **Three Firebase secrets per project.** `FIREBASE_ADMIN_CREDENTIALS_JSON` is
   the one actually bound to Cloud Run. `FIREBASE_SERVICE_ACCOUNT_JSON` is a
   legacy runtime alias, `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` belongs to the
   auth split. Precedence is documented at
   `consent-protocol/api/utils/firebase_admin.py:1-10`. Editing the wrong one
   changes nothing live — and reads as "done".
2. **Two GCP auth paths from CI.** The three `deploy-*.yml` lanes use Workload
   Identity Federation. `release-ios-appstore.yml`, `ship-ios-testflight.yml`,
   and `provision-wallet-pass-certificate.yml` use the long-lived
   `GCP_SA_KEY_UAT` JSON key. Fixing "CI auth" in one does not fix the other.
3. **Two mail paths.** Per-user Gmail sync uses `GMAIL_OAUTH_*`. Support email
   uses domain-wide delegation on `FIREBASE_ADMIN_CREDENTIALS_JSON`
   (`consent-protocol/hushh_mcp/services/support_email_service.py`). There is no
   SMTP, SendGrid, or Resend anywhere in this repo.
4. **A "UAT" topic in the prod project.** `one-email-kyc-uat` lives in
   `hushh-pda` and fans out to both UAT and dev. UAT alone owns the Gmail watch —
   never schedule watch renewal against dev.

**Rule.** Before editing, state in one sentence which system the change lands in
and which look-alike it does **not** touch. Then prove the other is untouched
with a scoped diff.

**Check.** Confirm which name is actually live, and scope the diff:
```bash
gcloud run services describe consent-protocol --project=hushh-pda --region=us-central1 \
  --format='value(spec.template.spec.containers[0].env.valueFrom.secretKeyRef.name)' \
  | tr ';' '\n' | grep -i firebase
git diff --stat -- <the-path-you-claim-you-did-not-touch>
```
First must print exactly one line. Second must be empty.

### R5 — Prove a revert, don't claim it

**Incident (2026-08-05, carried in — a revert was diffed against the wrong base.)**
Diffing against your own last commit only proves the last step undid itself. The
intermediate state stays in the tree and nobody sees it until it ships.

**Rule.** Diff against the commit **before the work started**, not against your
own last commit. Byte-identical or it isn't reverted.

**Check.**
```bash
git diff --stat <sha-before-work-started>..HEAD -- <path>
```
Empty output, or it is not reverted. To find that base:
```bash
git log --oneline -15 -- <path>
```

### R6 — Verify with the real thing, and report what you did NOT verify

**Incident (2026-08-05, carried in — a green test suite was reported as a working deploy.)**
Unit tests pass against mocks; an accepted `gcloud` call means the API stored
your request, not that the service works. A checklist that only lists passes
implies coverage that does not exist.

**Rule.** Verify against the live surface. Then name what you could not check —
cost, quota, blast radius, anything behind an access boundary — and why.

**Check.**
```bash
python3 scripts/ops/verify_live_environment.py --env production
python3 scripts/ops/verify-env-secrets-parity.py --project hushh-pda
```
Other real probes when relevant:
`scripts/ci/cloudrun-http-health.sh`,
`scripts/ci/assert-cloud-run-runtime-identity.sh <project> <region> <revision> <expected-sa>`,
`scripts/ci/verify-cloudrun-revision-provenance.py`.

Known access boundary: manual Cloud Run **writes** on `hushh-pda-uat` are
blocked by a deliberate IAM deny policy. Reads work. If a UAT change needs a
write, say so — do not route around it.

### R7 — "Give me the URL / link / repo" is a READ request

**Incident (2026-08-05, carried in — a request to locate something was answered by creating something.)**
Creating a durable named resource — repo, project, bucket, service — is the
user's decision, and is often hard to undo with the credentials on hand. A path
inside an existing repo is a valid URL.

**Rule.** Locate what already exists. Do not create to answer a question.

**Check.**
```bash
git remote -v
git ls-remote --heads origin "$(git branch --show-current)"
```
Empty second output means the branch exists only locally — say that plainly
rather than pushing it to make a URL exist.

### R8 — A silent fallback is indistinguishable from success. Make the inert path say so

**Incident (2026-08-06, wiring the Nationwide insurance agent directory).**
The advisor directory's key is mirrored from `hushh-tech-prod` into each lane on
every deploy, so a rotation cannot leave a lane holding a revoked copy. The
mirror reads the source and, if it reads nothing, returns `None` and moves on —
deliberately, so a lane without access does not fail its deploy.

No lane had access. `roles/secretmanager.secretAccessor` on `hushh-tech-prod`
was granted to exactly two identities, neither of them a deploy identity, and
the source secrets carried **no per-secret bindings at all**. So the mirror read
nothing, wrote nothing, and reported nothing, in every environment. The deploy
went green. The fix from the day before had never once executed, and the only
reason UAT still worked was a hand-made copy that happened to be current.

Wiring a second directory the same way would have shipped the same silence.

**Rule.** A "degrade quietly" branch needs a signal on the way out. When a step
can no-op — a missing grant, an absent secret, a skipped mirror — it must print
which branch it took, and something must assert the intended branch was the one
taken. Project-level roles do not cross a project boundary: a cross-project read
is a per-secret grant, and nothing else implies it.

**Check.** Assert the mirror's source is readable by the identity that runs it,
before trusting that the mirror runs:
```bash
for secret in brokercheck-api-key insurance-agents-api-key; do
  echo "== $secret =="
  gcloud secrets get-iam-policy "$secret" --project=hushh-tech-prod \
    --flatten='bindings[].members' --format='value(bindings.members)' 2>/dev/null | sort
done
```
Each must list all three `github-actions-{prod,uat,dev}-deployer` identities. An
empty result means every lane's mirror is a silent no-op. After a deploy, the
sync step's own JSON is the second half of the proof — a secret that mirrored
appears in `synced_secrets` as `(rotated)` or `(unchanged)`; one that was skipped
does not appear at all.

---

## Pre-flight checklist

Before editing deploy config, a secret, an IAM policy, or infrastructure:

1. **Which system?** Name it, and name the look-alike you are not touching — R4.
2. **Who consumes it?** No consumer today → do not wire it — R2.
3. **Which environments?** Prod, UAT, dev have different runtime identities.
   Enumerate all three — R1.
4. **Read access before binding.** Run the R1 check; every row `READER` — R1.
5. **Additive only.** `add-iam-policy-binding`, never `set-iam-policy`; no
   revoke/rotate/disable unless asked in those words — R3.
6. **Shared credential?** Check it against the shared-credentials table above.
   If it appears there, list every feature affected before touching it — R4.

Before deploying:

7. **Right lane.** All three lanes are manual and must be dispatched from `main`.
   Prod needs an exact green `main` SHA.
8. **Live verification.** Run the R6 checks after deploy, not just CI.
9. **Prove the untouched.** Scoped diff on everything you claim not to have
   changed — R4, R5.
10. **Report the gaps.** State what you could not verify and why — R6.

---

### R9 — "Unknown" is not "absent". Never write a durable negative from a partial view

**Incident (2026-08-06, One's connection mail).** A hook reported which
capabilities were connected so the server could mail about new ones, and seeded
silently on the first report so nobody would be told about a link they made
months ago. The seed came from whichever surface reported first. `/one` resolves
without OAuth enrichment, so Gmail reads `unknown` there — not connected. A seed
taken from the dashboard therefore omitted Gmail, and the first `/one/setup`
visit, which does enrich, looked like a brand-new connection. It would have
mailed people about links made months earlier: exactly the mail the seeding rule
existed to prevent.

The bug was not in the mail. It was reading a tri-state (`unknown` /
`not-started` / `completed`) as a boolean and persisting the result.

**Rule.** When a derived view feeds a durable store, carry *what was resolvable*
alongside *what was true*, and let the writer act only on ids it actually
observed. A capability, flag, or connection whose state could not be determined
must never be recorded as false. Check the call sites for which enrichment each
one requests — the abstraction will not tell you.

**Check.** The reporter must filter on resolvability, and the consumer must keep
a separate "seen" record:
```bash
git grep -n 'state !== "unknown"' origin/main -- hushh-webapp/lib/onboarding/use-capability-setup-states.ts
git grep -n "LINKED_SEEN_CLAIM" origin/main -- hushh-webapp/lib/mail/auth-mail-service.ts
```
Both must return lines. If the first is gone, a partial view is being written as
fact again.

### R10 — `latestReadyRevisionName` is not proof that anything is serving

**Incident (2026-08-06, promoting One's mail to production.)** The deploy was
reported verified on the strength of `status.latestReadyRevisionName` matching
the release SHA. That field only says a revision built and became ready. It says
nothing about traffic: a revision can be ready while 100% of requests still go
to the previous one, which is exactly what `--no-traffic` deploys do, and both
UAT and production lanes pass `_CLOUD_RUN_NO_TRAFFIC=true` before a later step
shifts traffic. Reporting "deployed" off the wrong field would have called a
release live while the old code served every user.

Indexing `traffic[0]` is the same mistake wearing a different hat — tagged
revisions occupy the leading slots.

**Rule.** Prove the serving revision by finding the traffic entry with
`percent == 100`, and confirm the domain actually maps to the service you
deployed. Similarly named services and domains routinely belong to other apps.

**Check.**
```bash
gcloud run services describe hushh-webapp --region us-central1 --project hushh-pda --format=json \
| python3 -c "
import json,sys; st=json.load(sys.stdin)['status']
live=next((t for t in st.get('traffic',[]) if t.get('percent')==100), None)
print('serving:', live and live['revisionName'], '| latest:', st.get('latestReadyRevisionName'))
print('IN SYNC' if live and live['revisionName']==st.get('latestReadyRevisionName') else '*** NOT SERVING LATEST ***')"
gcloud beta run domain-mappings list --region us-central1 --project hushh-pda --format="table(metadata.name,spec.routeName)"
```
First must print `IN SYNC`; second must show `one.hushh.ai  hushh-webapp`.

### R11 — A cross-environment endpoint hides in the secret's VALUE, not its name

**Incident (2026-08-06, auditing prod/UAT parity).** Production's
`RIA_INTELLIGENCE_VERIFY_BASE_URL` held
`https://hushh-ria-intelligence-api-f2gsa4kfsq-uc.a.run.app`. That `f2gsa4kfsq`
suffix is **`hushh-pda-uat`** — prod's is `rpphvsc3tq` — and `hushh-pda` had no
RIA service at all. Production RIA verification was calling UAT infrastructure,
with `ria.routes_enabled` live in the prod backend. UAT carries no prod SLO, and
a routine UAT deploy or teardown would have taken the prod path down.

Nothing in the repo could reveal it. `deploy-production.yml` passes only
`_RIA_INTELLIGENCE_VERIFY_BASE_URL_SECRET=RIA_INTELLIGENCE_VERIFY_BASE_URL` — a
secret *name*. Both projects hold a same-named secret, so every name-level parity
check passes while the values point to different projects. Worse, the code's
fallback `DEFAULT_RIA_INTELLIGENCE_API_BASE_URL`
(`consent-protocol/hushh_mcp/services/crd_scrape_proxy_service.py:12`) names a
*third* project's host, so a missing secret degrades to yet another environment
instead of failing.

**Rule.** Environment parity is a property of resolved secret **values**, not
names. For any secret naming a host, assert the host belongs to the project that
consumes it. A same-named secret in both projects proves nothing.

**Check.** Resolve the URL-valued secrets and confirm each host belongs to its own
lane. Cloud Run publishes **two** URL forms and both are legitimate — the hash
(`-rpphvsc3tq-uc.a.run.app`) and the project number
(`-1006304528804.us-central1.run.app`) — so match on either, or prod's own
`BACKEND_URL` reads as foreign:
```bash
for spec in "hushh-pda:rpphvsc3tq:1006304528804" "hushh-pda-uat:f2gsa4kfsq:745506018753"; do
  p="${spec%%:*}"; rest="${spec#*:}"; h="${rest%%:*}"; n="${rest##*:}"
  for s in RIA_INTELLIGENCE_VERIFY_BASE_URL BACKEND_URL FRONTEND_URL APP_FRONTEND_ORIGIN; do
    v=$(gcloud secrets versions access latest --secret="$s" --project="$p" 2>/dev/null)
    case "$v" in
      *run.app*) case "$v" in *"$h"*|*"$n"*) r=OK;; *) r="*** FOREIGN LANE ***";; esac;;
      *) r="(not a run.app host)";;
    esac
    printf '%-16s %-34s %-20s %s\n' "$p" "$s" "$r" "$v"
  done
done
```
No row may read `*** FOREIGN LANE ***`.

### R12 — Prod must never be provisioned smaller than UAT

**Incident (2026-08-06, dispatching a prod backend deploy).** The release died at
"Apply production release migrations" with
`asyncpg.exceptions.TooManyConnectionsError: remaining connection slots are
reserved for non-replication superuser connections`. Production Cloud SQL
(`hushh-vault-db`) runs on **`db-f1-micro`** — 0.6 GB, shared core, Postgres
`max_connections` ≈ 25 — while **UAT** (`hushh-uat-pg`) runs the larger
`db-custom-1-3840`. Prod is the *smaller* machine.

The backend's own deploy substitutions ask for more than that ceiling:
`_DB_POOL_MAX_SIZE=4` + `_DB_SQLALCHEMY_POOL_SIZE=4` per instance across
`_CLOUD_RUN_MAX_INSTANCES=5` is a worst case of 40 connections against ~25. So
production can exhaust its own database under load, and while exhausted **no
release can be applied** — the migration gate cannot get a connection. Capacity
became a deploy-availability problem, not just a latency one.

The saturation is **transient**: run `31055731332` cleared the identical migration
step ~13 minutes later with no infrastructure change. So retry once before
investigating the diff — but a retry is a workaround, not the fix. The headroom
gap is what makes the failure recur.

**Rule.** Prod's tier must be greater than or equal to UAT's for every shared
data store, and the connection ceiling must exceed worst-case pool demand
(`max_instances × (pool + overflow)`). Raising a tier or setting
`max_connections` restarts the instance — that is user-facing downtime, so it is
scheduled with the owner, never applied mid-task.

**Check.**
```bash
for spec in hushh-pda:hushh-vault-db hushh-pda-uat:hushh-uat-pg; do
  p="${spec%%:*}"; i="${spec##*:}"
  printf '%-16s %-18s %s\n' "$p" "$i" \
    "$(gcloud sql instances describe "$i" --project "$p" \
        --format='value(settings.tier,settings.availabilityType)' 2>/dev/null)"
done
grep -o '_CLOUD_RUN_MAX_INSTANCES=[0-9]*\|_DB_SQLALCHEMY_POOL_SIZE=[0-9]*\|_DB_POOL_MAX_SIZE=[0-9]*' \
  .github/workflows/deploy-production.yml | sort -u
```
The prod row must not be a smaller tier than the UAT row, and
`max_instances × (pool sizes)` must stay under the tier's `max_connections`.

### R13 — Deploying one lane is half a release; parity is a property of deployed SHAs

**Incident (2026-08-06, syncing prod and UAT).** Every lane is manual
`workflow_dispatch` and **nothing auto-deploys on merge**, so each merge leaves
both environments stale until somebody dispatches — twice. Drift is the default
state, not the exception.

It compounds because the dispatcher passes an explicit `sha`. Prod run
`31055731332` was dispatched with `sha=e0715daab` while `main` had already moved
to `025ceb964` and UAT was serving it. The run went green and *looked* like a
release, but it shipped prod to a SHA two commits behind UAT. A green workflow is
not evidence of parity — it only proves the SHA you named was deployed.

Reading the workflow's own summary will not catch this either:
`scripts/ci/resolve-deploy-scope.py:134` pools the backend and frontend diffs into
one `candidate_files` list before classifying, so its per-lane "changed files"
output includes files from the other lane's range. It does not affect the deploy
decision, which reads only the booleans — but do not quote those lists as a diff.

**Rule.** Parity is the **deployed image tag** on all four surfaces, read from
Cloud Run, compared against `origin/main`. Never infer it from a workflow
conclusion, a PR merge, or a dispatch. After deploying either lane, re-read all
four. And never dispatch a second prod deploy while one is in flight — the
concurrency group is keyed on the input SHA
(`deploy-production-${{ github.event.inputs.sha }}`), so two different SHAs run
**concurrently** and race the traffic shift.

**Check.**
```bash
cd ~/Desktop/husshresearch && git fetch origin --prune --quiet
MAIN=$(git rev-parse origin/main); echo "main: ${MAIN:0:9}"
for spec in hushh-pda:consent-protocol hushh-pda-uat:consent-protocol \
            hushh-pda:hushh-webapp    hushh-pda-uat:hushh-webapp; do
  p="${spec%%:*}"; svc="${spec##*:}"
  tag=$(gcloud run services describe "$svc" --project "$p" --region us-central1 \
          --format="value(spec.template.spec.containers[0].image)" 2>/dev/null)
  sha="${tag##*:}"; sha="${sha#*-}"
  [ "$sha" = "$MAIN" ] && r=current || r="*** $(git rev-list --count "$sha".."$MAIN" 2>/dev/null) behind ***"
  printf '%-14s %-16s %-11s %s\n' "$p" "$svc" "${sha:0:9}" "$r"
done
```
All four rows must read `current`. Any other row means the release is unfinished,
whatever the workflow said.

### R14 — A bug fixed where it was reported still lives where its pattern was copied

**Incident (2026-08-06, making the Connect page's Call buttons dial from India).**
The adviser detail surface built its call link as
`` `tel:${card.phone.replace(/[^\d+]/g, "")}` ``. BrokerCheck serves bare
ten-digit US numbers, so the link dialed fine from a US-region device and
misdialed from everywhere else — invisible to US testing, broken for the founder,
who tests from India. The reported surface got an E.164 helper. The identical
line, character for character, sat in the insurance-agency surface one file away —
same page, same US-only data provenance (Nationwide), same failure — and the fix
as scoped would have shipped the Connect page half-fixed for the exact person who
reported it. Only an independent sweep for the idiom caught it before merge
(PR #4894).

**Rule.** A copied idiom is one defect with many addresses. Before calling a fix
complete, grep for the idiom repo-wide, route every instance through one shared
helper (here `usTelHref` — `hushh-webapp/lib/services/us-tel-href.ts`), and
justify by name each site deliberately left alone: wallet-card phones are
user-entered international numbers that must not be forced to `+1`, and SOS
emergency short codes must never gain a country code at all.

**Check.**
```bash
git grep -nE 'tel:\$\{' origin/main -- 'hushh-webapp' \
  | grep -vE 'us-tel-href|wallet-card/public-card-view|one-location/redesign/sos-panel|__tests__|\.test\.'
git grep -n 'usTelHref(' origin/main -- hushh-webapp/components/connect
```
First must be empty — any hit is a raw `tel:` template that skipped the helper.
Second must list both directory surfaces (`advisor-detail-surface.tsx` and
`insurance-agent-detail-surface.tsx`).

### R15 — An overlay's z-index is meaningless until you name what it must sit above

**Incident (2026-08-16, the Location onboarding "save a place" sheet).**
The sheet's scrim was `z-[559]` with `bg-black/45 backdrop-blur-[6px]` — correct
CSS, correct intent, and completely invisible. Location onboarding renders as a
full-screen **opaque** takeover at `z-[560]`, so the dim and the blur were painted
underneath it. The sheet's own content tied at `z-[560]` and won on portal order,
which is why it appeared at all: a white rectangle pasted onto a fully lit screen
with no separation. Reported as "it's looking like a patch — background should be
blur", which reads as a missing blur and is actually a buried one. Adding more
blur would have changed nothing.

**Rule.** A modal layered over a takeover, drawer, or any other full-screen
surface must be checked against **that surface's** z-index, not against the app's
default chrome. Before setting one, grep the z-indexes it must clear and the ones
it must stay under, and write both into the comment. Here: above the onboarding
takeover at 560, below the shared sheet/drawer layer at 711.

**Check.**
```bash
git grep -nE 'fixed inset-0 z-\[[0-9]{3}\]' -- hushh-webapp/components hushh-webapp/app \
  | grep -E 'bg-(white|\[#)' 
git grep -nE 'overlayClassName="z-\[([0-9]{3})\]' -- hushh-webapp/components
```
Every overlay in the second list must outrank every opaque full-screen layer in
the first that it can appear over. The Location pair is 600/601 vs 560.

### R16 — A Tailwind arbitrary value does not always beat the class it is meant to replace

**Incident (2026-08-16, giving that same sheet a real elevation.)**
`cn(...)` merged `shadow-[var(--app-card-shadow-feature)]` from the dialog
primitive with `shadow-[0_24px_60px_-12px_rgba(16,24,40,0.35),...]` from the
caller. tailwind-merge kept **both** classes on the element — it cannot compare
two opaque arbitrary values — and the base one won on stylesheet order. Typecheck,
lint and the unit tests were all green; the class was present in the DOM; the
shadow simply never rendered. Only reading `getComputedStyle(...).boxShadow` in a
real browser exposed it.

**Rule.** When an arbitrary-value utility overrides another arbitrary-value
utility of the same property, assert the **computed** style, not the class list.
If it loses, mark it `!`. This applies to any comma-bearing arbitrary value
(`shadow-[…]`, `transition-[…]`, `bg-[image:…]`, `grid-template-columns-[…]`).

**Check.**
```bash
# Every shared primitive that ships its own arbitrary shadow.
git grep -lE 'shadow-\[' -- hushh-webapp/components/ui
# Every caller trying to override one of those from the outside.
git grep -nE 'shadow-\[0_' -- hushh-webapp/components hushh-webapp/app \
  | grep -v 'components/ui/' | grep -v '!shadow-'
```
The first lists the base layers (`dialog`, `sheet`, `alert-dialog`, `card`,
`tabs`, `sidebar`). Any hit in the second is a caller whose shadow may be silently
losing to one of them — read `getComputedStyle(el).boxShadow` in a browser before
believing it rendered.

### R17 — `git stash` is shared by every worktree; never use it to take a baseline

**Incident (2026-08-16, proving a test failure was pre-existing on main.)**
The plan was ordinary: `git stash -u`, run the suite at the base, `git stash
pop`. But there was nothing local to stash — the work was already committed — so
`stash -u` created no entry, and `pop` therefore popped **another agent's**
wallet-card WIP into this worktree. It conflicted across 17 files. Nothing was
lost (their two entries survived, because a conflicting pop does not drop the
entry, and the real work was in a commit), but the tree had to be reset and the
"baseline" proved nothing.

The stash is a property of the **repository**, not the worktree or the branch.
In a checkout several agents share, it is someone else's inbox.

**Rule.** To compare against a base, add a throwaway worktree at that commit and
run there. Never `git stash` in this repo — not to park work, not to peek at
main. Commit to a branch instead; a commit is yours, a stash entry is everyone's.

**Check.**
```bash
# Anything here belongs to somebody. If it is non-empty, do not pop.
git stash list
# The safe baseline instead:
git worktree add /tmp/base-$$ origin/main && \
  echo "run the check in /tmp/base-$$, then: git worktree remove /tmp/base-$$ --force"
```

### R18 — A width that "looks fine" is unmeasured; product titles need a number, not a glance

**Incident (2026-08-16, adding a third tab to Connect.)** Three tabs plus the
strip's stock 16px option padding left `Around you` 77px of the 80px it needs on
a 375px screen, so it rendered `Around yo…`. Typecheck, lint, the full unit
suite and every governance verifier were green: jsdom performs no layout, so a
`truncate` class is invisible to it, and there was no horizontal scrollbar to
notice. Measuring the real class strings against the built stylesheet in headless
Chromium found it in seconds — and the same run found `Insurance` had been
shipping as `Insuranc…` at 320px in the already-released *Around you* strip.

**Rule.** A product-owned title may never resolve to an ellipsis. Adding an
option to any segmented/tab strip, or lengthening a label, requires a measured
width at 320-430px before it ships. Unbounded user content may truncate; copy we
wrote may not.

**Check.**
```bash
# Needs a build first — it measures the real stylesheet, not a copy of it.
cd hushh-webapp && npx playwright test e2e/tab-title-integrity.spec.ts \
  --project=chromium --reporter=line
```
Add every new strip's labels to `TAB_STRIPS` in that spec; a strip that is not
listed is simply unmeasured.

### R19 — A CSS rule that "obviously" wins may not. Read the computed value off the running app

**Incident (2026-08-16, chasing a "header overlaying" report on the Feed).**
`hushh-webapp/app/globals.css` gates the top chrome's background on an attribute:
`html:not([data-ambient-chrome-primed="true"]) .ambient-chrome-mask { --ambient-chrome-wash: 0% }`.
Every supporting fact checked out — `grep -rn data-ambient-chrome-primed` returns
that line and nothing else (no code sets it), the top bar element really does
carry the bare `ambient-chrome-mask` class, and the gate's specificity (0,2,1)
really does beat `.ambient-chrome-mask--top` (0,1,0). The conclusion drawn —
"the top bar is permanently transparent, that is the overlap report" — was still
wrong. Signed into UAT and measured, `--ambient-chrome-wash` computes to **94%**
and the bar paints solidly; cascade layers decide it, not specificity. A
subagent RCA lane reached the same wrong answer at "high" confidence, so reader
agreement was not evidence either. The change was written and would have shipped
a global-stylesheet edit — every screen in the app — for a defect that does not
exist.

**Rule.** Never edit `globals.css`, a theme token, or any global chrome rule on
the strength of reading the cascade. Sign in and read the value back off the
running app first. If the measurement contradicts the code reading, the
measurement wins — revert, do not rationalise.

**Check.** Credentials are in Secret Manager; the login page only auto-signs-in
when the native test bridge is installed as an init script before the first
`goto`. From `hushh-webapp/` (so the `playwright` import resolves):
```bash
export REVIEWER_UID=$(gcloud secrets versions access latest --secret=REVIEWER_UID --project=hushh-pda-uat)
export REVIEWER_VAULT_PASSPHRASE=$(gcloud secrets versions access latest --secret=REVIEWER_VAULT_PASSPHRASE --project=hushh-pda-uat)
```
```js
await page.addInitScript(({ expectedUserId, vaultPassphrase }) => {
  window.__HUSHH_NATIVE_TEST__ = { ...(window.__HUSHH_NATIVE_TEST__ || {}),
    enabled: true, autoReviewerLogin: true, expectedUserId, vaultPassphrase };
}, { expectedUserId: process.env.REVIEWER_UID, vaultPassphrase: process.env.REVIEWER_VAULT_PASSPHRASE });
// /login?redirect=%2Fria -> "Continue as reviewer" -> #unlock-passphrase -> "Unlock with passphrase"
getComputedStyle(document.querySelector(".ambient-chrome-mask--top")).getPropertyValue("--ambient-chrome-wash");
```
Must print `94%`. Anything you believe about a global rule that you have not
read back this way is a hypothesis, not a finding.

---

### R20 — A word-boundary regex built from `\p{L}\p{N}` silently shreds every Indic name

**Incident (2026-08-16, making one-letter people search work — PR #5317, fixed
in #5325).** A new people-search helper split names on `/[^\p{L}\p{N}]+/u` to
find word beginnings, so typing `n` would surface "Neelesh" rather than every
name merely containing an "n". It worked perfectly in Latin and shipped green:
13 unit tests, typecheck, lint, a full-suite baseline comparison, and a verified
UAT deploy. A matra is a combining mark (`\p{M}`) — neither a letter nor a
digit — so the regex treated every one as a **word separator**. `झुम्मा` became
`["झ","म","म",""]` and `नीलेश` became `["न","ल","श"]`: every syllable read as a
separate word. "Begins a word" therefore meant nothing for exactly the names
this product's users have. Because a one-character query keeps only
word-beginning matches, it could **drop** a real match — `म` over `[सुमन, कमल]`
returned `सुमन` alone. Nothing caught it because every fixture was Latin.

**Rule.** Any regex that splits or tokenizes **user-supplied names or text**
must include `\p{M}` with the `u` flag — `/[^\p{L}\p{N}\p{M}]+/u`, never
`/[^\p{L}\p{N}]+/u`. Combining marks belong *inside* a word, never between
words. Add at least one Devanagari fixture: a Latin-only fixture set cannot fail
this. (`normalizeSpokenName` in `app/one/location/page.tsx` already had this
right — copy it rather than re-deriving it.)

Scope this to regexes that **split**. A deliberately lossy comparison key may
strip marks on purpose — `comparable()` in
`lib/one-location/saved-location-address.ts` strips spaces and punctuation too,
so dropping marks matches its intent — and a postal-code validator is fine
without `\p{M}` because Devanagari digits are already `\p{N}` (`११००११`
validates). Both are expected hits below; neither is a bug.

**Check.**
```bash
cd hushh-webapp
# Boundary regexes missing \p{M}. Expect only the two known-benign hits in
# saved-location-address.ts; anything else that SPLITS a name is the bug.
grep -rnE '\\p\{L\}\\p\{N\}\]' --include='*.ts' --include='*.tsx' lib components app \
  | grep -v '\\p{M}'

# Prove the difference on a real name before trusting either form:
node -e '
const bad=/[^\p{L}\p{N}]+/u, good=/[^\p{L}\p{N}\p{M}]+/u;
for (const n of ["झुम्मा","नीलेश","सुमन"])
  console.log(n, JSON.stringify(n.split(bad)), "->", JSON.stringify(n.split(good)));'
# bad splits each name into single consonants; good keeps it whole.
```

---


### R21 — The top shell paints lower than it reserves. Clear the fade, not the reserve

**Incident (2026-08-17, "header overlay ho rha hai" reported across screens.)**
The fixed top shell is solid down to `--top-shell-reserved-height` and then
dissolves over `--top-fade-active`. `--top-shell-mask-visible-height` is the sum,
and that is the header's real bottom edge. Standard routes are cleared
structurally — `app/providers.tsx` renders `[data-app-shell-top-spacer]` inside
the scroll root, so a page cannot start under the header even if it forgets to
ask. A `flow` route gets **no spacer at all**, and
`resolveSignedInShellContentOffset` forced its `--page-top-start` to `0px`. So
`--app-fullscreen-flow-content-offset` came out exactly equal to the reserved
height and every fullscreen flow began its first line 22px *inside* the
dissolve. Measured on UAT: `/ria/claim` content top 76px against a header
painting to 82px, identically at 390px and 1024px.

It then survived the obvious fix. Two RIA screens hard-set that same variable
back to `var(--top-shell-reserved-height)` in a local `style` prop, so they kept
the old geometry after the shared token was corrected — which is exactly what
"it's fixed on some pages but not others" looks like from the outside.

**Rule.** Clearance is measured against the mask's **visible** height, never its
reserved height. A `flow` route has no shell spacer, so its page must consume
`--app-fullscreen-flow-content-offset` (through `FullscreenFlowShell`) or
`--top-content-pad`, and no page may redefine either token down to the bare
reserved height. Prove it in a browser: JSDOM performs no layout, so a green unit
suite says nothing about whether a header covers text.

**Check.**
```bash
cd ~/Desktop/husshresearch/hushh-webapp
npx vitest run __tests__/navigation/fullscreen-flow-top-clearance.contract.test.ts
npm run test:layout-contracts
```
The first fails closed for any `flow` route that does not name the file owning
its clearance. The second measures the pixels at eight widths in Chromium and in
WebKit — WebKit being the engine the iOS app actually runs.

### R22 — A fixture that inherits `:root` is measuring a different app than the one that ships

**Incident (2026-08-17, extending the R21 contract to the sticky section rail.)**
The new browser test passed with the bug deliberately reintroduced. The fixture
built the shell from `resolveSignedInShellContentOffset` and let everything else
inherit from `app/globals.css`, which looked faithful and was not: CSS
substitutes a custom property using the values present where it is **declared**,
so `:root`'s `--top-shell-mask-visible-height` bakes in `:root`'s own
`--top-fade-active` (8px) and keeps that computed value as it inherits. The real
route shell re-declares the whole derived block, resolving the same token
against 22px. The fixture's header was therefore **14px shorter** than the
shipped one — and a rail pinned 6px too high cleared it comfortably.

A passing new test is not evidence. Only the mutation is.

**Rule.** When a test reproduces a runtime surface outside the app, it must
build it from the **same exported function** the app uses, never from a
hand-picked subset of tokens. If a value is re-declared at a scope below
`:root`, inheriting it instead of re-declaring it silently changes the number.
And every new contract test gets mutation-checked against the bug it claims to
catch, before it is committed — reintroduce the defect, watch it go red, restore.

**Check.**
```bash
cd ~/Desktop/husshresearch/hushh-webapp
# The fixture and the shell must read one source; this returns two call sites.
grep -rn "resolveTopShellGeometryStyle" app components e2e
```
One call site means something is hand-copying the geometry again.

### R23 — The `:root` substitution trap is in the shipped CSS too, not only in fixtures

**Incident (2026-08-17, the empty band under every screen — PR #5390.)** R22
caught this pattern in a *test fixture*. It is also in `app/globals.css`:

```css
:root {
  --app-bottom-content-clearance: calc(
    var(--bottom-chrome-stack-height, var(--app-bottom-inset)) + 24px
  );
}
```

`--bottom-chrome-stack-height` is set on the route shell in `app/providers.tsx`
and **never on `:root`**, so this token froze the `--app-bottom-inset` fallback
and inherited that computed value everywhere — 112px measured, against the 132px
`AppBottomShell` actually publishes. `.app-page-shell` then applied it as a
second bottom reserve on top of the scroll root's real one, and
`.profile-home-screen` a third. Result: a wide empty band under the last card on
every screen in the app, and enough manufactured scroll travel that short pages
scrolled their content up under the top bar.

Nobody spotted it for months because the number is wrong by a constant. It does
not look like a bug; it looks like a slightly generous gap.

**Rule.** A token declared at `:root` may only read other tokens that are also
defined at `:root`. If it needs a value the route shell owns, declare it at the
shell too (as `resolveTopShellGeometryStyle` does) — or do the `calc()` at the
point of use. And before adding any clearance, find out who already reserves that
edge: in this app the scroll root owns the fixed bottom chrome, and its own
comment says so.

**Check.** Every `:root` token that reads a shell-scoped var, listed:

```bash
cd ~/Desktop/husshresearch/hushh-webapp
# Tokens providers.tsx declares on the route shell, not on :root.
python3 - <<'EOF'
import re
shell = set(re.findall(r'"(--[a-z0-9-]+)":', open('app/providers.tsx').read()))
css = open('app/globals.css').read()
root = css.split('}')[0] if css.startswith(':root') else re.search(r':root\s*{(.*?)\n}', css, re.S).group(1)
hits = sorted({v for v in re.findall(r'var\((--[a-z0-9-]+)', root) if v in shell})
print('\n'.join(hits) or 'clean')
EOF
```
Anything printed is a token to check by hand: it is frozen to its `:root`
fallback **unless** the shell also re-declares every token derived from it (the
top-shell block does; the bottom one did not). Read the computed value back in a
browser before believing either answer, then either move the declaration or move
the `calc()`. And grep for other places applying the same clearance — this one
was being added four times: `.app-page-shell`, `.profile-home-screen`,
`profile-stack-navigator.tsx`, and the scroll root that legitimately owns it.

## Adding a rule

Every mistake found becomes a rule. Fix the **cause**, not the symptom, then add
the rule so it cannot recur. When the user says "add that to the skill", that
means a new numbered rule here.

Rules are numbered sequentially and **never renumbered** — R3 must still mean R3
in six months, so it can be cited in review. Append; do not reorder or reuse a
retired number.

Template:

```markdown
### R<n> — <imperative one-liner>
**Incident (<date>, <what was being built>).** What went wrong and what it
would have broken.
**Rule.** The generalisation.
**Check.** The exact command or diff that catches it next time.
```

The Check line must be a command that **runs in this repo** and returns
something meaningful. Run it before committing the rule. A rule with a command
that doesn't work here is worse than no rule.
