---
name: frontend
description: Use when the request is broadly about the Hussh web frontend and the correct frontend specialist skill is not yet clear.
---

# Hussh Frontend Skill

## Purpose and Trigger

- Primary scope: `frontend-intake`
- Trigger on broad frontend requests across routes, components, services, contracts, and frontend verification where the correct spoke is not yet obvious.
- Avoid overlap with `mobile-native`, `docs-governance`, and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/app`
2. `hushh-webapp/components`
3. `hushh-webapp/lib`
4. `hushh-webapp/__tests__`
5. `hushh-webapp/scripts`

Non-owned surfaces:

1. `hushh-webapp/ios`
2. `hushh-webapp/android`
3. `docs-governance`

## Do Use

1. Broad frontend intake before the correct spoke is clear.
2. Cross-route, component, service, UI ownership, or frontend verification work.
3. Choosing between architecture, design-system, and surface-placement spokes.

## Do Not Use

1. Native-only plugin or parity work.
2. Backend, trust, or operational work outside the web frontend.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `docs/reference/quality/frontend-ui-architecture-map.md`
2. `docs/reference/quality/design-system.md`
3. `hushh-webapp/components/README.md`
4. `hushh-webapp/lib/services/README.md`
5. `.codex/skills/frontend/references/browser-ux-runtime.md`

## Workflow

1. Read the frontend architecture and design-system docs before narrowing ownership.
2. Route shared UI to `frontend-design-system`, route/package conventions to `frontend-architecture`, and placement/layer questions to `frontend-surface-placement`.
3. Route native-only concerns to `mobile-native`.
4. Keep route and verification changes aligned with existing package scripts and contracts.
5. Choose the smallest authoritative proof; use browser proof only for browser-only behavior or explicit user request.
6. For protected routes, distinguish same-session client navigation from cold-entry/re-unlock behavior.
7. Use canonical frontend runtime launch and phone-auth triage rules from `browser-ux-runtime.md`.
8. Apply the UX review kernel before finalizing visible routes, cards, sheets, modals, and actionables.

## Handoff Rules

1. Shared visual-system work routes to `frontend-design-system`.
2. Route contracts, package conventions, and verification ownership route to `frontend-architecture`.
3. File-placement and layer-boundary work routes to `frontend-surface-placement`.
4. Native-only work routes to `mobile-native`.
5. Cross-domain scans start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run verify:routes
```
