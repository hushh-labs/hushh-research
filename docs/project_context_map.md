# Project Context Map

> Orientation for contributors and coding agents. Read this before making changes.


## Visual Map

```mermaid
flowchart TB
  contributor["Contributor / Operator"]
  users["Investor / RIA / Developer users"]

  subgraph frontend["Frontend Runtime: hushh-webapp"]
    routes["Route contracts<br/>App Router + visible surfaces"]
    shell["Signed-in shell<br/>providers, top bar, nav, guards"]
    services["Service layer<br/>platform-aware reads and writes"]
    runtime["Auth + persona + vault + cache contexts"]
    proxies["Web proxies<br/>app/api/*"]
    plugins["Native bridges<br/>Capacitor plugins"]
  end

  subgraph backend["Backend Runtime: consent-protocol"]
    api["FastAPI routes"]
    policy["Consent + IAM policy"]
    domain["Domain services<br/>PKM, Kai, RIA, marketplace"]
    agents["Agents / tools / operons"]
  end

  subgraph data["Data and provider planes"]
    relational["Relational core<br/>identity, consent, workflow, shared datasets"]
    pkm["Encrypted PKM blobs + sanitized index"]
    market["Market caches + external providers"]
  end

  subgraph security["Security boundary"]
    token["Consent tokens + VAULT_OWNER"]
    key["Vault key<br/>memory-only client secret"]
  end

  contributor --> routes
  contributor --> api
  users --> routes
  routes --> shell --> services
  runtime --> services
  services --> proxies --> api
  services --> plugins --> api
  api --> policy
  api --> domain
  domain --> agents
  policy --> token
  domain --> relational
  domain --> pkm
  domain --> market
  key --> runtime
  token --> policy
```

## North Stars

- Hushh Principle: "An agent should work for the person whose life it touches."
- Kai North Star: "Your data, your business. Your committee, on-demand."

## CRITICAL RULES (Non-Negotiables)

These are invariants. If a change violates one, it is the wrong change.

1. **BYOK (Bring Your Own Key)**
   - Vault keys are derived/unlocked client-side.
   - The backend stores ciphertext only.
2. **Consent-First**
   - "Signed in" is not consent.
   - Every vault/PKM/agent operation requires a valid consent token with correct scope.
   - No backdoors or bypasses for dev/testing.
3. **Tri-Flow (Web + iOS + Android)**
   - Every data feature must work on Web, iOS, and Android (or be explicitly marked platform-specific).
   - Components do not call `fetch()`; they call the service layer (`hushh-webapp/lib/services/*`).
   - Keep route governance in sync (see `docs/reference/architecture/route-contracts.md`).
4. **Minimal Browser Storage**
   - Sensitive credentials and vault keys stay memory-only (React context / Zustand).
   - Decrypted PKM stays memory-only.
   - Only explicitly-approved encrypted PKM snapshots and non-sensitive cache/settings may use device storage.

## Repo Map

- `hushh-webapp/`: Next.js + React + Capacitor shell (Web + iOS + Android)
  - UI: `hushh-webapp/app/`, `hushh-webapp/components/`
  - Platform-aware calls: `hushh-webapp/lib/services/`
  - Native bridges: `hushh-webapp/ios/App/App/Plugins/`, `hushh-webapp/android/app/src/main/java/.../plugins/`
- `consent-protocol/`: FastAPI backend + consent protocol + agents + MCP server (git subtree)
  - Routes: `consent-protocol/api/routes/`
  - Services (DB access): `consent-protocol/hushh_mcp/services/`
  - Agents/tools/operons: `consent-protocol/hushh_mcp/agents/`, `consent-protocol/hushh_mcp/operons/`, `consent-protocol/hushh_mcp/hushh_adk/`
- `docs/`: system reference, guides, vision, and audits (start at `docs/README.md`)
- `deploy/`: Cloud Build/Cloud Run + App Store deployment docs
- `scripts/`: local CI and repo tooling

## Current Kai Route Map (v4.x)

The frontend route split is intentional and must remain stable unless route contracts are updated.

- `/`: public marketing onboarding surface (intro + preview, no auth controls)
- `/login`: auth-only surface (Google/Apple + disabled phone)
- `/kai/onboarding`: canonical onboarding questionnaire + persona
- `/kai/import`: portfolio connection/import flow and vault introduction moment
- `/kai/plaid/oauth/return`: Plaid OAuth callback/resume surface
- `/kai`: signed-in live market home (token-gated, cache-first, degraded labels when providers are partial)
- `/kai/portfolio`: portfolio analytics/dashboard (requires data, redirects to `/kai/import` when empty)
- `/ria/*`: advisor workflow tree under the same product shell
- `/marketplace`: shared discovery surface for investor + RIA
- `/consents`: shared workflow hub for incoming/outgoing requests, grants, history, invites, and future MCP/developer access

Guard invariants:
- Incomplete onboarding cannot navigate to non-onboarding `/kai` routes.
- Vault unlock is required only when vault exists and protected operations need it.
- First-time no-vault users are not forced into vault unlock directly after login.
- Market home refresh remains cache-first while fresh; provider fallback/degraded states must be explicit.

## Vault Security Model (Current)

- Encryption at rest is mandatory. There is no plaintext fallback.
- Passphrase and recovery wrappers are mandatory. Optional quick-unlock methods (biometric/passkey) add wrappers for the same DEK.
- Primary method controls default UX only; all enrolled wrappers remain valid fallback unlock methods.
- Method switching updates wrappers for the same vault key and updates metadata in `vault_keys`.
- Recovery key remains mandatory fallback.

## How Data Access Works (Mental Model)

- Web: React component -> service -> Next.js `/app/api/...` proxy -> FastAPI
- Native: React component -> service -> Capacitor plugin (Swift/Kotlin) -> FastAPI
- Backend: route -> service (validates consent) -> DB client -> Postgres (Supabase)

System overview: `docs/reference/architecture/architecture.md`
Kai interconnection map: `docs/reference/kai/kai-interconnection-map.md`
Kai blast radius matrix: `docs/reference/kai/kai-change-impact-matrix.md`

## Dynamic Domains & Scopes (PKM)

PKM storage is encrypted and domain-driven.

- Encrypted blobs: `pkm_blobs` (ciphertext)
- Non-encrypted index/metadata: `pkm_index`
- Scope pattern: `attr.{domain}.{attribute_key}` (with wildcards like `attr.food.*`)

Primary references:
- `consent-protocol/docs/reference/personal-knowledge-model.md`
- `consent-protocol/docs/reference/consent-protocol.md`

Storage boundary:
- Relational tables own identity, consent workflow, compliance, public discovery, and query-heavy shared market datasets.
- `pkm_blobs` stores encrypted private user content only.
- `pkm_index` stores sanitized metadata only.
- The same boundary applies to both Investor and RIA personas. RIA does not introduce a second private data plane.

Persona state:
- `actor_profiles.last_active_persona` is the canonical persisted persona state.
- `runtime_persona_state` is transitional setup continuity only and should not become a second long-term source of truth.

Shared market datasets:
- `renaissance_*` tables remain the current system-curated benchmark dataset.
- Future RIA stock templates should land behind a generic security-list abstraction, not by cloning Renaissance tables per advisor.

Current onboarding/tour domain usage:
- `kai_profile` (encrypted) is canonical for onboarding completion and nav-tour completion/skips.
- Local pending stores are temporary per-user+device and sync after vault unlock.

PKM cutover and migration guidance is tracked in `docs/reference/architecture/pkm-cutover-runbook.md`.

## When Adding A Feature

Use `docs/guides/new-feature.md` and treat it as a required checklist.

Minimum definition of done:
- Tri-flow implemented (or explicitly N/A) and tested on all platforms
- Consent token validated at entry points
- BYOK preserved (no plaintext-at-rest; if custom key is skipped, generate a secure default key)
- API documented (`docs/reference/architecture/api-contracts.md`)
- Route governance updated (`hushh-webapp/lib/navigation/routes.ts` + `docs/reference/architecture/route-contracts.md`)
- PR impact map included (`docs/reference/quality/pr-impact-checklist.md`)
- Tests updated (`TESTING.md`)

## Trust/Compliance Reality Check

Compliance and readiness tracking references:
- `docs/reference/kai/kai-runtime-smoke-checklist.md`

If you're shipping anything investor-facing, read it and close critical findings first.
