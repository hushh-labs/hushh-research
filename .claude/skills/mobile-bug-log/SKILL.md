---
name: mobile-bug-log
description: Running reference log of every iOS/mobile bug diagnosed + fixed on the `mobile` branch (symptom → root cause → fix → files/commit), plus the recurring build/runtime gotchas that keep biting. Use when the user asks "what bugs did we fix", "known issues", "list the resolved bugs", "why did X break", when a similar symptom reappears (check if it's a known regression before re-diagnosing), or before shipping a mobile build (re-verify the gotchas). ALWAYS append a new entry here whenever another mobile bug is resolved.
argument-hint: "[optional: keyword to filter, e.g. 'keyboard' | 'backend' | 'navigation']"
allowed-tools: Read Grep Glob Bash(git log*) Bash(git show*) Bash(grep*) Bash(xcrun simctl*)
paths:
  - .claude/skills/mobile-bug-log/**
  - hushh-webapp/**
---

# Mobile bug log (hushh One iOS)

The single source of truth for iOS/mobile bugs we've diagnosed and fixed on the **`mobile`** branch. Read this FIRST when a mobile symptom reappears — it's probably here. When you fix a new one, **append an entry** (symptom, root cause, fix, files, commit).

Related memory: [[hushh-research-mobile-branch]], [[hushh-research-ios-build]]. Diagnosis tool: `xcrun simctl spawn <UDID> log show --last 120s --predicate 'process == "App"'` (the WKWebView console + native network log — this is how most of these were found).

---

## 🔴 RECURRING GOTCHA #1 — Native build must point at the UAT backend (NOT localhost)
- **Symptom:** app can't check vault status ("We could not check your Vault status right now"), and — because guards can't verify state — the **top-bar back button and navigation die on EVERY screen**. Looks like a UI bug; it isn't.
- **Root cause:** `.env.local` has `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000` (local dev backend). `capacitor.config.ts` bakes that into every plugin's `backendUrl`, and the web layer fetches `${NEXT_PUBLIC_BACKEND_URL}/db/vault/check`. On the simulator that resolves to `127.0.0.1:8000`, which is **Connection refused (NSURLError -1004)** unless a local backend is running there. Confirmed via the sim log showing `http://127.0.0.1:8000/db/vault/check ... Connection refused`.
- **Fix:** build the sim against the reachable UAT backend. Inline override (does NOT touch the user's `.env.local`):
  `export NEXT_PUBLIC_BACKEND_URL="https://consent-protocol-f2gsa4kfsq-uc.a.run.app"` before `npm run cap:build && npm run cap:sync:ios`. Confirm after boot: `xcrun simctl spawn <UDID> log show --last 20s --predicate 'process=="App"' | grep -oE "consent-protocol|127.0.0.1:8000"` should show `consent-protocol`, never `127.0.0.1:8000`. (UAT url lives in `.env.uat.local`.)
- **Verify reachable first:** `curl -s -o /dev/null -w "%{http_code}" https://consent-protocol-f2gsa4kfsq-uc.a.run.app/` → `200`.
- **EVERY sim build must set this** or localhost:8000 gets baked back in.

## 🔴 RECURRING GOTCHA #2 — sim shuts down / stale install
- If `simctl install` fails with `Unable to lookup in current state: Shutdown`, the sim isn't booted. `xcrun simctl boot <UDID>; open -a Simulator; sleep 6` then install/launch. The build itself likely already succeeded (`** BUILD SUCCEEDED **`) — don't rebuild, just boot + install the existing `.app`.
- Build gotchas (see [[hushh-research-ios-build]]): Node 22 for `cap sync`; `NODE_OPTIONS=--max-old-space-size=8192` for `cap:build` (OOM); `GoogleService-Info.plist` required; DerivedData in `/tmp/hushh-ios-dd` (iCloud FinderInfo breaks codesign).

---

## Resolved bugs

### B1 — Set up One back button bounced back to /one/setup (native)
- **Symptom:** top-left back (←) on `/one/setup` did nothing (bounced straight back).
- **Root cause:** back button primes "setup resolved" + `router.push('/one')`, but `OneOnboardingGuard` (`components/kai/onboarding/kai-onboarding-guard.tsx`) only early-exits when the **vault is unlocked** (`unlockedOnStandardKaiRoute = isVaultUnlocked && !onOnboardingRoute`). Vault-locked → runs the async check → on native it transiently reports setup incomplete → `router.replace('/one/setup')`.
- **Fix:** native fast-path in the guard — if `isNativePlatform() && !onOnboardingRoute && readOneSetupCompletionHint(uid) === true`, clear cookies + `setChecking(false); return;` (trust the in-session hint, skip the bounce). Web unchanged (native-gated).
- **File:** `components/kai/onboarding/kai-onboarding-guard.tsx`. Note: this only matters once GOTCHA #1 is fixed (guards need a reachable backend to run at all).

### B2 — Agent chat header slid under the status bar when the keyboard opened
- **Symptom:** opening the composer keyboard pushed the "One" chat header up under the Dynamic Island / status bar.
- **Root cause:** `@capacitor/keyboard` is NOT installed and there's no keyboard-resize handling. iOS WKWebView doesn't shrink `100dvh`; it scrolls the whole `fixed inset-0` overlay up to reveal the focused input → the fixed header drifts under the status bar.
- **Fix:** `visualViewport` keyboard-pin in `components/agent/agent-popover-provider.tsx` — track keyboard height (`window.innerHeight - visualViewport.height - offsetTop`), shrink the mobile sheet to `h-[calc(100dvh-var(--agent-kb-height))]` (top-pinned, `bottom-auto`), and `window.scrollTo(0,0)` to undo any iOS scroll. Composer sits above the keyboard, header stays below the status bar. Mobile-scoped (`max-sm`).

### B3 — Agent chat looked "web-forced": header/composer overlapped safe areas, no back button, blue accents
- **Fix (commit `a6cb290b1`):** popover header height includes `--app-safe-area-top-effective`; composer adds `--app-safe-area-bottom-effective`; ink-glass back button replaces the top-right X; blue `text-primary` → luxury gold `#9C7434`/`#D4AF6A`, SF Pro type, iOS rounded cards. All `isPopover`/`max-sm`-scoped so desktop/web unchanged. File: `components/agent/agent-chat-workspace.tsx`.

### B4 — "Setup tiles do nothing" was NOT a routing/export bug
- **Ruled out:** all `/one/setup/<capability>/index.html` ARE exported in the static build + app bundle; tiles use relative routes (no external/uat URLs). The real cause of dead navigation was GOTCHA #1 (backend down → guards error). Don't chase the tiles; check the backend + guard first.

### B6 — "Finish setup" dashboard bar vanished after entering a couple of setup items (Gmail not set up) — QA/TestFlight blocker
- **Symptom:** on `/one`, the "Finish setup — X% done" bar disappeared once the user opened "Set up One" and tapped a couple of capability tiles, even though Gmail (and others) were not set up.
- **Root cause:** `app/one/setup/[capability]/one-onboarding-capability-client.tsx` `handlePrimary` (commit `d83ed1890`) resolved the **account-wide master gate** `PreVaultUserStateService.syncKaiSetupState({ completed: true })` whenever Continue forwarded into a hard-gated `/one/*` surface (gmail, email→/one/kyc, location, pkm, connected-systems) — done only to stop `OneOnboardingGuard` bouncing. But `setupCompleted === true` also makes `resolveFinance` (`lib/services/capability-setup-state-service.ts`) report **finance = completed** pre-vault, so entering ONE capability flipped enough tiles non-actionable that `hasSetupRemaining = some(isCapabilitySetupActionable)` (`one-dashboard-page.tsx`) went false → bar gone. NOT a symptom of the palette/UI work.
- **Fix (commit `ee35b9e12`) — decouple "entered a capability" from "finished ALL setup":**
  1. `one-onboarding-capability-client.tsx` — stop the master-gate write on capability entry; forward hard-gated surfaces with `?from=setup` instead (removed the `KaiProfileService.setOnboardingCompleted` call from this path too).
  2. `lib/navigation/routes.ts` — added `isCapabilityHandoffTarget()` (the gated `/one/*` handoff set: gmail/kyc/location/pkm/connected-systems; excludes finance→`/one/setup/kai` and consent→`/consents`).
  3. `components/kai/onboarding/kai-onboarding-guard.tsx` — allow a setup-originated (`?from=setup` + known gated target) entry through WITHOUT the master gate, at all 3 bounce points (added `&& !setupOriginatedCapabilityEntry`). Preserves `d83ed1890`'s redirect-loop fix without the account-wide side effect; scoped so arbitrary `/one/*` stays gated.
- **Net:** master gate now resolves only on a genuine finish (hub Skip/Continue → `syncKaiSetupState`), so the bar stays until the user actually finishes.
- **Verified:** typecheck + lint + `verify:design-system` + capability-client/routes/dashboard/auth-gate vitest all pass; iOS build succeeds + runs on sim against UAT. NOTE: full logged-in on-device repro (login → dashboard → tap tiles → bar persists → hub Skip/Continue → bar hides) still needs a human login (vault passphrase or an allowlisted UAT test number) — the unit tests encode the exact behavior change.
- **Same root cause exists on `main` (web)** — a separate PR can port it if the web team wants it.

### B7 — "Personal Data" (PKM) screen showed a red `HTTP Error 404: {"detail":"No data found for user"}` for fresh users (native only)
- **Symptom:** dashboard → "Personal Data" (`/one/pkm`, "Saved Intelligence", Readable tab) on a fresh/no-data account showed a red error banner `HTTP Error 404: {"detail":"No data found for user"}` + `0 domains / 0 saved details / 0 memory cards / Last updated Unavailable`. iOS/TestFlight only.
- **Root cause — web↔native parity gap.** The backend (`consent-protocol/api/routes/pkm_routes_shared.py`) raises `404 "No … data found for user"` for a data-less user as a NORMAL empty condition. The **web** branches of `getMetadata`/`getEncryptedData`/`getDomainData` in `lib/services/personal-knowledge-model-service.ts` already map `response.status === 404` → `emptyMetadata`/`null`. But the **native** branches call the Capacitor plugin (`HushhPersonalKnowledgeModel.*`) directly; the iOS Swift (`ios/App/App/Plugins/PersonalKnowledgeModelPlugin.swift` `executeRequest`) + Android Kotlin plugins `reject("HTTP Error <status>: <body>")` for ALL non-2xx, so the 404 throws and `pkm-natural-panel.tsx` paints `bootstrapError`. (`getDomainManifest` is NOT affected — it uses `ApiService.apiFetch` with its own 404→null; the bug is exactly 3 native call sites, not 4. `getAvailableScopes` is out of scope: no UI consumer + web also throws on 404, i.e. already symmetric.)
- **Fix (commit `bfc8bae3d`), single file `lib/services/personal-knowledge-model-service.ts`:** added `private static isNativeNoDataError(error)` = `/^HTTP Error 404\b/.test(message)` (anchored to the plugin prefix so 401/403/408/429/5xx, `Network error:`, `JSON parsing error:` all keep throwing — no false positives; the plugins reject with a message only, no `.code`). Wrapped the 3 native calls in try/catch: `getMetadata` → on no-data `result = this.emptyMetadata(userId)` (flows through the normal MEDIUM-ttl cache, mirroring web); `getEncryptedData`/`getDomainData` → on no-data `return null` (no cache write, mirroring web). Non-404 errors rethrow. Fixes natural panel + explorer + data-manager + agent-lab transitively.
- **Verified:** typecheck + lint + new `__tests__/services/pkm-native-no-data.test.ts` (9) + 45 PKM regression tests pass; a 9-agent investigation workflow + a 4-lens adversarial review workflow (control-flow / caching-staleness / matcher-precision / parity-completeness) returned **SHIP AS-IS, 0 confirmed defects**; iOS build runs on sim vs UAT. Full logged-in on-device repro (fresh account → Personal Data → no banner, clean empty state; then add a memory → Refresh → data appears; negative: force a 500 → error still surfaces) needs a human login.
- **Same gap exists on `main`/web is already correct there** (web branch handles 404); this is a native-only parity fix. iOS = immediate target; Android has the identical plugin so it benefits from the same TS fix.

### B8 — Chat composer disappears under the keyboard + header showed a generic Bot icon (iOS, QA raised ~20×)
- **Symptom 1 (critical):** opening the keyboard in the "One" chat pushed the composer ("Message One…" + mic + send) UNDER the keyboard — user couldn't see what they typed. The earlier visualViewport keyboard-pin (B2) did NOT reliably fix it. **Symptom 2:** header next to "One" showed a lucide `<Bot/>` "random chatbot icon" instead of the hushh One mark.
- **Root cause (keyboard):** NATIVE WKWebView scroll-drift, not CSS. `@capacitor/keyboard` was NOT installed, and `capacitor.config.ts ios.scrollEnabled: true` left the native `UIScrollView` free to auto-scroll the whole webview up to reveal the focused input. Because the chat sheet is `position: fixed`, that native scroll dragged the entire overlay (header under the status bar, composer under the keyboard). The JS `window.scrollTo(0,0)` in the visualViewport hack resets the DOM scroll, **not** `UIScrollView.contentOffset`, so it could never win. `100dvh` never shrinks (contentInset "never", no `interactive-widget` — which iOS/WKWebView does NOT support anyway).
- **Fix (robust, native-layer — commit `01050387a`):**
  1. `npm i @capacitor/keyboard@^8.0.5` + `cap sync ios` (adds CapacitorKeyboard SPM package).
  2. `capacitor.config.ts`: `ios.scrollEnabled: false` (kills the drift at root); add `Keyboard: { resize: "none", style: "LIGHT", resizeOnFullScreen: false }` (resize:none keeps 100dvh full so our own sheet-shrink owns avoidance — `native` would double-shrink + make fixed-bottom UI jump). Type-only import `KeyboardResize`/`KeyboardStyle` + `as` casts (string values need the enum types; type-only = no runtime import).
  3. `ios/App/App/MyViewController.swift`: `webView.scrollView.isScrollEnabled = false` (belt-and-suspenders).
  4. `components/agent/agent-popover-provider.tsx`: keyboard effect now uses the plugin's authoritative `keyboardWillShow.keyboardHeight` on `isNativePlatform()` to set `--agent-kb-height` (visualViewport kept as web fallback via dynamic-import gate); toggles `html.agent-kb-open`. The `--agent-kb-height` var + sheet calc `max-sm:h-[calc(100dvh-var(--agent-kb-height))]` are unchanged.
  5. `app/globals.css`: `html.agent-kb-open .agent-chat-workspace` drops the composer home-indicator padding to 0.5rem while typing (keyboard covers that zone).
  6. `components/agent/agent-chat-workspace.tsx`: header `<Bot/>` → `<Image src="/one-quiet-emoji.png" unoptimized>` (the 🤫 app-icon mark, already proven under the App:// scheme in AuthStep/vault-lock-guard/register-phone) in a gold-tinted squircle badge. `Bot` import kept (still used for message avatars ~L879).
  7. `components/kai/modals/edit-holding-modal.tsx`: `repositionInputs={false}` on its vaul Drawer (only flagged regression — let CSS/native own avoidance, don't let vaul fight).
- **Why scrollEnabled:false is safe:** `html,body` have no `overflow-y` (globals.css:34-35); all scrolling is in the inner `[data-app-scroll-root]` `overflow-y-auto` (providers.tsx:386); top-app-bar listens on that inner root. Verified directly, not just from the plan.
- **Verified:** typecheck+lint+design-system pass; iOS build SUCCEEDED with CapacitorKeyboard compiled/linked + `KeyboardPlugin` registered at runtime; sim runs vs UAT. 9-agent investigation + 3-lens adversarial review workflows. **Full logged-in on-device repro (open chat → focus composer → composer stays above keyboard) needs a human login (auth+vault gated).** Fix is native-config-level = correct by construction.
- **Note:** this is the pattern for ANY future keyboard-avoidance need — the app now has `@capacitor/keyboard` (resize none) + native scroll off + inner-overflow scrolling. Reuse `--agent-kb-height` / `keyboardWillShow` rather than new visualViewport hacks.

### B5 — Redesign leak check (always run when "it shows on the website")
- **How to verify no leak:** `git merge-base --is-ancestor <redesign-sha> origin/main` for each redesign commit → must be false. The website deploys from `main` only (manual `workflow_dispatch`); the `mobile` branch (pushed as `ankit/iOS-UI-rephrased-v01`) never reaches it.

---

## 🧪 QA test phone numbers (UAT, fixed OTP `000000`)
The app has a backend UAT-test phone path so QA can log in without SMS, with a FULL prod-like experience (real backend/vault/app — only the OTP is bypassed).
- **Backend (already live on `consent-protocol` / `hushh-pda-uat`):** `ENVIRONMENT=uat`, secret `HUSHH_UAT_PHONE_TEST_CODE=000000`, secret `HUSHH_UAT_PHONE_TEST_NUMBERS` (comma/`;`/newline-separated allowlist, ref `:latest` → durable across CI deploys). Handler: `consent-protocol/api/routes/account.py` `/api/account/phone/uat-test/{start,confirm}`. Frontend: `ApiService.*UatPhoneTestVerification`, `AccountIdentityService.*UatTestPhoneVerification`.
- **Native was gated off (`!isNative`) — fixed in `0c19110c2`:** `lib/firebase/auth-context.tsx` `startPhoneVerification` now tries the UAT-test start on native too, and `confirmPhoneVerification` routes `uat-test-phone:` verification ids to the UAT-test confirm before the real Firebase native link. Prod-safe (backend returns ineligible when not UAT/allowlisted → falls through to real Firebase).
- **Add numbers (Secret write + Cloud Run deploy — auth config, run manually / outside auto-mode):**
  ```bash
  P=hushh-pda-uat
  CUR="$(gcloud secrets versions access latest --secret=HUSHH_UAT_PHONE_TEST_NUMBERS --project=$P)"
  NEW="+1XXXXXXXXXX,+1YYYYYYYYYY"   # append; keep existing
  printf '%s' "${CUR},${NEW}" | gcloud secrets versions add HUSHH_UAT_PHONE_TEST_NUMBERS --data-file=- --project=$P
  gcloud run services update consent-protocol --region=us-central1 --project=$P --update-secrets=HUSHH_UAT_PHONE_TEST_NUMBERS=HUSHH_UAT_PHONE_TEST_NUMBERS:latest
  ```
  Use real-looking numbers (team convention; not 555). 2026-07-05: 20 numbers `+19898989898…+19898989879` prepared for QA (secret write pending user run — auto-mode blocked it).

## Palette invariant (so bugs don't reintroduce blue)
Onboarding + agent chat + profile use the luxury palette: onyx `#0A0908`, champagne gold `#D4AF6A` (dark), deep gold `#9C7434` (light), cream `#F4EAD6`, ivory `#FAF6EE`, ink `#17130C`, positive `#12A150`, destructive `#C94F44`. **No indigo/blue** (`#5E5CE6`/`#8583ff`) on redesigned mobile surfaces. The `/one` dashboard uses the 2a pastel blocks. See [[hushh-research-mobile-branch]].
