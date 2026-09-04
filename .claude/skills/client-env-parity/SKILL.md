---
name: client-env-parity
description: Prevents a client credential from existing in Secret Manager yet never reaching the app that needs it, and prevents an API key from rejecting an origin the app really runs at. Use BEFORE shipping any iOS/TestFlight/App Store or web build, when adding or changing any NEXT_PUBLIC_* value, when adding a build lane, when a feature works on web but not in the app (or the reverse), and whenever a map, embed, analytics tag, or third-party widget renders as a blank box, a placeholder, or a static fallback with no error in the console.
---

# Client env parity

**A credential that exists is not a credential that shipped.**

Two independent things must both be true before a client credential works. Each fails
silently on its own. Both failed at once on 2026-08-11, which is why this skill exists.

1. **The value reaches the build.** Every `NEXT_PUBLIC_*` is baked in at build time.
   Each lane copies its own explicit list, so a value can be perfect in Secret Manager
   and simply absent from one lane's build.
2. **The key accepts the origin.** A referrer-restricted key must list every origin the
   app actually runs at — and the app runs at more origins than the hosted domain.

Neither failure throws. The client reads `""`, or the provider returns a refusal the
UI already has a fallback for, and the feature degrades into something that looks
merely plain. A blank map is not an error state anyone reports.

---

## Run both checks

```bash
.claude/skills/client-env-parity/check.sh                       # value reaches every lane
.claude/skills/client-env-parity/check-key-origins.sh hushh-pda-uat   # key accepts every origin
```

Both exit non-zero on a gap and print exactly what is missing. `check.sh` is offline and
fast — put it in front of any release. `check-key-origins.sh` is read-only and needs
`gcloud`; it never modifies a key.

Verified to catch the real bug: run `check.sh` against `main` at
`34eb56b02d6734b0ecfa8455f009f0f66db7eac3` and it reports all three genuine gaps that
shipped. A guard that cannot fail is not a guard — re-prove it this way after editing it.

---

## The lanes, and why parity is not automatic

| Lane | File | How it passes values |
|---|---|---|
| web | `deploy/frontend.cloudbuild.yaml` | `--build-arg NEXT_PUBLIC_X=…` + `availableSecrets` |
| ios-testflight | `.github/workflows/ship-ios-testflight.yml` | `put NEXT_PUBLIC_X "$VAL"` → `.env.local` |
| ios-appstore | `.github/workflows/release-ios-appstore.yml` | `put NEXT_PUBLIC_X "$VAL"` → `.env.local` |

There is no shared list. Adding a value to the web lane does **not** add it to the iOS
lanes. `check.sh` compares `required-client-env.tsv` against all three.

**When you add a client credential, add a row to `required-client-env.tsv`.** That row —
not good intentions — is what makes the check protect it. Keep local-only and test-only
vars out; a noisy check gets ignored, which is precisely how the original bug survived.

---

## Origins this app runs at

From `hushh-webapp/capacitor.config.ts`:

```ts
ios:    { scheme: "App" }          // webview origin: App://localhost
server: { iosScheme: "App",
          androidScheme: "https" } // webview origin: https://localhost
```

So a browser key restricted to the hosted domain alone is rejected inside the app with
`RefererNotAllowedMapError`. The required list:

| Origin | Where it comes from |
|---|---|
| `https://<hosted-host>/*` | the real site |
| `http://localhost:3000/*` | `npm run dev` |
| `App://localhost/*` | **iOS app webview** — the one everyone forgets |
| `capacitor://localhost/*` | Capacitor's default if `iosScheme` is ever removed |
| `https://localhost/*` | Android app webview |
| `http://localhost/*` | Capacitor fallback |

Scheme matching is case-insensitive — `app://`, `App://`, and `APP://` all match a single
entry. Verified against Google directly, not assumed.

`gcloud services api-keys update` **replaces** the restriction lists; it does not append.
Always pass the complete desired set or you will silently drop the origins you meant to keep.

After widening a key, confirm it is still restricted:

```bash
curl -s -X POST "https://places.googleapis.com/v1/places:searchNearby" \
  -H "X-Goog-Api-Key: $KEY" -H "Referer: https://evil.example.com/" \
  -H "Content-Type: application/json" -H "X-Goog-FieldMask: places.id" \
  -d '{"includedTypes":["cafe"],"maxResultCount":1,"locationRestriction":{"circle":{"center":{"latitude":19.076,"longitude":72.877},"radius":500}}}'
# must return 403 "Requests from referer ... are blocked"
```

Widening is not the same as opening. Prove the difference.

---

## One key is rarely enough

A Capacitor app draws maps two different ways, and they need different keys:

| Surface | Renderer | Key |
|---|---|---|
| "Your Map" immersive — on native | `@capacitor/google-maps` native SDK | `NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY` |
| Onboarding location picker, LiveMap — on native | `@capacitor/google-maps` native SDK | `NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY` |
| Either surface — on web (browser tab, `npm run dev`) | Maps **JS** in the page | `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY` |

"It is the iPhone app, so the iOS key covers it" is the wrong instinct and cost this
incident — but so is "the onboarding picker is Maps JS, so it always wants the browser
key": that was true until the picker was moved onto the native SDK too, precisely
because the browser JS SDK is rejected inside the `App://` WKWebView. Both map surfaces
now key off `isNative()`, not off which surface they are — read
`hushh-webapp/lib/one-location/maps-config.ts` and the `isNative()` branch in
`location-picker-map.tsx` / `location-immersive-map.tsx` before assuming which key a
surface uses, rather than trusting this table's surface names alone.

Restrict each key to only the services its surface calls. The browser key needs
`maps-backend` (Maps JS), `places` (the picker's `Place.searchNearby` nearest-place
lookup — this key deliberately has no classic Geocoding API), and `routes`.

---

## Verifying a native build for real

A green workflow does not prove a credential landed in the app. Grep the built bundle:

```bash
KEY="$(gcloud secrets versions access latest \
  --secret=NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY --project=hushh-pda-uat)"
grep -rlF "$KEY" hushh-webapp/ios/App/App/public/ || echo "NOT IN THE BUILD"
```

To run it on a simulator use the `run-ios-sim` skill. Two things that will bite:

- `ios/App/App/GoogleService-Info.plist` is gitignored, so a local build fails with
  `Build input file cannot be found`. Fetch it the way the release workflow does, then
  **delete it again** when finished:
  ```bash
  gcloud secrets versions access latest --secret=IOS_GOOGLESERVICE_INFO_PLIST_B64 \
    --project=hushh-pda-uat | openssl base64 -d -A > hushh-webapp/ios/App/App/GoogleService-Info.plist
  ```
- The app is auth + vault gated. An agent can prove the build, the launch, the backend,
  and the absence of key errors in the log — it cannot reach a gated screen. Say so
  plainly instead of implying a screen was seen.

---

## What "verified" means here

Do not report a client credential as fixed on the strength of the secret existing. Show:

- the value is present in each lane that needs it (`check.sh`);
- the key accepts each origin and service (`check-key-origins.sh`);
- the key still rejects an unknown origin (the 403 above);
- the value is physically inside the built bundle (the grep above);
- for a native change, that the next build is what carries it — Capacitor has no
  over-the-air update, so a merged fix reaches a tester only through a new build.

Related: `run-ios-sim`, `mobile-bug-log`, `safe-changes`, `hushh-research-ship`.
