import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("One Location native one-shot position resilience", () => {
  it("keeps Android approximate permission away from GPS and races permitted providers", () => {
    const android = source(
      "android/app/src/main/java/com/hushh/app/plugins/HushhLocation/HushhLocationPlugin.kt",
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
});
