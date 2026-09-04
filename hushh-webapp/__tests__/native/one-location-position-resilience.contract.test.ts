import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isLocationPermissionDeniedError } from "@/lib/one-location/location-readiness";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("One Location native one-shot position resilience", () => {
  it("keeps Android approximate permission away from GPS and races permitted providers", () => {
    const android = source(
      "android/app/src/main/java/com/hussh/app/plugins/HushhLocation/HushhLocationPlugin.kt",
    );

    expect(android).toContain("val fineGranted = hasAndroidPermission");
    expect(android).toContain("if (!fineGranted)");
    expect(android).toContain("listOf(LocationManager.NETWORK_PROVIDER)");
    expect(android).toContain(
      "runCatching { locationManager.getLastKnownLocation(provider) }.getOrNull()",
    );
    expect(android).toContain("for (provider in providers)");
    expect(android).toContain(".coerceIn(3_000, 30_000)");
  });

  it("keeps iOS one-shot capture bounded and cancels late settlement", () => {
    const ios = source(
      "ios/App/App/Plugins/HushhLocationPlugin.swift",
    );

    expect(ios).toContain("private var pendingLocationTimeout: DispatchWorkItem?");
    expect(ios).toContain(
      'max(3_000, min(call.getInt("timeoutMs") ?? 15_000, 30_000))',
    );
    expect(ios).toContain("Precise location unavailable before timeout.");
    expect(ios).toContain("private func clearPendingLocationCall()");
    expect(ios).toContain("pendingLocationTimeout?.cancel()");
    expect(ios).toContain("if let call = clearPendingLocationCall()");
  });

  it("tells JS about a revocation that lands while a watch is already running", () => {
    // locationManagerDidChangeAuthorization answers pendingPermissionCall,
    // pendingWatchStartCall and pendingLocationCall — and a mid-watch
    // revocation is none of those, so it used to fall through the final guard
    // and return. CoreLocation stops delivering, JS is never told, and the
    // last known point stays on the map with the Location switch still ON for
    // someone the OS has already cut off.
    const ios = source("ios/App/App/Plugins/HushhLocationPlugin.swift");

    const denialBranch = ios.slice(
      ios.indexOf("public func locationManagerDidChangeAuthorization"),
      ios.indexOf("guard let call = pendingLocationCall else { return }"),
    );
    expect(denialBranch).toContain("case .denied, .restricted:");
    expect(denialBranch).toContain("failWatches(");
  });

  it("rejects every watch with a message the shared JS denial check recognises", () => {
    // The cross-language contract. CAPPluginCall.reject takes a `String?`
    // code and this plugin passes none, so JS cannot switch on a numeric
    // code — it matches on the MESSAGE via isLocationPermissionDeniedError.
    // If someone reworded a failWatches() string, a real denial would silently
    // degrade to a generic error on device and nothing else would catch it.
    const ios = source("ios/App/App/Plugins/HushhLocationPlugin.swift");

    const messages = [...ios.matchAll(/failWatches\(\s*"([^"]+)"\s*\)/g)].map(
      (match) => match[1],
    );
    expect(messages.length).toBeGreaterThan(0);

    const denials = messages.filter((message) =>
      isLocationPermissionDeniedError(new Error(message)),
    );
    // At least one path must read as a denial: the authorization change.
    expect(denials).toContain("Location permission was not granted.");
  });

  it("does not end a live watch on the transient kCLErrorLocationUnknown", () => {
    // Apple's guidance is to wait that one out — CoreLocation keeps trying.
    // Treating it as fatal ran failWatches(), which releases every saved call
    // AND calls stopUpdatingLocation(), so a single blip in a lift or a tunnel
    // permanently stopped live sharing until the person toggled Location off
    // and on again.
    const ios = source("ios/App/App/Plugins/HushhLocationPlugin.swift");

    const didFail = ios.slice(
      ios.indexOf("didFailWithError error: Error"),
    );
    expect(didFail).toContain("as? CLError");
    expect(didFail).toContain(".locationUnknown");
    // The early return must come BEFORE the watch teardown, or it does nothing.
    expect(didFail.indexOf(".locationUnknown")).toBeLessThan(
      didFail.indexOf("failWatches(message)"),
    );
  });
});
