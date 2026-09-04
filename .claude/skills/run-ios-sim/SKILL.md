---
name: run-ios-sim
description: Build the hushh One webapp, sync it into the native iOS shell, and launch it on an iPhone simulator against the UAT backend. Use when the user asks to run/launch/build the app on the simulator, take a screenshot on device, or verify a change in the real native app. Wraps the mobile build gotchas (UAT backend override, Node 22, 8 GB heap, /tmp DerivedData) into one command.
argument-hint: "[optional: simulator UDID to override the default iPhone 16]"
allowed-tools: Bash, Read
---

# Run hushh One on the iOS simulator

One command that goes from source → running app on the simulator. It bakes in
every recurring build gotcha from [[mobile-bug-log]] so you don't rediscover them.

## Quick start

```bash
.claude/skills/run-ios-sim/launch.sh
```

Optional: pass a specific simulator UDID as `$1`. With no argument the script
resolves one itself: an already-booted iPhone if there is one, otherwise the
newest available iPhone. List them with `xcrun simctl list devices available`.

- **Simulator:** resolved at run time, never pinned. Xcode updates retire device
  types, so a hardcoded UDID eventually points at a simulator that no longer
  exists and the run fails only after a full web build.
- **App:** `com.hushh.app` (scheme `App`, `ios/App/App.xcodeproj`)
- **Backend baked in:** UAT (`https://consent-protocol-f2gsa4kfsq-uc.a.run.app`)

## What the script does (and why)

1. **`nvm use 22`** — `cap sync` needs Node 22 (see [[mobile-bug-log]] GOTCHA #2 / iOS build notes).
2. **Verify UAT backend is reachable** (`curl` → expect `200`) before wasting a build.
3. **`export NEXT_PUBLIC_BACKEND_URL=<UAT>`** then `NODE_OPTIONS=--max-old-space-size=8192 npm run cap:build` — the UAT override is **mandatory** (GOTCHA #1: without it `localhost:8000` gets baked in and the app can't reach the vault → navigation dies on every screen). The 8 GB heap avoids the `cap:build` OOM. This does NOT touch your `.env.local`.
4. **`npm run cap:sync:ios`** — copies `out/` into the native shell + syncs plugins.
5. **Boot the simulator** (`xcrun simctl boot`, `open -a Simulator`) and wait until it reports `Booted`.
6. **`xcodebuild`** the `App` scheme for `iphonesimulator`, DerivedData in **`/tmp/hushh-ios-dd`** (iCloud FinderInfo on the default DerivedData path breaks codesign).
7. **Install + launch** the built `App.app` and print the app's URL so you can confirm.
8. **Confirm the right backend is live** — greps the app log for `consent-protocol` (good) vs `127.0.0.1:8000` (bad, GOTCHA #1 regressed).

## After it launches

Most screens are **auth + vault gated** — you must log in to reach the dashboard,
Onepoint/location, etc. On UAT you can use a QA test phone number with fixed OTP
`000000` (see [[mobile-bug-log]] "QA test phone numbers"), then unlock the vault.
Autonomous agents cannot pass this gate — a human does the login.

Diagnose runtime issues with the WKWebView + native log:
```bash
UDID="$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-]\{36\}\)).*/\1/p' | head -1)"
xcrun simctl spawn "$UDID" log show --last 120s --predicate 'process == "App"'
```

Screenshot the current simulator screen:
```bash
xcrun simctl io booted screenshot /tmp/onepoint-sim.png
```

## Gotchas (don't relearn these)

- **Sim shows "Shutdown" / install fails** → it's not booted. The build likely
  already succeeded; just `xcrun simctl boot <UDID>; open -a Simulator; sleep 6`
  then re-run install. The script handles this, but if you install manually,
  boot first.
- **Capacitor has no OTA** — a committed fix that isn't in this build has NOT
  shipped to a TestFlight tester. This script always rebuilds from current
  source, so what you see is your working tree.
- **First `next` build is slow** (a few minutes). Subsequent builds are faster.
- **Stale CSS after a color/className change** → the webpack cache (`.next/cache`)
  can serve a Tailwind compilation from *before* your edit, so new arbitrary
  classes (e.g. `bg-[#007aff]`) ship in the JS but have **no CSS rule** — the
  element renders with no color (a blue button with a transparent background).
  Fix: `CLEAN=1 .claude/skills/run-ios-sim/launch.sh` (forces `rm -rf .next out`).
  Verify a class landed: `grep -c 'background-color:#007aff' hushh-webapp/out/_next/static/css/*.css`.
- **Full disk corrupts the build** — `next build` on a 100%-full disk produces a
  broken/partial CSS bundle (same symptom as above) even though it reports
  success. The script now aborts if < 5 GB is free. `.next` can grow to ~17 GB;
  `rm -rf hushh-webapp/.next` to reclaim it.
