# Mobile Verification

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## Verification Lanes

Non-destructive contract gate:

```bash
cd hushh-webapp && npm run verify:capacitor:static
```

Intentional cold-start route audit:

```bash
cd hushh-webapp && npm run verify:capacitor:cold:audit
```

The cold audit resets the app and uses a governed reviewer fixture. It includes:

- frontend/native surface-map verification
- native microphone permission metadata verification
- native route-inventory verification
- native plugin parity verification
- Capacitor runtime config verification
- iOS project sanity
- Android project sanity
- iOS simulator route audit
- Android emulator route audit
- native report freshness against the current route inventory

It does not prove an active user's route or memory-only vault survives background/resume. Use `npm run ios:continuity:local` or `npm run android:continuity:local` against an already-installed, normally unlocked app for that evidence; these commands only launch and monitor the current session.

## Test Execution Safety

Start with static and host-native verification. These do not launch a test-mode
app:

```bash
cd hushh-webapp && npm run verify:capacitor:static
cd hushh-webapp && ./android/gradlew -p android :app:testDebugUnitTest --no-daemon
cd hushh-webapp && xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -destination 'platform=iOS Simulator,id=9C5B1D61-028C-474A-BDFC-523BACC3B02C' -derivedDataPath ios/App/build/DerivedData build-for-testing
```

Cold audit launch is intentionally explicit. It resets only the test
installation and always terminates that test process after capture. The
in-page UI runner also terminalizes a bootstrap that does not become ready in
45 seconds; it records a sanitized timeout instead of retaining an interval.
Never use a cold audit after an interrupted continuity rehearsal to diagnose a
valid in-memory vault—first inspect the active app/process state.

## Smoke Checklist

Before releasing mobile updates:

- all required plugins are registered on both platforms
- Firebase authentication works
- Apple Sign-In works on iOS
- vault operations work end to end
- consent flow completes successfully
- Kai analysis streams correctly
- streaming features complete and show results
- save-to-vault calls pass `vaultOwnerToken` explicitly
- backend URLs point to the intended runtime
- biometric prompts work correctly

## Native Streaming

For Server-Sent Events on native:

- use native plugins that emit events through `notifyListeners()`
- build a `ReadableStream` from plugin events in the service layer
- process buffered final events after stream close
- keep the detailed implementation in [Native Streaming Guide](../native_streaming.md)

## Manual Device Proof

Manual simulator/device smoke is still required after build/sync checks when a change touches:

- native permissions
- contacts
- vault unlock
- role sync
- push notifications
- location
- passkeys

Native audit runners stay headless by default. Set `NATIVE_AUDIT_VISIBLE=true` only when a desktop simulator window is explicitly requested. The iOS continuity runner uses `-- --visible` for the same opt-in. Headless launch does not itself prove any product interaction.
