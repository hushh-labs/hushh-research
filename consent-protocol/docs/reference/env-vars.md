# Environment Variables

> Backend environment variables and secrets reference. See `.env.example` for the template.


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## Parity Rule

What is in `.env` / GCP Secret Manager must match exactly what the code reads -- no extra keys, no missing keys.

- **Local:** `.env` must contain exactly the keys the application code reads. Use `.env.example` as the template.
- **Production:** GCP Secret Manager must hold exactly the secrets the code expects. Cloud Run config injects only these.

---

## Variables

| Variable | Where Read | Required | Notes |
|----------|------------|----------|-------|
| `APP_SIGNING_KEY` | `hushh_mcp/config.py` | Yes | Min 32 chars (64-char hex recommended). HMAC signing and state integrity only. |
| `VAULT_DATA_KEY` | `hushh_mcp/config.py` | Yes | Exactly 64-char hex. Vault/PKM data encryption only. |
| `DB_USER` | `db/connection.py`, `db/db_client.py` | Yes | Supabase pooler username. |
| `DB_PASSWORD` | same | Yes | Database password. |
| `DB_HOST` | same | Yes | Supabase session pooler host. |
| `DB_PORT` | same | No | Default: 5432. |
| `DB_NAME` | same | No | Default: postgres. |
| `REQUIRE_DATABASE_ON_STARTUP` | `server.py` | No | Optional startup strictness override. Defaults to `true` in production and `false` in development; when `false`, local startup warns instead of failing if the DB is offline, but schema mismatches still fail. |
| `APP_FRONTEND_ORIGIN` | `server.py` | Yes (prod) | Backend-owned app origin for CORS and user-facing links. Not part of the public MCP host setup. |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | `api/utils/firebase_admin.py` | Yes | Default Firebase Admin credential for server operations (FCM/admin). |
| `GOOGLE_API_KEY` | `hushh_mcp/config.py`, services | Yes | Gemini / Vertex AI API key. |
| `SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON` | `hushh_mcp/services/support_email_service.py` | Optional | Dedicated service account JSON for support mail. If unset, support mail falls back to `FIREBASE_ADMIN_CREDENTIALS_JSON`. |
| `SUPPORT_EMAIL_DELEGATED_USER` | `hushh_mcp/services/support_email_service.py` | Recommended | Workspace mailbox to impersonate for Gmail send. Default: `support@hushh.ai`. |
| `SUPPORT_EMAIL_FROM` | `hushh_mcp/services/support_email_service.py` | Optional | Visible `From` address for outgoing support mail. Defaults to `SUPPORT_EMAIL_DELEGATED_USER`. |
| `SUPPORT_EMAIL_TO` | `hushh_mcp/services/support_email_service.py` | Recommended | Live support inbox recipient. Default: `support@hushh.ai`. |
| `SUPPORT_EMAIL_TEST_TO` | `hushh_mcp/services/support_email_service.py` | Optional | Test-mode recipient override for non-production verification. |
| `SUPPORT_EMAIL_MODE` | `hushh_mcp/services/support_email_service.py` | Optional | `live` or `test`. If unset, non-production defaults to `test` when `SUPPORT_EMAIL_TEST_TO` exists. |
| `GMAIL_OAUTH_CLIENT_ID` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Gmail OAuth client id. Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_CLIENT_SECRET` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Gmail OAuth client secret. Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_REDIRECT_URI` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Gmail OAuth redirect URI. Same key name across local, UAT, and production. |
| `GMAIL_OAUTH_TOKEN_KEY` | `hushh_mcp/services/gmail_receipts_service.py` | Yes (Gmail sync) | Encryption key for persisted Gmail OAuth tokens. Same key name across local, UAT, and production. |
| `OPENAI_API_KEY` | `hushh_mcp/services/voice_intent_service.py` | Yes (voice) | Required for voice STT, planning, TTS, and realtime session creation. |
| `VOICE_RUNTIME_CONFIG_JSON` | `hushh_mcp/runtime_settings.py`, `api/routes/kai/voice.py`, `hushh_mcp/services/voice_intent_service.py` | Yes (voice) | Structured runtime config for rollout, allowlists/canary, fail-fast policy, and model defaults. |
| `DEFAULT_CONSENT_TOKEN_EXPIRY_MS` | `hushh_mcp/config.py` | No | Token TTL (default: 24h). |
| `DEFAULT_TRUST_LINK_EXPIRY_MS` | `hushh_mcp/config.py` | No | TrustLink TTL. |
| `ENVIRONMENT` | `hushh_mcp/config.py` | No | `production` or `development` (default). |
| `AGENT_ID` | `hushh_mcp/config.py` | No | Default: `agent_hushh_default`. |
| `HUSHH_HACKATHON` | `hushh_mcp/config.py` | No | Feature flag (default: disabled). |
| `CONSENT_TIMEOUT_SECONDS` | `api/routes/sse.py`, `developer.py` | No | Consent wait timeout. |
| `CONSENT_SSE_ENABLED` | `api/routes/sse.py` | No | Defaults off in production. |
| `DEVELOPER_API_ENABLED` | `api/routes/developer.py`, `server.py` | No | Enables `/api/v1/*`; defaults false in production unless explicitly enabled. |
| `REMOTE_MCP_ENABLED` | `api/developer_auth.py`, `mcp_remote.py` | No | Enables hosted remote MCP transport at `/mcp`. |
| `SYNC_REMOTE_ENABLED` | deploy/runtime env contract | No | Legacy deploy flag; keep false unless the runtime reintroduces an active reader. |
| `HUSHH_DEVELOPER_TOKEN` | `api/routes/session.py`, `mcp_server.py` | Optional | Self-serve developer token used by stdio MCP and token-auth `/api/user/lookup`. It is not part of the normal hosted runtime contract. |
| `ROOT_PATH` | `server.py` | No | FastAPI root path for reverse proxy. |
| `GOOGLE_GENAI_USE_VERTEXAI` | Cloud Run env | No | Set `True` for Vertex AI in production. |
| `PLAID_ENV` / `PLAID_ENVIRONMENT` | `hushh_mcp/services/plaid_portfolio_service.py` | No | Plaid environment. Defaults to `sandbox`. |
| `PLAID_CLIENT_ID` | `hushh_mcp/services/plaid_portfolio_service.py` | If Plaid enabled | Plaid client ID. |
| `PLAID_SECRET` | `hushh_mcp/services/plaid_portfolio_service.py` | If Plaid enabled | Plaid secret for the selected environment. |
| `PLAID_CLIENT_NAME` | `hushh_mcp/services/plaid_portfolio_service.py` | No | Link display name. Defaults to `Hushh Kai`. |
| `PLAID_COUNTRY_CODES` | `hushh_mcp/services/plaid_portfolio_service.py` | No | Comma-separated country codes, default `US`. |
| `PLAID_WEBHOOK_URL` | `hushh_mcp/services/plaid_portfolio_service.py` | Recommended | Public webhook URL for `/api/kai/plaid/webhook`. Localhost must use a tunnel. Plaid webhook URLs are provided during Link token creation; they are not dashboard-allowlisted. |
| `PLAID_REDIRECT_PATH` | `hushh_mcp/services/plaid_portfolio_service.py` | Recommended for OAuth | Relative callback path used with `APP_FRONTEND_ORIGIN`. Default: `/kai/plaid/oauth/return`. |
| `PLAID_REDIRECT_URI` / `PLAID_OAUTH_REDIRECT_URI` | `hushh_mcp/services/plaid_portfolio_service.py` | Optional override | Full allowlisted redirect URI, including path. Use only when overriding `APP_FRONTEND_ORIGIN + PLAID_REDIRECT_PATH`. |
| `PLAID_ACCESS_TOKEN_KEY` | `hushh_mcp/services/plaid_portfolio_service.py` | Recommended | Encryption key for stored Plaid access tokens. Keep the same value anywhere that must read/write the same Plaid item records, especially `local` and UAT when they share a DB. If omitted, backend derives a fallback key from Plaid credentials. |
| `PLAID_TX_HISTORY_DAYS` | `hushh_mcp/services/plaid_portfolio_service.py` | No | Investment transaction lookback window. Default `730`. |
| `PLAID_WEBHOOK_VERIFICATION_ENABLED` | `hushh_mcp/services/broker_funding_service.py` | Recommended | Enables Plaid webhook JWT signature verification (default `true`). |
| `PLAID_WEBHOOK_MAX_SKEW_SECONDS` | `hushh_mcp/services/broker_funding_service.py` | No | Max allowed clock skew for Plaid webhook `iat` claim. Default `300`. |
| `ALPACA_ENV` / `ALPACA_BROKER_ENV` | `hushh_mcp/integrations/alpaca/config.py` | No | Alpaca Broker environment. Defaults to `sandbox`. |
| `ALPACA_BROKER_BASE_URL` / `BROKER_API_BASE` | `hushh_mcp/integrations/alpaca/config.py` | Optional | Override Alpaca Broker API base URL. |
| `ALPACA_BROKER_AUTH_TOKEN` / `BROKER_TOKEN` / `ALPACA_AUTH_TOKEN` | `hushh_mcp/integrations/alpaca/config.py` | Optional | Pre-built Authorization header token (Basic or Bearer). |
| `ALPACA_BROKER_KEY_ID` / `APCA_API_KEY_ID` / `ALPACA_API_KEY` | `hushh_mcp/integrations/alpaca/config.py` | If Alpaca enabled | Alpaca API key ID for Basic auth generation. |
| `ALPACA_BROKER_SECRET` / `APCA_API_SECRET_KEY` / `ALPACA_API_SECRET` | `hushh_mcp/integrations/alpaca/config.py` | If Alpaca enabled | Alpaca API secret for Basic auth generation. |
| `ALPACA_DEFAULT_ACCOUNT_ID` | `hushh_mcp/integrations/alpaca/config.py` | Recommended | Default Alpaca account ID for funding when user-specific mapping is absent. |
| `ALPACA_CONNECT_CLIENT_ID` | `hushh_mcp/services/broker_funding_service.py` | If Alpaca OAuth connect enabled | Alpaca OAuth app client ID for user login flow. |
| `ALPACA_CONNECT_CLIENT_SECRET` | `hushh_mcp/services/broker_funding_service.py` | If Alpaca OAuth connect enabled | Alpaca OAuth app client secret. |
| `ALPACA_CONNECT_REDIRECT_URI` / `ALPACA_OAUTH_REDIRECT_URI` | `hushh_mcp/services/broker_funding_service.py` | If Alpaca OAuth connect enabled | HTTPS callback URI for Alpaca OAuth code exchange. |
| `ALPACA_CONNECT_AUTHORIZE_URL` | `hushh_mcp/services/broker_funding_service.py` | No | Override OAuth authorize endpoint. Default `https://app.alpaca.markets/oauth/authorize`. |
| `ALPACA_CONNECT_TOKEN_URL` | `hushh_mcp/services/broker_funding_service.py` | No | Override OAuth token endpoint. Default `https://api.alpaca.markets/oauth/token`. |
| `ALPACA_CONNECT_ACCOUNT_URL` | `hushh_mcp/services/broker_funding_service.py` | No | OAuth Bearer account profile endpoint. Default `https://api.alpaca.markets/v2/account`. |
| `ALPACA_CONNECT_SCOPES` | `hushh_mcp/services/broker_funding_service.py` | No | Space-delimited OAuth scopes for authorize URL. Default `account:write trading`. |
| `ALPACA_CONNECT_ENV` | `hushh_mcp/services/broker_funding_service.py` | No | Authorize URL env hint (`paper` or `live`). Defaults by Alpaca runtime env. |
| `ALPACA_CONNECT_STATE_TTL_SECONDS` | `hushh_mcp/services/broker_funding_service.py` | No | OAuth state/session TTL in seconds. Default `900`. |
| `FUNDING_SECRET_ENCRYPTION_KEY` | `hushh_mcp/services/broker_funding_service.py` | Recommended | Encryption key for stored Plaid access tokens and processor tokens in funding tables. |
| `FUNDING_ACH_RELATIONSHIP_POLL_SECONDS` | `hushh_mcp/services/broker_funding_service.py` | No | Max seconds to poll Alpaca ACH relationship approval. Default `15`. |
| `FUNDING_ACH_RELATIONSHIP_POLL_INTERVAL_SECONDS` | `hushh_mcp/services/broker_funding_service.py` | No | Poll interval for ACH approval status. Default `2`. |
| `FUNDING_TRANSFER_MAX_INCOMING_USD` | `hushh_mcp/services/broker_funding_service.py` | No | Max allowed incoming funding transfer amount. Default `250000`. |
| `FUNDING_TRANSFER_MAX_OUTGOING_USD` | `hushh_mcp/services/broker_funding_service.py` | No | Max allowed outgoing funding transfer amount. Default `250000`. |
| `FUNDING_STALE_PENDING_SECONDS` | `hushh_mcp/services/broker_funding_service.py` | No | Reconciliation stale-pending threshold. Default `172800` (48h). |

---

## MCP Server Variables

These are read by `mcp_server.py` (separate from the main FastAPI server):

| Variable | Default | Description |
|----------|---------|-------------|
| `CONSENT_API_URL` | `http://127.0.0.1:8000` | FastAPI backend URL. Defaults to loopback + `PORT` when unset. |
| `APP_FRONTEND_ORIGIN` | `http://localhost:3000` | Backend-owned app origin for user-facing links. Do not add this to public MCP host configs. |
| `PRODUCTION_MODE` | `true` | Require real user approval via Hussh app. |
| `HUSHH_DEVELOPER_TOKEN` | _(none)_ | Self-serve developer token for stdio MCP. |
| `CONSENT_TIMEOUT_SECONDS` | `120` | Max wait for user consent approval. |

---

## Migrations and Scripts

Migration scripts use `DB_*` variables only (same as runtime). `db/migrate.py` uses `db.connection.get_database_url()` and `get_database_ssl()`. There is no `DATABASE_URL` variable.

## Kai Portfolio Import Model Policy

Kai portfolio import model selection is constants-driven in `hushh_mcp/constants.py` (`KAI_PORTFOLIO_IMPORT_*` constants) rather than per-environment toggles. Runtime environment controls provider/auth (`GOOGLE_GENAI_USE_VERTEXAI`, Vertex project/location credentials, API key).

## Kai Portfolio Import Upload Limits

Portfolio import endpoints accept statement uploads up to **25MB** (`/api/kai/portfolio/import`, `/api/kai/portfolio/import/run/start`, `/api/kai/portfolio/import/stream`).
This accommodates longer brokerage statements while preserving relevance/quality gates.

Kai generation behavior for import/optimize/debate is also constants-driven (not `.env` toggles):

- `KAI_LLM_TEMPERATURE=0.0` (deterministic)
- `KAI_LLM_THINKING_ENABLED`
- `KAI_LLM_THINKING_LEVEL`
- `KAI_LLM_STREAM_INCLUDE_THOUGHTS`
- `KAI_OPTIMIZE_STREAM_TIMEOUT_SECONDS`

Maintainer-only overlay vars used by release verification, migration/reset utilities, and review flows:

- `UAT_SMOKE_USER_ID`
- `UAT_SMOKE_PASSPHRASE`
- `APP_REVIEW_MODE`
- `REVIEWER_UID`

Notes:

- These maintainer-only overlay vars are loaded by backend scripts and release verification at process start.
- Changing them requires restarting the backend or rerunning the script; they are not hot-reloaded into an already running process.

Maintainer-only non-production bypass overlay:

- `ADVISORY_VERIFICATION_BYPASS_ENABLED`
  - enables non-production advisory bypass for the professional onboarding flow
  - has no effect in `production`
- `BROKER_VERIFICATION_BYPASS_ENABLED`
  - enables non-production broker-capability bypass
  - has no effect in `production`
- `RIA_DEV_BYPASS_ENABLED`
  - legacy compatibility alias for advisory bypass only
  - prefer `ADVISORY_VERIFICATION_BYPASS_ENABLED` in new configs

Professional verification providers:

- `RIA_INTELLIGENCE_VERIFY_BASE_URL`
- `RIA_INTELLIGENCE_VERIFY_ENDPOINT_PATH`
- `RIA_INTELLIGENCE_VERIFY_URL`
- `RIA_INTELLIGENCE_VERIFY_API_KEY`
- `RIA_INTELLIGENCE_VERIFY_TIMEOUT_SECONDS`
- `IAPD_VERIFY_BASE_URL`
- `IAPD_VERIFY_API_KEY`
- `IAPD_VERIFY_TIMEOUT_SECONDS`
- `BROKER_CAPABILITY_ENABLED`
- `BROKER_VERIFY_BASE_URL`
- `BROKER_VERIFY_API_KEY`
- `BROKER_VERIFY_TIMEOUT_SECONDS`
- `BROKER_PUBLIC_FALLBACK_ENABLED`

## Kai Brokerage Boundary

Kai now supports embedded bank funding orchestration using:

- Plaid Link/Auth + processor token creation (`processor=alpaca`)
- Alpaca Broker ACH relationship creation and approval tracking
- Alpaca Broker transfer create/get/cancel orchestration
- webhook verification + replay protection for Plaid funding webhooks
- reconciliation and support escalation tables for transfer lifecycle auditing

Existing Plaid investment-sync variables remain valid for read-only holdings/transactions refresh flows.

Webhook maintenance:

- If `PLAID_WEBHOOK_URL` changes after users have already linked institutions, existing Items will need a one-time `/item/webhook/update` maintenance pass from an operator.
- UAT value: `https://uat.kai.hushh.ai/api/kai/plaid/webhook`
- Localhost value: `https://<your-current-tunnel>/api/kai/plaid/webhook`

## Profile Support Messaging

Profile support / bug-report emails are sent through Gmail API using a delegated
Workspace mailbox. The service account source is:

- `SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON`, if provided
- otherwise `FIREBASE_ADMIN_CREDENTIALS_JSON`

- delegated sender: `SUPPORT_EMAIL_DELEGATED_USER` (must be a real mailbox user)
- visible From address: `SUPPORT_EMAIL_FROM` (default matches delegated user)
- live inbox: `SUPPORT_EMAIL_TO`
- optional non-production test inbox: `SUPPORT_EMAIL_TEST_TO`

RIA invite emails reuse this same Gmail authorization path and delegated sender.
The recipient becomes the investor invite target, but the Workspace delegation
requirements stay the same.

Recommended local testing:

- `SUPPORT_EMAIL_DELEGATED_USER=kushal@hushh.ai`
- `SUPPORT_EMAIL_FROM=support@hushh.ai`
- `SUPPORT_EMAIL_TO=support@hushh.ai`
- `SUPPORT_EMAIL_TEST_TO=kushal@hushh.ai`
- `SUPPORT_EMAIL_MODE=test`

This path requires Workspace domain-wide delegation for the chosen service account client ID with:

- `https://www.googleapis.com/auth/gmail.send`

`SUPPORT_EMAIL_DELEGATED_USER` cannot be a Google Group. A group like `support@hushh.ai` can be the visible sender or recipient inbox, but it cannot be the delegated Gmail user.

Local runtime bootstrap:

- `bash scripts/env/bootstrap_profiles.sh` hydrates Gmail and voice backend secrets into `consent-protocol/.env` from the selected cloud project when those secrets are available.
- The key names are identical across local, UAT, and production. Only the secret values differ by project.
- Missing Gmail/voice values are warnings by default and become failures only when bootstrap is run with `--strict`.

---

## Secrets in Production

| Variable | Secret | Where Set |
|----------|--------|-----------|
| `APP_SIGNING_KEY` | Yes | GCP Secret Manager |
| `VAULT_DATA_KEY` | Yes | GCP Secret Manager |
| `DB_USER` | Yes | GCP Secret Manager |
| `DB_PASSWORD` | Yes | GCP Secret Manager |
| `APP_FRONTEND_ORIGIN` | Yes | GCP Secret Manager |
| `GOOGLE_API_KEY` | Yes | GCP Secret Manager |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | Yes | GCP Secret Manager |
| `GMAIL_OAUTH_CLIENT_ID` | Yes | GCP Secret Manager |
| `GMAIL_OAUTH_CLIENT_SECRET` | Yes | GCP Secret Manager |
| `GMAIL_OAUTH_REDIRECT_URI` | Yes | GCP Secret Manager |
| `GMAIL_OAUTH_TOKEN_KEY` | Yes | GCP Secret Manager |
| `OPENAI_API_KEY` | Yes | GCP Secret Manager |
| `BACKEND_RUNTIME_CONFIG_JSON` | Yes | GCP Secret Manager |
| `VOICE_RUNTIME_CONFIG_JSON` | Yes | GCP Secret Manager |
| `DB_HOST` | No | Cloud Run env var |
| `DB_PORT` | No | Cloud Run env var |
| `DB_NAME` | No | Cloud Run env var |
| `ENVIRONMENT` | No | Cloud Run env var |
| `GOOGLE_GENAI_USE_VERTEXAI` | No | Cloud Run env var |

---

## See Also

- [FCM Notifications](./fcm-notifications.md) -- Firebase push notification setup
- [Consent Protocol](./consent-protocol.md) -- Token lifecycle
- [.env.example](../../.env.example) -- Template file
