import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NativeTestRouteStatus } from "@/components/app-ui/native-test-route-status";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1" },
    loading: false,
  }),
}));

vi.mock("@/lib/testing/native-test", () => ({
  getNativeTestConfig: () => ({
    enabled: true,
    expectedMarker: "native-route-home",
    expectedRoute: "/",
    initialRoute: "/",
  }),
}));

describe("NativeTestRouteStatus", () => {
  it("renders loaded route status semantics", () => {
    render(<NativeTestRouteStatus />);

    const marker = screen.getByTestId("native-route-home");

    expect(marker.getAttribute("aria-hidden")).toBe("true");
    expect(marker.getAttribute("data-native-route-marker")).toBe("true");
    expect(marker.getAttribute("data-native-route-id")).toBe("/");
    expect(marker.getAttribute("data-native-auth-default")).toBe("authenticated");
    expect(marker.getAttribute("data-native-data-default")).toBe("loaded");
  });
});
