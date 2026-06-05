import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isNativeTestVaultBootstrapManaged,
  isNativeUiTestSession,
  preferPassphraseUnlockForAutomation,
  shouldSkipGeneratedVaultUnlockForAutomation,
} from "@/lib/testing/native-test";

describe("native test automation guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-hushh-native-test-enabled");
    delete (window as Window & { __HUSHH_NATIVE_TEST__?: unknown }).__HUSHH_NATIVE_TEST__;
  });

  it("does not bypass biometric unlock for normal app users", () => {
    expect(isNativeUiTestSession()).toBe(false);
    expect(preferPassphraseUnlockForAutomation()).toBe(false);
    expect(shouldSkipGeneratedVaultUnlockForAutomation()).toBe(false);
    expect(isNativeTestVaultBootstrapManaged()).toBe(false);
  });

  it("does not bypass biometric unlock from DOM hints alone", () => {
    document.documentElement.setAttribute("data-hushh-native-test-enabled", "true");
    expect(isNativeUiTestSession()).toBe(false);
    expect(preferPassphraseUnlockForAutomation()).toBe(false);
  });

  it("allows passphrase bypass only for explicit native UITest sessions", () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
      vaultPassphrase: "test#123",
      expectedUserId: "reviewer-uid",
    };

    expect(isNativeUiTestSession()).toBe(true);
    expect(preferPassphraseUnlockForAutomation()).toBe(true);
    expect(shouldSkipGeneratedVaultUnlockForAutomation()).toBe(true);
    expect(isNativeTestVaultBootstrapManaged()).toBe(true);
  });

  it("allows Playwright automation to prefer passphrase without native bridge", () => {
    vi.stubGlobal("navigator", { webdriver: true });
    expect(preferPassphraseUnlockForAutomation()).toBe(true);
    expect(isNativeUiTestSession()).toBe(false);
  });
});
