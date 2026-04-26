---
name: frontend-design-system
description: Use when changing Hussh UI architecture, shared components, shell chrome, or styling rules inside the frontend owner family.
---

# Hussh Frontend Design System Skill

## Purpose and Trigger

- Primary scope: `frontend-design-system`
- Trigger on shared UI architecture, reusable surface primitives, shell chrome, styling rules, and design-system policy changes.
- Avoid overlap with `frontend-architecture` and `frontend-surface-placement`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/components/ui`
2. `hushh-webapp/lib/morphy-ux`
3. `hushh-webapp/components/app-ui`
4. `docs/reference/quality/design-system.md`

Non-owned surfaces:

1. `frontend`
2. `mobile-native`
3. `docs-governance`

## Do Use

1. Shared component and shell-chrome work.
2. Morphy UX, app-ui, and stock UI ownership decisions driven by design-system semantics.
3. Design-system rule changes that require docs and verification updates.

## Do Not Use

1. Broad frontend intake where the correct spoke is still unclear.
2. Native plugin or mobile parity work.
3. Route-contract and package-convention work without a design-system rule change.

## Read First

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/frontend-ui-architecture-map.md`
3. `docs/reference/quality/app-surface-design-system.md`
4. `docs/reference/quality/frontend-pattern-catalog.md`

## Workflow

1. Read the design-system and frontend-ui architecture docs before touching shared UI code.
2. Decide the owning layer first: stock UI, Morphy UX, or app-ui.
3. Keep route-container ownership with `AppPageShell` or `FullscreenFlowShell`.
4. Update docs or verification commands in the same change when the rule itself changes.
5. Keep persona-facing labels plain-language; internal platform terms such as `PKM` stay out of consumer-facing surfaces unless the route is explicitly developer-facing.
6. Preserve one navigation language across breakpoints: grouped menu/list treatment should scale from mobile to desktop rather than switching to a separate desktop composition.
7. Shared top-bar navigation and actions take precedence over inline route-local back/unlock chrome on signed-in surfaces.
8. Standard route headers must use `PageHeader`'s `icon` slot by default; custom `leading` content is reserved for semantic non-icon content such as badges or avatars.
9. `PageHeader` accent selection must match the actual surface identity, not the broader parent product area.
10. Primary route headers with both actions and descriptive copy should default to the standard 3-row mobile layout; avoid `actionsInlineMobile` unless the header is intentionally utility-dense.
11. Analysis/workspace sections should use one primary summary card per read and avoid adjacent duplicate mini-summary cards.
12. Section layouts must be compositionally responsive, not just width-responsive; rebalance cards and supporting modules at tablet/desktop breakpoints instead of leaving mobile stacks stretched across wide screens.
13. Dialog and sheet close controls are part of the interaction system: they must stay clickable above surface chrome, keep content mounted through exit animations, and use the same tactile feedback language as other actionables.
14. Review composition before styling polish; choose the right information architecture before adding visual treatment.
15. Review hierarchy before adding cards, badges, helper copy, or status chrome.
16. Choose components by meaning and evidence density, not by convenience or visual familiarity.
17. Every multi-card section needs an explicit density and symmetry review so the layout reads as one intentional board, not a leftover stack of fragments.
18. Tablet and desktop re-layout is a first-class responsibility for app-facing surfaces; wide screens must be recomposed, not merely stretched.
19. Detail surfaces must be narrower and more focused than the page shell unless a broader layout is required for real content.
20. If a card exposes a count, the detail state must reveal the concrete items and why they matter.
21. Names, evidence, and grouped data must use the right component density; do not fall back to arbitrary comma-group text walls when chips, rows, or structured sections would be clearer.
22. Codex is expected to challenge incomplete, vague, or asymmetric UI and propose a better composition instead of shipping the obvious but weaker version.
23. Stack-owned detail screens must not repeat the same title in both the stack header and the first content group; remove duplicated framing instead of stacking `Preferences` over `Preferences`, `Security` over `Security`, or similar.
24. Route-level and stack-level transitions must be symmetric on enter and exit; if a screen slides in, the return path must feel like the inverse of that motion instead of a fade/pop fallback.
25. Apply this design review checklist mentally before finalizing a shared surface:
   - is the main question obvious
   - does the primary card answer something real
   - are there duplicate headers or repeated framing layers
   - is the detail view concrete, inspectable, and worth opening
   - is the desktop/tablet composition intentionally rebalanced
   - is the copy shorter, clearer, and less noisy than the previous version
   - would the result feel credible without a human UI/UX reviewer correcting it later
26. Focused auth, mandate, and verification flows should default to flat top-anchored composition; do not add decorative logo blocks or floating card wrappers unless the route genuinely needs a separate surface boundary.
27. Radius must be intentional and locally uniform; when a screen combines inputs, selects, and buttons, choose one radius scale for that flow instead of mixing stock button rounding with oversized field rounding.
28. If a surface uses shared primitives with overridden geometry, review every actionable and field in that flow together so one-off radii or container chrome do not slip through.
29. Consumer auth, onboarding, and verification flows must use plain product language; do not mention provider names, backend systems, token formats, or protocol terms in first-read UI copy.
30. Do not ship footer-style engineering notes under core verification or onboarding actions; keep supporting copy to one short line that directly helps the next user action.
31. Mandatory verification flows require a final review for plain-language clarity, radius consistency, and shell spacing before they are considered done.
32. Compact production forms should prefer the canonical form layer (`Field`, `FieldLabel`, `FieldDescription`, `InputGroup`) over route-local primitive restyling when symmetry and density matter.
33. If a route mixes `Input` and `Select`, they must share one row-shell geometry contract; do not try to visually match them with separate ad hoc utility stacks.
34. Verification forms are not hero surfaces by default; use form-width composition, tighter heading scale, and compact field spacing unless the product explicitly needs a showcase layout.
35. Interactive icons inside shared controls must inherit the active foreground of their host surface; do not leave chevrons, clear buttons, or adornments on muted gray when the hover/fill surface changes to a strong color.
36. Contrast review is required for shared interactive states: if a background becomes blue, dark, or accent-heavy on hover/open/pressed, the foreground and icons must remain visibly legible at the component layer.
37. Route shell, greeting, notification, consent, and memory copy must follow One/Kai/Nav ownership:
   - One owns shared shell, greetings, memory framing, background-task notifications, and specialist handoffs.
   - Kai owns finance analysis, portfolio, market, RIA finance, and decision-receipt copy.
   - Nav owns consent, privacy, vault, deletion, revocation, suspicious-access, and scope-review copy.
38. UI action ids for ordinary navigation must use `route.*`. Do not use `nav.*` unless the action is truly Nav-owned privacy/consent guardian behavior.
39. Product copy should use neutral voice descriptors and plain product language; do not add celebrity references or personal numeric preferences to maintained UI copy.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `frontend`.
2. If the question is primarily about route contracts or verification ownership, use `frontend-architecture`.
3. If the question is primarily about file placement or layer ownership, use `frontend-surface-placement`.
4. If the request begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:design-system
cd hushh-webapp && npm run verify:cache
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
```
