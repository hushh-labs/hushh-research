# Kai UI North Star

Kai route-facing UI lives here. The market route is the canonical shell/layout reference.

## Start Here

- `views/kai-market-preview-view.tsx`: canonical market-led shell and responsive layout reference.
- `views/dashboard-master-view.tsx`: portfolio/dashboard internals.
- `views/investments-master-view.tsx`: investment workspace.
- `onboarding/`: onboarding and preferences flows.
- `cards/`, `charts/`, `home/`: reusable Kai feature surfaces.
- Virtual scrolling via `@tanstack/react-virtual` for large holdings lists in portfolio views.
- R1/R2 round pill badges for debate confidence and risk alignment indicators.

## Rules

1. New Kai routes should copy the market shell contract before adding feature-specific layout.
2. Cache-first behavior after vault unlock belongs in shared services, not route-local fetch effects.
3. Route pages should compose shared shells and surfaces instead of inventing page chrome.
