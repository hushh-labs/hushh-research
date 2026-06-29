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
5. Keep persona-facing labels plain-language and route action ids aligned to One/Kai/Nav ownership. For One consent/vault copy, frame user-held knowledge/information as safewords and avoid generic `your data` onboarding language. Onboarding is One-first with downstream sub-onboardings (Kai/RIA/KYC): model every flow via the registry in `hushh-webapp/lib/navigation/onboarding-registry.ts` (One is the only account-scoped gate, reappearing only on reset/delete; subs are surface-scoped, independently re-enterable), gate on the authoritative store not the deprecated `kai_onboarding_required` cookie, and await server completion sync before navigating. See `docs/reference/quality/one-onboarding-architecture.md`.
6. Keep consumer notifications, Email Helper rows, and background-task rows free of implementation diagnostics. Do not show `PKM`, manifests, schemas, tokens, thread ids, workflow ids, consent ids, hashes, timings, correlation ids, route names, raw errors, or dummy-save language outside developer-only surfaces.
7. For signed-in route shell, header, search/filter, or hover changes, verify shared `AppPageShell`, `PageHeader`, `KaiCommandBarGlobal`, and app-ui interaction contracts before adding route-local chrome.
8. Use shadcn Sonner for transient success/error/loading feedback and shadcn AlertDialog for destructive confirmation. Do not add route-local inline error banners for row actions, saves, deletes, refreshes, or short-lived failures; reserve inline errors for stable page-blocking states. For async actionables that wait for a backend ack/status (deletes, resets, disconnects, sends), use the branded `morphyToast.promise` from `@/lib/morphy-ux/morphy` tied to the real action promise so one toast morphs loading -> success/error in place; never pair a manual loading toast with a separate success/error toast or fire success before the promise resolves. Confirmation buttons (`AlertDialogAction`/`AlertDialogCancel`) carry the shared Material ripple from `components/ui/alert-dialog.tsx`; do not swap them to the plain `@/components/ui/button` or strip the ripple host. See the Consumer Copy Contract and Ripple Ownership and Clipping sections in `app-surface-design-system.md`.
9. When changing approval-gated Email Helper drafts or preview templates, use the canonical `agent_kyc.approved_disclosure_formatter.v1` client renderer in `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` through the strict-ZK service. Do not hand-roll route-local email HTML, and keep plaintext/HTML output derived from the same render model.
10. Gmail-safe dense data tables must live in an inline-styled horizontal scroll wrapper with a fixed/minimum table width. Do not squeeze holdings or financial tables into mobile width if that causes overlap, truncation, or unreadable numeric columns.
11. Signed-in Email Helper, PKM, and consent UI proof must use the reviewer-mode vault-owner identity resolved from runtime env. Do not treat counterparty labels, copied recipients, thread ids, or admin fixtures as the active data owner.
12. Profile sharing controls must present the three visibility postures as plain language: `Private`, `Ask first`, and `Available by default`. Do not show `visibility_posture`, `default_available`, `scope`, `manifest`, `registry`, or `non-consented export` in consumer copy.
13. Review composition, hierarchy, responsive layout, interaction, form geometry, copy, and contrast through `design-review-kernel.md`.
14. Challenge incomplete, vague, asymmetric, or noisy UI before shipping the obvious weaker version.
15. Match all standalone buttons, pill triggers, and icon controls to the gold-standard flat-control recipe owned by the agent bar, bottom nav, and top-app-bar buttons. Reuse `ShellActionSurface` (`SHELL_ICON_BUTTON_CLASSNAME` / `SHELL_PILL_TRIGGER_CLASSNAME`) rather than re-deriving `rounded-full` + `bg-black/[0.05] dark:bg-white/[0.07]` + flat hover/press per surface. Sibling controls in one group must share one `morphy-ux` effect (do not mix `glass` and `fade`). See the Control Surface Contract in `app-surface-design-system.md`.
16. Give every modal floating surface the shared backdrop thump. Dialogs/sheets/drawers/command palette/vault dialog inherit it from `DialogOverlay`; modal popovers opt in with `PopoverContent withBackdrop` (renders `data-slot="popover-scrim"` animated by the shared `overlay-scrim-*` keyframes). Do not hand-roll per-surface scrim opacity, blur, or duration. Bottom navigation is a FIXED per-scope set: subroutes collapse onto their parent top-level tab (finance is the reference) through `lib/navigation/app-bottom-nav.ts`; never inject a per-subroute tab into the bar. There is exactly ONE app-wide route transition (uniform exit->enter crossfade): `useRouteTransition` (mounted once in `app/providers.tsx`) intercepts `<a>` clicks AND patches the History API once, so every `router.push`/`router.replace` inherits the crossfade with zero per-site code — never add a parallel navigation animation (framer-motion `template.tsx`, View Transitions, per-route motion); a hard-cut screen bypassed `router`/`<a>`, so route it through `router`, and keep `EXIT_MS`/`ENTER_MS` in `lib/morphy-ux/hooks/use-route-transition.ts` synced with `--motion-route-exit/enter-duration`. See the Overlay Backdrop Contract and Bottom Navigation Contract in `app-surface-design-system.md` and the Route transitions section in `lib/morphy-ux/README.md`.

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
