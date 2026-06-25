import { render, screen } from "@testing-library/react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";

describe("NativeTestBeacon", () => {
  it("renders auth and data state attributes", () => {
    render(
      <NativeTestBeacon
        routeId="native://one/dashboard"
        marker="native-test-dashboard"
        authState="authenticated"
        dataState="loaded"
      />,
    );

    const beacon = screen.getByTestId("native-test-dashboard");

    expect(beacon.getAttribute("aria-hidden")).toBe("true");
    expect(beacon.getAttribute("data-native-test-beacon")).toBe("true");
    expect(beacon.getAttribute("data-native-route-id")).toBe("native://one/dashboard");
    expect(beacon.getAttribute("data-native-auth-state")).toBe("authenticated");
    expect(beacon.getAttribute("data-native-data-state")).toBe("loaded");
  });
});
