import { describe, expect, it } from "vitest";

type MobileConnectVaultState = {
  nativeVaultReady: boolean;
  webVaultFallbackReady: boolean;
};

function resolveMobileConnectVaultMode(
  state: MobileConnectVaultState,
): "native" | "web-fallback" | "unavailable" {
  if (state.nativeVaultReady) {
    return "native";
  }

  if (state.webVaultFallbackReady) {
    return "web-fallback";
  }

  return "unavailable";
}

describe("mobile connect vault fallback state", () => {
  it("preserves web fallback when native vault is unavailable", () => {
    expect(
      resolveMobileConnectVaultMode({
        nativeVaultReady: false,
        webVaultFallbackReady: true,
      }),
    ).toBe("web-fallback");
  });
});