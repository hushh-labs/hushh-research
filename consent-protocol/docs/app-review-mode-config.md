# App Review Mode Runtime Config


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose
Move app-review-mode control from frontend build-time variables to backend runtime configuration.

## Endpoints
- `GET /api/app-config/review-mode`
- `POST /api/app-config/review-mode/session`

## Environment Variables (backend)
- `APP_REVIEW_MODE`
  Truthy values: `1`, `true`, `yes`, `on`. Ignored in production (see below).
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
- The passphrase bypass exists only so UAT/browser smoke can mint the same reviewer token without creating another user.
- `UAT_SMOKE_*` and `KAI_TEST_*` are deprecated one-release aliases.

## Production: backend-only review (founder decision, 2026-09-29)

The App Store binary talks to production. Apple still needs a demo sign-in, and the founder
decided the reviewer must not be visible in the interface. On production, review is therefore a
dedicated reviewer **account**, not a mode the app can see.

What production does, whatever `APP_REVIEW_MODE` says (`api/routes/health.py`):

- `GET /api/app-config/review-mode` always returns `{"enabled": false}`.
- `POST /api/app-config/review-mode/session` always returns `403 App review mode is disabled`,
  the same answer a disabled lane gives, and logs
  `app_review_mode.session_refused reason=production_runtime`. The mint is a sign-in with no
  credential; on production it would hand the reviewer account to anyone who asked.
- A production frontend build (`NEXT_PUBLIC_APP_ENV=production`) never calls either endpoint
  (`ApiService.getAppReviewModeConfig` returns `enabled: false`; `createAppReviewModeSession`
  throws). The "Continue as reviewer" button also needs native test mode, which is compiled out
  of Release iOS builds (`#if DEBUG` in `NativeTestSupport.swift`).
- Production detection is `ENVIRONMENT=production` or `APP_RUNTIME_PROFILE=production`. The live
  service sets `ENVIRONMENT=production`.

How the reviewer gets in, with no reviewer-specific backend grant:

1. **Sign-in** is the normal Google (or Apple) sign-in with a dedicated reviewer account that
   Hussh owns. The app has no other sign-in method, and the production test-phone allowlist is
   not a sign-in method.
2. **Phone mandate.** The account claims one number from `HUSHH_PROD_PHONE_TEST_NUMBERS` with
   the fixed code `HUSHH_PROD_PHONE_TEST_CODE` (`/api/account/phone/uat-test/*` in
   `api/routes/account.py`, honoured on production only when `HUSHH_PROD_PHONE_TEST_ENABLED` and
   the challenge secret are set). The allowlist is UID-agnostic: it grants a verified synthetic
   number, nothing else. Once claimed, later sign-ins do not ask again.
3. **Vault.** The reviewer vault is created in the app with a generated passphrase. Apple gets
   the passphrase in the App Store Connect review notes and types it; the app never fills it in.

Where the reviewer identity lives:

| Secret (project `hushh-pda`) | Holds | Bound to the production service? |
| --- | --- | --- |
| `REVIEWER_UID` | The production reviewer's Firebase UID | No |
| `REVIEWER_VAULT_PASSPHRASE` | The production reviewer's vault passphrase | No |

Both are for operator tooling only: the App Store submission notes and the iPhone device gate.
Production has no runtime use for either, and `config/deploy-env-coverage.json` keeps
`_REVIEWER_UID_SECRET` and `_REVIEWER_VAULT_PASSPHRASE_SECRET` out of `deploy-production.yml`.
`scripts/ops/sync_backend_runtime_secrets.py` re-writes an existing `REVIEWER_UID` to itself on
every production deploy (its legacy-fallback loop); that is expected and binds nothing.

**Never reuse the production reviewer as a UAT or dev `REVIEWER_UID`.** UAT and production share
the Firebase authority `hushh-pda`, and UAT mints a review session with no credential. A UID
configured there can be signed into from UAT, and the resulting Firebase session is also valid
against the production API.

The legacy production `REVIEWER_UID` value predating this decision (first version 2026-02-21)
is a Firebase user with no sign-in provider, so only a minted token can reach it. It cannot be
used through normal sign-in. Repoint the secret to the new account once that account exists.
