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

### R24 — A dependency pinned to a private index cannot travel through `requirements.txt`

**Incident (2026-09-07, adding sentence-transformers for semantic retrieval).** To
keep ~2.5 GB of nvidia CUDA wheels out of a GPU-less Cloud Run image, torch was
pinned to PyTorch's CPU index in `pyproject.toml` with `[[tool.uv.index]]` +
`[tool.uv.sources]`. `uv lock` then recorded `torch==2.14.0+cpu`, and
`uv export` wrote that pin into `requirements.txt` **without any index
directive** — it does not carry index configuration into the generated file. A
`+cpu` local version exists only on PyTorch's index, never on PyPI, so the
Docker build could not resolve it. UAT failed at "Build and pin backend image",
before deploying anything.

It cannot be repaired at the install command either. `--extra-index-url` fails
because that index mirrors much of PyPI and uv's first-index strategy then
refuses the PyPI versions it shadows. `[tool.uv.sources]` and `explicit = true`
apply in uv **project** mode, not in pip mode against a requirements file.

**Rule.** If the Dockerfile installs from `requirements.txt`, every dependency
must be resolvable from the indexes that file can reach — which is PyPI alone.
A per-package index needs project-mode install (`COPY pyproject.toml uv.lock` +
`uv sync --frozen`), or it does not belong in the lock at all.

**Check.** Resolve for the deploy target, not for your Mac:

```bash
cd consent-protocol
uv pip install --dry-run \
  --python-platform x86_64-unknown-linux-gnu --python-version 3.13 \
  -r requirements.txt | tail -3
# "Resolved N packages" = the image will build.
# "No solution found" = the next UAT deploy dies before it ships anything.
grep -nE '\+[a-z]+( |$)|^--(extra-)?index-url' requirements.txt
# A local version (+cpu, +cu121) with no index directive is the trap.
```

### R25 — In replay mode, every migration must be replay-safe against *today's* data

**Incident (2026-09-07, unblocking UAT).** UAT runs
`db/migrate.py --migration-mode replay`, which re-executes **every** migration
body in order on **every** deploy. Migration 138 re-adds
`connection_origins_origin_kind_check` with the vocabulary as it stood then —
before 175 added `contact_sync`. The moment UAT held its first `contact_sync`
row, replaying 138 began failing with *"check constraint ... is violated by
some row"*, and every deploy of every commit stopped there. The 03:18 run
passed only because no such row existed yet.

A migration is not a historical record here. It is code that runs again tonight,
against data that did not exist when it was written.

**Rule.** Any migration that narrows a constraint, adds a NOT NULL, or asserts
a vocabulary must tolerate rows a later migration legitimises. Add the
constraint `NOT VALID` when the migration's intent is "change what future rows
do" — its own comment usually says so. Let the later migration validate the
full set. Never widen an old migration to name a value that did not exist yet.

**Check.** Find every migration that re-adds a constraint a later one changes:

```bash
cd consent-protocol
for c in $(grep -rhoE 'ADD CONSTRAINT [a-z_]+' db/migrations/*.sql \
           | awk '{print $3}' | sort | uniq -d); do
  echo "== $c"
  grep -ln "ADD CONSTRAINT $c" db/migrations/*.sql | sort
done
# Two or more files for one constraint name = every earlier one re-runs on
# replay with its older, narrower rule. Each must be NOT VALID or provably
# no narrower than the final one.
```

### R26 — UAT replays migrations against a live database; it fails by time of day, not by commit

**Incident (2026-09-07, after R25 was fixed.)** With the constraint violation
gone, the deploy got further and then died on
`LockNotAvailableError: canceling statement due to lock timeout`. Replay takes
`ACCESS EXCLUSIVE` locks across the whole migration history while UAT is
serving traffic, and `lock_timeout_ms` defaults to **5 seconds**
(`db/migration_authority.py:56`). Two consecutive retries failed identically,
so it is contention, not a transient blip.

The deploy history makes the pattern plain — successes cluster at 00:56, 06:05
and 11:17; failures at 21:04, 21:59, 14:46, 15:33, 16:22, 16:28. The same
commit deploys at night and fails in the evening.

**Rule.** Do not read a UAT failure as "my change broke it" until the lane
itself is ruled out. Check whether the failure is the same step failing for
everyone, and whether recent successes cluster in quiet hours. A retry is
evidence only when it changes the outcome; two identical failures mean stop
retrying and fix the lane.

**Check.** Before blaming a commit, look at the lane:

```bash
gh run list --repo hushh-labs/hushh-research --workflow deploy-uat.yml \
  --limit 15 --json conclusion,createdAt,headSha \
  --jq '.[] | "\(.createdAt[11:16]) \(.conclusion // "running") \(.headSha[0:9])"'
# Many SHAs failing, and successes clustered in off-hours, means the lane is
# the problem. One SHA failing while neighbours pass means the commit is.
```

The durable fix is `ledger` mode — pending migrations only, after a verified
baseline — which `db/migrate.py` already supports and which exists precisely
for this. It needs a one-time baseline established against the UAT database
(`db/migrate.py --establish-baseline`), so it requires database access.

### R27 — Hoisting an App Shortcut phrase array deletes every shortcut in the app

**Incident (2026-09-07, iOS TestFlight build 99 — merge `a4a95a1e4`, PR #6559).** Long-pressing
the app icon showed no App Shortcuts at all, only the system items, and `TalkToHusshOneIntent`
stopped working despite being **byte-identical to build 98**. The PR had refactored every phrase
list out of its `AppShortcut(...)` call into a named constant — `phrases: shareLocationPhrases`
where build 98 wrote the phrases in place — and the app name likewise into
`private static let agentOne: AppShortcutPhraseToken = .applicationName`.

`appintentsmetadataprocessor` extracts App Shortcuts at **compile time** by reading those
expressions literally. It cannot follow a reference to a `static let`. It saw ten shortcuts with
zero phrases and stopped:

```
OneVoiceAppIntent.swift:1113: warning: App Shortcuts should have at least one phrase
error: At least one halting error produced during export. No AppIntents metadata have been
exported and this target is not usable with AppIntents until errors are resolved.
```

No metadata means **no App Shortcuts of any kind** — including ones whose code never changed.

Proven on this repo, Xcode 26.6, one file swapped between otherwise identical builds:

| provider shape | `Metadata.appintents` |
| --- | --- |
| build 99 as shipped (arrays hoisted + token hoisted) | **not written** — halting error |
| arrays inline, token still hoisted | **not written** — halting error |
| arrays hoisted, token inline | **not written** — halting error |
| both inline (build 98's shape) | **written**, 10 shortcuts, 61 phrases |

Both hoistings must be undone; neither alone is sufficient. The table above was produced locally
on Xcode 26.6; the shipped CI ran 26.3 and *did* write a metadata file, so no log line looked
wrong — "Writing Metadata.appintents" in a log is not evidence that the shortcuts are in it.

Corrected 2026-09-07: do not read that as a version mismatch between CI and the release. All three
iOS lanes pin the same Xcode — `ci.yml:424`, `ship-ios-testflight.yml:121` and
`release-ios-appstore.yml:135` are each `xcode-version: "26.3"` — so build 99 was cut by the same
compiler CI used. The reason CI stayed green is simpler and worth naming plainly: **nothing
checked.** `xcodebuild` exits 0 even when `appintentsmetadataprocessor` halts. The fix is the
assertion, not a version bump. Verified on the merge run, reading the built binary on 26.3:
`OK: 10 App Shortcuts, 61 phrases, compiled into the binary.`

Separately and secondarily: that PR also bound `\(\.$requestText)`, a plain `String`, into a
phrase. Apple allows only `AppEnum` and `AppEntity` phrase parameters. That is a real violation
worth fixing, but it is **not** what emptied the menu.

**Rule.** Phrase arrays and the `\(.applicationName)` token are written inline inside
`AppShortcut(phrases: [...])`, never hoisted into a named constant, no matter how much tidier
hoisting looks. Every phrase parameter is an `AppEnum` or `AppEntity`; free text goes through the
parameter's `requestValueDialog`. Order both structural checks BEFORE the phrase-fragment
assertions — an earlier throw means later assertions never run, which is how this verifier passed
while the app shipped with nothing.

**Check.** Both guards must fail on the real bug. Hoist while keeping every phrase intact, so the
fragment assertions still pass and only the shape guard can fire:

```bash
cd hushh-webapp && node scripts/native/verify-siri-action-contract.mjs   # green first
# then hoist one family into a `static let ...Phrases` and re-run:
#   Error: Phrase arrays must be written inline ... not hoisted into a named constant
# and add "Ask \(.applicationName) with \(\.$requestText)" as an extra phrase:
#   Error: ... binds \(\.$requestText), typed `String` ...
```

A green contract still is not a registered shortcut. Only a build proves it:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/dd \
  CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "halting error|Writing Metadata.appintents"
python3 -c "
import json;d=json.load(open('/tmp/dd/Build/Products/Debug-iphonesimulator/App.app/Metadata.appintents/extract.actionsdata'))
[print(s['shortTitle']['key'], len(s.get('phraseTemplates') or [])) for s in d['autoShortcuts']]"
```

Expect ten rows with non-zero phrase counts. Zero rows, or a row with zero phrases, is the bug.

### R28 — An error handler that runs on a broken connection will report itself instead of the failure

**Incident (2026-09-07, six consecutive UAT deploys.)** Every one failed at
"Apply UAT DB migrations behind account deletion fence" with
`asyncpg.exceptions.InFailedSQLTransactionError: current transaction is aborted`.
That was never the failure. The real one, four frames up the chained traceback,
was `LockNotAvailableError: canceling statement due to lock timeout`.

`apply_manifest_entries` rolled the failed transaction back only when
`mode is not MigrationMode.REPLAY` — and UAT runs in `replay`. So a replay
failure left the connection aborted, and the function's own
`finally: await _unlock(conn)` then issued `SELECT pg_advisory_unlock($1)` on
that dead connection. Its exception propagated **in place of** the migration's.
The cleanup step overwrote the diagnosis.

It compounded with a second gap: nothing in that function ever named
`entry.filename`. UAT replays 173 migrations per deploy, so the log said a
migration failed and gave no way to learn which one. Six deploys produced six
identical, useless tracebacks.

**Rule.** Cleanup in a `finally` — unlock, close, release, flush — must not be
able to replace the exception that brought you there. Wrap it and swallow its
own failure. Any loop applying a batch of units must name the unit in the error;
"something in this batch failed" is not a diagnosis. And when an error path is
gated on a mode, check whether the *cleanup* it also skips is needed in every
mode. Diagnostics must not quote the database's message — a Postgres error can
carry row values (a unique violation names the key and its value) — so report
the exception class and its SQLSTATE instead.

**Check.**
```bash
cd ~/Desktop/husshOne/consent-protocol
# The unlock must be guarded, and the rollback must not be inside the mode gate.
python3 - <<'PY'
import re, pathlib
s = pathlib.Path("db/migration_authority.py").read_text()
tail = s.split("async def apply_manifest_entries")[1].split("    finally:")[1]
print("unlock guarded:", "try:" in tail and "_unlock(conn)" in tail)
blk = re.search(r"except Exception as exc:(.*?)\n                raise", s, re.S).group(1)
print("rollback before mode gate:",
      blk.index("_rollback_failed_transaction") < blk.index("if mode is not"))
print("failure names the file:", "entry.filename" in blk)
PY
```
All three must print `True`.

### R29 — A warning you cannot fix must become an assertion about the one you can

**Incident (2026-09-07, TestFlight build 100.)** Every `exportArchive` logs four copies of
`warning: exportArchive Upload Symbols Failed. The archive did not include a dSYM for the
FirebaseAnalytics.framework with the UUIDs [...]` — also for `GoogleAppMeasurement`,
`GoogleAppMeasurementIdentitySupport` and `GoogleAdsOnDeviceConversion`. It was reported as
"not something this change introduced" and left alone, which was accurate and useless.

The warning is unfixable from here, but **not** for the reason first written down. The original
version of this rule claimed those four were static libraries linked into `App` that never ship as
their own image, so nothing was lost. That was wrong, and the guard's own first real run disproved
it: all four appear in `App.app/Frameworks/`, and the signed `.ipa` shows each is `MH_DYLIB` with
its own UUID (`FirebaseAnalytics` = `CC492DC7-…`). They are separately loaded dynamic libraries.

The claim came from reading `SourcePackages/artifacts/` in **local** DerivedData, where `file` said
`current ar archive`. That local checkout did not match what CI resolves and ships. R19's lesson
again, in a new place: when a local reading and a measurement of the real artifact disagree, the
artifact wins.

What *is* true, and is what makes it unfixable: Google publishes **no dSYM** for any of the four —
none inside the `.xcframework`, none reaching `App.xcarchive/dSYMs` (the archive holds 8 dSYMs:
`App.app` plus Capacitor, Cordova, four Facebook SDK frameworks, and IONCameraLib — none Google).
So there is nothing to supply, and **crash frames inside those four libraries genuinely will not
symbolicate**. That is a real accepted loss, not a harmless one. Say so plainly rather than
implying the warning costs nothing.

The danger is not the warning. It is that **our own dSYM going missing prints the same sentence**.
Flip `DEBUG_INFORMATION_FORMAT` from `dwarf-with-dsym` to `dwarf` on Release and the log grows a
fifth identical-looking line among four that are always there, every build, forever. Nobody would
see it, and every crash report from real users would arrive as raw addresses. Crashlytics is not
linked in this app, so App Store Connect's symbol upload is the *only* symbolication path there is.

**Rule.** Do not silence a warning class that contains a real signal, and do not silence it by
turning `uploadSymbols` off — that drops our own symbols too, which is the exact failure being
guarded against. Instead assert the thing that matters (our dSYM exists **and its UUIDs match the
shipped binary**), name each known-unfixable exception in an allow-list with the reason, and fail
on anything outside it. Apply it to every lane that exports an archive, not just the one where it
was noticed (R14).

**Check.** Measure the **shipped artifact**, never the local package checkout — that is the whole
mistake above. Download the `.ipa` a dry run produces and read it:

```bash
gh run download <RUN_ID> --repo hushh-labs/hushh-research -n ios-testflight-<N> -D /tmp/art
cd /tmp/art/export && mkdir -p ipa && unzip -qq *.ipa -d ipa
APP=$(find ipa/Payload -maxdepth 1 -name '*.app' | head -1)
for fw in "$APP"/Frameworks/*.framework; do
  n=$(basename "$fw" .framework)
  printf '  %-38s %s\n' "$n" "$(file -b "$fw/$n" | tail -1)"
done
ls /tmp/art/App.xcarchive/dSYMs
```

Every framework listed must either have a matching `.framework.dSYM` in that `dSYMs` listing or be
one of the four Google names. A dynamic library that is neither is a real symbolication gap.

Then mutation-test the guard, because a passing new check proves nothing (R22). Against a mock
archive, all five must hold: healthy passes; a deleted `App.app.dSYM` fails; a dSYM whose UUIDs no
longer match the binary fails; an allow-listed vendor framework with no dSYM passes; any other
framework with no dSYM fails. Note that `clang -g` re-runs `dsymutil` automatically, so a "stale
dSYM" test that rebuilds in place silently regenerates it and passes — hold the dSYM aside first,
or the mutation test proves nothing.

### R30 — A default that is right for you is a silent bug for everyone else

**Incident (2026-09-08, UAT phone verification.)** The founder, testing from
India, could not verify any phone number. The country picker read **United
States (+1)** and he typed a real Indian mobile, so the app sent
`+1<10 digits>` — a different number. The code went nowhere, and the UAT
test-number allowlist, which matches on the full E.164 string, could never hit:
`+19898989892` is not `+919898989892`.

Nothing failed loudly. The picker was on screen and looked deliberate, so the
symptom read as *"phone verification is broken"* and cost an evening chasing a
database that phone verification never touches. The whole path is the client,
Google's `identitytoolkit.googleapis.com`, and two environment variables — no
table, no column, no migration.

`DEFAULT_COUNTRY_VALUE = "US"` was hard-coded, in a product whose team tests
from India. The repo already had `resolveContactPhoneRegion` doing this
properly for contact sync — SIM region, then the account's own number, then the
browser locale. One surface used it; the other guessed.

**Rule.** A locale-, country-, currency-, timezone- or unit-shaped default must
be derived from the person, not hard-coded to the team's own market. When the
repo already resolves that signal somewhere, reuse it rather than writing a
second answer. Detect in an effect, never during render: `navigator` does not
exist on the server, and seeding state from it changes the first client paint
and breaks hydration. An explicit user choice always outranks detection.

**Check.**
```bash
cd ~/Desktop/husshOne/hushh-webapp
# Hard-coded country/locale defaults. Each hit must either derive from the user
# or be a deliberate, commented fallback.
grep -rnE 'DEFAULT_(COUNTRY|LOCALE|REGION|CURRENCY)[A-Z_]* *= *"' \
  --include='*.ts' --include='*.tsx' lib components app | grep -v node_modules
# The phone flow must consult the shared resolver, not guess.
grep -n 'resolveContactPhoneRegion' components/auth/phone-verification-flow.tsx
npx vitest run __tests__/components/phone-verification-flow-interaction.test.tsx
```
The second must return a line; the suite covers `en-IN`, `en-US`, and an
existing account number outranking the browser.

### R31 — An empty-defaulting deploy substitution is a feature that never turns on

**Incident (2026-09-08, found while tracing R30.)**
`deploy/backend.cloudbuild.yaml` binds 49 secrets, each through a substitution:

```bash
add_secret "${_SOME_THING_SECRET}" "SOME_THING"
```

**40 of those substitutions default to `""`**, and `add_secret` skips empties. A
lane that never passes one deploys a service with that environment variable
simply **absent** — no error, no log, no failed step. The feature that reads it
behaves exactly as though it was never configured.

The other 9 default to the secret's own name and are bound whether or not a
lane passes them. That distinction matters: a first version of this check
ignored it and reported all 9 as gaps, including `_WALLET_PASS_*` and
`_OMNIGATEWAY_*` which were working fine. Verified against the live service —
`HUSHH_MANAGED_GEMINI_LIVE_API_KEY` is **present** on
`consent-protocol` in `hushh-pda-uat` despite no lane passing it.

Of the 40 that can vanish, UAT omits 4, production 25, dev 24. Most are
correct — production must not carry UAT test numbers. The one that is not:
`_HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET_SECRET`, so the phone-test challenge
key silently falls back to `APP_SIGNING_KEY`. Every UAT test code therefore
changes the day that key rotates, with no warning.

That one still must not be bound: `gcloud secrets describe
HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET --project=hushh-pda-uat` returns
**not found**. Cloud Run validates every `secretKeyRef` at revision start, so
binding it would make every UAT revision fail to become ready while the old one
kept serving (R1). Create the secret first, then bind.

**Rule.** Every empty-defaulting secret substitution must be passed by each
deploy lane, or recorded as a deliberate omission **with a reason**. Check the
substitution's default before calling an omission a bug, and check the running
service before calling it broken. Never bind a secret you have not confirmed
exists.

**Check.**
```bash
cd ~/Desktop/husshOne
python3 scripts/ci/check-deploy-secret-coverage.py
```
Runs in the `Governance` CI job. It fails on an omission absent from
`config/deploy-env-coverage.json`, and on a listed entry that no longer matches
reality — both directions mutation-tested before this rule landed.

### R32 — A busy database is not a broken migration: retry contention, never widen the lock wait

**Incident (2026-09-07, six failed UAT deploys — runs 34142917051 and 34143403982.)**
Replay applies every migration with `lock_timeout_ms = 5_000` and **no retry
anywhere** — `grep -c 'retry\|backoff\|attempt'` on `db/migration_authority.py`
returned 0. One unlucky 5-second window against a live UAT killed the whole
release, and the same commit deployed fine minutes later. R26 named the pattern;
nothing was done about the immediate cause, so it stayed a coin flip.

The obvious repair is the wrong one. Postgres queues lock requests, so a pending
`ACCESS EXCLUSIVE` request blocks every **later** reader of that table as well.
Raising `lock_timeout` to 30s does not buy 30s of patience — it buys 30s of
queued UAT traffic. The safe shape is the opposite: keep the timeout short, roll
back, let the queue drain, try again.

**Rule.** Never widen `lock_timeout` to survive contention. Retry it instead,
bounded and backed off, and only on a contention SQLSTATE — `55P03`
lock_not_available, `40P01` deadlock_detected, `40001` serialization_failure. A
`23514` check violation or a `42601` syntax error must still fail on the first
attempt; retrying a broken migration only reports the same error later, having
spent the deploy window. Roll back between attempts or the retry runs on an
aborted connection and reports itself instead of the failure (R28).

**Check.**
```bash
cd consent-protocol
# The behaviour, not the source text. A string-matching check over this
# function is worthless: the first version of this Check split on
# `_is_lock_contention(exc) and attempt`, and died with IndexError the moment
# that condition became multi-line -- one commit later (R34).
../.venv/bin/python -m pytest tests/test_migration_authority.py -q
grep -n "test_migration_authority" scripts/test-ci.manifest.txt
```
All 16 must pass, and the grep must return a line -- an unregistered test file
never runs in CI, and this manifest is the only pytest invocation in any lane.
Mutation-test before trusting it (R22): `_LOCK_RETRY_ATTEMPTS = 1` turns three
red; an unconditional `_is_lock_contention` turns the not-retried test red;
unguarding the reset turns the masking test red; deleting the run-budget
condition turns the budget test red.

### R33 — `ledger` mode cannot be switched on today: 152 of 194 migrations open their own transaction

**Incident (2026-09-07, scoping the durable fix R26 recommends.)** R26 says the
durable answer to replay is `ledger` mode — pending migrations only, after a
baseline. Acting on that sentence alone would have broken a release. Three
things block it, and none are visible from the mode flag:

1. **The migration bodies nest transactions.** `ledger` wraps each transactional
   entry in `async with conn.transaction()` (`migration_authority.py:342`), but
   `grep -lE '^\s*BEGIN\s*;' db/migrations/*.sql` returns **152 of 194 files**
   that open their own. A `BEGIN` inside an open transaction warns and is
   ignored; the body's own `COMMIT` then commits the **outer** transaction, so
   the ledger row and the migration stop being atomic — exactly the guarantee
   ledger mode exists to provide.
2. **The backup tooling the baseline requires does not exist.** `establish_baseline`
   demands `backup_checksum_sha256` matching `[0-9a-f]{64}` plus `restore_status
   == "ok"`. There are **zero `pg_dump` references in the repository** — the
   logical-backup scripts were deleted in `78aaa1e4b`. Nothing can produce the
   artifact the gate asks for.
3. **The evidence expires in an hour.** `load_preservation_evidence` rejects a
   report older than `HUSHH_BASELINE_EVIDENCE_MAX_AGE_SECONDS` (default 3600),
   so backup, restore-verify and baseline must complete inside one window.

**Rule.** Do not set `UAT_MIGRATION_MODE=ledger`, and do not change the
hardcoded `replay` in `deploy-production.yml:355` or `deploy-dev.yml:324`, until
every transactional entry is proven not to open its own transaction. Enabling it
first is not a smaller step — it is a silent loss of atomicity across 152 files.
The ordered prerequisites are: strip `BEGIN`/`COMMIT` from the migration bodies
(or mark those entries `transactional=False`), restore a logical-backup tool,
provision a clone database, then baseline.

**Check.**
```bash
cd consent-protocol
grep -lE '^\s*BEGIN\s*;' db/migrations/*.sql | wc -l   # must be 0 before ledger mode
grep -rn "pg_dump" --include="*.py" --include="*.sh" . | grep -v node_modules | head -1
grep -n "migration-mode" ../.github/workflows/deploy-*.yml
```
The first must print `0`. The second must return a tool. Until both hold, every
lane stays on `replay`.

### R34 — A retry bounded per unit is unbounded per run, and a fix's own tests may never run

**Incident (2026-09-08, hours after R32 shipped in PR #6609.)** The retry that
fixed the lock-timeout outage introduced three defects of its own, none caught
by review and none catchable by its tests, because its tests did not run.

1. **Unbounded per run.** 4 attempts per migration is bounded; 174 migrations x
   (4 x 5s lock wait + 7s backoff) is **~78 minutes**, and `deploy-uat.yml` sets
   no `timeout-minutes` at all (GitHub default 360). The bug being fixed made
   UAT go red in three minutes. The fix could make it hang for over an hour
   while holding the migration advisory lock **and** the installed
   account-deletion release fence. That is a worse availability posture than the
   defect.
2. **R28 reintroduced on the new path.** The retry branch called
   `await _rollback_failed_transaction(conn)` unguarded. That cleanup runs on a
   connection that has just failed, so it can fail too -- and its exception then
   replaces the 55P03 as the reported error, which is precisely the masking R28
   exists to prevent, on a path R28's own check does not reach.
3. **The tests were decoration.** `tests/test_migration_authority.py` was not in
   `consent-protocol/scripts/test-ci.manifest.txt`, and that manifest is the only
   pytest invocation in any lane (its own header says so). R28's masking tests
   and R32's four retry tests had never executed in CI, on any PR, ever.

And R32's own Check was brittle: it split the source on
`_is_lock_contention(exc) and attempt`, so it died with `IndexError` as soon as
that condition became multi-line -- one commit after it was written.

**Rule.** A retry needs two bounds: per unit **and** per run. State the run's
worst case in seconds before shipping it, and compare that number against the
job's own timeout -- if the job has no `timeout-minutes`, the worst case is the
platform default, not the number you hoped for. Any cleanup on the failure path
goes through one guarded helper, never a bare call, so a second failure cannot
overwrite the first. And a test file is not coverage until it is in the
manifest: adding tests and adding them to `test-ci.manifest.txt` are one change,
not two. Write Checks against behaviour (run the tests) rather than against
source text, which goes stale on the next refactor.

**Check.**
```bash
cd consent-protocol
grep -n "test_migration_authority" scripts/test-ci.manifest.txt
python3 -c "
import pathlib
s=pathlib.Path('db/migration_authority.py').read_text()
print('run budget present:', '_LOCK_RETRY_RUN_BUDGET_S' in s)
print('no bare rollback on a failure path:', s.count('await _rollback_failed_transaction(conn)') == 1)
"
grep -n "timeout-minutes" ../.github/workflows/deploy-uat.yml || echo "deploy-uat has NO job timeout"
```
The grep must return a line. Both prints must be `True` -- the single remaining
bare call is the one inside `_reset_connection` itself. The last line records
whether the lane is still relying on the platform default.

### R35 — `secrets versions add` REPLACES. A list in a secret needs read-modify-write

**Incident (2026-09-03, discovered 2026-09-08.)** `HUSHH_UAT_PHONE_TEST_NUMBERS`
holds the UAT fixed-OTP phone allowlist. Version 8 held **59** numbers. Version
9, written **three minutes and ten seconds later**, held **1**. Fifty-eight
testers' numbers were destroyed in a single write, and nothing anywhere said so.

The damage surfaced days later, and not as a secret problem. A number that was
no longer allowlisted fell through to real Firebase exactly as designed, a real
SMS went to a number nobody was holding, and the person typing the fixed test
code `000000` got *"That verification code is incorrect."* Every component
behaved correctly. The founder spent an evening convinced the database had
broken phone verification, which never touches the database at all.

The cause is the tool's shape, not carelessness: `gcloud secrets versions add`
**replaces the entire value**. There is no append. Editing a list therefore
means read the current version, merge, write back — and skipping the read
silently deletes everyone else's entries. Nothing warns you, and the old
versions look like ordinary history rather than the evidence of a wipe.

R3 already says *only ever ADD access, never replace*. It was written about IAM
policies. It applies exactly as hard to a **list stored in a secret**, and it
did not say so.

**Rule.** Never hand-write a list-valued secret. Use
`scripts/ops/secret_list_edit.py`, which reads the current value, unions into
it, and **refuses to write a version with fewer entries than the current one**.
Print counts and last-4s, never values. Before assuming a list-valued secret is
correct, look at its version history — an entry count that collapses between
adjacent versions is a wipe, not an edit.

**Check.**
```bash
cd ~/Desktop/husshOne
# Entry count per version. A sharp drop between adjacent versions is a wipe.
for v in $(gcloud secrets versions list HUSHH_UAT_PHONE_TEST_NUMBERS \
  --project=hushh-pda-uat --format='value(name)' --limit=6); do
  printf 'v%-3s ' "$v"
  gcloud secrets versions access "$v" --secret=HUSHH_UAT_PHONE_TEST_NUMBERS \
    --project=hushh-pda-uat 2>/dev/null | tr ',;' '\n' | grep -c . 
done
# And the safe editor refuses to shrink:
scripts/ops/secret_list_edit.py --secret HUSHH_UAT_PHONE_TEST_NUMBERS \
  --project hushh-pda-uat --show
```
Restored as version 10 on 2026-09-08: 59 entries, verified, nothing dropped.

### R36 — Nothing reads a secret's old versions, so a wipe is invisible until a user hits it

**Incident (2026-09-03, found 2026-09-08.)** The 58 numbers deleted from
`HUSHH_UAT_PHONE_TEST_NUMBERS` (R35) sat gone for **five days**. Not one system
noticed. No alert, no failing check, no red deploy. It surfaced only when the
founder could not verify a phone and spent an evening convinced the database had
broken phone verification — which never touches the database.

The evidence was there the whole time: version 8 had 59 entries, version 9 had
1. Secret Manager keeps every version. **Nothing in this repo ever read them.**

Audit detail, for the record: both writes came from `kushal@hushh.ai` via
`Python-urllib/3.13` — a custom script, not the CLI. Automation that owns a
value and rewrites it wholesale is the highest-risk shape for this, because it
repeats reliably and nobody reviews its payload.

The same exposure exists in **production**: `HUSHH_PROD_PHONE_TEST_NUMBERS`
holds 40 entries and one careless write destroys them the same way.

**Rule.** Every list-valued secret that a feature depends on is declared in
`config/protected-lists.json` with an entry floor and a shrink limit, and
checked automatically. A deploy must fail rather than ship on top of destroyed
configuration. Detection is not optional just because the edit tool is safe —
`secret_list_edit.py` only helps the people who use it, and the wipe came from
something that did not.

**Check.**
```bash
cd ~/Desktop/husshOne
python3 scripts/ops/verify_secret_list_invariants.py
```
Runs in `deploy-uat.yml` before the runtime-parity check. Fails when a tracked
list falls below its floor, or when more entries vanished between adjacent
versions than the limit allows, and prints the exact `secret_list_edit.py
--restore-from` command to recover.

Verified by replaying the real incident: against v8 → v9 it reports 58 entries
lost against a limit of 5, and 1 entry against a floor of 25 — it fails on both
counts. A guard never seen to catch its own incident is decoration.

### R37 — On a flat team you cannot remove access, so remove the accident and shorten the silence

**Context (2026-09-08, after R35/R36.)** The obvious fix for "one write destroyed
58 entries" is to restrict who may write that secret. On a small team with a flat
hierarchy that is the wrong trade: everyone genuinely needs to ship, and an
access ticket between an engineer and their own test number buys nothing.

So the control is not permission. It is three layers, none of which asks anyone
for approval:

1. **Make the safe path the easy path.** `scripts/ops/secret_list_edit.py`
   reads before it writes, unions, and refuses to shrink a list. It is shorter
   to type than the raw command it replaces.
2. **Make the accident impossible.** `scripts/ops/protected-secret-guard.sh`
   defines a shell function that refuses `gcloud secrets versions add` on any
   secret declared in `config/protected-lists.json`, and tells you what to run
   instead. Installed per engineer with one line in `~/.zshrc`. It is
   deliberately bypassable with `command gcloud` — it stops the slip, not the
   decision.
3. **Make the silence short.** `.github/workflows/verify-protected-lists.yml`
   runs hourly against UAT *and* production, and the same check gates both
   deploy lanes. The 2026-09-03 wipe went unnoticed for five days; the ceiling
   is now an hour, and a production wipe cannot wait for the next rare
   production deploy to be found.

Prevention that only works when people cooperate is not a control. Detection
that only runs at deploy time is not a control either, because the deploy that
would catch it may be weeks away. Layer both.

**Rule.** When access cannot be restricted, every destructive operation on
shared state needs all three: a safe default tool, a guard against the
accidental form, and time-bounded detection that runs without anyone
remembering to run it. Adding a list to `config/protected-lists.json` gets all
three at once.

**Check.**
```bash
cd ~/Desktop/husshOne
# The guard must refuse a protected list and pass everything else through.
HUSHH_REPO_ROOT="$PWD" bash -c '
source scripts/ops/protected-secret-guard.sh
gcloud secrets versions add HUSHH_UAT_PHONE_TEST_NUMBERS --project=hushh-pda-uat \
  --data-file=- </dev/null 2>&1 | grep -q REFUSED && echo "guard: refuses protected" || echo "GUARD BROKEN"
gcloud secrets versions list HUSHH_UAT_PHONE_TEST_NUMBERS --project=hushh-pda-uat \
  --limit=1 --format="value(name)" >/dev/null 2>&1 && echo "guard: reads untouched" || echo "GUARD TOO BROAD"'
```
Both lines must be the positive form. Verified 2026-09-08, including flags
placed before the secret name and an unprotected secret passing through to real
gcloud.

### R17 — A retry loop must test the success condition, not "did it print something"

**Incident (2026-08-17, shipping #5393–#5396 through a GitHub outage).** A
retry loop around `gh workflow run deploy-uat.yml` treated any output as
failure and retried. `gh workflow run` prints the run URL **on success**, so
the loop never stopped: it fired **19 UAT deploys** of the same SHA. The
concurrency group cancelled 8, 7 failed at the workflow's own "Resolve
deployment SHA" guard, and 2 succeeded. Nothing was damaged — the guard is
exactly what caught it, and UAT ended healthy on the right commit — but it
burned ~17 pointless runner-hours and buried the one deploy that mattered in
noise.

Same shape as the SHA I hand-assembled minutes earlier: `--match-head-commit`
was given a full SHA reconstructed from a short hash, and GitHub answered
`409 Head branch was modified`. Never rebuild an identifier you can read.

**Rule.** A loop that retries a command must branch on the command's **exit
code** or on a positive assertion about the resulting state — never on whether
stdout was empty. For anything that spends money or mutates a shared
environment, assert the state first and bail: "is a run already in flight for
this SHA?" before dispatching another. And read identifiers (`git rev-parse`,
the API's own field), never assemble them.

**Check.** Before shipping any dispatch loop, dry-run its predicate:

```bash
# gh workflow run prints a URL on SUCCESS -- prove the predicate is not inverted
out=$(gh workflow run deploy-uat.yml --ref main 2>&1); code=$?
echo "exit=$code output=${out:0:60}"
# exit 0 with non-empty output is SUCCESS. A loop keying on -z "$out" storms.

# and never dispatch blind: check for an in-flight run on this SHA first
gh api "repos/hushh-labs/hushh-research/actions/runs?per_page=10" \
  --jq '[.workflow_runs[] | select(.name=="Deploy to UAT" and .status!="completed")] | length'
```
A non-zero count means one is already running: wait, do not dispatch.

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
