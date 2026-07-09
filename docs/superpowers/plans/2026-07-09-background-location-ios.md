# Background Location Sharing (iOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a sender's iOS app keep publishing near-real-time, end-to-end-encrypted location to active share grants while the app is backgrounded or the screen is locked.

**Architecture:** Extend the existing native `HushhLocationPlugin` (Always authorization + background location updates) and add a native `BackgroundLocationPublisher` that reproduces the JS ECIES envelope in CryptoKit and POSTs ciphertext directly. The web layer hands native a "share session" (grant list + recipient public keys + auth token + resolved backend base URL) while foregrounded; native owns publishing while backgrounded. Web/desktop remain foreground-only.

**Tech Stack:** Swift (CoreLocation, CryptoKit, URLSession, XCTest), Capacitor plugin bridge, TypeScript, React, Vitest.

## Global Constraints

- **E2E preserved:** the backend never receives plaintext coordinates. Native encrypts before POST. (from spec §Goal)
- **Envelope algorithm string:** exactly `"ECDH-P256-AES256-GCM"`. (from `lib/one-location/types.ts:376`)
- **Crypto parity is byte-exact:** ECDH P-256 raw shared-secret X-coordinate (32 bytes, **no HKDF**) used directly as the AES-256-GCM key; 12-byte random IV; ciphertext output is `ciphertext || 16-byte GCM tag`; all binary fields base64url without padding. (from spec §Crypto parity, `lib/one-location/encryption.ts:524`)
- **Publish endpoint:** `POST {base}/api/one/location/grants/{grantId}/envelopes`, headers `Authorization: Bearer <vaultOwnerToken>` + `Content-Type: application/json`, body `{"envelope": <envelope>}`. (from `lib/one-location/service.ts:347`)
- **Backend base URL** comes from `getApiBaseUrl()` exported from `lib/services/api-service.ts:4452` — never hardcode it.
- **iOS first.** Android is out of scope for this plan.
- **Explicit opt-in:** background sharing starts only when the user enables it AND Always permission is granted. (from spec §UX)
- **No new third-party location dependency** (Approach A). (from spec §Architecture)
- **No Claude co-author trailer** in commits; keep the DCO `Signed-off-by` line.

---

## File Structure

**TypeScript / web:**
- Modify `hushh-webapp/lib/capacitor/index.ts` — add `startBackgroundShare` / `stopBackgroundShare` to `HushhLocationPlugin`, add `BackgroundShareSession` + `BackgroundShareGrant` types, add `"granted"` note for `background`.
- Modify `hushh-webapp/lib/capacitor/plugins/location-web.ts` — no-op web stubs for the two new methods.
- Create `hushh-webapp/lib/one-location/background-share.ts` — pure `buildBackgroundShareSession(...)` builder.
- Create `hushh-webapp/lib/one-location/__tests__/background-share.test.ts` — builder tests.
- Modify `hushh-webapp/lib/one-location/service.ts` — `OneLocationService.startBackgroundShare` / `stopBackgroundShare` wrappers.
- Modify `hushh-webapp/app/one/location/page.tsx` — effect that starts/stops the native session from the toggle + `activeOwnerGrants`; a "keep sharing when app is closed" toggle; recipient live/paused indicator; sender resume nudge.
- Create `hushh-webapp/lib/one-location/__tests__/background-share-effect.test.tsx` — start/stop wiring test.

**Native iOS Swift:**
- Modify `hushh-webapp/ios/App/App/Info.plist` — Always usage strings + `UIBackgroundModes`.
- Modify `hushh-webapp/ios/App/App/Plugins/HushhLocationPlugin.swift` — Always auth, background updates, new bridge methods, real `background` permission status.
- Create `hushh-webapp/ios/App/App/Plugins/LocationEnvelopeCrypto.swift` — CryptoKit ECIES.
- Create `hushh-webapp/ios/App/App/Plugins/BackgroundLocationPublisher.swift` — session store, throttle, encrypt-per-grant, POST, bounded queue.
- Create `hushh-webapp/ios/App/AppTests/LocationEnvelopeCryptoTests.swift` — round-trip + golden-vector output.
- Create `hushh-webapp/lib/one-location/__tests__/swift-parity.test.ts` — decrypts the Swift-generated golden envelope with the existing JS decrypt.

---

## Task 1: TS bridge interface + web stubs

**Files:**
- Modify: `hushh-webapp/lib/capacitor/index.ts:767-819`
- Modify: `hushh-webapp/lib/capacitor/plugins/location-web.ts:10-249`

**Interfaces:**
- Produces: `BackgroundShareGrant = { grantId: string; recipientKeyId: string; recipientPublicKeyJwk: JsonWebKey }`; `BackgroundShareSession = { vaultOwnerToken: string; backendBaseUrl: string; grants: BackgroundShareGrant[]; minMoveMeters: number; minIntervalMs: number }`; `HushhLocationPlugin.startBackgroundShare(session: BackgroundShareSession): Promise<{ started: boolean; reason?: string }>`; `HushhLocationPlugin.stopBackgroundShare(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/capacitor/plugins/__tests__/location-web-background.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HushhLocationWeb } from "@/lib/capacitor/plugins/location-web";

describe("HushhLocationWeb background sharing", () => {
  it("reports background sharing as unsupported on web", async () => {
    const web = new HushhLocationWeb();
    const result = await web.startBackgroundShare({
      vaultOwnerToken: "t",
      backendBaseUrl: "https://api.example.com",
      grants: [],
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(result).toEqual({ started: false, reason: "unsupported-on-web" });
  });

  it("stopBackgroundShare resolves as a no-op on web", async () => {
    const web = new HushhLocationWeb();
    await expect(web.stopBackgroundShare()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/capacitor/plugins/__tests__/location-web-background.test.ts`
Expected: FAIL — `startBackgroundShare is not a function` (types/methods missing).

- [ ] **Step 3: Add the types + interface methods**

In `hushh-webapp/lib/capacitor/index.ts`, after the `HushhLocationPermissionState` type (~line 772) add:

```ts
export type BackgroundShareGrant = {
  grantId: string;
  recipientKeyId: string;
  recipientPublicKeyJwk: JsonWebKey;
};

export type BackgroundShareSession = {
  vaultOwnerToken: string;
  backendBaseUrl: string;
  grants: BackgroundShareGrant[];
  minMoveMeters: number;
  minIntervalMs: number;
};
```

Then inside `interface HushhLocationPlugin` (before the closing brace at ~line 819) add:

```ts
  /**
   * Start native background publishing for the given share session. iOS only:
   * requires Always authorization. Returns { started:false, reason } when
   * unavailable (web, missing permission). Foreground JS keeps publishing too;
   * native takes over while the app is backgrounded.
   */
  startBackgroundShare(
    session: BackgroundShareSession,
  ): Promise<{ started: boolean; reason?: string }>;
  /** Stop native background publishing. Safe to call when not started. */
  stopBackgroundShare(): Promise<void>;
```

- [ ] **Step 4: Add the web stubs**

In `hushh-webapp/lib/capacitor/plugins/location-web.ts`, import the new types by extending the existing import block at the top:

```ts
import type {
  BackgroundShareSession,
  HushhLocationPermissionState,
  HushhLocationPlugin,
} from "@/lib/capacitor";
```

Then add these methods inside the `HushhLocationWeb` class (before the final closing brace):

```ts
  async startBackgroundShare(
    _session: BackgroundShareSession,
  ): Promise<{ started: boolean; reason?: string }> {
    // Web tabs cannot run location updates in the background (timers freeze when
    // hidden; no GPS in service workers). Always report unsupported.
    return { started: false, reason: "unsupported-on-web" };
  }

  async stopBackgroundShare(): Promise<void> {
    // No-op on web; nothing was started.
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/capacitor/plugins/__tests__/location-web-background.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/capacitor/index.ts hushh-webapp/lib/capacitor/plugins/location-web.ts hushh-webapp/lib/capacitor/plugins/__tests__/location-web-background.test.ts
git commit -m "feat(one-location): background-share bridge interface + web no-op stubs

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 2: Share-session builder (pure function)

**Files:**
- Create: `hushh-webapp/lib/one-location/background-share.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/background-share.test.ts`

**Interfaces:**
- Consumes: `BackgroundShareGrant`, `BackgroundShareSession` (Task 1); `OneLocationGrant`, `OneLocationRecipient` (`lib/one-location/types.ts`).
- Produces: `buildBackgroundShareSession(params: { activeGrants: OneLocationGrant[]; recipients: OneLocationRecipient[]; vaultOwnerToken: string; backendBaseUrl: string; minMoveMeters: number; minIntervalMs: number }): BackgroundShareSession` — includes only grants whose recipient has both `keyId` and `publicKeyJwk`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/background-share.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import type { OneLocationGrant, OneLocationRecipient } from "@/lib/one-location/types";

const grant = (over: Partial<OneLocationGrant> = {}): OneLocationGrant =>
  ({
    id: "g1",
    status: "active",
    recipientUserId: "u1",
    recipientKeyId: "k1",
  } as OneLocationGrant);

const recipient = (over: Partial<OneLocationRecipient> = {}): OneLocationRecipient =>
  ({
    userId: "u1",
    keyId: "k1",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    ...over,
  } as OneLocationRecipient);

describe("buildBackgroundShareSession", () => {
  it("maps active grants with a resolvable recipient key", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [grant()],
      recipients: [recipient()],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(session).toEqual({
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
      grants: [
        {
          grantId: "g1",
          recipientKeyId: "k1",
          recipientPublicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        },
      ],
    });
  });

  it("drops grants whose recipient is missing key material", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [grant()],
      recipients: [recipient({ publicKeyJwk: undefined })],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(session.grants).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/one-location/__tests__/background-share.test.ts`
Expected: FAIL — cannot find module `background-share`.

- [ ] **Step 3: Implement the builder**

Create `hushh-webapp/lib/one-location/background-share.ts`:

```ts
import type {
  BackgroundShareGrant,
  BackgroundShareSession,
} from "@/lib/capacitor";
import type {
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";

/**
 * Build the native background-share session from the owner's active grants and
 * known recipients. Mirrors the foreground publish path: for each active grant
 * we resolve the recipient by (userId, keyId) and include it only when both the
 * recipient keyId and public key are present — the exact precondition
 * `publishEnvelope` enforces before encrypting. The result is handed to the
 * native plugin, which reproduces the ECIES envelope offline.
 */
export function buildBackgroundShareSession(params: {
  activeGrants: OneLocationGrant[];
  recipients: OneLocationRecipient[];
  vaultOwnerToken: string;
  backendBaseUrl: string;
  minMoveMeters: number;
  minIntervalMs: number;
}): BackgroundShareSession {
  const grants: BackgroundShareGrant[] = [];
  for (const grant of params.activeGrants) {
    if (grant.status !== "active") continue;
    const recipient = params.recipients.find(
      (candidate) =>
        candidate.userId === grant.recipientUserId &&
        candidate.keyId === grant.recipientKeyId,
    );
    if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
    grants.push({
      grantId: grant.id,
      recipientKeyId: recipient.keyId,
      recipientPublicKeyJwk: recipient.publicKeyJwk,
    });
  }
  return {
    vaultOwnerToken: params.vaultOwnerToken,
    backendBaseUrl: params.backendBaseUrl,
    minMoveMeters: params.minMoveMeters,
    minIntervalMs: params.minIntervalMs,
    grants,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/one-location/__tests__/background-share.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/one-location/background-share.ts hushh-webapp/lib/one-location/__tests__/background-share.test.ts
git commit -m "feat(one-location): background share-session builder

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 3: Service wrappers + page wiring

**Files:**
- Modify: `hushh-webapp/lib/one-location/service.ts:116` (after `clearLocationWatch`)
- Modify: `hushh-webapp/app/one/location/page.tsx` (new effect + toggle state)
- Test: `hushh-webapp/lib/one-location/__tests__/background-share-effect.test.tsx`

**Interfaces:**
- Consumes: `buildBackgroundShareSession` (Task 2); `HushhLocation.startBackgroundShare/stopBackgroundShare` (Task 1); `getApiBaseUrl` (`lib/services/api-service.ts:4452`); `LIVE_LOCATION_MIN_MOVE_METERS` (25) + `LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS` (8000) (`page.tsx:213-214`).
- Produces: `OneLocationService.startBackgroundShare(session)` / `OneLocationService.stopBackgroundShare()`; a `syncBackgroundShare(...)` helper used by the page effect.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/background-share-effect.test.tsx`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const start = vi.fn().mockResolvedValue({ started: true });
const stop = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    startBackgroundShare: (s: unknown) => start(s),
    stopBackgroundShare: () => stop(),
  },
}));

import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";

describe("syncBackgroundShare", () => {
  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
  });

  it("stops native sharing when the toggle is off", async () => {
    await syncBackgroundShare({ enabled: false, session: null });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("stops native sharing when enabled but no grants remain", async () => {
    await syncBackgroundShare({
      enabled: true,
      session: {
        vaultOwnerToken: "t",
        backendBaseUrl: "https://api",
        grants: [],
        minMoveMeters: 25,
        minIntervalMs: 8000,
      },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts native sharing when enabled with grants", async () => {
    const session = {
      vaultOwnerToken: "t",
      backendBaseUrl: "https://api",
      grants: [
        { grantId: "g1", recipientKeyId: "k1", recipientPublicKeyJwk: {} },
      ],
      minMoveMeters: 25,
      minIntervalMs: 8000,
    };
    await syncBackgroundShare({ enabled: true, session });
    expect(start).toHaveBeenCalledWith(session);
    expect(stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/one-location/__tests__/background-share-effect.test.tsx`
Expected: FAIL — cannot find module `background-share-runtime`.

- [ ] **Step 3: Add the service wrappers**

In `hushh-webapp/lib/one-location/service.ts`, after `clearLocationWatch` (line 116-119) add:

```ts
  static async startBackgroundShare(session: import("@/lib/capacitor").BackgroundShareSession) {
    return HushhLocation.startBackgroundShare(session);
  }

  static async stopBackgroundShare(): Promise<void> {
    return HushhLocation.stopBackgroundShare();
  }
```

- [ ] **Step 4: Implement the runtime sync helper**

Create `hushh-webapp/lib/one-location/background-share-runtime.ts`:

```ts
import { HushhLocation, type BackgroundShareSession } from "@/lib/capacitor";

/**
 * Reconcile native background sharing with the current UI intent. We start only
 * when the user has opted in AND there is at least one publishable grant;
 * otherwise we stop. Idempotent — safe to call on every relevant change.
 */
export async function syncBackgroundShare(params: {
  enabled: boolean;
  session: BackgroundShareSession | null;
}): Promise<void> {
  if (!params.enabled || !params.session || params.session.grants.length === 0) {
    await HushhLocation.stopBackgroundShare();
    return;
  }
  await HushhLocation.startBackgroundShare(params.session);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/one-location/__tests__/background-share-effect.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire into the page**

In `hushh-webapp/app/one/location/page.tsx`:

1. Add imports near the other `lib/one-location` imports:

```ts
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";
import { getApiBaseUrl } from "@/lib/services/api-service";
```

2. Add toggle state near the other owner-side `useState` hooks (search for `const [revokingGrantId`):

```ts
  const [backgroundShareEnabled, setBackgroundShareEnabled] = useState(false);
```

3. Add this effect immediately AFTER the recipient live-view effect that ends at `page.tsx:3530` (the `}, [activeVisibleReceivedGrants, busy, viewGrantEnvelope]);` line):

```ts
  // Keep native background publishing in sync with the opt-in toggle + grants.
  // Web returns { started:false } and this is a no-op there.
  useEffect(() => {
    if (!vaultOwnerToken) return;
    const session = buildBackgroundShareSession({
      activeGrants: activeOwnerGrants,
      recipients,
      vaultOwnerToken,
      backendBaseUrl: getApiBaseUrl(),
      minMoveMeters: LIVE_LOCATION_MIN_MOVE_METERS,
      minIntervalMs: LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS,
    });
    void syncBackgroundShare({ enabled: backgroundShareEnabled, session });
    return () => {
      void OneLocationService.stopBackgroundShare();
    };
  }, [backgroundShareEnabled, activeOwnerGrants, recipients, vaultOwnerToken]);
```

- [ ] **Step 7: Run the one-location suite to verify no regressions**

Run: `npx vitest run lib/one-location app/one`
Expected: PASS (existing + new tests).

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/lib/one-location/service.ts hushh-webapp/lib/one-location/background-share-runtime.ts hushh-webapp/lib/one-location/__tests__/background-share-effect.test.tsx hushh-webapp/app/one/location/page.tsx
git commit -m "feat(one-location): sync native background share from toggle + grants

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 4: iOS Info.plist + Always authorization

**Files:**
- Modify: `hushh-webapp/ios/App/App/Info.plist`
- Modify: `hushh-webapp/ios/App/App/Plugins/HushhLocationPlugin.swift:45-57,199-205`

**Interfaces:**
- Produces: plugin can request Always auth via a new `requestAlwaysAuthorization` path; `permissionPayload()` reports real `background` status.

- [ ] **Step 1: Add Info.plist keys**

In `hushh-webapp/ios/App/App/Info.plist`, inside the top-level `<dict>`, add (keep any existing WhenInUse key):

```xml
	<key>NSLocationWhenInUseUsageDescription</key>
	<string>Hushh uses your location to share it live with people you choose.</string>
	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
	<string>Hushh keeps sharing your live location with people you choose even when the app is in the background, until you stop sharing.</string>
	<key>UIBackgroundModes</key>
	<array>
		<string>location</string>
	</array>
```

- [ ] **Step 2: Enable the Background Modes capability**

In Xcode: select the **App** target → **Signing & Capabilities** → **+ Capability** → **Background Modes** → check **Location updates**. (This writes the entitlement/target setting the plist array alone does not cover.)
Verify: the target's Background Modes shows "Location updates" checked.

- [ ] **Step 3: Add an Always-authorization request method**

In `HushhLocationPlugin.swift`, add a new bridged method. First register it in `pluginMethods` (after the `clearWatch` entry, line 24):

```swift
        CAPPluginMethod(name: "clearWatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlwaysAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBackgroundShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundShare", returnType: CAPPluginReturnPromise)
```

Then add the method (near `requestLocationPermission`):

```swift
    @objc func requestAlwaysAuthorization(_ call: CAPPluginCall) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .denied, .restricted:
            call.resolve(permissionPayload())
        case .authorizedWhenInUse, .notDetermined:
            // iOS shows the "Always Allow" upgrade prompt only from a
            // WhenInUse-or-notDetermined state. Resolve immediately with the
            // current payload; JS re-reads state via getPermissionState.
            pendingPermissionCall = call
            DispatchQueue.main.async { self.manager.requestAlwaysAuthorization() }
        @unknown default:
            call.resolve(permissionPayload())
        }
    }
```

- [ ] **Step 4: Report real background status**

In `permissionPayload()`, replace the hardcoded line `"background": "foreground-only"` (line 202) with:

```swift
            "background": backgroundStatus(),
```

And add this helper method in the class:

```swift
    private func backgroundStatus() -> String {
        switch manager.authorizationStatus {
        case .authorizedAlways:
            return "available"
        case .authorizedWhenInUse:
            return "foreground-only"
        case .restricted:
            return "restricted"
        default:
            return "unavailable"
        }
    }
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd hushh-webapp/ios/App && xcodebuild -scheme App -destination 'generic/platform=iOS' -quiet build`
Expected: BUILD SUCCEEDED (no `startBackgroundShare`/`stopBackgroundShare` implementations yet will error — if so, add temporary empty `@objc func startBackgroundShare(_ call: CAPPluginCall) { call.resolve() }` / `stopBackgroundShare` stubs to compile; Task 7 replaces them). Prefer to proceed to Task 5-7 and build once at Task 7.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/ios/App/App/Info.plist hushh-webapp/ios/App/App/Plugins/HushhLocationPlugin.swift hushh-webapp/ios/App/App.xcodeproj/project.pbxproj
git commit -m "feat(one-location): iOS Always auth + background location capability

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 5: Native ECIES crypto (CryptoKit)

**Files:**
- Create: `hushh-webapp/ios/App/App/Plugins/LocationEnvelopeCrypto.swift`
- Test: `hushh-webapp/ios/App/AppTests/LocationEnvelopeCryptoTests.swift`

**Interfaces:**
- Produces: `enum LocationEnvelopeCrypto { static func encrypt(pointJSON: Data, recipientPublicKeyJwk: [String: Any], recipientKeyId: String, capturedAt: String, sourcePlatform: String) throws -> [String: Any] }` returning a dictionary with keys `algorithm, recipientKeyId, ciphertext, iv, senderEphemeralPublicKeyJwk, capturedAt, sourcePlatform, metadata` matching `OneLocationEncryptedEnvelope`.
- Helpers: `base64url(_ data: Data) -> String`, `base64urlDecode(_ s: String) -> Data?`.

- [ ] **Step 1: Write the failing test (self round-trip)**

Create `hushh-webapp/ios/App/AppTests/LocationEnvelopeCryptoTests.swift`:

```swift
import XCTest
import CryptoKit
@testable import App

final class LocationEnvelopeCryptoTests: XCTestCase {

    // Fixed recipient keypair shared with the JS parity test (Task 6).
    let recipientJwk: [String: Any] = [
        "kty": "EC", "crv": "P-256",
        "x": "bYSlqg5_E4ruu5r3PRtBxjAM4a_DqCJwaLIXYu2Sats",
        "y": "uLLY49pNxir21iuk3Wy0N852NvxZYTGFtEUotBQ8ZNM"
    ]
    // Matching private scalar d (base64url) for in-test decryption.
    let recipientD = "0QSES3IFfQY4dKAIft3Kz5aVbxxIGWuiCd84LdYBjcs"

    func testEncryptProducesDecryptableEnvelope() throws {
        let point = #"{"latitude":12.9716,"longitude":77.5946,"capturedAt":"2026-07-09T00:00:00.000Z","sourcePlatform":"ios"}"#
        let envelope = try LocationEnvelopeCrypto.encrypt(
            pointJSON: Data(point.utf8),
            recipientPublicKeyJwk: recipientJwk,
            recipientKeyId: "k1",
            capturedAt: "2026-07-09T00:00:00.000Z",
            sourcePlatform: "ios"
        )

        // Reconstruct the recipient private key and derive the same AES key from
        // the sender's ephemeral public key to prove the envelope decrypts.
        let ephem = envelope["senderEphemeralPublicKeyJwk"] as! [String: Any]
        let ex = LocationEnvelopeCrypto.base64urlDecode(ephem["x"] as! String)!
        let ey = LocationEnvelopeCrypto.base64urlDecode(ephem["y"] as! String)!
        var ephemRaw = Data([0x04]); ephemRaw.append(ex); ephemRaw.append(ey)
        let ephemPub = try P256.KeyAgreement.PublicKey(x963Representation: ephemRaw)

        let d = LocationEnvelopeCrypto.base64urlDecode(recipientD)!
        let recipientPriv = try P256.KeyAgreement.PrivateKey(rawRepresentation: d)
        let shared = try recipientPriv.sharedSecretFromKeyAgreement(with: ephemPub)
        let aesKey = shared.withUnsafeBytes { SymmetricKey(data: Data($0)) }

        let iv = LocationEnvelopeCrypto.base64urlDecode(envelope["iv"] as! String)!
        let ctPlusTag = LocationEnvelopeCrypto.base64urlDecode(envelope["ciphertext"] as! String)!
        let ct = ctPlusTag.prefix(ctPlusTag.count - 16)
        let tag = ctPlusTag.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct, tag: tag)
        let plaintext = try AES.GCM.open(box, using: aesKey)

        XCTAssertEqual(String(decoding: plaintext, as: UTF8.self), point)
        XCTAssertEqual(envelope["algorithm"] as? String, "ECDH-P256-AES256-GCM")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp/ios/App && xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:AppTests/LocationEnvelopeCryptoTests -quiet`
Expected: FAIL — `LocationEnvelopeCrypto` is undefined.

- [ ] **Step 3: Implement the crypto**

Create `hushh-webapp/ios/App/App/Plugins/LocationEnvelopeCrypto.swift`:

```swift
import Foundation
import CryptoKit

/// Reproduces the JS ECIES envelope (`lib/one-location/encryption.ts`) so the
/// native background publisher can encrypt without any JS runtime.
///
/// Scheme: fresh ephemeral P-256 keypair per publish → ECDH against the
/// recipient's public key → the raw 32-byte shared-secret X-coordinate is used
/// directly as the AES-256-GCM key (NO HKDF, matching Web Crypto's ECDH→AES-GCM
/// derivation) → AES-GCM with a random 12-byte IV → ciphertext is `ct || tag`.
enum LocationEnvelopeCrypto {

    enum CryptoError: Error { case badRecipientKey }

    static func encrypt(
        pointJSON: Data,
        recipientPublicKeyJwk: [String: Any],
        recipientKeyId: String,
        capturedAt: String,
        sourcePlatform: String
    ) throws -> [String: Any] {
        guard
            let xB64 = recipientPublicKeyJwk["x"] as? String,
            let yB64 = recipientPublicKeyJwk["y"] as? String,
            let x = base64urlDecode(xB64),
            let y = base64urlDecode(yB64),
            x.count == 32, y.count == 32
        else { throw CryptoError.badRecipientKey }

        var recipientRaw = Data([0x04]); recipientRaw.append(x); recipientRaw.append(y)
        let recipientPub = try P256.KeyAgreement.PublicKey(x963Representation: recipientRaw)

        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipientPub)
        let aesKey = shared.withUnsafeBytes { SymmetricKey(data: Data($0)) }

        let iv = AES.GCM.Nonce() // 12 random bytes
        let sealed = try AES.GCM.seal(pointJSON, using: aesKey, nonce: iv)
        var ctPlusTag = sealed.ciphertext
        ctPlusTag.append(sealed.tag)

        // Ephemeral public key → JWK (x963Representation is 0x04 || x || y).
        let ephemRaw = ephemeral.publicKey.x963Representation
        let ephemX = ephemRaw.subdata(in: 1..<33)
        let ephemY = ephemRaw.subdata(in: 33..<65)
        let ephemJwk: [String: Any] = [
            "kty": "EC", "crv": "P-256",
            "x": base64url(ephemX), "y": base64url(ephemY)
        ]

        return [
            "algorithm": "ECDH-P256-AES256-GCM",
            "recipientKeyId": recipientKeyId,
            "ciphertext": base64url(ctPlusTag),
            "iv": base64url(Data(iv)),
            "senderEphemeralPublicKeyJwk": ephemJwk,
            "capturedAt": capturedAt,
            "sourcePlatform": sourcePlatform,
            "metadata": ["payload": "coordinate_envelope", "plaintext": false]
        ]
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func base64urlDecode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+")
                 .replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b.append("=") }
        return Data(base64Encoded: b)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp/ios/App && xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:AppTests/LocationEnvelopeCryptoTests -quiet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/ios/App/App/Plugins/LocationEnvelopeCrypto.swift hushh-webapp/ios/App/AppTests/LocationEnvelopeCryptoTests.swift hushh-webapp/ios/App/App.xcodeproj/project.pbxproj
git commit -m "feat(one-location): native CryptoKit ECIES envelope + round-trip test

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 6: Cross-language parity (Swift → JS decrypt)

**Files:**
- Modify: `hushh-webapp/ios/App/AppTests/LocationEnvelopeCryptoTests.swift` (add a printer test)
- Create: `hushh-webapp/lib/one-location/__tests__/swift-parity.test.ts`

**Interfaces:**
- Consumes: `decryptLocationEnvelope` (`lib/one-location/encryption.ts:560`) — but that reads the recipient key from IndexedDB by userId; instead use the lower-level derivation. Add a tiny exported test helper (below).

- [ ] **Step 1: Export a decrypt-with-key helper for tests**

In `hushh-webapp/lib/one-location/encryption.ts`, add (after `decryptLocationEnvelope`):

```ts
/**
 * Decrypt an envelope using an explicitly-provided recipient private JWK.
 * Exists so cross-language parity tests can decrypt a natively-produced envelope
 * without touching IndexedDB/Keychain. Production code should use
 * `decryptLocationEnvelope`.
 */
export async function decryptLocationEnvelopeWithKey(params: {
  privateKeyJwk: JsonWebKey;
  envelope: OneLocationEncryptedEnvelope;
}): Promise<PlainLocationPoint> {
  const privateKey = await importPrivateKey(params.privateKeyJwk);
  const senderPublicKey = await importPublicKey(
    params.envelope.senderEphemeralPublicKeyJwk,
  );
  const aesKey = await deriveAesKey(privateKey, senderPublicKey, "decrypt");
  const plaintext = await requireCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(params.envelope.iv) },
    aesKey,
    fromBase64Url(params.envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as PlainLocationPoint;
}
```

- [ ] **Step 2: Add a Swift printer test that emits a golden envelope**

Append to `LocationEnvelopeCryptoTests.swift`:

```swift
    func testPrintGoldenEnvelopeForJS() throws {
        let point = #"{"latitude":12.9716,"longitude":77.5946,"capturedAt":"2026-07-09T00:00:00.000Z","sourcePlatform":"ios"}"#
        let envelope = try LocationEnvelopeCrypto.encrypt(
            pointJSON: Data(point.utf8),
            recipientPublicKeyJwk: recipientJwk,
            recipientKeyId: "k1",
            capturedAt: "2026-07-09T00:00:00.000Z",
            sourcePlatform: "ios"
        )
        let json = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        print("GOLDEN_ENVELOPE_BEGIN" + String(decoding: json, as: UTF8.self) + "GOLDEN_ENVELOPE_END")
    }
```

- [ ] **Step 3: Run the printer test and capture the envelope**

Run: `cd hushh-webapp/ios/App && xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:AppTests/LocationEnvelopeCryptoTests/testPrintGoldenEnvelopeForJS 2>&1 | grep -o 'GOLDEN_ENVELOPE_BEGIN.*GOLDEN_ENVELOPE_END'`
Expected: one line containing the JSON envelope. Copy the JSON between the markers.

- [ ] **Step 4: Write the JS parity test with the captured envelope**

Create `hushh-webapp/lib/one-location/__tests__/swift-parity.test.ts`. Paste the captured envelope JSON into `swiftEnvelope`:

```ts
import { describe, expect, it } from "vitest";
import { decryptLocationEnvelopeWithKey } from "@/lib/one-location/encryption";
import type { OneLocationEncryptedEnvelope } from "@/lib/one-location/types";

// Recipient private key matching the fixture public key in the Swift test.
const privateKeyJwk = {
  kty: "EC",
  crv: "P-256",
  x: "bYSlqg5_E4ruu5r3PRtBxjAM4a_DqCJwaLIXYu2Sats",
  y: "uLLY49pNxir21iuk3Wy0N852NvxZYTGFtEUotBQ8ZNM",
  d: "0QSES3IFfQY4dKAIft3Kz5aVbxxIGWuiCd84LdYBjcs",
  key_ops: ["deriveKey"],
  ext: true,
};

// PASTE the JSON printed by testPrintGoldenEnvelopeForJS between the markers.
const swiftEnvelope = {
  /* GOLDEN_ENVELOPE */
} as unknown as OneLocationEncryptedEnvelope;

describe("Swift → JS envelope parity", () => {
  it("decrypts a natively-produced envelope to the original point", async () => {
    const point = await decryptLocationEnvelopeWithKey({
      privateKeyJwk,
      envelope: swiftEnvelope,
    });
    expect(point.latitude).toBeCloseTo(12.9716, 4);
    expect(point.longitude).toBeCloseTo(77.5946, 4);
    expect(point.sourcePlatform).toBe("ios");
  });
});
```

> Note: this test uses Node's Web Crypto (Vitest environment). If the environment lacks `crypto.subtle`, add `import { webcrypto } from "node:crypto"` and assign `globalThis.crypto = webcrypto as unknown as Crypto` at the top of the test.

- [ ] **Step 5: Run the parity test**

Run: `npx vitest run lib/one-location/__tests__/swift-parity.test.ts`
Expected: PASS — proves Swift output is decryptable by the production JS crypto path.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/one-location/encryption.ts hushh-webapp/ios/App/AppTests/LocationEnvelopeCryptoTests.swift hushh-webapp/lib/one-location/__tests__/swift-parity.test.ts
git commit -m "test(one-location): Swift->JS envelope crypto parity golden vector

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 7: Native background publisher + bridge methods

**Files:**
- Create: `hushh-webapp/ios/App/App/Plugins/BackgroundLocationPublisher.swift`
- Modify: `hushh-webapp/ios/App/App/Plugins/HushhLocationPlugin.swift`

**Interfaces:**
- Consumes: `LocationEnvelopeCrypto.encrypt(...)` (Task 5).
- Produces: `final class BackgroundLocationPublisher` with `func start(session: BackgroundShareSessionNative)`, `func stop()`, `func handle(location: CLLocation)`; `struct BackgroundShareSessionNative` decoded from the JS session dict. Plugin methods `startBackgroundShare` / `stopBackgroundShare`.

- [ ] **Step 1: Implement the publisher**

Create `hushh-webapp/ios/App/App/Plugins/BackgroundLocationPublisher.swift`:

```swift
import Foundation
import CoreLocation

struct BackgroundShareGrantNative {
    let grantId: String
    let recipientKeyId: String
    let recipientPublicKeyJwk: [String: Any]
}

struct BackgroundShareSessionNative {
    let vaultOwnerToken: String
    let backendBaseUrl: String
    let grants: [BackgroundShareGrantNative]
    let minMoveMeters: Double
    let minIntervalMs: Double
}

/// Owns background publishing: on each CLLocation fix it throttles, encrypts an
/// ECIES envelope per active grant, and POSTs ciphertext to the backend. Runs
/// with no JS alive. A bounded in-memory queue absorbs transient POST failures.
final class BackgroundLocationPublisher {

    private var session: BackgroundShareSessionNative?
    private var lastPublishedAt: Date?
    private var lastPoint: CLLocation?
    private let session URLSession = URLSession(configuration: .default)
    private let iso = ISO8601DateFormatter()

    func start(session: BackgroundShareSessionNative) {
        self.session = session
        self.lastPublishedAt = nil
        self.lastPoint = nil
    }

    func stop() {
        self.session = nil
    }

    var isActive: Bool { session != nil }

    func handle(location: CLLocation) {
        guard let session = session, !session.grants.isEmpty else { return }

        let now = Date()
        if let last = lastPoint {
            let moved = location.distance(from: last)
            let sinceMs = now.timeIntervalSince(lastPublishedAt ?? .distantPast) * 1000
            if moved < session.minMoveMeters && sinceMs < session.minIntervalMs {
                return
            }
        }
        lastPoint = location
        lastPublishedAt = now

        let capturedAt = iso.string(from: location.timestamp)
        let pointDict: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyM": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull(),
            "capturedAt": capturedAt,
            "sourcePlatform": "ios"
        ]
        guard let pointJSON = try? JSONSerialization.data(withJSONObject: pointDict) else { return }

        for grant in session.grants {
            guard let envelope = try? LocationEnvelopeCrypto.encrypt(
                pointJSON: pointJSON,
                recipientPublicKeyJwk: grant.recipientPublicKeyJwk,
                recipientKeyId: grant.recipientKeyId,
                capturedAt: capturedAt,
                sourcePlatform: "ios"
            ) else { continue }
            post(envelope: envelope, grantId: grant.grantId, session: session)
        }
    }

    private func post(envelope: [String: Any], grantId: String, session: BackgroundShareSessionNative) {
        let base = session.backendBaseUrl.hasSuffix("/")
            ? String(session.backendBaseUrl.dropLast())
            : session.backendBaseUrl
        guard
            let encodedGrant = grantId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
            let url = URL(string: "\(base)/api/one/location/grants/\(encodedGrant)/envelopes"),
            let body = try? JSONSerialization.data(withJSONObject: ["envelope": envelope])
        else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(session.vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        urlSession.dataTask(with: request).resume()
    }
}
```

Fix the typo before building: rename the property declaration `private let session URLSession = ...` to `private let urlSession = URLSession(configuration: .default)`.

- [ ] **Step 2: Wire the publisher into the plugin**

In `HushhLocationPlugin.swift`:

1. Add a property near the other private vars (line ~34):

```swift
    private let backgroundPublisher = BackgroundLocationPublisher()
```

2. In `load()`, allow background updates:

```swift
    public override func load() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
    }
```

3. Implement the two bridge methods (replace any temporary stubs from Task 4):

```swift
    @objc func startBackgroundShare(_ call: CAPPluginCall) {
        guard manager.authorizationStatus == .authorizedAlways else {
            call.resolve(["started": false, "reason": "always-permission-required"])
            return
        }
        guard
            let token = call.getString("vaultOwnerToken"),
            let base = call.getString("backendBaseUrl"),
            let rawGrants = call.getArray("grants") as? [[String: Any]]
        else {
            call.resolve(["started": false, "reason": "invalid-session"])
            return
        }
        let grants: [BackgroundShareGrantNative] = rawGrants.compactMap { g in
            guard
                let grantId = g["grantId"] as? String,
                let keyId = g["recipientKeyId"] as? String,
                let jwk = g["recipientPublicKeyJwk"] as? [String: Any]
            else { return nil }
            return BackgroundShareGrantNative(grantId: grantId, recipientKeyId: keyId, recipientPublicKeyJwk: jwk)
        }
        guard !grants.isEmpty else {
            call.resolve(["started": false, "reason": "no-grants"])
            return
        }
        let session = BackgroundShareSessionNative(
            vaultOwnerToken: token,
            backendBaseUrl: base,
            grants: grants,
            minMoveMeters: call.getDouble("minMoveMeters") ?? 25,
            minIntervalMs: call.getDouble("minIntervalMs") ?? 8000
        )
        backgroundPublisher.start(session: session)
        DispatchQueue.main.async { self.manager.startUpdatingLocation() }
        call.resolve(["started": true])
    }

    @objc func stopBackgroundShare(_ call: CAPPluginCall) {
        backgroundPublisher.stop()
        if watchCalls.isEmpty {
            DispatchQueue.main.async { self.manager.stopUpdatingLocation() }
        }
        call.resolve()
    }
```

4. Feed fixes to the publisher — in `locationManager(_:didUpdateLocations:)`, after `notifyWatchesSuccess(payload)` (line 273) add:

```swift
        if let last = locations.last, backgroundPublisher.isActive {
            backgroundPublisher.handle(location: last)
        }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd hushh-webapp/ios/App && xcodebuild -scheme App -destination 'generic/platform=iOS' -quiet build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add hushh-webapp/ios/App/App/Plugins/BackgroundLocationPublisher.swift hushh-webapp/ios/App/App/Plugins/HushhLocationPlugin.swift hushh-webapp/ios/App/App.xcodeproj/project.pbxproj
git commit -m "feat(one-location): native background location publisher + bridge

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 8: Bounded offline queue + token-refresh on 401

**Files:**
- Modify: `hushh-webapp/ios/App/App/Plugins/BackgroundLocationPublisher.swift`

**Interfaces:**
- Produces: internal `pendingEnvelopes` bounded queue with flush-on-success; a `PublishResult` handling `401` by surfacing a `needsReauth` flag readable by the plugin.

- [ ] **Step 1: Add a bounded queue**

In `BackgroundLocationPublisher.swift`, add:

```swift
    private struct QueuedPost { let grantId: String; let envelope: [String: Any] }
    private var pending: [QueuedPost] = []
    private let maxPending = 50
    private(set) var needsReauth = false
```

Replace the `urlSession.dataTask(...).resume()` line in `post(...)` with a completion handler that requeues on failure and drains on success:

```swift
        urlSession.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if error != nil || status == 0 {
                self.enqueue(QueuedPost(grantId: grantId, envelope: envelope))
                return
            }
            if status == 401 {
                self.needsReauth = true
                return
            }
            if (200...299).contains(status) {
                self.drainPending(session: session)
            }
        }.resume()
```

Add the helpers:

```swift
    private func enqueue(_ item: QueuedPost) {
        pending.append(item)
        if pending.count > maxPending {
            let dropped = pending.count - maxPending
            pending.removeFirst(dropped)
            NSLog("[BackgroundLocationPublisher] dropped %d queued fixes (cap %d)", dropped, maxPending)
        }
    }

    private func drainPending(session: BackgroundShareSessionNative) {
        guard !pending.isEmpty else { return }
        let items = pending
        pending.removeAll()
        for item in items { post(envelope: item.envelope, grantId: item.grantId, session: session) }
    }
```

- [ ] **Step 2: Build**

Run: `cd hushh-webapp/ios/App && xcodebuild -scheme App -destination 'generic/platform=iOS' -quiet build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add hushh-webapp/ios/App/App/Plugins/BackgroundLocationPublisher.swift
git commit -m "feat(one-location): bounded offline queue + 401 reauth flag in bg publisher

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 9: Background-sharing toggle UI + permission upgrade

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx` (toggle UI in the active-share area)
- Test: `hushh-webapp/app/one/location/__tests__/background-toggle.test.tsx`

**Interfaces:**
- Consumes: `backgroundShareEnabled`/`setBackgroundShareEnabled` (Task 3); `OneLocationService.getPermissionState`, `HushhLocation.requestAlwaysAuthorization` (via a new `OneLocationService.requestAlwaysAuthorization` wrapper).
- Produces: `OneLocationService.requestAlwaysAuthorization()`; a `BackgroundShareToggle` behavior: turning it on requests Always auth; if not granted, the toggle stays off and shows guidance.

- [ ] **Step 1: Add the service wrapper**

In `hushh-webapp/lib/one-location/service.ts`, after `requestLocationPermission` (line 77) add:

```ts
  static async requestAlwaysAuthorization() {
    const plugin = HushhLocation as typeof HushhLocation & {
      requestAlwaysAuthorization?: () => Promise<import("@/lib/capacitor").HushhLocationPermissionState>;
    };
    if (typeof plugin.requestAlwaysAuthorization === "function") {
      return plugin.requestAlwaysAuthorization();
    }
    return HushhLocation.getPermissionState();
  }
```

Also add `requestAlwaysAuthorization` to the `HushhLocationPlugin` interface in `index.ts`:

```ts
  /** iOS: prompt for the "Always Allow" upgrade. No-op elsewhere. */
  requestAlwaysAuthorization(): Promise<HushhLocationPermissionState>;
```

and a web stub in `location-web.ts`:

```ts
  async requestAlwaysAuthorization(): Promise<HushhLocationPermissionState> {
    // Browsers have no "always" location tier.
    return this.getPermissionState();
  }
```

- [ ] **Step 2: Write the failing test**

Create `hushh-webapp/app/one/location/__tests__/background-toggle.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BackgroundShareToggle } from "@/app/one/location/background-share-toggle";

describe("BackgroundShareToggle", () => {
  it("requests Always auth and enables when granted", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "available" });
    render(
      <BackgroundShareToggle
        enabled={false}
        onEnabledChange={onEnabledChange}
        requestAlwaysAuthorization={requestAlways}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(requestAlways).toHaveBeenCalled());
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("stays off and shows guidance when Always is denied", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "foreground-only" });
    render(
      <BackgroundShareToggle
        enabled={false}
        onEnabledChange={onEnabledChange}
        requestAlwaysAuthorization={requestAlways}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(requestAlways).toHaveBeenCalled());
    expect(onEnabledChange).not.toHaveBeenCalledWith(true);
    expect(screen.getByText(/Always/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/one/location/__tests__/background-toggle.test.tsx`
Expected: FAIL — cannot find `background-share-toggle`.

- [ ] **Step 4: Implement the toggle component**

Create `hushh-webapp/app/one/location/background-share-toggle.tsx`:

```tsx
"use client";

import { useState } from "react";

export interface BackgroundShareToggleProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  requestAlwaysAuthorization: () => Promise<{ background: string }>;
}

/**
 * Opt-in switch for background location sharing. Turning it ON requests iOS
 * "Always" authorization; we only flip enabled when that is granted, otherwise
 * we keep it off and explain why. Turning it OFF is immediate.
 */
export function BackgroundShareToggle({
  enabled,
  onEnabledChange,
  requestAlwaysAuthorization,
}: BackgroundShareToggleProps) {
  const [pending, setPending] = useState(false);
  const [needsAlways, setNeedsAlways] = useState(false);

  const handleToggle = async () => {
    if (enabled) {
      onEnabledChange(false);
      return;
    }
    setPending(true);
    try {
      const state = await requestAlwaysAuthorization();
      if (state.background === "available") {
        setNeedsAlways(false);
        onEnabledChange(true);
      } else {
        setNeedsAlways(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={pending}
        onClick={handleToggle}
        className="inline-flex items-center gap-2 text-sm font-medium"
      >
        <span
          className={
            enabled
              ? "h-5 w-9 rounded-full bg-emerald-500"
              : "h-5 w-9 rounded-full bg-muted"
          }
        />
        Keep sharing when the app is closed
      </button>
      {needsAlways ? (
        <p className="text-xs text-amber-600">
          Set location access to “Always” in Settings to keep sharing in the
          background.
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/one/location/__tests__/background-toggle.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Render the toggle in the active-share area**

In `hushh-webapp/app/one/location/page.tsx`, where active owner shares are rendered (near the "Stop sharing"/`handleRevoke` UI), mount:

```tsx
{activeOwnerGrants.length > 0 ? (
  <BackgroundShareToggle
    enabled={backgroundShareEnabled}
    onEnabledChange={setBackgroundShareEnabled}
    requestAlwaysAuthorization={OneLocationService.requestAlwaysAuthorization}
  />
) : null}
```

Add the import: `import { BackgroundShareToggle } from "@/app/one/location/background-share-toggle";`

- [ ] **Step 7: Run suites**

Run: `npx vitest run app/one/location lib/one-location`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/app/one/location/background-share-toggle.tsx hushh-webapp/app/one/location/__tests__/background-toggle.test.tsx hushh-webapp/lib/one-location/service.ts hushh-webapp/lib/capacitor/index.ts hushh-webapp/lib/capacitor/plugins/location-web.ts hushh-webapp/app/one/location/page.tsx
git commit -m "feat(one-location): background-sharing opt-in toggle + Always auth request

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 10: Recipient live/paused indicator

**Files:**
- Create: `hushh-webapp/lib/one-location/freshness.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/freshness.test.ts`
- Modify: `hushh-webapp/app/one/location/page.tsx` (use it in the recipient live view label)

**Interfaces:**
- Consumes: `LIVE_LOCATION_STALE_THRESHOLD_MS` (`page.tsx:205`, = 60_000).
- Produces: `liveFreshness(capturedAtISO: string, nowMs: number, staleThresholdMs: number): { state: "live" | "paused"; agoLabel: string }`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/freshness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { liveFreshness } from "@/lib/one-location/freshness";

const base = Date.parse("2026-07-09T00:00:00.000Z");

describe("liveFreshness", () => {
  it("reports live within the stale threshold", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base + 8_000, 60_000);
    expect(r.state).toBe("live");
    expect(r.agoLabel).toBe("8s ago");
  });

  it("reports paused past the stale threshold", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base + 240_000, 60_000);
    expect(r.state).toBe("paused");
    expect(r.agoLabel).toBe("4m ago");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/one-location/__tests__/freshness.test.ts`
Expected: FAIL — cannot find module `freshness`.

- [ ] **Step 3: Implement**

Create `hushh-webapp/lib/one-location/freshness.ts`:

```ts
/**
 * Classify how fresh a received location point is. "live" while within the
 * stale threshold (a device is actively publishing), "paused" once it lapses
 * (e.g. the sender closed the app and no device is publishing). agoLabel is a
 * compact human string for the recipient's badge.
 */
export function liveFreshness(
  capturedAtISO: string,
  nowMs: number,
  staleThresholdMs: number,
): { state: "live" | "paused"; agoLabel: string } {
  const capturedMs = Date.parse(capturedAtISO);
  const deltaMs = Math.max(0, nowMs - capturedMs);
  const seconds = Math.round(deltaMs / 1000);
  const agoLabel =
    seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  return {
    state: deltaMs <= staleThresholdMs ? "live" : "paused",
    agoLabel,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/one-location/__tests__/freshness.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use it in the recipient live label**

In `page.tsx`, in the recipient live-view rendering, compute `liveFreshness(point.capturedAt, Date.now(), LIVE_LOCATION_STALE_THRESHOLD_MS)` and render "Live · {agoLabel}" (emerald) vs "Paused · last seen {agoLabel}" (amber). Reuse the existing badge styling near `statusLabel` (`page.tsx:831`).

- [ ] **Step 6: Run suites**

Run: `npx vitest run lib/one-location app/one/location`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/lib/one-location/freshness.ts hushh-webapp/lib/one-location/__tests__/freshness.test.ts hushh-webapp/app/one/location/page.tsx
git commit -m "feat(one-location): recipient live/paused freshness indicator

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 11: Manual device verification

**Files:** none (verification task).

- [ ] **Step 1: Full build + install on a physical iPhone**

Run: `cd hushh-webapp && npm run cap:build && npx cap open ios`
Then run on a physical device from Xcode (background location needs real hardware).

- [ ] **Step 2: Grant Always + enable toggle**

In the app: start a share, toggle "Keep sharing when the app is closed", accept the "Always Allow" prompt.
Expected: toggle stays on; no "set to Always" guidance.

- [ ] **Step 3: Background + move**

Lock the phone and walk/drive a short loop for ~3 minutes.
Expected on a *different* recipient device/platform: the dot moves and the badge reads "Live · Ns ago".

- [ ] **Step 4: Verify E2E on the wire**

Inspect the backend `envelopes` POST payloads (server logs / proxy).
Expected: only ciphertext fields (`ciphertext`, `iv`, `senderEphemeralPublicKeyJwk`) — no plaintext lat/lng.

- [ ] **Step 5: Handoff gap**

Share from desktop web, close it, then open the phone app once.
Expected: recipient shows "Paused · last seen …" after ~1 min, then returns to "Live" once the phone app registers the session.

- [ ] **Step 6: Stop sharing**

Toggle off / revoke.
Expected: no further POSTs; recipient goes to "Paused".

---

## Self-Review (completed by plan author)

- **Spec coverage:** Goal (Tasks 3-11), Approach A extend-plugin (Tasks 4,7), native ECIES + parity (Tasks 5-6), iOS permissions/config (Task 4), auth token + 401 (Tasks 7-8), offline buffering (Task 8), explicit toggle (Task 9), handoff indicator (Task 10), out-of-scope Android/drive-overrides/recipient-bg (not implemented, per spec). All spec sections map to a task.
- **Placeholder scan:** the only intentional fill-in is the golden envelope JSON in Task 6 Step 4, which is *generated* by Task 6 Step 3 and pasted — not a design gap. Fixture keypair is a real generated P-256 pair.
- **Type consistency:** `BackgroundShareSession`/`BackgroundShareGrant` field names are identical across Tasks 1-3 and decoded 1:1 in Task 7 (`vaultOwnerToken`, `backendBaseUrl`, `grants[].grantId/recipientKeyId/recipientPublicKeyJwk`, `minMoveMeters`, `minIntervalMs`). Envelope keys match `OneLocationEncryptedEnvelope` and the JS `encryptLocationForRecipient` output.
