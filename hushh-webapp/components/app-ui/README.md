# App UI North Star

This folder is the canonical home for signed-in shell primitives, page chrome, and semantic app-level compositions.

## Start Here

- `app-page-shell.tsx`: page root, header region, and content region contract.
- `page-sections.tsx`: `PageHeader` and `SectionHeader`.
- `surfaces.tsx`: semantic bridge to the Morphy-owned surface primitives and `SurfaceStack`.
- `settings-ui.tsx`: shared grouped settings rows, segmented tabs, and mobile drawer/desktop detail-panel primitives.
- `top-app-bar.tsx`: the single `AppTopShell` renderer for the fixed bar,
  optional route-owned contextual tabs, persona switcher, vault action, and
  Profile. Cross-domain activity lives in the Feed tab (bottom nav), not here.
- `app-edge-back-gesture.tsx`: native iOS left-edge back affordance. It shares
  the authored top-shell back contract and takes priority over tab swipes.
- `shell-action-surface.tsx`: canonical interaction surface for top-shell buttons and pills.
- `top-shell-dropdown.ts`: shared dropdown chrome contract for shield/overlay surfaces.
- `command-fields.tsx`: shared command/search field chrome for route-local filters and pickers.
- `route-error-boundary.tsx`: top-level error boundary for route failures with graceful fallback UI.

## Rules

1. Top-level page layout belongs here, not inside route files.
2. Shared headers and semantic app surfaces are the market-route reference implementation.
3. Base card primitives belong in `lib/morphy-ux/*`, not here.
4. New shell behavior must update `docs/reference/quality/README.md` and `app-surface-design-system.md`.
5. Labs components are never imported here directly; they must graduate first.
6. Routes declare `hidden`, `bar`, or `bar-with-tabs` through the central top-
   shell route model. They must not render their own fixed bar, tab strip, or
   top spacer.
