import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasIncompleteNativeUiFlowSession,
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
    window.sessionStorage.removeItem("__hushh_native_ui_flow_state_v1");
    window.sessionStorage.removeItem("__hushh_native_ui_flow_state_v1:flow-1");
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
      vaultPassphrase: "fixture-only-passphrase",
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

  it("recognizes only a structurally valid incomplete native flow resume marker", () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      uiFlowRunId: "flow-1",
    };
    window.sessionStorage.setItem(
      "__hushh_native_ui_flow_state_v1:flow-1",
      JSON.stringify({
        started: true,
        complete: false,
        nextIndex: 1,
        report: { startedAt: "2026-07-14T00:00:00.000Z", flows: [] },
      }),
    );
    expect(hasIncompleteNativeUiFlowSession()).toBe(true);

    window.sessionStorage.setItem(
      "__hushh_native_ui_flow_state_v1:flow-1",
      JSON.stringify({ started: true, complete: false }),
    );
    expect(hasIncompleteNativeUiFlowSession()).toBe(false);
  });
});
