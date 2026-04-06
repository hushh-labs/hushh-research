# App UI North Star

This folder is the canonical home for signed-in shell primitives, page chrome, and semantic app-level compositions.

## Start Here

- `app-page-shell.tsx`: page root, header region, and content region contract.
- `page-sections.tsx`: `PageHeader` and `SectionHeader`.
- `surfaces.tsx`: semantic bridge to the Morphy-owned surface primitives and `SurfaceStack`.
- `top-app-bar.tsx`: top chrome, persona switcher, shield consent inbox, and bell trigger.
- `shell-action-surface.tsx`: canonical interaction surface for top-shell buttons and pills.
- `top-shell-dropdown.ts`: shared dropdown chrome contract for shield/bell overlays.
- `debate-task-center.tsx`: notification bell surface for background tasks and activity.
- `route-error-boundary.tsx`: top-level error boundary for route failures with graceful fallback UI.

## Rules

1. Top-level page layout belongs here, not inside route files.
2. Shared headers and semantic app surfaces are the market-route reference implementation.
3. Base card primitives belong in `lib/morphy-ux/*`, not here.
4. New shell behavior must update `docs/reference/quality/README.md` and `app-surface-design-system.md`.
5. Labs components are never imported here directly; they must graduate first.
