# Consent UI North Star

This folder owns the shared consent center experience and all consent launchers.

## Start Here

- `consent-sheet-controller.tsx`: compatibility launcher that redirects older sheet entrypoints into the page route.
- `consent-center-page.tsx`: canonical standalone consent center page surface.
- `consent-center-view.tsx`: legacy embedded consent surface kept for compatibility.
- `notification-provider.tsx`: push/toast delivery and one-time pending hydration; not the primary source of truth for consent counts.

## Rules

1. There is one consent center experience.
2. `/one/consent` is the canonical route for that experience; `/consents` redirects while preserving its query.
3. The shield is the consent inbox. The bell stays dedicated to background tasks and push notifications.
4. `/one/consent` is One-owned by default. Missing actor, `actor=one`, and legacy `actor=investor` all resolve to the same One user access view.
5. RIA advisor workflows opt in explicitly with `actor=ria&view=outgoing`.
6. The canonical page uses `/api/consent/center/summary` + `/api/consent/center/list` for pending, active, and history tabs. The monolithic `/api/consent/center` payload is compatibility-only outside the Connections tab (formerly "relationships"; the legacy tab param is still accepted).
7. The shield inbox reuses the shared pending page-1 consent list cache and renders the first 5 rows from that payload.
8. Dense consent review happens in a detail panel, not as a permanent inline split layout on the root page.
9. History renders one row per requester/system/advisor identifier for the current One user. Separate scope and request chains live inside that row as activity trails connected by event timing.
