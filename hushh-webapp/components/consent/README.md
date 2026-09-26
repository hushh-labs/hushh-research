# Consent UI North Star

This folder owns the shared consent center experience and all consent launchers.

## Start Here

- `consent-sheet-controller.tsx`: compatibility launcher that redirects older sheet entrypoints into the page route.
- `consent-center-page.tsx`: canonical standalone consent center page surface.
- `notification-provider.tsx`: push/toast delivery and one-time pending hydration; not the primary source of truth for consent counts.
- `information-request-review-fields.tsx`: shared field, purpose and duration review for Profile's compact dialog and inline Chat. Both submit through `lib/consent/use-person-information-request.ts`; mounting or restoring a card never sends a request.

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
10. Discovery cards refresh current authorized catalog metadata before displaying retained fields. Profile and Chat follow explicit revisioned continuation; a revision change clears selections rather than combining old and new eligibility. Exact server-side eligibility validation is independent of loaded pages.
11. A request needs selected eligible fields (at most 50), a purpose, an access duration, unlocked authority, and explicit confirmation. Unchanged retries reuse an in-memory idempotency key; owner, recipient or vault-session changes cancel pending work. A failed refresh after sending must not be reported as a failed submission.
