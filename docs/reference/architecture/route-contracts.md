# Route Contracts

> Governance for Next.js proxy routes, native plugin parity, and app navigation truth.

Hushh uses a contract manifest to keep the declared runtime surface aligned across:

- Next.js API route handlers under `hushh-webapp/app/api/**/route.ts`
- backend router prefixes and path families
- Capacitor TypeScript, iOS, and Android plugin surfaces
- mobile parity classification for the full visible page tree

## Files

- Manifest: `hushh-webapp/route-contracts.json`
- Mobile parity registry: `hushh-webapp/mobile-parity-registry.json`
- Verifier: `hushh-webapp/scripts/verify-route-contracts.cjs`
- Run locally:
  - `cd hushh-webapp && npm run verify:routes`
  - `cd hushh-webapp && npm run verify:capacitor:routes`
  - `cd hushh-webapp && npm run verify:capacitor:audit`

## Canonical App Routes

Keep navigation documentation aligned with `hushh-webapp/lib/navigation/routes.ts`:

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

Detail entrypoints that require an identifier use query-backed static routes so Capacitor export stays compatible:

- `/marketplace/ria?riaId=<ria_id>`
- `/ria/workspace?clientId=<investor_user_id>`

Legacy navigation surfaces and aliases must not be reintroduced without updating both `routes.ts` and this reference.

## Visible Route Coverage

`pageContracts[]` is the declared inventory for the live visible page tree. The Capacitor parity registry must classify every `pageContracts[]` entry as:

- native-supported
- explicitly web-only exempt

If a page exists on disk and is not declared in `pageContracts[]`, `npm run verify:routes` fails.
If a declared page contract is not classified for Capacitor parity, `npm run verify:capacitor:routes` fails.

## When To Update `route-contracts.json`

Update the manifest whenever you:

- add a new Next.js API route under `hushh-webapp/app/api/`
- change a backend router prefix or supported backend path family
- add, remove, or rename a Capacitor plugin method that must exist in TS, iOS, and Android
- intentionally retire an old proxy or plugin surface

## Contract Shape

Each `contracts[]` entry typically includes:

- `id`: stable identifier used in verification errors
- `webRouteFile` or `webRouteFiles`: repo-relative Next.js `route.ts` files
- `backend`:
  - `file`: FastAPI router module path
  - `routerPrefix`: declared `APIRouter(prefix="...")`
  - `paths`: supported path family list relative to the prefix
- `native`:
  - `tsPluginFile`: TypeScript plugin export
  - `iosPluginFile`: Swift plugin
  - `androidPluginFile`: Kotlin plugin
  - `requiredMethodNames`: TS methods that must exist

## Allowlisting

`allowlistedWebRouteFiles` is reserved for intentional exceptions such as web-only utilities.

Default stance:

- tri-flow features should use a real contract entry
- removed legacy routes should be deleted, not allowlisted
- wildcard proxies should be constrained to supported backend paths

## Relationship To Other Docs

- [api-contracts.md](./api-contracts.md) describes the API surface itself.
- `route-contracts.json` is a guardrail that prevents undeclared route drift.
- [../mobile/capacitor-parity-audit.md](../mobile/capacitor-parity-audit.md) defines the stricter mobile release gate layered on top of route contracts.
