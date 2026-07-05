# Mobile Verification

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## Primary Gate

```bash
cd hushh-webapp && npm run verify:capacitor:audit
```

This gate includes:

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
