# Env/Secrets Key Matrix


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This matrix is the canonical key-level contract used by the pre-launch verification workflow.
It is intentionally key-only (no values) and is used to classify keys as `required`, `optional`, `legacy`, or runtime `drift`.

For live evidence across `.env`, `.env.local`, deploy manifests, Secret Manager, and Cloud Run:

```bash
bash scripts/verify-pre-launch.sh
```

Canonical environment keys:

1. Backend: `ENVIRONMENT=development|uat|production`
2. Frontend: `NEXT_PUBLIC_APP_ENV=development|uat|production`

Current environment divergence policy:

1. UAT and production use the same canonical frontend key shape.
2. Analytics/GTM use one active key per deployed environment, not per-environment fan-out inside local profile files.
3. Maintainer-only overlays stay out of the canonical runtime contract and out of this matrix.

Profile bootstrap rule:

1. `scripts/env/bootstrap_profiles.sh` must validate canonical identity keys in generated local profiles:
- backend `ENVIRONMENT`
- frontend `NEXT_PUBLIC_APP_ENV`

## Contract Matrix

| key | read_by_code | backend_local_env | frontend_local_env | secret_manager | backend_cloudbuild | frontend_cloudbuild | cloud_run_live_backend | cloud_run_live_frontend | classification |
|---|---|---|---|---|---|---|---|---|---|
| `APP_SIGNING_KEY` | `consent-protocol/hushh_mcp/config.py` | Y | N | Y | secret | N | secret | N | required |
| `VAULT_DATA_KEY` | `consent-protocol/hushh_mcp/config.py` | Y | N | Y | secret | N | secret | N | required |
| `GOOGLE_API_KEY` | `consent-protocol/hushh_mcp/config.py` | Y | N | Y | secret | N | secret | N | required |
| `FIREBASE_ADMIN_CREDENTIALS_JSON` | `consent-protocol/api/utils/firebase_admin.py`, `hushh-webapp/lib/firebase/admin.ts` | Y | Y | Y | secret | secret | secret | secret | required |
| `APP_FRONTEND_ORIGIN` | `consent-protocol/server.py` | Y | N | Y | secret | N | secret | N | required |
| `BACKEND_RUNTIME_CONFIG_JSON` | `consent-protocol/hushh_mcp/runtime_settings.py`, `consent-protocol/server.py` | Y | N | Y | secret | N | secret | N | required |
| `DB_USER` | `consent-protocol/db/connection.py` | Y | N | Y | secret | N | secret | N | required |
| `DB_PASSWORD` | `consent-protocol/db/connection.py` | Y | N | Y | secret | N | secret | N | required |
| `GMAIL_OAUTH_CLIENT_ID` | `consent-protocol/hushh_mcp/services/gmail_receipts_service.py` | Y | N | Y | secret | N | secret | N | required |
| `GMAIL_OAUTH_CLIENT_SECRET` | `consent-protocol/hushh_mcp/services/gmail_receipts_service.py` | Y | N | Y | secret | N | secret | N | required |
| `GMAIL_OAUTH_REDIRECT_URI` | `consent-protocol/hushh_mcp/services/gmail_receipts_service.py` | Y | N | Y | secret | N | secret | N | required |
| `GMAIL_OAUTH_TOKEN_KEY` | `consent-protocol/hushh_mcp/services/gmail_receipts_service.py` | Y | N | Y | secret | N | secret | N | required |
| `OPENAI_API_KEY` | `consent-protocol/hushh_mcp/services/voice_intent_service.py` | Y | N | Y | secret | N | secret | N | required |
| `VOICE_RUNTIME_CONFIG_JSON` | `consent-protocol/hushh_mcp/runtime_settings.py`, `consent-protocol/api/routes/kai/voice.py`, `consent-protocol/hushh_mcp/services/voice_intent_service.py` | Y | N | Y | secret | N | secret | N | required |
| `HUSHH_DEVELOPER_TOKEN` | `consent-protocol/api/routes/session.py` | Y | N | N | N | N | N | N | optional |
| `ENVIRONMENT` | `consent-protocol/hushh_mcp/config.py` | Y | N | N | env | N | env | N | required |
| `GOOGLE_GENAI_USE_VERTEXAI` | runtime SDK config | Y | N | N | env | N | env | N | required |
| `DB_HOST` | `consent-protocol/db/connection.py` | Y | N | N | env | N | env | N | required |
| `DB_PORT` | `consent-protocol/db/connection.py` | Y | N | N | env | N | env | N | required |
| `DB_NAME` | `consent-protocol/db/connection.py` | Y | N | N | env | N | env | N | required |
| `CONSENT_SSE_ENABLED` | `consent-protocol/api/routes/sse.py` | Y | N | N | env | N | env | N | required |
| `SYNC_REMOTE_ENABLED` | `runtime deploy env` | Y | N | N | env | N | env | N | required |
| `DEVELOPER_API_ENABLED` | `consent-protocol/server.py` | Y | N | N | env | N | env | N | required |
| `CORS_ALLOWED_ORIGINS` | `consent-protocol/server.py` | Y | N | N | env | N | env | N | required |
| `BACKEND_URL` | frontend server-side API handlers | N | N | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_BACKEND_URL` | `hushh-webapp/lib/config.ts` | N | Y | N | N | N | N | N | required |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `hushh-webapp/lib/firebase/config.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `hushh-webapp/lib/firebase/config.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `hushh-webapp/lib/firebase/config.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `hushh-webapp/lib/firebase/config.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `hushh-webapp/lib/firebase/config.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `hushh-webapp/lib/firebase/config.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | `hushh-webapp/lib/notifications/fcm-service.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | `hushh-webapp/lib/observability/env.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_GTM_ID` | `hushh-webapp/lib/observability/env.ts` | N | Y | Y | N | Y | N | N | required |
| `NEXT_PUBLIC_APP_ENV` | `hushh-webapp/lib/app-env.ts` | N | Y | N | N | N | N | N | required |
| `IOS_GOOGLESERVICE_INFO_PLIST_B64` | native release pipeline | N | N | Y | N | N | N | N | optional |
| `ANDROID_GOOGLE_SERVICES_JSON_B64` | native release pipeline | N | N | Y | N | N | N | N | optional |
| `APPLE_TEAM_ID` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `IOS_DEV_CERT_P12_B64` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `IOS_DEV_CERT_PASSWORD` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `IOS_DEV_PROFILE_B64` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `IOS_DIST_CERT_P12_B64` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `IOS_DIST_CERT_PASSWORD` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `IOS_APPSTORE_PROFILE_B64` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `APPSTORE_CONNECT_API_KEY_P8_B64` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `APPSTORE_CONNECT_KEY_ID` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `APPSTORE_CONNECT_ISSUER_ID` | native iOS signing bootstrap | N | N | Y | N | N | N | N | optional |
| `ANDROID_RELEASE_KEYSTORE_B64` | native Android signing bootstrap | N | N | Y | N | N | N | N | optional |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | native Android signing bootstrap | N | N | Y | N | N | N | N | optional |
| `ANDROID_RELEASE_KEY_ALIAS` | native Android signing bootstrap | N | N | Y | N | N | N | N | optional |
| `ANDROID_RELEASE_KEY_PASSWORD` | native Android signing bootstrap | N | N | Y | N | N | N | N | optional |
| `NEXT_PUBLIC_ENVIRONMENT_MODE` | `hushh-webapp/lib/app-env.ts` | N | Y | N | N | N | N | N | legacy |
| `REVIEWER_EMAIL` | none | N | N | N | N | N | N | N | legacy |
| `REVIEWER_PASSWORD` | none | N | N | N | N | N | N | N | legacy |
| `NEXT_PUBLIC_API_URL` | none | N | N | N | N | N | N | N | legacy |

## Notes

- `cloud_run_live_*` columns are evaluated from current active service revision at runtime by the audit script.
- `legacy` keys must not appear in Secret Manager, deploy manifests, or live Cloud Run env refs.
- Gmail and voice use the same backend key names across local, UAT, and production. Local bootstrap hydrates them into `consent-protocol/.env`; tracked files keep only placeholders/templates.
- Native release/signing secrets are deploy-only inputs. They are not part of the canonical frontend runtime profile files under `hushh-webapp/.env*.local*`.
- Maintainer-only overlays such as reviewer passphrases, rehearsal toggles, and native signing inputs are intentionally excluded from contributor env files. UAT still mounts `REVIEWER_UID` / `REVIEWER_VAULT_PASSPHRASE` from Secret Manager on the backend because app-review smoke cannot mint a reviewer Firebase token without those runtime bindings.
