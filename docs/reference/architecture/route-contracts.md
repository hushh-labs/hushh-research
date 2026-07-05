# Route Contracts

> Governance for Next.js proxy routes, native plugin parity, and app navigation truth.


## Visual Map

```mermaid
flowchart TD
  contracts["Route Contracts"]
  standard["standard routes"]
  flow["flow routes"]
  hidden["hidden / redirect routes"]
  parity["Web / iOS / Android parity"]
  contracts --> standard
  contracts --> flow
  contracts --> hidden
  standard --> parity
  flow --> parity
  hidden --> parity
```

Hussh uses a code-owned route contract plus docs/runtime checks to keep the declared runtime surface aligned across:

- Next.js API route handlers under `hushh-webapp/app/api/**/route.ts`
- backend router prefixes and path families
- Capacitor TypeScript, iOS, and Android plugin surfaces
- mobile parity guidance for the visible page tree

## Files

- Canonical app route source: `hushh-webapp/lib/navigation/routes.ts`
- Route governance reference: `docs/reference/architecture/route-contracts.md`
- Frontend/native surface mapper: `docs/reference/architecture/frontend-native-surface-map.md`
- Mobile parity reference: `docs/reference/mobile/capacitor-parity-audit.md`
- Docs/runtime verification:
  - `bash scripts/ci/docs-parity-check.sh`
  - `node scripts/verify-doc-runtime-parity.cjs`

## Canonical App Routes

Keep navigation documentation aligned with `hushh-webapp/lib/navigation/routes.ts`:

- `/`
- `/developers`
- `/login`
- `/register-phone`
- `/logout`
- `/labs/profile-appearance`
- `/agent`
- `/profile`
- `/profile/account`
- `/profile/account/phone`
- `/profile/preferences`
- `/profile/preferences/kai`
- `/profile/preferences/device`
- `/profile/security`
- `/profile/security/vault`
- `/profile/security/session`
- `/profile/my-data`
- `/profile/my-data/domain?key=<domain_key>`
- `/profile/access`
- `/profile/access/connection?id=<connection_id>`
- `/profile/connected-systems`
- `/profile/gmail`
- `/profile/gmail/connection`
- `/profile/gmail/actions`
- `/profile/support`
- `/profile/support/routing`
- `/profile/support/compose?kind=<support_kind>`
- `/profile/receipts`
- `/profile/gmail/oauth/return`
- `/consents`
- `/one/setup`
- `/one/setup/kai`
- `/one/setup/[capability]`
- `/one/kyc`
- `/one/marketplace`
- `/marketplace`
- `/marketplace/ria`
- `/ria`
- `/ria/onboarding`
- `/ria/clients`
- `/ria/picks`
- `/ria/requests`
- `/ria/settings`
- `/one/kai`
- `/one/kai/import`
- `/one/kai/plaid/oauth/return`
- `/one/kai/alpaca/oauth/return`
- `/one/kai/investments`
- `/one/kai/funding-trade`
- `/one/kai/portfolio`
- `/one/kai/analysis`
- `/one/kai/optimize`

Detail entrypoints that require an identifier use query-backed static routes so Capacitor export stays compatible:

- `/marketplace/ria?riaId=<ria_id>`
- `/ria/workspace?clientId=<investor_user_id>`
- `/profile/my-data/domain?key=<domain_key>`
- `/profile/access/connection?id=<connection_id>`
- `/profile/support/compose?kind=<support_kind>`

Legacy `/kai/*` aliases and `/one/kai/onboarding` remain compatibility redirect surfaces only. They must not be documented as canonical navigation surfaces or reintroduced as primary routes without updating both `routes.ts` and this reference.

Legacy `/profile?panel=...&detail=...` URLs remain compatibility inputs only. Canonical profile navigation is nested under `/profile/<panel>` and owned by `hushh-webapp/lib/navigation/profile-routes.ts`.

## Route Contract Cascade

Every added, removed, or renamed app route must update the route contract cascade in one change:

- `hushh-webapp/lib/navigation/routes.ts`, route builders, breadcrumbs, bottom navigation, and signed-in route coverage
- `hushh-webapp/lib/navigation/app-route-layout.contract.json`
- `hushh-webapp/frontend-native-surface-map.generated.json`
- `hushh-webapp/cache-coherence-screen-manifest.generated.json`
- `hushh-webapp/native-route-inventory.json`
- local `.voice-action-contract.json` files and generated voice gateway artifacts when route/action reachability changes
- route docs, cache-coherence docs, One Voice docs, mobile parity docs, and owning Codex skill reads/checks

Preserve query params for transient state such as OAuth callbacks, filters, pagination, `unlock_vault`, `return_to`, redirects, and static-export-sensitive identifiers. Do not use query params as durable panel/detail navigation when a finite nested route exists.

## Visible Route Coverage

`hushh-webapp/lib/navigation/routes.ts` is the declared inventory for the canonical app navigation surface. The mobile parity docs must classify visible routes as:

- native-supported
- intentionally web-only

If a route is added to the navigation contract, the corresponding architecture/mobile docs must be updated in the same change.

Auth-only routes can still be mandatory even when they intentionally bypass the standard shell. Current hidden auth routes include:

- `/login`
- `/register-phone`
- `/logout`

## When To Update Route Governance

Update the route contract docs whenever you:

- add a new Next.js API route under `hushh-webapp/app/api/`
- change a backend router prefix or supported backend path family
- add, remove, or rename a Capacitor plugin method that must exist in TS, iOS, and Android
- intentionally retire an old proxy or plugin surface

## Contract Shape

The practical contract is split across:

- `hushh-webapp/lib/navigation/routes.ts` for app-visible routes
- backend route modules and Next.js proxy handlers for API surfaces
- mobile parity docs for platform-specific expectations and exceptions
- `hushh-webapp/frontend-native-surface-map.generated.json` for the
  route-to-API/native/plugin/voice scaffold used by Codex agents and parity audits

## Relationship To Other Docs

- [api-contracts.md](./api-contracts.md) describes the API surface itself.
- `hushh-webapp/lib/navigation/routes.ts` is the code-owned navigation source of truth.
- [../mobile/capacitor-parity-audit.md](../mobile/capacitor-parity-audit.md) defines the stricter mobile release gate layered on top of route contracts.
