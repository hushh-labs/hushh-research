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

### B5 — Redesign leak check (always run when "it shows on the website")
- **How to verify no leak:** `git merge-base --is-ancestor <redesign-sha> origin/main` for each redesign commit → must be false. The website deploys from `main` only (manual `workflow_dispatch`); the `mobile` branch (pushed as `ankit/iOS-UI-rephrased-v01`) never reaches it.

---

## Palette invariant (so bugs don't reintroduce blue)
Onboarding + agent chat + profile use the luxury palette: onyx `#0A0908`, champagne gold `#D4AF6A` (dark), deep gold `#9C7434` (light), cream `#F4EAD6`, ivory `#FAF6EE`, ink `#17130C`, positive `#12A150`, destructive `#C94F44`. **No indigo/blue** (`#5E5CE6`/`#8583ff`) on redesigned mobile surfaces. The `/one` dashboard uses the 2a pastel blocks. See [[hushh-research-mobile-branch]].
