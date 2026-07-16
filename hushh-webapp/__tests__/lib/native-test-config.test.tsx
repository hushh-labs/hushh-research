import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useNativeTestConfig } from "@/lib/testing/native-test";

describe("useNativeTestConfig", () => {
  afterEach(() => {
    delete window.__HUSHH_NATIVE_TEST__;
    document.documentElement.removeAttribute("data-hushh-native-test-enabled");
    document.documentElement.removeAttribute(
      "data-hushh-native-test-auto-reviewer-login"
    );
  });

  it("observes credentials injected after the bridge is already enabled", async () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
    };
    const { result } = renderHook(() => useNativeTestConfig());

    expect(result.current.enabled).toBe(true);
    expect(result.current.vaultPassphrase).toBeNull();

    act(() => {
      window.__HUSHH_NATIVE_TEST__!.vaultPassphrase = "local-test-passphrase";
      window.__HUSHH_NATIVE_TEST__!.expectedUserId = "reviewer-user";
      window.dispatchEvent(new Event("hushh:native-test-config-updated"));
    });

    await waitFor(() => {
      expect(result.current.vaultPassphrase).toBe("local-test-passphrase");
      expect(result.current.expectedUserId).toBe("reviewer-user");
    });
  });
});
