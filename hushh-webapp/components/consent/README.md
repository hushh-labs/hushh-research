# Consent UI North Star

This folder owns the shared consent center experience and all consent launchers.

## Start Here

- `consent-inbox-dropdown.tsx`: top-shell shield inbox for the active persona, rendering the first 5 rows from the shared pending page-1 consent cache.
- `consent-sheet-controller.tsx`: compatibility launcher that redirects older sheet entrypoints into the page route.
- `consent-center-page.tsx`: canonical standalone consent center page surface.
- `consent-center-view.tsx`: legacy embedded consent surface kept for compatibility.
- `notification-provider.tsx`: push/toast delivery and one-time pending hydration; not the primary source of truth for consent counts.
- `consent-dialog.tsx`: grant/revoke consent dialog using `DOMAIN_EMOJI` mapping and `resolveScopeDisplay` helpers.

## Rules

1. There is one consent center experience.
2. `/consents` is the canonical route for that experience.
3. The shield is the consent inbox. The bell stays dedicated to background tasks and push notifications.
4. The active persona is the default actor for both the shield inbox and `/consents`.
5. The canonical page uses `/api/consent/center/summary` + `/api/consent/center/list`, not the monolithic `/api/consent/center` payload.
6. The shield inbox reuses the shared pending page-1 consent list cache and renders the first 5 rows from that payload.
7. Dense consent review happens in a detail panel, not as a permanent inline split layout on the root page.
