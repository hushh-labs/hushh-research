# API Contracts

> Complete endpoint reference, authentication model, and developer integration guide.

---

## Token Hierarchy

All data access is gated by consent tokens. Firebase auth is only used to bootstrap the initial VAULT_OWNER token.

```
Firebase Sign-In
      │
      ▼
POST /api/consent/vault-owner-token  (Firebase Bearer)
      │
      ▼
  VAULT_OWNER Token (24h)
      │
      ├── All vault/data operations
      ├── Agent operations
      └── Can delegate scoped tokens to MCP agents (7d)
```

| Token Type            | Purpose                            | Duration | Auth Format                    |
| --------------------- | ---------------------------------- | -------- | ------------------------------ |
| Firebase ID Token     | Identity verification only       | 1 hour   | `Bearer <firebase-id-token>`   |
| VAULT_OWNER Token     | Consent + identity for all data  | 24 hours | `Bearer <vault-owner-token>`   |
| Agent Scoped Token    | Delegated MCP agent access       | 7 days   | `Bearer <consent-token>`       |
| Developer Token       | External API and remote MCP access | N/A    | `?token=<developer-token>`     |

---

## Route Categories

### Public (No Auth)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/health` | Detailed health check with agent list |
| GET | `/api/kai/health` | Kai subsystem health |
| GET | `/api/investors/search?q={name}` | Fuzzy search investors by name |
| GET | `/api/investors/{investor_id}` | Full investor profile by ID |
| GET | `/api/investors/cik/{cik}` | Investor profile by SEC CIK |
| GET | `/api/investors/stats` | Investor database statistics |
| GET | `/api/tickers/search?q={query}&limit={n}` | Public ticker search with enrichment metadata |
| GET | `/api/tickers/all` | Full ticker universe export with enrichment metadata |
| POST | `/api/validate-token` | Validate a consent token |
| GET | `/api/app-config/review-mode` | Review mode toggle (enabled only) |
| POST | `/api/app-config/review-mode/session` | Mint Firebase custom token for `REVIEWER_UID` when review mode enabled |

### Developer API (Developer Token / Developer API Enabled)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/v1` | Developer API root summary (`410` when developer API disabled) |
| GET | `/api/v1/list-scopes` | Generic dynamic scope catalog (`410` when developer API disabled) |
| GET | `/api/v1/tool-catalog` | Public-beta or app-filtered tool visibility |
| GET | `/api/v1/user-scopes/{user_id}` | Discover dynamic user scopes for one user (requires `?token=<developer-token>`) |
| GET | `/api/v1/consent-status` | Check app-scoped consent status by scope or request id |
| POST | `/api/v1/request-consent` | Create or reuse consent for one discovered scope (requires `?token=<developer-token>`) |
| POST | `/api/v1/scoped-export` | Fetch encrypted consent export metadata and ciphertext for an approved developer grant |

### Developer Portal (Firebase Sign-In / Self-Serve)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/developer/access` | Read the self-serve developer workspace for the signed-in Kai account |
| POST | `/api/developer/access/enable` | Create the self-serve developer app and first active token |
| PATCH | `/api/developer/access/profile` | Update the app identity shown during Kai consent review |
| POST | `/api/developer/access/rotate-key` | Revoke the current developer token and issue a replacement |

### Debug (Dev Only)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/debug/diagnostics` | Registered route diagnostics (returns `404` in production) |
| GET | `/debug/consent-listener` | Consent listener diagnostics (returns `404` in production) |
| GET | `/api/_debug/firebase` | Firebase debug endpoint (returns `404` in production) |

### Firebase Auth (Bootstrap)

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/consent/vault-owner-token` | Issue VAULT_OWNER token |
| POST | `/api/notifications/register` | Register FCM push token |
| DELETE | `/api/notifications/unregister` | Unregister FCM tokens (logout) |
| POST | `/api/kai/consent/grant` | Grant consent for Kai scopes |

### VAULT_OWNER (Consent-Gated)

#### Consent Management

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/consent/pending` | List pending consent requests |
| POST | `/api/consent/pending/approve` | Approve consent (zero-knowledge export) |
| POST | `/api/consent/pending/deny` | Deny consent request |
| POST | `/api/consent/cancel` | Cancel pending request |
| POST | `/api/consent/revoke` | Revoke active consent |
| GET | `/api/consent/history` | Paginated consent audit history |
| GET | `/api/consent/active` | Active (non-expired) tokens |

#### RIA And Relationship Sharing

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/ria/clients` | Advisor-facing relationship summary list, including implicit relationship-share status |
| GET | `/api/ria/clients/{investor_user_id}` | Advisor-facing relationship detail, including scoped grants and included advisor-picks benefit |
| GET | `/api/ria/workspace/{investor_user_id}` | Advisor workspace over investor-consented data plus relationship-share status |
| GET | `/api/kai/market/insights/{user_id}` | Investor market home payload with rights-gated `pick_sources[]` and RIA feed share metadata |

RIA relationship bundle note:

- investor private data -> RIA stays on explicit scope consent
- RIA active picks feed -> investor is an implicit relationship share (`ria_active_picks_feed_v1`)
- advisor picks are gated by both relationship approval and an active relationship-share grant, not by a second consent prompt

#### Personal Knowledge Model

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/pkm/store-domain` | Store encrypted PKM domain data + update index |
| GET | `/api/pkm/data/{user_id}` | Get full encrypted PKM payload |
| GET | `/api/pkm/domain-data/{user_id}/{domain}` | Get encrypted PKM domain data |
| DELETE | `/api/pkm/domain-data/{user_id}/{domain}` | Delete a PKM domain |
| GET | `/api/pkm/metadata/{user_id}` | Get PKM metadata for UI |
| GET | `/api/pkm/upgrade/status/{user_id}` | Get generic PKM upgrade status + resumable run metadata |
| POST | `/api/pkm/upgrade/start-or-resume` | Start or resume a client-side PKM upgrade run |
| POST | `/api/pkm/upgrade/runs/{run_id}/status` | Update run-level PKM upgrade status |
| POST | `/api/pkm/upgrade/runs/{run_id}/steps/{domain}` | Update per-domain PKM upgrade checkpoint |
| POST | `/api/pkm/upgrade/runs/{run_id}/complete` | Mark a PKM upgrade run completed |
| POST | `/api/pkm/upgrade/runs/{run_id}/fail` | Mark a PKM upgrade run failed |
| GET | `/api/pkm/scopes/{user_id}` | Get available PKM scope handles for the user |
| POST | `/api/pkm/get-context` | Get user context for analysis |

#### Kai Chat

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/kai/chat` | Conversational Kai endpoint |
| GET | `/api/kai/chat/history/{conversation_id}` | Conversation history |
| GET | `/api/kai/chat/conversations/{user_id}` | List all conversations |
| GET | `/api/kai/chat/initial-state/{user_id}` | Initial chat state |
| POST | `/api/kai/chat/analyze-loser` | Analyze a specific loser |

#### Kai Portfolio

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/kai/portfolio/import` | Import brokerage statement (CSV/PDF) |
| POST | `/api/kai/portfolio/import/stream` | Streaming import with deterministic Gemini extraction, thought telemetry, and strict quality-gate aborts |
| GET | `/api/kai/portfolio/summary/{user_id}` | Portfolio summary from PKM discovery metadata |
| GET | `/api/kai/dashboard/profile-picks/{user_id}` | Real profile-based picks for dashboard cards (`symbols`, `limit`) |
| POST | `/api/kai/portfolio/analyze-losers` | Analyze losers vs Renaissance |
| POST | `/api/kai/portfolio/analyze-losers/stream` | Streaming losers analysis (SSE, deterministic config, cash-excluded investable universe) |

#### Kai Plaid Brokerage Connectivity

Plaid is the read-only brokerage connectivity layer for Kai. It supports Link/OAuth, holdings, investment transactions, refresh, and connection health. It does not place trades.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/kai/plaid/status/{user_id}` | Load Plaid aggregate status, active source, items, holdings, and transactions summary |
| POST | `/api/kai/plaid/link-token` | Create a new Plaid Link token for investment connectivity |
| POST | `/api/kai/plaid/link-token/update` | Create an update-mode Plaid Link token for reconnect/add-account flows |
| POST | `/api/kai/plaid/oauth/resume` | Resume a web OAuth Link flow using an active opaque resume session |
| POST | `/api/kai/plaid/exchange-public-token` | Exchange Plaid `public_token`, sync holdings + investment transactions, and aggregate the read-only source |
| POST | `/api/kai/plaid/refresh` | Start a manual refresh run for one or more connected Plaid Items |
| GET | `/api/kai/plaid/refresh/{run_id}` | Inspect a Plaid refresh run status |
| POST | `/api/kai/plaid/source` | Persist the active Kai portfolio source (`statement`, `plaid`) |
| POST | `/api/kai/plaid/webhook` | Receive Plaid webhook updates for holdings refresh and item health |

Operational note:

- webhook URLs are supplied to Plaid during Link token creation via backend configuration, not dashboard allowlisting
- if `PLAID_WEBHOOK_URL` changes after Items exist, existing Items need a one-time `/item/webhook/update` maintenance pass

#### Kai Support Messaging

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/kai/support/message` | Send a profile-originated bug report, support request, or developer reachout through the Gmail-backed support inbox |

#### Kai Analysis

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/kai/analyze` | 3-agent investment analysis |
| GET | `/api/kai/analyze/stream` | SSE streaming debate analysis |
| POST | `/api/kai/analyze/stream` | SSE streaming with context body |
| POST | `/api/analysis/analyze` | Deep fundamental analysis |

#### Kai Market Home

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/kai/market/insights/{user_id}` | Token-gated market home payload (cache-backed, provider-fallback aware) |

#### Kai Decisions

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/kai/decisions/{user_id}` | Decision history from domain summaries |

#### Kai Personalization

Kai personalization no longer uses dedicated `/api/kai/preferences/*` endpoints.
Optional intro fields are persisted in encrypted PKM path `financial.profile`.
Frontend reads/writes these fields through the centralized onboarding/profile flows that call PKM APIs.

#### Account & Sync

| Method | Path | Description |
| ------ | ---- | ----------- |
| DELETE | `/api/account/delete` | Delete user account and all data |

Reserved future surface:

- broker execution will live under a separate `/api/kai/brokers/*` or `/api/kai/execution/*` family
- no live-trading routes exist today
- trade execution will require distinct consent scopes, approval, and audit logging

#### Vault Key Metadata (Setup/Get)

Vault setup/get now use a multi-wrapper `VaultState` contract:
- `vaultKeyHash`
- `primaryMethod`
- `recoveryEncryptedVaultKey`
- `recoverySalt`
- `recoveryIv`
- `wrappers[]` with:
  - `method`
  - `encryptedVaultKey`
  - `salt`
  - `iv`
  - `passkeyCredentialId` (nullable)
  - `passkeyPrfSalt` (nullable)

Method-management semantics:
- Passphrase wrapper is mandatory for every vault.
- Recovery wrapper is mandatory for every vault.
- Optional quick methods (native biometric/web PRF passkey) add wrappers for the same DEK.
- Primary method only controls default unlock UX; fallback wrappers remain valid.
- Additional endpoints: `POST /db/vault/wrapper/upsert`, `POST /db/vault/primary/set`.

Security invariant:
- No plaintext-at-rest path is allowed.
- PKM encryption/decryption always uses the same DEK regardless of unlock method.
- Generic PKM upgrades remain client-side after unlock; the backend only stores resumable run metadata and ciphertext.
| POST | `/api/sync/vault` | Disabled in regulated cutover (`501`, `SYNC_DISABLED`) |
| POST | `/api/sync/batch` | Disabled in regulated cutover (`501`, `SYNC_DISABLED`) |
| GET | `/api/sync/pull` | Disabled in regulated cutover (`501`, `SYNC_DISABLED`) |

### Consent Token (MCP Data Access)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/consent/data?token={consent_token}` | Retrieve encrypted export for token |

### SSE (Server-Sent Events)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/consent/events/{user_id}` | Disabled in production unless `CONSENT_SSE_ENABLED=true` |
| GET | `/api/consent/events/{user_id}/poll/{request_id}` | Deprecated and disabled (`410`, `CONSENT_POLL_DEPRECATED`) |

### Deprecated (410 Gone)

| Method | Path | Replacement |
| ------ | ---- | ----------- |
| POST | `/api/v1/food-data` | `GET /api/pkm/domain-data/{uid}/{discovered_domain}` after runtime domain discovery, or the publishable flow `/api/v1/user-scopes/{uid}` → `/api/v1/request-consent` → `/api/consent/data` |
| POST | `/api/v1/professional-data` | `GET /api/pkm/domain-data/{uid}/{discovered_domain}` after runtime domain discovery, or the publishable flow `/api/v1/user-scopes/{uid}` → `/api/v1/request-consent` → `/api/consent/data` |
| DELETE | `/api/pkm/attributes/{uid}/{domain}/{key}` | Client-side BYOK operation |
| POST | `/api/kai/decision/store` | `POST /api/pkm/store-domain` with domain=`financial` |
| GET | `/api/kai/decision/{id}` | `GET /api/kai/decisions/{user_id}` |
| DELETE | `/api/kai/decision/{id}` | `POST /api/pkm/store-domain` with domain=`financial` |
| `*` | `/api/identity/*` | Removed from app surface; compatibility stubs return `410` |

---

## Kai Market Insights v2 Payload (Additive)

`GET /api/kai/market/insights/{user_id}` returns additive sections for `/kai`:

- `layout_version`
- `hero`
- `watchlist`
- `movers`
- `sector_rotation`
- `news_tape`
- `signals`
- `meta.symbol_quality`
- `meta.filtered_symbols`
- `meta.provider_status`

Backward-compatible sections remain present while migration is active:
- `market_overview`
- `spotlights`
- `themes`

### Ticker Enrichment Fields (`/api/tickers/search`, `/api/tickers/all`)

Each ticker row can include:

- `sic_code`
- `sic_description`
- `sector_primary`
- `industry_primary`
- `sector_tags`
- `metadata_confidence`
- `tradable`

### Analyze Stream Terminal Decision Metadata

Terminal `decision` events from `/api/kai/analyze/stream` include:

- `short_recommendation`
- `analysis_degraded`
- `degraded_agents`
- `company_strength_score` (0-10 deterministic score)
- `market_trend_label`
- `market_trend_score` (0-10 deterministic score)
- `fair_value_label`
- `fair_value_score` (0-10 deterministic score)
- `fair_value_gap_pct`
- `analysis_updated_at` (UTC ISO-8601)
- `stream_id`
- `llm_calls_count`
- `provider_calls_count`
- `retry_counts`
- `analysis_mode`

These fields are additive to the canonical decision payload and mirrored in `raw_card` where applicable.

### Portfolio Import Stream Terminal Diagnostics (V2)

Terminal payload from `POST /api/kai/portfolio/import/stream` now includes:

- `portfolio_data_v2` (canonical app-consumed portfolio payload)
- `raw_extract_v2` (raw single-pass LLM extraction snapshot)
- `analytics_v2` (materialized dashboard/debate/optimize metrics)
- `quality_report_v2` (deterministic quality report and gate output)
- `timings_ms` (phase timings, includes `total_ms`)
- `token_counts` (phase -> `{chunks, thoughts}`; import thoughts are suppressed for investor-facing output)
- `coverage_metrics` (positions availability coverage checks)
- `quality_gate`:
  - `passed`
  - `holdings_count`
  - `placeholder_symbol_count`
  - `account_header_row_count`
  - `core_keys_present`
  - `rows_with_symbol_pct`
  - `rows_with_market_value_pct`

If import cannot proceed, terminal events are:

- terminal `error` with `code=IMPORT_JSON_INVALID` (invalid/non-JSON extractor output)
- terminal `error` with `code=IMPORT_SCHEMA_INVALID` (missing required top-level keys)
- terminal `error` or `aborted` with `code=IMPORT_NO_HOLDINGS` (no confirmed holdings available)

No silent success is emitted on terminal failures.

---

## External Developer API

### Consent Flow

External developers (MCP agents, third-party apps) use the `/api/v1` endpoints:

```
1. GET /api/v1/user-scopes/{user_id}
   Query: ?token=<developer-token>
   → Returns: { user_id, available_domains, scopes }

2. POST /api/v1/request-consent
   Query: ?token=<developer-token>
   Body: { user_id, scope, reason, approval_timeout_minutes, connector_public_key, connector_key_id, connector_wrapping_alg }
   → Returns: { request_id, status: "pending" } or an immediate reuse payload with
     { requested_scope, granted_scope, coverage_kind, covered_by_existing_grant }

3. User receives FCM notification → approves in app

4. POST /api/validate-token
   Body: { token: "<consent-token>" }
   → Returns: { valid, user_id, scope, expires_at }

5. GET /api/consent/data?token=<consent-token>
   → Returns: { ciphertext, iv, tag, export_key }
   → Developer decrypts with export_key
```

For MCP hosts, the recommended consumption surface is:

`discover_user_domains` → `request_consent` → `check_consent_status` → `get_scoped_data(expected_scope=original_scope)`

Coverage rules:

- broader active grant → narrower ask: reuse immediately
- narrower active grant → broader ask: requires fresh approval
- exact duplicate pending request → reuse the existing request_id
- broader-token reuse must still return the narrower requested slice when `expected_scope` is supplied

Production policy:
- All `/api/v1/*` endpoints return `410` with:
- `{"error_code":"DEVELOPER_API_DISABLED_IN_PRODUCTION","message":"Developer API is disabled in production."}`
- Non-production can enable `/api/v1/*` via `DEVELOPER_API_ENABLED=true` with runtime registry `DEVELOPER_REGISTRY_JSON`.

### Available Scopes

```
pkm.read
pkm.write
attr.{domain}.*
attr.{domain}.{subintent}.*
attr.{domain}.{subintent}.{attribute}
```

Scope strings are dynamic. Do not hardcode domain keys. Discover user-available scopes via:

- `GET /api/pkm/scopes/{user_id}`
- `GET /api/v1/user-scopes/{user_id}?token=<developer-token>`
- `discover_user_domains(user_id)` in MCP

### Token Format

```
HCT:<base64(user_id|agent_id|scope|issued_at|expires_at)>.<hmac_sha256_signature>
```

### Error Responses

| Status | Meaning | Action |
| ------ | ------- | ------ |
| 401 | Missing or invalid token | Re-authenticate or re-request consent |
| 403 | Insufficient scope | Request additional scopes |
| 404 | Resource not found | Verify user_id or resource exists |
| 410 | Endpoint deprecated | Use the replacement endpoint |
| 429 | Rate limited | Back off and retry |

---

## Response Format

Backend returns **snake_case**. Frontend transforms to **camelCase** in the service layer.

```
Backend:  { "user_id": "abc", "domain_summaries": {...} }
Service:  { userId: "abc", domainSummaries: {...} }
React:    Uses camelCase throughout
```

Plugins requiring camelCase transformation: PersonalKnowledgeModel, Kai.

---

## How to Add a New Endpoint

1. Create route function in `consent-protocol/api/routes/{module}.py`
2. Add auth dependency (`require_vault_owner_token` / `verify_firebase_bearer`)
3. Use service layer for all DB access (never direct SQL)
4. Register router in `server.py`: `app.include_router(router)`
5. Create Next.js proxy: `hushh-webapp/app/api/{path}/route.ts`
6. Create Capacitor plugin: iOS Swift + Android Kotlin
7. Add service method: `hushh-webapp/lib/services/{name}-service.ts`
8. Add route contract: `hushh-webapp/route-contracts.json`
9. Verify: `npm run verify:routes`

See [Architecture: Tri-Flow](./architecture.md#tri-flow-architecture) for the full pattern.

---

## See Also

- [Architecture](./architecture.md) -- System overview and tri-flow
- [Personal Knowledge Model](../../../consent-protocol/docs/reference/personal-knowledge-model.md) -- Data storage endpoints
- [Consent Protocol](../../../consent-protocol/docs/reference/consent-protocol.md) -- Token lifecycle
