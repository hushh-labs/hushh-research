import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/one/location/map",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
}));

vi.mock("@/lib/testing/native-test", () => ({
  getNativeTestConfig: () => ({
    enabled: true,
    autoReviewerLogin: true,
    vaultPassphrase: "in-memory-test-value",
    expectedUserId: null,
    expectedMarker: "native-route-one-location-map",
    initialRoute: "/one/location/map",
    expectedRoute: "/one/location/map",
  }),
}));

import { NativeTestRouter } from "@/components/app-ui/native-test-router";

afterEach(() => {
  cleanup();
  navigation.pathname = "/one/location/map";
  navigation.replace.mockReset();
  delete window.__HUSHH_NATIVE_TEST__;
});

describe("NativeTestRouter route ownership", () => {
  it("releases the route after the expected screen settles", () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      bootstrapState: "vault_unlocked",
      uiFlowRunId: "map-close-test",
    };

    const view = render(<NativeTestRouter />);
    expect(navigation.replace).not.toHaveBeenCalled();

    navigation.pathname = "/one/location";
    view.rerender(<NativeTestRouter />);

    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
