---
name: frontend
description: Use when the request is broadly about the Hushh web frontend and the correct frontend specialist skill is not yet clear.
---

# Hushh Frontend Skill

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
2. Requests that cut across route contracts, UI ownership, service boundaries, and frontend verification.
3. Choosing whether work belongs in design-system, architecture, or surface-placement specialists.

## Do Not Use

1. Native-only plugin or parity work.
2. Backend, trust, or operational work outside the web frontend.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `docs/reference/quality/frontend-ui-architecture-map.md`
2. `docs/reference/quality/design-system.md`
3. `hushh-webapp/components/README.md`
4. `hushh-webapp/lib/services/README.md`

## Workflow

1. Read the frontend architecture and design-system docs before narrowing the task.
2. Decide whether the work belongs to `frontend-design-system`, `frontend-architecture`, or `frontend-surface-placement`.
3. Route native-only concerns to `mobile-native`.
4. Keep route and verification changes aligned with existing package scripts and contracts.
5. Treat protected-route browser verification according to the vault model:
   - the vault key is memory-only
   - Next client navigation preserves unlocked state
   - full document navigations and raw `page.goto(...)` reset React memory and may require re-unlock
6. For signed-in Playwright work, prefer real in-app clicks after login/unlock for same-session route coverage.
7. Use direct deep links only when explicitly validating cold-entry behavior, redirect behavior, or re-unlock flows.
8. Default frontend runtime launch behavior must be a visible OS terminal window, not a hidden Codex session.
9. Prefer `./bin/hushh terminal web --mode <mode>` as the primary frontend runtime path unless the user explicitly asks for a hidden/background launch.
10. Use `./bin/hushh terminal stack --mode <mode>` only when one combined visible terminal is explicitly preferred over separate backend/frontend terminals.
11. Persona-facing UI copy must avoid internal architecture abbreviations such as `PKM`; use plain-language labels unless the route is explicitly developer-facing.
12. Signed-in nested routes and query-state workspaces must use the shared top app bar as the back-navigation owner instead of rendering inline body back controls.
13. Profile-family vault actions belong in the shared top app bar, not route-local hero chrome.
14. Standard signed-in route headers should use `PageHeader icon={...}` as the default leading treatment; custom `leading` content is only for semantic non-icon cases.
15. Route-header accent choice must follow the surface identity (`marketplace`, `ria`, `consent`, `kai`, etc.), not the broader parent section by habit.
16. When a primary signed-in route header includes both actions and descriptive copy, prefer the standard 3-row mobile layout instead of forcing actions inline.
17. Analysis/workspace sections should not stack duplicate summary cards that restate the same read; keep one primary card and make secondary surfaces additive.

## Handoff Rules

1. Route shared visual-system work to `frontend-design-system`.
2. Route route contracts, package conventions, and verification ownership to `frontend-architecture`.
3. Route file-placement and layer-boundary work to `frontend-surface-placement`.
4. If the task becomes native-only, route it to `mobile-native`.
5. If the task begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run verify:routes
```

When route work touches protected signed-in surfaces, also prove one real browser flow using reviewer login plus vault unlock before calling the task done.
