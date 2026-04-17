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
5. Do not default to Playwright when a faster proof is sufficient:
   - use typecheck, route/service tests, and Next runtime diagnostics first
   - reserve Playwright for browser-only behavior such as auth, unlock, navigation, responsiveness, or interaction defects
6. Treat protected-route browser verification according to the vault model:
   - the vault key is memory-only
   - Next client navigation preserves unlocked state
   - full document navigations and raw `page.goto(...)` reset React memory and may require re-unlock
7. For signed-in Playwright work, the default protected-route browser contract is:
   - reviewer-mode login
   - vault unlock using the configured Kai/reviewer passphrase from env
   - real in-app clicks for same-session route coverage
8. Use direct deep links only when explicitly validating cold-entry behavior, redirect behavior, or re-unlock flows.
9. Default frontend runtime launch behavior must be a visible OS terminal window, not a hidden Codex session.
10. Prefer `./bin/hushh terminal web --mode <mode>` as the primary frontend runtime path unless the user explicitly asks for a hidden/background launch.
11. Use `./bin/hushh terminal stack --mode <mode>` only when one combined visible terminal is explicitly preferred over separate backend/frontend terminals.
12. Persona-facing UI copy must avoid internal architecture abbreviations such as `PKM`; use plain-language labels unless the route is explicitly developer-facing.
13. Signed-in nested routes and query-state workspaces must use the shared top app bar as the back-navigation owner instead of rendering inline body back controls.
14. Profile-family vault actions belong in the shared top app bar, not route-local hero chrome.
15. Standard signed-in route headers should use `PageHeader icon={...}` as the default leading treatment; custom `leading` content is only for semantic non-icon cases.
16. Route-header accent choice must follow the surface identity (`marketplace`, `ria`, `consent`, `kai`, etc.), not the broader parent section by habit.
17. When a primary signed-in route header includes both actions and descriptive copy, prefer the standard 3-row mobile layout instead of forcing actions inline.
18. Analysis/workspace sections should not stack duplicate summary cards that restate the same read; keep one primary card and make secondary surfaces additive.
19. Responsive analysis surfaces must rebalance card grids and detail modules for tablet and desktop; a mobile-stacked composition should not ship unchanged on wide screens.
20. Modal and control-surface close affordances must behave like first-class interactive controls: keep content mounted through the exit animation, and ensure the close button has the same tactile feedback and click reliability as other actionables.
21. Every screen, card, sheet, and modal must answer the user’s next question; do not stop at labels, counts, or shallow summaries when the interface can expose the concrete object, evidence, or next action.
22. Reject vague summary text when the UI can expose real underlying items, names, states, or reasons.
23. Reject card-inside-card composition unless the inner surface creates real semantic separation that improves scanability.
24. Reject stacked headers, stacked framing chrome, or repeated explanatory text that restates the same idea.
25. Treat responsive composition review as mandatory across mobile, tablet, and desktop; do not ship width-only responsiveness.
26. Review density on every surface: text volume, chip usage, vertical space, and helper copy must all be justified by the user task.
27. Interaction review is required for all actionables; close, back, open, and tap states must feel consistent, tactile, and reliable across the app.
28. Reject these UX failure patterns by default:
   - vague counts without inspectable names, objects, or evidence
   - cards that open a modal or detail state which only restates the card
   - grouped text dumps that hide meaning instead of clarifying it
   - mobile-stacked compositions stretched onto desktop unchanged
   - decorative explanation text that does not support action or understanding
   - mismatched modal exit behavior, dead close affordances, or interaction feedback that feels weaker than the primary surface
   - one oversized summary block combined with smaller fragmented cards that do not form a balanced hierarchy
   - overuse of helper text, badges, chips, or status copy that increases noise without increasing clarity
   - screens that obviously need a better composition but are shipped as-is because the user did not ask for design help explicitly
   - detail surfaces that hide the important evidence behind arbitrary truncation, vague prose, or line-broken data dumps
29. Apply this UX review checklist mentally on every screen:
   - does the primary surface answer a real user question
   - if a card exposes a count, can the user inspect the underlying items cleanly
   - are repeated headers, repeated framing, or repeated copy removable
   - is the desktop/tablet layout intentionally rebalanced instead of merely widened
   - is the copy shorter, clearer, and more concrete than the previous version
   - do the actionables feel first-class and visually consistent
   - would this still feel credible without a dedicated UI/UX reviewer in the loop

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
