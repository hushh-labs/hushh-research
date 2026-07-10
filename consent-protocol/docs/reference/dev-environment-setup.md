# Dev Environment Setup (UAT Replica)

> Operator runbook for standing up and operating the hosted `dev` environment: a full
> infrastructure replica of the UAT GCP project, deployed from green `main` SHAs through
> `.github/workflows/deploy-dev.yml` — the same pipeline shape as UAT.

## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## End-to-End Audit (run this first)

The dev environment has a dedicated doctor that derives its baseline live from UAT
(APIs, secret names, SQL shape and users, runtime-SA roles, Cloud Run services,
scheduler jobs) and audits the dev project against it, printing a remediation command
for every failure:

```bash
python3 scripts/ops/dev_environment_doctor.py \
  --dev-project hushh-pda-dev --uat-project hushh-pda-uat \
  --report-path /tmp/dev-doctor.json
```

Exit 0 = healthy, 1 = failures. Run it after any environment change and before
declaring dev ready.

## Provisioned State (as of 2026-07-10)

Phases 1–3, the IAM plumbing, and the One Email fanout subscription were executed via
the governed operator service account. Current live facts:

| Item | Value |
| --- | --- |
| Project | `hushh-pda-dev`, display name **consent-protocol dev** (number `621416509462`, folder shared with UAT, billing `014D7F-FD970D-D2459E`) |
| Cloud SQL | `hushh-pda-dev:us-central1:hushh-dev-pg` (POSTGRES_15, db-custom-1-3840, 20GB SSD), user `hushh_uat_app` (new password in dev `DB_PASSWORD`) |
| Secrets | all 144 UAT secrets replicated; overrides: `APP_FRONTEND_ORIGIN`, `BACKEND_URL`, `DB_PASSWORD` |
| Backend URL (deterministic) | `https://consent-protocol-621416509462.us-central1.run.app` |
| Frontend URL (deterministic) | `https://hushh-webapp-621416509462.us-central1.run.app` |
| One Email fanout | subscription `one-email-kyc-dev-push` in `hushh-pda` on topic `one-email-kyc-uat`, OIDC audience = dev backend webhook |
| Runtime SAs | compute + cloudbuild SAs granted UAT-parity roles |

Still pending: `dev.kai.hushh.ai` DNS + domain mapping (origin temporarily set to the
deterministic frontend Cloud Run URL in `deploy-dev.yml`; passkey unlock is unavailable
on the temporary origin because the RP id is `kai.hushh.ai` — passphrase unlock works),
GitHub environment `dev` + `GCP_SA_KEY_DEV`, first deploy, and the post-deploy
schedulers below.

## Identity Model (read this first)

The dev environment splits infrastructure identity from runtime identity on purpose:

| Layer | Value | Why |
| --- | --- | --- |
| GCP project | `hushh-pda-dev` | isolation from UAT |
| Cloud SQL instance | `hushh-pda-dev:us-central1:hushh-dev-pg` | own database |
| Frontend origin | `https://dev.kai.hushh.ai` | own domain |
| Deploy labels / provenance | `deploy-env=dev`, `deploy-source=deploy-dev` | auditability |
| Runtime identity | `ENVIRONMENT=uat`, `NEXT_PUBLIC_APP_ENV=uat` | exact UAT behavior parity |

Backend behavior gates (UAT phone test numbers, webhook auth defaults, SSE defaults,
review-alias verification, non-production CORS) all key off `ENVIRONMENT`. Keeping the
`uat` runtime identity is what makes dev a true replica. The string `dev` must NOT be
used as `ENVIRONMENT` or `NEXT_PUBLIC_APP_ENV`: existing code treats `dev` as local
development and would silently change behavior (auth defaults off, debug routes on).

The deploy pipeline enforces this through the `_RUNTIME_ENVIRONMENT=uat` Cloud Build
substitution (backend) and `_APP_ENV=uat` (frontend), while `_DEPLOY_ENV=dev` drives
labels and provenance verification.

## Intentional divergences from UAT

1. **One Email KYC runs in dev through topic fanout (founder-approved 2026-07).**
   `one@hushh.ai` is a single real Workspace mailbox, and two environments must never
   independently renew Gmail watches for it. The approved pattern:
   - **One watch, owned by UAT.** The existing UAT scheduler remains the only caller of
     `POST /api/one/email/watch/renew`. Never point a scheduler at the dev renewal
     endpoint.
   - **One topic, two subscriptions.** The watch keeps publishing to
     `projects/hushh-pda/topics/one-email-kyc-uat`; dev gets its own push subscription
     on that topic targeting the dev backend webhook (setup in Phase 6b below).
   - **Caveat:** both environments see every inbound email, so the same message can
     open a pending KYC workflow in UAT and dev. Sends stay user-approval-gated per
     environment, but approvers should expect duplicates and treat dev as the testing
     lane.
2. Everything else (voice, Plaid, market data, Gmail receipts OAuth, Maps, reviewer
   smoke, phone test numbers) replicates UAT, using secret values copied into the dev
   project.

---

## Phase 1 — GCP project bootstrap (operator, requires org access)

```bash
# 1. Create the project and link billing
gcloud projects create hushh-pda-dev --name="Hussh PDA Dev"
gcloud billing projects link hushh-pda-dev --billing-account=<BILLING_ACCOUNT_ID>
gcloud config set project hushh-pda-dev

# 2. Enable the same APIs as UAT
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  aiplatform.googleapis.com \
  cloudscheduler.googleapis.com
```

## Phase 2 — Cloud SQL replica

```bash
# Mirror the UAT instance shape (check current UAT tier before running)
gcloud sql instances describe hushh-uat-pg --project=hushh-pda-uat \
  --format='value(settings.tier, databaseVersion, region)'

gcloud sql instances create hushh-dev-pg \
  --project=hushh-pda-dev \
  --region=us-central1 \
  --database-version=<same-as-uat> \
  --tier=<same-as-uat>

# Create the runtime DB user (new credentials — do NOT reuse UAT DB credentials)
gcloud sql users create <dev-db-user> --instance=hushh-dev-pg --password=<generated>
```

Seed the schema, choosing one of:

- **Recommended — data replica:** export the UAT database and import it into
  `hushh-dev-pg` (`gcloud sql export sql` from UAT → GCS → `gcloud sql import sql`).
  This carries the reviewer smoke identities and marketplace fixtures with it, so
  post-deploy semantic verification works on day one.
- **Schema-only:** run `consent-protocol/db/migrate.py --release` against the empty
  dev DB (the deploy workflow does this anyway) and recreate the reviewer smoke
  fixture manually.

The schema contract for dev is the UAT contract by definition:
`consent-protocol/db/contracts/uat_integrated_schema.json` (dev replicates UAT; do not
fork a dev contract file unless dev is allowed to drift, which it is not).

## Phase 3 — Secret Manager population

Copy the UAT secret values into the dev project, then override the environment-specific
ones. From an operator machine with access to both projects:

```bash
# Copy every UAT secret name/value into hushh-pda-dev
for secret in $(gcloud secrets list --project=hushh-pda-uat --format='value(name)'); do
  value="$(gcloud secrets versions access latest --secret="$secret" --project=hushh-pda-uat)"
  gcloud secrets create "$secret" --replication-policy=automatic --project=hushh-pda-dev 2>/dev/null || true
  printf '%s' "$value" | gcloud secrets versions add "$secret" --data-file=- --project=hushh-pda-dev
done
```

Then override the values that must differ in dev:

| Secret | Dev value |
| --- | --- |
| `DB_USER` / `DB_PASSWORD` | the new dev Cloud SQL credentials |
| `APP_FRONTEND_ORIGIN` | `https://dev.kai.hushh.ai` |
| `BACKEND_URL` | dev backend Cloud Run URL (set after the first deploy) |
| `GMAIL_OAUTH_REDIRECT_URI` | dev origin redirect (only if Gmail receipts should run in dev) |

Notes:

- `APP_SIGNING_KEY` / `VAULT_DATA_KEY`: copying UAT values makes dev able to read a
  cloned UAT database (tokens and ciphertext stay valid). If you seed schema-only,
  prefer generating fresh values instead.
- Firebase identity plane is shared across environments by policy, so
  `FIREBASE_ADMIN_CREDENTIALS_JSON` and all `NEXT_PUBLIC_FIREBASE_*` values are copied
  as-is.
- The deploy workflow's secret-sync step
  (`scripts/ops/sync_backend_runtime_secrets.py --environment uat`,
  `scripts/ops/sync_frontend_runtime_secrets.py --environment dev`) maintains
  `BACKEND_RUNTIME_CONFIG_JSON`, CORS, passkey RP ids
  (`localhost,127.0.0.1,kai.hushh.ai,dev.kai.hushh.ai`), and analytics ids on every
  deploy — do not hand-maintain those.
- Verify parity when done:

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda-dev \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp \
  --require-plaid --require-market-data --require-gmail --require-one-email \
  --require-voice --require-reviewer-smoke
```

## Phase 4 — Deploy service account + GitHub wiring

```bash
# Service account with the same roles as the UAT deployer
gcloud iam service-accounts create github-deployer \
  --project=hushh-pda-dev --display-name="GitHub Actions dev deployer"

for role in roles/cloudbuild.builds.editor roles/run.admin roles/iam.serviceAccountUser \
            roles/secretmanager.admin roles/cloudsql.client roles/storage.admin \
            roles/viewer; do
  gcloud projects add-iam-policy-binding hushh-pda-dev \
    --member="serviceAccount:github-deployer@hushh-pda-dev.iam.gserviceaccount.com" \
    --role="$role"
done

gcloud iam service-accounts keys create dev-deployer-key.json \
  --iam-account=github-deployer@hushh-pda-dev.iam.gserviceaccount.com
```

In GitHub (`hushh-labs/hushh-research` → Settings → Environments):

1. Create environment **`dev`** (mirror any reviewer/branch protections from `uat`).
2. Add environment secret **`GCP_SA_KEY_DEV`** = contents of `dev-deployer-key.json`.
3. Delete the local key file after upload.

Dispatch governance is already wired: `config/ci-governance.json` has a `dev` surface
with the same governed actor list as UAT, enforced by
`scripts/ci/assert-governed-actor.py --surface dev`.

## Phase 5 — Domain mapping (optional for first deploy)

```bash
gcloud beta run domain-mappings create --service hushh-webapp \
  --domain dev.kai.hushh.ai --region us-central1 --project hushh-pda-dev
# then add the DNS records it prints to the kai.hushh.ai zone
```

Until the domain is live you can leave `APP_FRONTEND_ORIGIN` pointing at the frontend
Cloud Run URL; the deploy pipeline reads the secret, so update it and redeploy when the
domain lands.

## Phase 6 — First deploy and verification

1. Merge the branch that adds `deploy-dev.yml` to `main` (the workflow must exist on
   `main` because dev deploys are dispatched from `main` only, same as UAT).
2. GitHub → Actions → **Deploy to Dev** → Run workflow (branch `main`, scope `all`,
   optionally an exact green SHA).
3. The pipeline then does what the UAT one does: governed-actor gate → SHA-on-main gate
   (requires the "Main Post-Merge Smoke Gate" check) → secret sync → DB migrations +
   schema-contract gate → backend/frontend Cloud Build → traffic promotion →
   provenance + parity + semantic verification → auto-rollback on failure.
4. After the first successful backend deploy, set the `BACKEND_URL` secret in
   `hushh-pda-dev` to the backend Cloud Run URL so frontend builds and contributor
   profile bootstrap resolve it.

### Phase 6b — One Email fanout subscription (after first backend deploy)

With the dev backend Cloud Run URL in hand:

1. Update `DEV_ONE_EMAIL_WEBHOOK_AUDIENCE` in `.github/workflows/deploy-dev.yml` to
   `https://<dev-backend-run-url>/api/one/email/webhook` and redeploy the backend so
   the runtime audience matches.
2. Create the dev push subscription on the shared UAT topic (topic lives in the
   `hushh-pda` project):

```bash
gcloud pubsub subscriptions create one-email-kyc-dev-push \
  --project=hushh-pda \
  --topic=one-email-kyc-uat \
  --push-endpoint="https://<dev-backend-run-url>/api/one/email/webhook" \
  --push-auth-service-account=one-email-pubsub-push@hushh-pda.iam.gserviceaccount.com \
  --push-auth-token-audience="https://<dev-backend-run-url>/api/one/email/webhook"
```

3. KYC retention purge for dev: schedule
   `POST /api/one/kyc/retention/purge?older_than_days=30` with
   `X-Hushh-Maintenance-Token: $ONE_EMAIL_WATCH_RENEW_TOKEN`
   (`deploy/one-email/setup_kyc_retention_scheduler.sh` shows the UAT shape).

Ongoing schedulers to replicate (after first deploy):

- One KYC retention purge (Phase 6b above; UAT runs it daily at 09:37 PT).
- One Location retention purge: `POST /api/one/location/retention/purge?older_than_hours=12`
  with `X-Hushh-Maintenance-Token: $ONE_LOCATION_RETENTION_TOKEN` (note: UAT itself has
  no such job today — parity means matching UAT, so treat this as optional until UAT
  adds it).
- `marketplace-investor-replenisher-every-8h` and `obs-supabase-data-health-every-30m`
  trigger Cloud Run *jobs* that must first be created in dev
  (`deploy/marketplace/setup_investor_replenisher_scheduler.sh`,
  `deploy/observability/`); the doctor reports them as warnings until then.
- Do NOT schedule One Email watch renewal in dev — watch ownership stays with UAT
  (see divergences above).

## Contributor usage once dev is live

```bash
./bin/hushh bootstrap                 # hydrates hushh-webapp/.env.dev.local from hushh-pda-dev
./bin/hushh web --mode dev            # local frontend against the dev backend
./bin/hushh doctor --mode dev
./bin/hushh db verify-dev-schema      # dev DB vs the UAT schema contract
```

Non-default project id? Export `DEV_PROJECT_ID=<project>` before running the tooling;
`bootstrap_profiles.sh` also accepts `--dev-project <project>`.
