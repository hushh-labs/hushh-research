# Consent UI North Star

This folder owns the shared consent center experience and all consent launchers.

## Start Here

- `consent-sheet-controller.tsx`: compatibility launcher that redirects older sheet entrypoints into the page route.
- `consent-center-page.tsx`: canonical standalone consent center page surface.
- `consent-center-view.tsx`: legacy embedded consent surface kept for compatibility.
- `notification-provider.tsx`: pending consent count, delivery state, and bell summary data.

## Rules

1. There is one consent center experience.
2. `/consents` is the canonical route for that experience.
3. Bell, profile, notifications, and compatibility entrypoints must all converge on the same page route.
