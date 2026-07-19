# Mobile Runtime Model

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## Runtime Boundary

The WebView UI can point to `next dev` for hot reload, but native plugins must call the Python backend through `NEXT_PUBLIC_BACKEND_URL`. Next.js `app/api/**` routes are web-only proxy routes; native plugins are the mobile proxy layer.

Recommended local terminals:

```bash
./bin/hushh backend --mode local --reload
./bin/hushh native android --mode local --fresh
./bin/hushh native ios --mode local --fresh
```

Android emulators require `10.0.2.2` instead of `localhost` when talking to the host backend. The runtime-mode launcher rewrites this in `capacitor.config.ts` when the active mode uses localhost.

## Route Coverage

Visible page routes are governed by:

- `hushh-webapp/lib/navigation/routes.ts`
- [Route Contracts](../../reference/architecture/route-contracts.md)
- [Capacitor Parity Audit](../../reference/mobile/capacitor-parity-audit.md)

Do not add a visible route without:

1. adding it to the route inventory when it is part of the app navigation contract
2. updating route governance when behavior changes
3. wrapping browser-sensitive behavior or documenting an accepted exception

Accepted parity exceptions: none for visible route behavior.

Internal route recovery must use Next.js routing or the shared internal navigation event in `app/providers.tsx`. Do not use direct `window.location` mutation for internal routes because it can discard the in-memory BYOK vault key.

## Passkey Domain Association

Native passkeys require:

- `/.well-known/apple-app-site-association`
- `/.well-known/assetlinks.json`

Current route handlers:

- `hushh-webapp/app/.well-known/apple-app-site-association/route.ts`
- `hushh-webapp/app/.well-known/assetlinks.json/route.ts`

Required configuration:

- `APPLE_TEAM_ID` or `NEXT_PUBLIC_APPLE_TEAM_ID`
- `NEXT_PUBLIC_IOS_BUNDLE_ID`
- `ANDROID_SHA256_CERT_FINGERPRINTS`
- `NEXT_PUBLIC_ANDROID_APP_ID`
- `PASSKEY_ALLOWED_RP_IDS`

Keep `NEXT_PUBLIC_PASSKEY_RP_ID` unset for dual-domain web behavior unless a dedicated migration proves otherwise.

The four association values are Cloud Run runtime secrets. They must be mounted
on the frontend service, not only present in Secret Manager, because the
well-known routes are dynamic. Native passkeys use `one.hushh.ai` as the
canonical relying-party ID; both `one.hushh.ai` and `uat.one.hushh.ai` must
serve valid association documents for their corresponding mobile builds.

Release verification uses:

```bash
python3 scripts/ops/verify_passkey_domain_associations.py \
  --project <project-id> \
  --origin https://one.hushh.ai
```

The verifier compares the published documents with Secret Manager in memory
and emits only pass/fail status, never the app identifiers or certificate
fingerprints. iOS retrieves association files through Apple’s CDN, so a device
may need an app reinstall or time for the CDN/device cache to refresh after a
domain-association repair.

## Firebase Artifact Safety

Native Firebase artifacts are local build inputs, not tracked source files.

- iOS workflow: `hushh-webapp/ios/App/App/GoogleService-Info-README.md`
- Android workflow: generated build input, not committed source
- `./bin/hushh bootstrap` hydrates runtime profiles only; it does not materialize native Firebase artifacts
- root-level local Firebase artifacts remain untracked

## Browser Storage

Sensitive credentials and vault keys stay memory-only. On native cold start, browser session storage semantics are restored by `lib/utils/session-storage.ts`; `_session_` keys are purged on boot when the WebView falls back to persistent storage.
