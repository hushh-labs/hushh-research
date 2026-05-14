# Frontend Native Surface Map

Use this workflow when a route, service, backend endpoint, native transport, plugin,
or voice/action contract may drift across web and native surfaces.

## Goal

Keep the generated surface map authoritative enough that agents can understand
which Next.js proxy, backend route family, native transport, plugin, and
voice/action contract belong to a screen before editing it.

## Steps

1. Start with `frontend` and use `frontend-native-surface-mapper` as the narrow spoke.
2. Run `cd hushh-webapp && npm run verify:surface-map` before trusting the current map.
3. Inspect the route page, service imports, API proxy file, backend endpoint family,
   native inventory entry, and `page.voice-action-contract.json` when present.
4. If dependencies changed, update `hushh-webapp/scripts/architecture/generate-surface-map.mjs`.
5. Regenerate from `hushh-webapp` with `node ./scripts/architecture/generate-surface-map.mjs`.
6. Re-run the surface-map, native static parity, and frontend docs checks.
7. Hand off to backend, native, voice, or docs owners when the map exposes a contract
   change outside frontend ownership.

## Common Drift Risks

1. A route calls a new service while the generated map still claims no API dependency.
2. Native uses direct backend transport while docs imply a Next.js server route.
3. Voice/action docs retain stale planning references after a route becomes current runtime.
4. A mobile parity audit checks markers but misses the route's actual API/plugin dependency.
