# Senior Engineering: Hushh Consent Protocol & RIA System

> Deep architectural reference for the hushh consent protocol, RIA verification, and dual-persona system. Read this before making changes to any RIA, verification, persona, or onboarding code.

---

## System Overview

Hushh is a consent-first financial data platform with two actor personas: **Investor** and **RIA** (Registered Investment Advisor). The platform enforces regulatory verification before granting RIAs access to investor data.

### Monorepo Structure

```
hushh-research/
  consent-protocol/       # Python FastAPI backend (the "consent protocol")
    api/routes/           # REST endpoints
      ria.py              # All /api/ria/* routes
      account.py          # Account lifecycle (delete, export)
    hushh_mcp/services/   # Core business logic
      ria_iam_service.py  # RIA IAM: onboarding, verification, persona, clients, picks
      ria_verification.py # Verification adapters (Stage1 lookup, IAPD, broker)
      account_service.py  # Account deletion across 43+ tables
      actor_identity_service.py  # Firebase identity sync
    db/                   # Migrations, connection pooling (asyncpg)
    scripts/              # Admin tools (e.g., admin_delete_user_by_email.py)

  hushh-webapp/           # Next.js 14+ frontend (App Router)
    app/
      ria/
        page.tsx          # RIA home dashboard
        onboarding/
          page.tsx        # 4-step onboarding wizard (capabilities, display_name, legal_identity, review)
      api/ria/[...path]/route.ts  # Catch-all proxy to Python backend
    lib/
      services/ria-service.ts     # Frontend RIA API client
      persona/persona-context.tsx # React context for persona state
    components/ria/
      ria-page-shell.tsx  # Layout + verification gate + status panel
```

---

## Architecture Layers

### 1. Frontend (Next.js)

**Proxy layer**: All `/api/ria/*` requests hit `app/api/ria/[...path]/route.ts`, a catch-all proxy that forwards to the Python backend at `getPythonApiUrl()`. Key behaviors:
- Onboarding endpoints (`submit`, `verify-name`) get 90s timeout (`RIA_ONBOARDING_PROXY_TIMEOUT_MS`)
- Status endpoint has 30s hot-cache with deduplication
- Standard endpoints get 12s timeout

**Persona context** (`lib/persona/persona-context.tsx`):
- `PersonaProvider` wraps the app and exposes `usePersonaState()` hook
- Provides: `activePersona`, `primaryNavPersona`, `riaCapability`, `riaSwitchAvailable`, `riaSetupAvailable`, `riaEntryRoute`
- Calls `RiaService.getPersonaState()` and `RiaService.getOnboardingStatus()` from the backend
- Caches persona state client-side with `CacheService` (session-scoped TTL)

**RIA Service** (`lib/services/ria-service.ts`):
- `verifyOnboardingName(idToken, { query, crd_number? })`: POST `/api/ria/onboarding/verify-name`
- `submitOnboarding(idToken, payload)`: POST `/api/ria/onboarding/submit` with `force_live_verification` flag
- `getPersonaState(idToken, { userId, force })`: GET `/api/ria/persona-state`
- `getOnboardingStatus(idToken, { userId, force })`: GET `/api/ria/onboarding/status`
- `switchPersona(idToken, target)`: POST `/api/ria/persona/switch`

**Onboarding wizard** (`app/ria/onboarding/page.tsx`, ~1400 lines):
- 4 steps: `capabilities` -> `display_name` -> `legal_identity/advisory_firm/broker_firm` -> `review`
- Name verification in `handleVerifyName()`:
  1. Calls `RiaService.verifyOnboardingName(idToken, { query, crd_number? })`
  2. 90s timeout with AbortController
  3. Stale response detection via `verificationRequestIdRef` (incremented per request)
  4. Post-verification: if status=verified but no CRD, downgrades to not_verified
  5. If user-entered CRD doesn't match returned CRD, downgrades to not_verified
- `nameVerificationSatisfied` logic: requires verified status + non-empty CRD + matching query and CRD

**Verification gate** (`components/ria/ria-page-shell.tsx`):
- `isRiaVerified(status)`: checks against `{"active", "verified", "finra_verified"}`
- `RiaVerificationGate`: blocks children if not verified (shows "complete advisor verification first")

### 2. Backend Routes (`consent-protocol/api/routes/ria.py`)

Key endpoints:
- `POST /api/ria/onboarding/submit` -> `RIAIAMService.submit_ria_onboarding()`
- `POST /api/ria/onboarding/verify-name` -> `RIAIAMService.verify_ria_name()`
- `GET /api/ria/onboarding/status` -> `RIAIAMService.get_ria_onboarding_status()`
- `GET /api/ria/home` -> `RIAIAMService.get_ria_home()`
- `GET /api/ria/clients` -> requires `_require_ria_verified` dependency (403 if not verified)
- `POST /api/ria/requests` -> requires `_require_ria_verified`
- `POST /api/ria/invites` -> requires `_require_ria_verified`

Auth: All routes require `require_firebase_auth` (Firebase ID token in Authorization header). Client-facing routes also require `_require_ria_verified` (fail-closed 403).

### 3. Backend Service (`consent-protocol/hushh_mcp/services/ria_iam_service.py`, ~3000+ lines)

**RIAIAMService** is the central service class:

**Persona state**: Built by `_build_persona_state()` method which queries `actor_profiles`, `ria_profiles`, and `runtime_persona_state` tables. Returns:
- `personas`: list of available personas (e.g., ["investor", "ria"])
- `active_persona` / `last_active_persona`
- `primary_nav_persona`
- `ria_switch_available`: true if user has verified RIA profile
- `ria_setup_available`: true if user can begin RIA onboarding
- `iam_schema_ready`: true if all IAM tables exist
- Server-side cache with 30s TTL (`_PERSONA_STATE_CACHE`)

**Onboarding submission** (`submit_ria_onboarding()`):
1. Prepares inputs via `_prepare_professional_onboarding_inputs()`
2. Runs Stage 1 name verification via `_verify_ria_name_result()`
3. If `provider_unavailable` -> 503 error
4. If not `verified` or no CRD -> 400 error
5. If CRD mismatch -> 400 error
6. On success: creates/updates `actor_profiles`, `ria_profiles`, `ria_firms`, `ria_firm_memberships`, `ria_verification_events`, `marketplace_public_profiles`
7. Sets verification_status to `verified`, verification_provider to the provider label

**Verification check** (`require_ria_verified()`):
- Queries `ria_profiles` for `advisory_status` or `verification_status`
- Checks against `_RIA_VERIFIED_STATUSES = {"active", "verified", "finra_verified"}`
- If not in set -> 403 `RIAIAMPolicyError`

### 4. Verification Adapters (`consent-protocol/hushh_mcp/services/ria_verification.py`)

**RIAIntelligenceStage1LookupAdapter** (primary, used for onboarding name verification):
- Calls `hushh-ria-intelligence-api` at `/v1/ria/profile/stage1`
- Request: `{"query": name, "context": {"targetName": name, "crdNumber": crd}}`
- Response parsed for: `profile.existsOnFinra`, `profile.fullName`, `profile.crdNumber`, `profile.currentFirm`, `profile.secNumber`, `profile.suggestedNames`, `profile.reasonIfNotExists`
- Verification rules:
  - `existsOnFinra` + non-empty CRD = `verified`
  - CRD mismatch = `not_verified`
  - Missing CRD = `not_verified`
  - API error = `provider_unavailable`
- Cache: keyed by `normalized_name|crd:normalized_crd`, TTL 300s, only caches verified/not_verified

**IapdVerificationAdapter** (legacy, used for firm-level verification):
- Calls external IAPD API at `IAPD_VERIFY_BASE_URL/verify-advisory`
- Used in the `VerificationGateway` / `FinraVerificationAdapter` chain

**FinraVerificationAdapter** (backward-compat wrapper):
- Tries IAPD adapter first, falls back to Intelligence adapter
- Used by `VerificationGateway`

**Production guards** (`validate_regulated_runtime_configuration()`):
- In production: requires `IAPD_VERIFY_BASE_URL`, `IAPD_VERIFY_API_KEY` to be set
- In production: FAILS if any bypass env vars are truthy
- In production: FAILS if `RIA_DEV_ALLOWLIST` is set

---

## Verification Status Lifecycle

```
draft -> submitted -> verified | not_verified | provider_unavailable
                                     |
                              (CRD-backed Stage1)
                                     |
                              advisory_status = "verified"
                              verification_status = "verified"
```

Valid "verified" statuses throughout the system: `active`, `verified`, `finra_verified`

These statuses grant:
- Access through `require_ria_verified()` backend gate
- Access through `RiaVerificationGate` frontend component
- `verification_badge = 'verified'` in marketplace_public_profiles

---

## Database Schema (Key Tables)

### IAM Tables (required for RIA features)
- `actor_profiles`: user_id, personas[], last_active_persona, investor_marketplace_opt_in
- `ria_profiles`: user_id, display_name, legal_name, finra_crd, sec_iard, verification_status, verification_provider, requested_capabilities[], individual_legal_name, individual_crd, advisory_firm_*, broker_firm_*, advisory_status, brokerage_status
- `ria_firms`: legal_name, finra_firm_crd, sec_iard, website_url
- `ria_firm_memberships`: ria_profile_id, firm_id, role_title, membership_status, is_primary
- `ria_verification_events`: ria_profile_id, provider, outcome, checked_at, expires_at, reference_metadata (audit trail)
- `marketplace_public_profiles`: user_id, profile_type, display_name, verification_badge, is_discoverable
- `advisor_investor_relationships`: RIA-to-investor consent/relationship tracking
- `ria_client_invites`: invite management
- `consent_scope_templates`: what data RIAs can request access to
- `runtime_persona_state`: persists last active persona across sessions

### Other Key Tables
- `vault_keys`: user encryption keys
- `pkm_*`: Personal Knowledge Management (user data store)
- `kai_*`: Kai financial platform tables (plaid, funding, gmail, etc.)
- `consent_audit`, `consent_exports`: consent tracking

### Schema Readiness
- `_ensure_iam_schema_ready()` checks all tables in `_IAM_REQUIRED_TABLES` exist
- Uses TTL-aware cache (300s) so new migrations are picked up within 5 minutes
- If schema not ready: returns `IAMSchemaNotReadyError` (503) with migration hint

---

## Tri-Flow Architecture (Web + iOS + Android)

The verification and persona systems serve three client surfaces:
1. **Web** (Next.js): Full onboarding wizard, proxy routes
2. **iOS**: Native app hitting the same `/api/ria/*` backend endpoints
3. **Android**: Same backend endpoints

The `ria-page-shell.tsx` includes `nativeTest` props for native app testing markers (`routeId`, `marker`, `authState`, `dataState`, `errorCode`). This is how native apps detect page states.

---

## Account Lifecycle

**Delete** (`AccountService.delete_account(user_id, target="both")`):
- Cascades across 43+ table categories
- Supports partial deletion: `target="investor"` or `target="ria"` or `target="both"`
- Route: `DELETE /api/account/delete` requires `VAULT_OWNER` token (Unlock to Delete pattern)

**Export** (`AccountService.export_data(user_id)`):
- Returns encrypted/private-user-bound payloads
- No plaintext PKM content in export

**Admin deletion** (`scripts/admin_delete_user_by_email.py`):
- Looks up Firebase UID by email
- Scans 30+ tables for user data
- Supports dry-run mode (default)
- Production guard: requires `--allow-production` flag
- Optional Firebase Auth deletion: `--delete-firebase` flag

---

## Environment & Configuration

### Key Environment Variables
- `APP_ENV` / `ENVIRONMENT` / `HUSHH_ENV` / `ENV`: Runtime environment detection
- `PYTHON_API_URL`: Backend URL for Next.js proxy
- `RIA_INTELLIGENCE_BASE_URL`: Stage1 lookup API base URL
- `RIA_INTELLIGENCE_API_KEY`: API key for Stage1 lookup
- `IAPD_VERIFY_BASE_URL` / `IAPD_VERIFY_API_KEY`: IAPD verification API
- `FIREBASE_ADMIN_CREDENTIALS_JSON`: Firebase Admin SDK config
- `RIA_ONBOARDING_PROXY_TIMEOUT_MS`: Proxy timeout for onboarding (default 90s)

### Production Guards
- `validate_regulated_runtime_configuration()` runs at startup in production
- Ensures verification APIs are configured
- Prevents any bypass flags from reaching production

---

## Common Patterns

### Error Handling
- `IAMSchemaNotReadyError`: 503, means IAM tables don't exist yet
- `RIAIAMPolicyError`: 400/403, policy violations (unverified, invalid input)
- `provider_unavailable`: external API down, returns 503 to frontend

### Caching
- Server-side persona state: 30s TTL in `_PERSONA_STATE_CACHE`
- Stage1 verification results: 300s TTL, keyed by `normalized_name|crd:normalized_crd`
- IAM schema readiness: 300s TTL in `_TABLE_EXISTS_CACHE`
- Frontend: `CacheService` with session-scoped TTL
- Next.js proxy: 30s hot-cache for onboarding status GET with auth dedup

### Connection Management
- Backend uses `asyncpg` connection pool via `get_pool()`
- `_PooledAsyncpgConnection` wrapper for pool release on `conn.close()`
- All service methods follow: `conn = await self._conn()` -> `try/finally conn.close()`

---

## Critical Rules for Making Changes

1. **Every RIA must pass Stage 1 CRD-backed verification.** No bypass paths. No dev shortcuts. The product rule is absolute: provide your CRD, get verified against FINRA, or you cannot onboard as an RIA.

2. **Verification status values must be consistent across all layers**: backend `_RIA_VERIFIED_STATUSES`, frontend `_VERIFIED_STATUSES` in ria-page-shell, `isAdvisoryAccessReady()` in onboarding, SQL queries in marketplace/verification_badge logic.

3. **Changes touch both repos.** RIA features span `consent-protocol/` (Python) and `hushh-webapp/` (TypeScript). Always trace the full path: frontend UI -> proxy route -> backend route -> service method -> verification adapter -> database.

4. **The proxy is transparent.** The catch-all route at `app/api/ria/[...path]/route.ts` just forwards requests. Business logic lives entirely in the Python backend.

5. **Database schema changes require migration + verification.** Use `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`. The system degrades gracefully (503) when schema is missing.

6. **Native apps share the same backend.** iOS and Android hit the same `/api/ria/*` endpoints. Frontend-only changes don't affect native flows, but backend changes affect all three surfaces.

7. **Always run the production guard after env changes.** `validate_regulated_runtime_configuration()` should pass. It prevents bypass flags from reaching production.

8. **Persona state is the source of truth** for what a user can do. The backend builds it; the frontend caches and consumes it. Never make authorization decisions purely on the frontend.
