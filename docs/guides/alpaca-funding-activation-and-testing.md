# Alpaca Funding Activation and Testing

Runbook for Kai's writable Plaid funding-bank -> Alpaca ACH funding -> funded trade lane.

## Visual Context

Canonical flow owners:

- `docs/reference/architecture/api-contracts.md`
- `docs/reference/kai/kai-interconnection-map.md`

Use this guide for operator activation, smoke, blocking-reason diagnosis, and supervised-v1 recovery.

## Scope

This guide covers the hosted runtime used by:

1. Plaid bank-link and OAuth resume
2. funding-account eligibility projection
3. Plaid `processor_token` creation for `alpaca`
4. Alpaca brokerage account connect or mapping
5. Alpaca ACH relationship creation
6. bank -> Alpaca transfer creation
7. funded trade progression after funded settlement

Current release posture:

- this lane is writable and distinct from the read-only Plaid brokerage sync
- v1 is supervised and polling-driven
- funded trades are not documented as fully unattended
- operators may need transfer refresh or funding reconciliation to advance stale state

Core backend owner files:

- `consent-protocol/hushh_mcp/services/broker_funding_service.py`
- `consent-protocol/api/routes/kai/plaid.py`
- `deploy/backend.cloudbuild.yaml`

## Supported Modes

### Broker-auth-only mode

Use this when Kai only has Alpaca Broker auth and the user already has a known Alpaca account mapping.

Requirements:

- Plaid hosted secrets present
- one Alpaca Broker auth option present:
  `ALPACA_BROKER_CLIENT_ID` + `ALPACA_BROKER_CLIENT_SECRET`
  or
  `ALPACA_BROKER_AUTH_TOKEN`
  or `ALPACA_BROKER_KEY_ID` + `ALPACA_BROKER_SECRET`
  or source-secret compatibility pair
  `ALPACA_API_KEY` + `ALPACA_API_SECRET`
- Kai already knows which Alpaca account to use through:
  - explicit `alpaca_account_id`
  - stored default brokerage mapping
  - latest ACH relationship account
  - optional `ALPACA_DEFAULT_ACCOUNT_ID`

What this mode supports:

- Plaid funding link
- funding-account selection
- processor-token handoff
- ACH relationship create or reuse
- transfer create
- funded trade progression

What this mode does not support:

- self-serve Alpaca onboarding for a new user
- user-driven Alpaca OAuth account connect

Expected block when no Alpaca account is already known:

- `ALPACA_ACCOUNT_REQUIRED`
- or `ALPACA_ACCOUNT_NOT_MAPPED`

### Full Alpaca Connect onboarding

Use this when a new user must self-serve link an Alpaca brokerage account through Kai.

Additional hosted requirements:

- `ALPACA_CONNECT_CLIENT_ID`
- `ALPACA_CONNECT_CLIENT_SECRET`
- `ALPACA_CONNECT_REDIRECT_URI`
- `ALPACA_CONNECT_AUTHORIZE_URL`
- `ALPACA_CONNECT_TOKEN_URL`
- `ALPACA_CONNECT_ACCOUNT_URL`
- `ALPACA_CONNECT_SCOPES`
- `ALPACA_CONNECT_ENV`
- `ALPACA_CONNECT_STATE_TTL_SECONDS`

What this mode adds:

- `/api/kai/alpaca/connect/start`
- `/api/kai/alpaca/connect/complete`
- secure browser state only; no Alpaca OAuth token is stored in the browser

Expected block when Connect is not configured:

- `ALPACA_CONNECT_NOT_CONFIGURED`

## Required Hosted Secrets

Keep these in GCP Secret Manager:

- Plaid:
  `PLAID_CLIENT_ID`
  `PLAID_SECRET`
  `PLAID_TOKEN_ENCRYPTION_KEY`
- dedicated funding secret storage:
  `FUNDING_SECRET_ENCRYPTION_KEY`
- full Alpaca Connect onboarding:
  `ALPACA_CONNECT_CLIENT_ID`
  `ALPACA_CONNECT_CLIENT_SECRET`
- one Alpaca Broker auth option:
  `ALPACA_BROKER_CLIENT_ID` + `ALPACA_BROKER_CLIENT_SECRET`
  or
  `ALPACA_BROKER_AUTH_TOKEN`
  or `ALPACA_BROKER_KEY_ID` + `ALPACA_BROKER_SECRET`
  or source-secret compatibility pair
  `ALPACA_API_KEY` + `ALPACA_API_SECRET`

Hosted parity command:

```bash
python3 scripts/ops/verify-env-secrets-parity.py \
  --project hushh-pda-uat \
  --region us-central1 \
  --backend-service consent-protocol \
  --frontend-service hushh-webapp \
  --require-plaid \
  --require-alpaca-funding \
  --assert-runtime-env-contract
```

Hosted deploy normalization:

- runtime `ALPACA_BROKER_CLIENT_ID` and `ALPACA_BROKER_CLIENT_SECRET` are injected directly from the canonical AuthX secret names when present
- runtime `ALPACA_BROKER_KEY_ID` may be sourced from secret `ALPACA_API_KEY`
- runtime `ALPACA_BROKER_SECRET` may be sourced from secret `ALPACA_API_SECRET`
- runtime still stays canonical inside Kai; compatibility is only at the deploy/secret boundary
- do not reuse `ALPACA_CONNECT_CLIENT_ID` and `ALPACA_CONNECT_CLIENT_SECRET` for Broker machine auth

Hosted security rule:

- `FUNDING_SECRET_ENCRYPTION_KEY` is required for hosted funding lanes
- fallback-derived encryption behavior is not release-ready for UAT or production

## Required Hosted Runtime Envs

Cloud Run backend envs are wired through `deploy/backend.cloudbuild.yaml`.

Plaid runtime:

- `PLAID_ENV`
- `PLAID_CLIENT_NAME`
- `PLAID_COUNTRY_CODES`
- `PLAID_WEBHOOK_URL`
- `PLAID_REDIRECT_PATH`
- optional `PLAID_REDIRECT_URI`
- `PLAID_TX_HISTORY_DAYS`

Alpaca runtime:

- `ALPACA_ENV`
- `ALPACA_BROKER_BASE_URL`
- `ALPACA_DEFAULT_ACCOUNT_ID`
- `ALPACA_CONNECT_REDIRECT_URI`
- `ALPACA_CONNECT_AUTHORIZE_URL`
- `ALPACA_CONNECT_TOKEN_URL`
- `ALPACA_CONNECT_ACCOUNT_URL`
- `ALPACA_CONNECT_SCOPES`
- `ALPACA_CONNECT_ENV`
- `ALPACA_CONNECT_STATE_TTL_SECONDS`

Current deploy defaults:

1. UAT: live Plaid + Alpaca `sandbox` + Alpaca Connect `paper`
2. Production: live Plaid + Alpaca Broker `live` + Alpaca Connect `live`

Naming rule:

- `ALPACA_ENV` selects Broker API `sandbox|live` and still accepts `production` as a compatibility alias
- `ALPACA_CONNECT_ENV` selects Connect authorize `paper|live`

Production guardrail:

- keep live incoming ACH funding feature-gated until Alpaca partner enablement for the intended production transfer path is explicitly confirmed

## Funding Readiness Model

`POST /api/kai/plaid/funding/exchange-public-token` and `GET /api/kai/plaid/funding/status/{user_id}` return a top-level `readiness` block so the UI and operators can see where the flow is blocked without inspecting internal tables.

Readiness fields:

- `plaid_item_linked`
- `eligible_funding_account_selected`
- `auth_snapshot_ready`
- `alpaca_account_linked`
- `processor_handoff_ready`
- `ach_relationship_ready`
- `blocking_reason`

Per-account contract:

- each eligible funding account may include `auth_summary`
- `auth_summary` contains sanitized Plaid Auth-derived metadata only:
  - `has_ach_numbers`
  - `verification_status`
  - `is_tokenized_account_number`
  - summarized `network_status`
  - `auth_fetched_at`
  - `auth_fingerprint`

Data-handling rule:

- raw routing numbers are never returned
- raw account numbers are never returned
- full Plaid Auth payload is never echoed

## Blocking Reasons and Operator Action

| `blocking_reason` | Meaning | Operator action |
| --- | --- | --- |
| `NO_ELIGIBLE_ACH_ACCOUNT` | Plaid item linked, but no ACH-eligible depository account is usable for funding | relink bank with a supported checking/savings account or choose a different eligible account |
| `ALPACA_ACCOUNT_REQUIRED` | broker auth exists, but Kai has no Alpaca account selection for this user | connect Alpaca or persist a brokerage account mapping before trying transfer creation |
| `ALPACA_ACCOUNT_NOT_MAPPED` | an Alpaca account was requested or inferred, but Kai could not resolve a valid mapping | repair mapping through `/api/kai/plaid/funding/brokerage-account` or retry Connect completion |
| `ALPACA_CONNECT_NOT_CONFIGURED` | hosted env is missing Alpaca Connect config for self-serve onboarding | add Connect secrets/runtime config or fall back to broker-auth-only mode with pre-mapped account |
| `ACH_RELATIONSHIP_PENDING` | processor handoff succeeded, but Alpaca relationship is not yet approved | wait, poll transfer readiness, or run funding reconciliation before retrying transfer creation |
| `ACH_RELATIONSHIP_FAILED` | relationship creation or reuse did not reach a usable state | inspect relationship history, recreate if allowed, and escalate if repeated |

## Supervised V1 Operator Flow

1. Open Kai funding flow and click `Connect bank account`.
2. Complete Plaid Link. For OAuth banks, confirm the redirect returns to `/kai/plaid/oauth/return` and Kai resumes Link automatically.
3. Verify funding status shows:
   - linked Plaid funding item
   - eligible funding account
   - `auth_snapshot_ready=true`
   - no blocking reason unless Alpaca is still unresolved
4. Choose the mode:
   - broker-auth-only mode if Alpaca account is already mapped
   - full Alpaca Connect onboarding if the user still needs brokerage OAuth
5. Verify readiness now shows:
   - `alpaca_account_linked=true`
   - `processor_handoff_ready=true`
6. Create or refresh the ACH relationship and confirm it reaches a usable state. `approved` is the preferred steady state.
7. Create a small transfer and confirm Kai records the Alpaca transfer with `timing=immediate`.
8. Start a funded trade intent and confirm it enters `funding_pending`.
9. Keep the funding-trade view open or trigger refresh manually. If state does not advance, run `/api/kai/plaid/funding/reconcile`.
10. Confirm the Alpaca order is submitted only after funded settlement is confirmed.

Operational rule:

- if a funded trade remains `funding_pending`, do not describe that as a product failure until transfer refresh and funding reconciliation have both been attempted

## Webhook Expectations

Plaid webhook verification is enforced in the funding service. Hosted environments must deliver the `Plaid-Verification` header to `POST /api/kai/plaid/webhook`.

Current funding webhook behavior:

1. ES256 Plaid webhook signatures are verified against `/webhook_verification_key/get`
2. funding item status is flipped to `relink_required` or `permission_revoked` on Plaid item revocation events
3. funding transaction sync responds to `TRANSACTIONS: SYNC_UPDATES_AVAILABLE`

Webhook scope note:

- this v1 lane depends on Plaid webhook verification for Plaid-side updates
- funded-trade settlement progression is still polling-driven and reconciliation-driven
- Alpaca webhook/SSE is not part of this release posture

## Failure Modes

- Missing `resume_session_id` on OAuth banks means the hosted backend is missing migration `047_kai_funding_plaid_link_sessions.sql` or stale code.
- Missing `FUNDING_SECRET_ENCRYPTION_KEY` is a hosted deployment blocker.
- If Alpaca Broker auth secrets are absent, Plaid bank linking still succeeds but ACH relationship creation, transfer creation, and funded trade execution cannot complete.
- If only `ALPACA_API_KEY` and `ALPACA_API_SECRET` exist in Secret Manager, hosted deploy can still succeed only for the legacy Basic-auth path because they are mapped into the canonical Kai Basic runtime env names.
- If you intend to use AuthX Broker OAuth, `ALPACA_BROKER_CLIENT_ID` and `ALPACA_BROKER_CLIENT_SECRET` must exist as separate hosted secrets.
- If Alpaca Connect secrets are absent, broker-auth-only mode may still work for pre-mapped accounts, but self-serve onboarding is blocked.
- If the ACH relationship remains pending, operators should use polling and `/api/kai/plaid/funding/reconcile` before marking the flow stuck.
