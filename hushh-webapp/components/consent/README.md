# Consent UI North Star

This folder owns the shared consent center experience and all consent launchers.

## Start Here

- `consent-inbox-dropdown.tsx`: top-shell shield inbox for the One user lane, rendering the first 5 rows from the shared pending page-1 consent cache.
- `consent-sheet-controller.tsx`: compatibility launcher that redirects older sheet entrypoints into the page route.
- `consent-center-page.tsx`: canonical standalone consent center page surface.
- `consent-center-view.tsx`: legacy embedded consent surface kept for compatibility.
- `notification-provider.tsx`: push/toast delivery and one-time pending hydration; not the primary source of truth for consent counts.
- `consent-dialog.tsx`: grant/revoke consent dialog using `DOMAIN_EMOJI` mapping and `resolveScopeDisplay` helpers.

## Rules

1. There is one consent center experience.
2. `/consents` is the canonical route for that experience.
3. The shield is the consent inbox. The bell stays dedicated to background tasks and push notifications.
4. `/consents` is One-owned by default. Missing actor, `actor=one`, and legacy `actor=investor` all resolve to the same One user access view.
5. RIA advisor workflows opt in explicitly with `actor=ria&view=outgoing`.
6. The canonical page uses `/api/consent/center/summary` + `/api/consent/center/list` for pending, active, and history tabs. The monolithic `/api/consent/center` payload is compatibility-only outside the relationships tab.
7. The shield inbox reuses the shared pending page-1 consent list cache and renders the first 5 rows from that payload.
8. Dense consent review happens in a detail panel, not as a permanent inline split layout on the root page.
9. History renders one row per requester/system/advisor identifier for the current One user. Separate scope and request chains live inside that row as activity trails connected by event timing.
