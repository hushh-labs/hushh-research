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

1. Shared component, shell chrome, Morphy UX, and app-ui work.
2. Design-system rules that require docs or verification updates.
3. Reusable visual, layout, interaction, form, and copy primitives.

## Do Not Use

1. Broad frontend intake where the correct spoke is unclear.
2. Native plugin or mobile parity work.
3. Route-contract and package-convention work without a design-system rule change.

## Read First

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/frontend-ui-architecture-map.md`
3. `docs/reference/quality/app-surface-design-system.md`
4. `docs/reference/quality/frontend-pattern-catalog.md`
5. `.codex/skills/frontend-design-system/references/design-review-kernel.md`

## Workflow

1. Read design-system and frontend architecture docs before touching shared UI.
2. Decide the owning layer first: stock UI, Morphy UX, or app-ui.
3. Keep route-container ownership with shared shells.
4. Update docs or verification commands when the design rule itself changes.
5. Keep persona-facing labels plain-language and route action ids aligned to One/Kai/Nav ownership.
6. Keep consumer notifications, Email Helper rows, and background-task rows free of implementation diagnostics. Do not show `PKM`, manifests, schemas, tokens, thread ids, workflow ids, consent ids, hashes, timings, correlation ids, route names, raw errors, or dummy-save language outside developer-only surfaces.
7. Use shadcn Sonner for transient success/error/loading feedback and shadcn AlertDialog for destructive confirmation. Do not add route-local inline error banners for row actions, saves, deletes, refreshes, or short-lived failures; reserve inline errors for stable page-blocking states.
8. When changing approval-gated Email Helper drafts or preview templates, use the canonical client renderer in `hushh-webapp/lib/services/one-kyc-client-zk-service.ts`. Do not hand-roll route-local email HTML, and keep plaintext/HTML output derived from the same render model.
9. Gmail-safe dense data tables must live in an inline-styled horizontal scroll wrapper with a fixed/minimum table width. Do not squeeze holdings or financial tables into mobile width if that causes overlap, truncation, or unreadable numeric columns.
10. Review composition, hierarchy, responsive layout, interaction, form geometry, copy, and contrast through `design-review-kernel.md`.
11. Challenge incomplete, vague, asymmetric, or noisy UI before shipping the obvious weaker version.

## Handoff Rules

1. Broad or ambiguous frontend work routes back to `frontend`.
2. Route contracts or verification ownership route to `frontend-architecture`.
3. File placement or layer ownership routes to `frontend-surface-placement`.
4. Cross-domain scans start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:design-system
cd hushh-webapp && npm run verify:cache
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
```
