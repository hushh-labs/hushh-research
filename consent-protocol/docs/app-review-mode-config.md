# App Review Mode Runtime Config


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose
Move app-review-mode control from frontend build-time variables to backend runtime configuration.

## Endpoints
- `GET /api/app-config/review-mode`
- `POST /api/app-config/review-mode/session`

## Environment Variables (backend)
- `APP_REVIEW_MODE` (or `HUSHH_APP_REVIEW_MODE`)  
  Truthy values: `1`, `true`, `yes`, `on`
- `REVIEWER_UID`
- `REVIEWER_VAULT_PASSPHRASE` (non-production reviewer smoke bypass only)

## Response
- When disabled:
```json
{
  "enabled": false
}
```

- When enabled:
```json
{
  "enabled": true
}
```

## Session mint response

`POST /api/app-config/review-mode/session`

```json
{
  "token": "<firebase-custom-token>"
}
```

## Notes
- This endpoint is included via the shared health router.
- Frontend web requests can proxy through Next API routes.
- Native iOS/Android clients can call backend directly.
- No reviewer password is exposed to clients.
- The passphrase bypass is ignored in production and exists only so UAT/browser smoke can mint the same reviewer token without creating another user.
- `UAT_SMOKE_*` and `KAI_TEST_*` are deprecated one-release aliases.
- Production deploy uses backend secrets/env only (no frontend build-time reviewer env).
