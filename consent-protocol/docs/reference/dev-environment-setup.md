# Dev Environment Setup (UAT Replica)

> Operator runbook for standing up and operating the hosted `dev` environment: a full
> infrastructure replica of the UAT GCP project, deployed through
> `.github/workflows/deploy-dev.yml` under the
> [dev fast lane](../../../docs/reference/operations/dev-fast-lane.md): CI-green SHAs
> from `integration/pr-train` (default) or any governed ref — never gated on `main`.

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
| APIs | full UAT parity (92 enabled; doctor-audited) |
| **Deployed services** | `consent-protocol` + `hushh-webapp` live and healthy (first deploy 2026-07-10, `deploy-env=dev`, public invoker enabled — note: org-fresh projects drop the `--allow-unauthenticated` binding silently; re-add `allUsers` → `roles/run.invoker` if a new service 403s) |
| Schedulers | full UAT parity: `one-email-kyc-retention-purge-dev` (daily 09:37 PT), `marketplace-investor-replenisher-every-8h`, `obs-Cloud SQL-data-health-every-30m` (+ their Cloud Run jobs and invoker SAs) |
| Database | full UAT data replica (102 tables, parity-verified) |
| Domain | `dev.one.hushh.ai` mapped to `hushh-webapp` + DNS CNAME live; origin flipped in secrets/workflow; TLS cert provisioning in flight |
| Doctor status | 0 failures, 1 warning (TLS cert provisioning — self-resolving) |

Known parity notes:

- `obs-Cloud SQL-data-health` exits 1 in dev with `pkm_coherence_mismatch` — the SAME
  anomaly its UAT runs currently fail with (data-shape issue inherited via the clone,
  not an environment defect).
- GitHub environment `dev` Workload Identity Federation variables are still pending,
  so the governed `Deploy to Dev` workflow cannot yet take over from manual bootstrap
  deploys.

## Identity Model (read this first)

The dev environment splits infrastructure identity from runtime identity on purpose:

| Layer | Value | Why |
| --- | --- | --- |
| GCP project | `hushh-pda-dev` | isolation from UAT |
| Cloud SQL instance | `hushh-pda-dev:us-central1:hushh-dev-pg` | own database |
| Frontend origin | `https://dev.one.hushh.ai` | own domain |
| Deploy labels / provenance | `deploy-env=dev`, `deploy-source=deploy-dev` | auditability |
| Backend runtime identity | `ENVIRONMENT=dev` | dev reports its own name (2026-08-07) |
| Frontend runtime identity | `NEXT_PUBLIC_APP_ENV=uat` | unchanged — see the note below |

**The backend now reports `dev`, and this section used to say it must not.** That warning
was right about one thing and wrong about another, and both are worth keeping:

- **Right: debug routes.** `/api/_debug/firebase` gated on the environment name alone and
  was closed only because dev reported `uat`. That gate now also requires *no deploy
  lane*, so it is open on a developer's machine and closed on every hosted lane including
  dev. The regression this section predicted was real, and is fixed rather than accepted.
- **Wrong: auth defaults.** `developer_api_enabled()` defaults true for anything that is
  not `production`, so `uat` and `dev` are identical. Same for SSE (`!= "production"`),
  CORS and database-on-startup (all `_is_production()`), the review-alias allowlist and
  `location.py`'s safe-environment set — every one admits `dev` and `uat` equally. The
  webhook auth defaults are moot because the dev lane sets them explicitly.

**`dev`, not `development`.** `runtime_providers/factory.py` keys `_HOSTED_ENVIRONMENTS`
on `{"dev","uat","staging","production","prod"}`, and that set gates the assertions that a
hosted runtime must use Vertex ADC and must carry `GOOGLE_CLOUD_PROJECT`. `dev` keeps those
guards; `development` is absent from the set and would quietly relax them.

**What changed behaviourally:** dev no longer resolves `HUSHH_UAT_PHONE_TEST_NUMBERS` /
`_CODE` as its own. It had been doing so silently — the dev revision mounts UAT's
phone-test secrets and, while it reported `uat`, treated them as its allowlist. Dev now
has its own simulation lane (`HUSHH_DEV_PHONE_TEST_NUMBERS`, reserved fictitious numbers,
OTP optional) which the deploy configures.

The override lives in `scripts/deploy/backend-deploy.sh`, not in `deploy-dev.yml`. The
deploy workflow definition always runs from `main`, so a substitution change there does
nothing for a branch deploy; the script ships from the deployed SHA. `deploy-dev.yml` still
passes `_RUNTIME_ENVIRONMENT=uat` and the script overrides it for the dev lane.

### The frontend half — safe now, still one `main`-side line

**The frontend still reports `uat`** (`_APP_ENV=uat`), because that substitution is set in
`deploy-dev.yml` and only a change on `main` can move it.

**Do not flip it without reading this.** The frontend is where the "auth defaults off"
warning is actually true — it was wrong about the backend and right here. The frontend type
has no `dev`: `normalizeEnvironment` maps `dev` → `development`, so `NEXT_PUBLIC_APP_ENV=dev`
makes `resolveAppEnvironment()` return `development`. Twelve auth bypasses were gated on
`isDevelopment()`, which asks only "is this build labelled development":

- `DEV_AUTO_GRANT` — auto-grants a consent token
- `Bearer DEV_TOKEN` — accepted as a valid Firebase session
- ten vault routes — `if (!validation.valid && !isDevelopment())` and
  `if (!authHeader && !isDevelopment())`, i.e. proceed anyway

All twelve would have turned on for an internet-reachable service holding real test
accounts.

They now use `devAuthBypassAllowed()`, which requires the development label **and** the
absence of `HUSHH_DEPLOY_ENV` — set on every hosted Cloud Run service (verified present on
`hushh-webapp` in `hushh-pda-dev`) and absent on a developer's machine. Every caller is a
server-side route handler, so the variable is read without a `NEXT_PUBLIC_` prefix on
purpose. Behaviour today is unchanged, because the frontend still reports `uat` and
`isDevelopment()` was already false on every hosted lane.

The other consumers were checked and are all binary `!== "production"`
(`nearby-check-in-availability`, `location-map-demo`, `ria-client-test-profile`,
`marketplace`, `ria/onboarding`, `observability/env`), so they do not move. The
`config.ts` URL fallbacks to `127.0.0.1:8000` and `localhost:3000` do not fire either:
`NEXT_PUBLIC_BACKEND_URL` and `NEXT_PUBLIC_APP_URL` are baked at build time from the
`BACKEND_URL` and `NEXT_PUBLIC_APP_URL` secrets, both confirmed present in
`hushh-pda-dev`.

**The substitution change is staged on the branch and awaits the Admin SOP.**
`deploy-dev.yml` now passes `_APP_ENV=dev` (frontend) and `_RUNTIME_ENVIRONMENT=dev`
(backend). Both are inert until that file lands on `main`, because the deploy workflow
definition always runs from there — the backend already reports `dev` regardless, via
the override in `scripts/deploy/backend-deploy.sh`, which is what makes a branch deploy
correct in the meantime.

`scripts/ops/setup_dev_cloudbuild_triggers.sh` was flipped in the same change. It is a
**second** deploy path into the same environment — a Cloud Build trigger that
auto-deploys the frontend to dev on `main` pushes — and leaving it at `uat` would have
made the two paths disagree, with whichever ran last deciding what dev reported.

After the SOP lands it, the frontend reports **`development`**, not `dev`: the frontend
vocabulary has no `dev`, and `normalizeEnvironment` maps it. The backend reports `dev`.
That asymmetry is a property of the two vocabularies, not a mistake.

The **local** `--mode dev` profile deliberately still hydrates `NEXT_PUBLIC_APP_ENV=uat`
(`scripts/env/bootstrap_profiles.sh`). Local has no deploy lane, so `development` there
would satisfy `devAuthBypassAllowed()` and turn on the vault auth bypasses while talking
to the shared dev backend. Changing that is a separate decision.

## Google OAuth return URIs, and what a local hub needs (corrected 2026-09-03)

The 2026-09-02 version of this section was wrong in three ways, each measured false by
probing the clients directly. Corrected:

- **There are two clients, not one.** `dev` **and every localhost port** use
  `745506018753-…` (which lives in the `hushh-pda-uat` project). **`uat` and `prod` share
  `1006304528804-…`** (in `hushh-pda`). So an entry added "for UAT" is an edit to the
  *production* client.
- **Every lane's `GMAIL_OAUTH_REDIRECT_URI` holds the `/one/profile/gmail/oauth/return`
  form**, including production — the deploy gate
  (`verify-env-secrets-parity.py --require-gmail`) requires exactly that.
- **uat and prod register both forms and need nothing.** The dev client is the outlier: it
  registers the no-`/one` Gmail shim and the `/one` **Google** return, but not the `/one`
  Gmail form. Dev Gmail connect therefore still needs one console entry
  (`https://dev.one.hushh.ai/one/profile/gmail/oauth/return`); it cannot be fixed from
  here, because no API edits a Web-application client's redirect URIs and the deploy gate
  runs from `main`. See `docs/reference/operations/env-and-secrets.md` § *Google OAuth
  redirect URIs, per lane* for the matrix and the probe that verifies it without console
  access.

Both no-`/one` paths 307 to their `/one` page with `code` and `state` intact (verified
live), so a registered shim is a real door, not a workaround.

**BYOC "give GCP access" no longer borrows the Gmail door.** `byoc_oauth_authorizer`
resolves `GOOGLE_OAUTH_REDIRECT_URI`, then the canonical
`/one/profile/google/oauth/return` derived from this deployment's own
`APP_FRONTEND_ORIGIN`. That URI is registered on all three lanes, so dev works with no
console change (verified live against the deployed hub).

## After pulling this branch — what every developer has to do once

Four steps, in this order. Three of them fail loudly and one fails silently.

1. **Re-sync the backend virtualenv.** The lockfile moved; the local hub refuses to start
   until you do (`The environment is outdated`).
   ```bash
   cd consent-protocol && uv sync --frozen --group dev
   ```
2. **Re-install frontend packages** if `npm` reports a missing binary
   (`sh: next: command not found`) — the webapp lockfile moved too.
   ```bash
   cd hushh-webapp && npm ci
   ```
3. **Add one line to your local `consent-protocol/.env`**, or BYOC and Calendar from a
   local hub die at Google with `redirect_uri_mismatch`. Localhost origins are not
   registered on the OAuth client and only the founder can add them, so a local hub
   borrows dev's registered Google return; the callback completes on the deployed dev
   frontend, which is fine because local rides the dev database and shares dev's
   `APP_SIGNING_KEY`, so the signed `state` validates there.
   ```bash
   GOOGLE_OAUTH_REDIRECT_URI=https://dev.one.hushh.ai/one/profile/google/oauth/return
   ```
4. **Mirror `HUSSH_ONE_POD_IMAGE` after every dev deploy.** This is the silent one: a
   stale value builds every new pod from an old image, and the symptoms look like pod
   bugs rather than a stale tag.
   ```bash
   gcloud run services describe consent-protocol --project hushh-pda-dev \
     --region us-central1 --format='value(spec.template.spec.containers[0].env)' \
     | tr ';' '\n' | grep -o 'consent-protocol-pod:dev-[a-f0-9]*'
   ```

No secret was created or rotated in any GCP project by this work, and no environment's
OAuth client id changed — nothing to re-fetch on the server side.

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
3. **Managed Vertex inference temporarily uses the UAT Vertex project.** The Dev
   Cloud Run service continues to run as
   `consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com`, but
   `GOOGLE_CLOUD_PROJECT=hushh-pda-uat` for managed Gemini text and One Live calls.
   Dev keeps its own Cloud Run and database resources while managed Gemini requests
   use UAT's working Vertex billing entitlement. UAT grants that Dev service account only
   `roles/aiplatform.user` and `roles/serviceusage.serviceUsageConsumer`; Dev usage
   therefore consumes UAT Vertex quota and appears in UAT billing and audit logs.
   The shared backend build rejects this override outside `deploy-env=dev`.
   The Dev Cloud Build identity has the UAT project-local
   `devVertexDeployVerifier` custom role with only
   `serviceusage.services.list` and `resourcemanager.projects.getIamPolicy`, allowing
   the build to verify those runtime grants without broad UAT Viewer access.

   Roll back after Google clears project `621416509462` by removing the Dev fallback
   from `deploy/backend.cloudbuild.yaml`, redeploying Dev, proving managed Vertex
   readiness against `hushh-pda-dev`, removing the two UAT IAM bindings from the Dev
   runtime service account, and removing the verifier-role binding from the Dev Cloud
   Build identity. Delete the custom role after no bindings remain.

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

The schema contract for dev is `consent-protocol/db/contracts/dev_minimum_schema.json`:
the UAT integrated schema as a **minimum floor** (`migration_version_policy: minimum`).
Dev may run AHEAD of UAT (train migrations land in dev first under the
[dev fast lane](../../../docs/reference/operations/dev-fast-lane.md)) but never behind it.

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
| `APP_FRONTEND_ORIGIN` | `https://dev.one.hushh.ai` |
| `BACKEND_URL` | dev backend Cloud Run URL (set after the first deploy) |
| `GMAIL_OAUTH_REDIRECT_URI` | `https://dev.one.hushh.ai/one/profile/gmail/oauth/return` when Gmail receipts or owner-approved send run in dev; it must exactly match `APP_FRONTEND_ORIGIN + /one/profile/gmail/oauth/return`. |

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
  (`localhost,127.0.0.1,one.hushh.ai,dev.one.hushh.ai`), and analytics ids on every
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

### Ed25519 consent-token signing (dev-only cutover)

Non-repudiation is staged on dev: `scripts/deploy/backend-deploy.sh` flips
`CONSENT_TOKEN_SIGNING_ALG=ed25519` **only** on the dev lane and **only when both
key secrets already exist** in `hushh-pda-dev`, so a deploy before the mint stays
HMAC and says so in the build log. UAT and production carry none of this by
construction (every value is dev-block-scoped and empty elsewhere;
`tests/test_consent_signing_dev_rollout_contract.py` keeps that a red/green fact).

The two secrets and their exact shapes (they must come from ONE keypair — a
mismatched pair verifies at the hub and fail-closes in every pod):

| Secret | Shape |
|---|---|
| `CONSENT_ED25519_PRIVATE_KEY` | base64 of the raw 32-byte Ed25519 seed |
| `CONSENT_ED25519_PUBLIC_KEYS` | JSON `{kid: b64_raw_32_public}` map |

Mint (and rotate) with the checked-in script — the seed rides stdin into Secret
Manager and is never printed:

```bash
cd consent-protocol
uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev
# rotation: mint -2 alongside -1, deploy + re-render pods, then drop -1 after
# outstanding tokens expire
uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev \
  --kid hushh-consent-dev-2 --rotate
```

Then grant the dev runtime read on both (same pattern as `HUSSH_POD_KEY_MASTER`)
and redeploy dev. Two standing caveats:

* **Pods receive verification keys at render time only** (`gcp_backend` injects
  `CONSENT_ED25519_PUBLIC_KEYS` from hub env into each render), so every key
  event — first flip, every rotation — ends with a pod re-render. Un-re-rendered
  pods keep working for turns (verification is hub-relayed) but their local a2a
  door fail-closes on ed25519 tokens until re-rendered.
* **Rollback** is deleting both secrets and redeploying: the existence gate
  reverts issuance to HMAC byte-identically. Outstanding ed25519 tokens then fail
  closed and dev's synthetic users re-consent — designed behavior, not a defect.

## Phase 4 — Deploy service account + GitHub wiring

```bash
# Service account with the narrowly scoped roles needed by the dev deploy workflow.
# Bind GitHub's OIDC principal through Workload Identity Federation; do not create a
# service-account key.
gcloud iam service-accounts create github-deployer \
  --project=hushh-pda-dev --display-name="GitHub Actions dev deployer"

for role in roles/cloudbuild.builds.editor roles/run.admin roles/iam.serviceAccountUser \
            roles/secretmanager.admin roles/cloudsql.client roles/storage.admin \
            roles/viewer; do
  gcloud projects add-iam-policy-binding hushh-pda-dev \
    --member="serviceAccount:github-deployer@hushh-pda-dev.iam.gserviceaccount.com" \
    --role="$role"
done

# Also grant roles/iam.serviceAccountUser on only:
# consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com
# Then configure the Workload Identity Pool/provider attribute condition for the
# exact hushh-labs/hushh-research repository and governed branch/environment.
```

In GitHub (`hushh-labs/hushh-research` → Settings → Environments):

1. Create environment **`dev`** (mirror any reviewer/branch protections from `uat`).
2. Add environment variable **`GCP_WORKLOAD_IDENTITY_PROVIDER`** = the full provider resource name.
3. Add environment variable **`GCP_DEPLOY_SERVICE_ACCOUNT`** = `github-deployer@hushh-pda-dev.iam.gserviceaccount.com`.
4. Do not create, download, or upload a service-account JSON key.

Dispatch governance is already wired: `config/ci-governance.json` has a `dev` surface
with the same governed actor list as UAT, enforced by
`scripts/ci/assert-governed-actor.py --surface dev`.

## Phase 5 — Domain mapping (optional for first deploy)

```bash
gcloud beta run domain-mappings create --service hushh-webapp \
  --domain dev.one.hushh.ai --region us-central1 --project hushh-pda-dev
# then add the DNS records it prints to the one.hushh.ai zone
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
  with `X-Hushh-Maintenance-Token: $ONE_LOCATION_RETENTION_TOKEN`.
  `deploy/one-location/setup_retention_scheduler.sh` is the operator-run UAT shape;
  use the same bounded endpoint for dev only after the UAT job is explicitly enabled.
- `marketplace-investor-replenisher-every-8h` and `obs-Cloud SQL-data-health-every-30m`
  trigger Cloud Run *jobs* that must first be created in dev
  (`deploy/marketplace/setup_investor_replenisher_scheduler.sh`,
  `deploy/observability/`); the doctor reports them as warnings until then.
- Do NOT schedule One Email watch renewal in dev — watch ownership stays with UAT
  (see divergences above).

## Phase 6c — GCP-native auto-deploy lane (Cloud Build triggers)

Complementing the governed `Deploy to Dev` workflow, dev can auto-deploy on every
push to `main` using Cloud Build triggers inside `hushh-pda-dev` — no GitHub
Actions dispatch required. This is the "commit and it ships to dev" lane:

```bash
bash scripts/ops/setup_dev_cloudbuild_triggers.sh
```

- **One-time human prerequisite:** the Cloud Build GitHub (2nd gen) host
  connection + repository link for `hushh-labs/hushh-research`, authorized in the
  console (the script detects it and prints exact instructions if missing).
- `dev-backend-autodeploy` fires on `main` pushes touching `consent-protocol/**`
  and runs `deploy/dev.autodeploy.backend.cloudbuild.yaml`: DB migrations + the
  `dev_minimum_schema.json` floor guard first, then the shared
  `deploy/backend.cloudbuild.yaml` (same substitution set as the workflow),
  then a provenance + health probe.
- `dev-frontend-autodeploy` fires on `main` pushes touching `hushh-webapp/**`
  and runs the shared `deploy/frontend.cloudbuild.yaml` directly with dev
  substitutions.
- Path filters replicate the workflow's auto-scope; `deploy-source` label is
  `cloudbuild-trigger` so revisions remain attributable per lane.
- **Gate honesty:** this lane keeps main-only + migrations + schema floor +
  health probe. It does NOT replicate the Actions lane's green-check SHA
  assertion, secret sync, parity/semantic verification, or auto-rollback. A
  `main` commit deploys immediately — possibly before its Post-Merge Smoke
  finishes. Dev is disposable by design; the fully-gated path remains the
  `Deploy to Dev` workflow. Never point triggers like these at UAT/production.

## Contributor usage once dev is live

```bash
./bin/hushh bootstrap                 # hydrates hushh-webapp/.env.dev.local from hushh-pda-dev
./bin/hushh web --mode dev            # local frontend against the dev backend
./bin/hushh doctor --mode dev
./bin/hushh db verify-dev-schema      # dev DB vs the UAT schema contract
```

Non-default project id? Export `DEV_PROJECT_ID=<project>` before running the tooling;
`bootstrap_profiles.sh` also accepts `--dev-project <project>`.
