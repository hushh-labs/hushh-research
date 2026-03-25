# Architecture

> Current runtime architecture for the Hushh monorepo.

---

## System Shape

```text
Web / iOS / Android clients
  -> Next.js route handlers or Capacitor plugins
  -> FastAPI backend
  -> service layer
  -> PostgreSQL / external services
```

Core invariants:

1. BYOK: user-private payloads stay encrypted client-side.
2. Consent-first: data access is token-gated and audited.
3. Tri-flow: web, iOS, and Android stay contract-aligned.
4. Canonical private data plane: PKM remains the user-private storage boundary.

---

## Backend: `consent-protocol/`

Runtime: Python 3.13, FastAPI, Uvicorn, Cloud Run.

### Registered Router Surface

All live routers are registered in `consent-protocol/server.py`.

| Router Module | Prefix | Purpose |
| --- | --- | --- |
| `health` | `/`, `/health`, `/kai/health`, app-config health helpers | liveness, readiness, app-review config |
| `agents` | `/api/agents` | agent discovery and related agent endpoints |
| `consent` | `/api/consent` | consent requests, grants, revocation, history |
| `session` | `/api` | session and lookup helpers used by app/auth flows |
| `developer` | `/api/v1` | developer API surface |
| `db_proxy` | `/db` | database proxy endpoints used by specific native flows |
| `sse` | `/api/consent/events` and related SSE endpoints | realtime consent events |
| `notifications` | `/api/notifications` | push token registration and notification support |
| `kai` | `/api/kai` | Kai chat, analysis, portfolio, streaming, decisions |
| `investors` | `/api/investors` | investor discovery/profile surface |
| `tickers` | `/api/tickers` | ticker search and holdings sync helpers |
| `identity` | compatibility identity endpoints | compatibility shims for identity flows |
| `pkm` | `/api/pkm` | store-domain, data, domain-data, metadata, scopes, context |
| `account` | `/api/account` | account deletion and management |
| `iam` | `/api/iam` | IAM actor and policy surface |
| `ria` | `/api/ria` | advisor onboarding and workspace flows |
| `marketplace` | `/api/marketplace` | marketplace discovery and publishing |
| `invites` | `/api/invites` | invite issuance and redemption |
| `debug_firebase` | `/api/_debug/*` in non-production only | local/debug-only auth diagnostics |

Not currently registered:

- no live `/api/sync` router
- no `api/routes/kai/preferences.py` module

### PKM Runtime Surface

The backend router is the authoritative PKM contract. Current supported path families include:

- `POST /api/pkm/store-domain`
- `GET /api/pkm/data/{user_id}`
- `GET|DELETE /api/pkm/domain-data/{user_id}/{domain}`
- `POST /api/pkm/reconcile/{user_id}`
- `DELETE /api/pkm/attributes/{user_id}/{domain}/{attribute_key}` returning legacy-removal behavior
- `GET /api/pkm/metadata/{user_id}`
- `GET /api/pkm/domain-registry`
- `GET /api/pkm/scopes/{user_id}`
- `POST /api/pkm/get-context`

Removed legacy read surfaces such as `/index`, `/attributes`, `/domains`, `/portfolio`, and `/portfolios` are not part of the supported contract.

### Service Layer

Routes do not access the database directly. Database access flows through service classes.

```text
FastAPI route -> service -> DatabaseClient / external adapter -> PostgreSQL or remote API
```

Representative services:

- `PersonalKnowledgeModelService`
- `ConsentDBService`
- `ChatDBService`
- `UniverseListService`
- `RenaissanceService`
- `PushTokensService`
- `DomainRegistryService`

### Backend Directory Layout

```text
consent-protocol/
  server.py
  consent_db.py
  api/
    middlewares/
    routes/
      account.py
      agents.py
      consent.py
      db_proxy.py
      debug_firebase.py
      developer.py
      health.py
      iam.py
      identity.py
      investors.py
      invites.py
      marketplace.py
      notifications.py
      ria.py
      session.py
      sse.py
      tickers.py
      pkm.py
      kai/
        __init__.py
        analyze.py
        chat.py
        consent.py
        decisions.py
        health.py
        market_insights.py
        plaid.py
        portfolio.py
        stream.py
  hushh_mcp/
    agents/
    consent/
    hushh_adk/
    integrations/
      plaid/
    operons/
      kai/
        brokerage.py
    services/
  db/
    migrations/
  mcp_modules/
  docs/
```

---

## Frontend: `hushh-webapp/`

Runtime: Next.js 16 App Router, React 19, Tailwind CSS, Capacitor 8.

### App Route Contract

Current app-level navigation targets are defined in `hushh-webapp/lib/navigation/routes.ts`:

- `/`
- `/developers`
- `/login`
- `/logout`
- `/labs/profile-appearance`
- `/profile`
- `/consents`
- `/marketplace`
- `/marketplace/ria`
- `/ria`
- `/ria/onboarding`
- `/ria/clients`
- `/ria/picks`
- `/ria/requests`
- `/ria/settings`
- `/kai`
- `/kai/onboarding`
- `/kai/import`
- `/kai/plaid/oauth/return`
- `/kai/investments`
- `/kai/portfolio`
- `/kai/analysis`
- `/kai/optimize`

Identifier-backed detail surfaces stay on static entrypoints for Capacitor export:

- `/marketplace/ria?riaId=<ria_id>`
- `/ria/workspace?clientId=<investor_user_id>`

### Tri-Flow Delivery

Product features that cross the backend boundary are expected to preserve parity across:

- web: Next.js route handlers under `app/api/**`
- iOS: Swift Capacitor plugins
- Android: Kotlin Capacitor plugins

```text
Component -> service layer -> web route handler or native plugin -> backend
```

Components should not own backend fetch orchestration directly.

### Frontend Directory Layout

```text
hushh-webapp/
  app/
    api/
    consents/
    developers/
    kai/
      analysis/
      dashboard/
      import/
      investments/
      onboarding/
      optimize/
    labs/
      profile-appearance/
    login/
    logout/
    marketplace/
      ria/
        [riaId]/
    profile/
    ria/
      clients/
      onboarding/
      picks/
      requests/
      settings/
      workspace/
        [clientId]/
  components/
  ios/App/App/Plugins/
  android/app/src/main/java/.../plugins/
  lib/
    agents/
    api/
    auth/
    capacitor/
    consent/
    firebase/
    kai/
      brokerage/
    navigation/
    notifications/
    observability/
    services/
    stores/
    streaming/
    vault/
  docs/
```

---

## Data Boundary

Runtime data is split into:

- relational operational state in PostgreSQL
- encrypted user-private payloads in the PKM data plane
- public/shared marketplace, IAM, and system-curated datasets in relational tables

The PKM boundary is the only supported private data plane for investor and RIA user-owned content.

---

## Operational References

- API contract detail: [api-contracts.md](./api-contracts.md)
- route governance: [route-contracts.md](./route-contracts.md)
- DB/runtime fact sheet: [runtime-db-fact-sheet.md](./runtime-db-fact-sheet.md)
- env and secrets contract: [../operations/env-and-secrets.md](../operations/env-and-secrets.md)
- backend PKM reference: [../../../consent-protocol/docs/reference/personal-knowledge-model.md](../../../consent-protocol/docs/reference/personal-knowledge-model.md)
- backend consent reference: [../../../consent-protocol/docs/reference/consent-protocol.md](../../../consent-protocol/docs/reference/consent-protocol.md)
