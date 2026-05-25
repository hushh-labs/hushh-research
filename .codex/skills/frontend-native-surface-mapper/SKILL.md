---
name: frontend-native-surface-mapper
description: Use when changing or auditing the generated mapping between app routes, page files, Next.js API proxies, backend endpoint families, native transport, Capacitor plugins, and voice/action contracts.
---

# Hussh Frontend Native Surface Mapper Skill

## Purpose and Trigger

- Primary scope: `frontend-native-surface-map`
- Trigger on route-to-API/native/plugin/voice mapping, screen parity audits, Next.js server API dependency mapping, and generated surface-map contract changes.
- Avoid overlap with `frontend-architecture`, `mobile-parity-audit`, `backend-api-contracts`, and `kai-voice-governance`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/frontend-native-surface-map.generated.json`
2. `hushh-webapp/scripts/architecture/generate-surface-map.mjs`
3. `docs/reference/architecture/frontend-native-surface-map.md`

Non-owned surfaces:

1. `frontend`
2. `mobile-native`
3. `backend-api-contracts`
4. `kai-voice-governance`
5. `docs-governance`

## Do Use

1. Before changing a route that depends on a Next.js proxy, backend endpoint family, native plugin, or voice/action contract.
2. When mapping a screen's API calls to native transport and plugin behavior.
3. When adding route-specific overrides to the generated surface map.
4. When auditing whether a native iOS/Android screen still matches web route behavior.

## Do Not Use

1. Broad frontend structure work that belongs to `frontend-architecture`.
2. Native plugin implementation or registration work that belongs to `mobile-plugin-contracts`.
3. Backend route wire-shape changes that belong to `backend-api-contracts`.
4. Voice/action gateway authoring that belongs to `kai-voice-governance`.

## Read First

1. `docs/reference/architecture/frontend-native-surface-map.md`
2. `docs/reference/architecture/route-contracts.md`
3. `docs/reference/mobile/capacitor-parity-audit.md`
4. `hushh-webapp/frontend-native-surface-map.generated.json`

## Workflow

1. Run `cd hushh-webapp && npm run verify:surface-map` before trusting the map.
2. Inspect the target route's page file, service imports, `page.voice-action-contract.json`, and native inventory row.
3. If the route uses a new service, proxy, backend family, plugin, loader, header, or back-button pattern, update `generate-surface-map.mjs`.
4. Regenerate the contract from `hushh-webapp` with `node ./scripts/architecture/generate-surface-map.mjs`.
5. Re-run `cd hushh-webapp && npm run verify:surface-map`.
6. Hand off to backend, mobile, or voice skills when the map reveals a contract change outside this skill's ownership.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `frontend`.
2. If the work is broad route/package structure, route to `frontend-architecture`.
3. If native parity evidence or simulator proof is needed, route to `mobile-parity-audit`.
4. If a Next.js proxy or backend endpoint contract changes, route to `backend-api-contracts`.
5. If voice/action ids, reachability, or execution policy changes, route to `kai-voice-governance`.
6. If documentation homes or stale links are the main problem, route to `docs-governance`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:surface-map
cd hushh-webapp && npm run verify:capacitor:static
cd hushh-webapp && npm run verify:docs
```
