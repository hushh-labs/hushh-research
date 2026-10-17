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
  Truthy values: `1`, `true`, `yes`, `on`. Advertises the reviewer button; it no longer lets the
  session route mint without a credential. Ignored in production (see below).
- `REVIEWER_UID`
- `REVIEWER_VAULT_PASSPHRASE` (non-production only): the credential the session route requires.

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

## Session mint request and response

`POST /api/app-config/review-mode/session`

```json
{
  "subject": "reviewer",
  "smoke_passphrase": "<the reviewer's vault passphrase>",
  "reviewer_uid": "<optional: a configured reviewer uid>"
}
```

```json
{
  "token": "<firebase-custom-token>"
}
```

### The mint requires the reviewer credential (2026-09-29)

Outside production the route mints only for a request that proves a configured reviewer pair:
`smoke_passphrase` must equal that pair's `REVIEWER_VAULT_PASSPHRASE` (or the counterpart's),
compared in constant time as UTF-8 bytes, under the route's existing `10/minute` limit. A request
naming a configured `reviewer_uid` must carry **that** pair's passphrase. A bare request, a wrong
passphrase, or a backend holding no passphrase gets `403 Review session credential required`,
whatever `APP_REVIEW_MODE` says, and logs `app_review_mode.session_refused
reason=credential_missing|credential_mismatch|credential_not_configured`. Neither the passphrase
nor the token is ever logged. The `?local=1` offline answer sits behind the same check, so it no
longer discloses `REVIEWER_UID` to an unauthenticated caller.

The rate limit keys unauthenticated callers by remote address and is per process unless
`RATE_LIMIT_STORAGE_URI` points at shared storage, so it bounds guessing per instance rather than
across the fleet. The passphrase must stay long enough that this does not matter.

Callers and where each gets the credential (process env or the env resolver only, never a file
or a log):

| Caller | Credential source |
| --- | --- |
| Native test bootstrap (`hushh-webapp/components/app-ui/native-test-bootstrap.tsx`), iOS and Android test bridges, `hushh-webapp/scripts/perf/ios-reviewer-signin.sh`, perf cards | Bridge `vaultPassphrase` from launch arguments, fed from `REVIEWER_VAULT_PASSPHRASE` / `HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE` in process env |
| Reviewer rehearsal harness (`.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs`) | Bridge `reviewerSessionPassphrase`, a mint-only field, so the locked-vault context can authenticate without enabling auto-unlock |
| "Continue as reviewer" in native test mode (`hushh-webapp/components/onboarding/AuthStep.tsx`) | The same bridge fields |
| `hushh-webapp/scripts/perf/resolve-reviewer-uid.mjs` | Process env, already |
| `hushh-webapp/scripts/testing/export-reviewer-test-env.mjs` | The env resolver the others are loaded from |
| Localhost backend | Start it from a shell that evaluated the resolver's output (`scripts/env/reviewer_mode.sh` prints the command); the overlay file still never holds the passphrase |

**Where the reviewer button renders.** "Continue as reviewer" renders only in native test mode
(`showReviewer` in `hushh-webapp/components/onboarding/AuthStep.tsx` requires the test bridge). That
bridge exists only in `#if DEBUG` iOS builds, debuggable Android builds and injected automation
bridges, so a Release TestFlight build or the UAT website never shows the button, whatever
`APP_REVIEW_MODE` advertises. Requiring the credential therefore breaks no human sign-in path: a
UAT-backed TestFlight build offers an Apple beta reviewer only the normal providers.
Offering a reviewer sign-in to such a reviewer would be a new visible surface, a product decision
this change does not make.

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
the Firebase authority `hushh-pda`. A UID configured on UAT can be signed into from UAT by anyone
holding its passphrase, and the only thing keeping that session off production is the lane claim
described below.

## Lane containment: one Firebase authority (2026-09-29)

**The lanes share one Firebase authority.** The UAT and production backends both hold
`FIREBASE_ADMIN_CREDENTIALS_JSON` for project `hushh-pda`, so a Firebase ID token issued on
either lane is cryptographically valid on both. Until this change a review session minted on UAT
could be exchanged for an ID token and presented to the production API as the reviewer.

What contains it now:

1. **Every review-mode mint is marked.** `POST /api/app-config/review-mode/session` passes the
   developer claim `hushh_review_mint: "<lane>"` to `create_custom_token`, where the lane is the
   service's `ENVIRONMENT` (`dev`, `uat`, `development` on localhost). Firebase carries
   custom-token developer claims into every ID token of that sign-in, including refreshed ones.
2. **Every verifier refuses a marked token outside its own lane.**
   `refuse_foreign_review_mint` in `api/utils/firebase_auth.py` refuses a token whose
   `hushh_review_mint` is present and differs from this service's lane, and refuses every marked
   token on production (`ENVIRONMENT=production` or `APP_RUNTIME_PROFILE=production`), whatever
   the claim says. The refusal is the same `401 Invalid Firebase ID token` an invalid token gets,
   and logs `one.auth.review_mint_rejected env=<this lane> minted_for=<claim>`, never the token.
   Unmarked tokens (every ordinary Google, Apple, phone or trusted-device sign-in) are unaffected.
3. **A review session cannot mint an unmarked token.** Two routes turn a signed-in session into a
   fresh custom token that cannot inherit the claim: trusted-device approval
   (`/api/account/trusted-device-authorizations`, exchanged at `.../exchange`) and the Hussh Tech
   launch (`/api/v1/products/hushh-tech/launch/authorize`, exchanged at `.../launch/exchange`).
   Both refuse any marked session, on every lane, at the step where the session is presented
   (`403 TRUSTED_DEVICE_REVIEW_SESSION_REFUSED`, and `401 UNAUTHENTICATED` respectively).

Verification paths and how each is covered:

| Path | Coverage |
| --- | --- |
| `verify_firebase_bearer` (`api/utils/firebase_auth.py`), behind `require_firebase_auth`, `require_firebase_auth_read_only`, consent, notifications, session, SSE, agent chat, voice, voice actor proof, Hussh Tech and debug routes | Refuses directly |
| `_verify_browser_enrollment_identity` (`api/routes/account.py`) | Refuses directly, and refuses any marked session |
| `_verify_phone_claim_id_token` (`api/routes/account.py`, also used by `api/routes/ria.py`) | Refuses directly (a minted session is `custom`, not `phone`, so it already failed the provider check) |
| `_require_recent_firebase_auth`, `_authorize_firebase_watermark` (`api/routes/hushh_tech.py`) | Refuse directly; the second also refuses any marked session |
| `_recipient` (`api/routes/drive_sharing.py`) | Covered by its `require_firebase_auth_read_only` dependency on the same `Authorization` header, which runs first |
| Next.js `validateFirebaseToken` (`hushh-webapp/lib/auth/validate.ts`) | Pre-check only; every route that uses it forwards the same header to a backend route above |

What this does **not** do: it does not reach review sessions minted before the change. Those
carry no claim, and their refresh tokens keep producing unmarked ID tokens. Revoking the UAT
reviewer's refresh tokens ends them; production verifies with `check_revoked=True`, so a
revocation takes effect there within the 60-second positive cache.

The legacy production `REVIEWER_UID` value predating this decision (first version 2026-02-21)
is a Firebase user with no sign-in provider, so only a minted token can reach it. It cannot be
used through normal sign-in. Repoint the secret to the new account once that account exists.
