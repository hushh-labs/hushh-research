import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";

describe("NativeRouteMarker", () => {
  it("renders route marker data attributes", () => {
    render(
      <NativeRouteMarker
        routeId="/one/location"
        marker="native-route-one-location"
        authState="authenticated"
        dataState="loaded"
      />,
    );

    const marker = screen.getByTestId("native-route-one-location");

    expect(marker.getAttribute("aria-hidden")).toBe("true");
    expect(marker.getAttribute("data-native-route-marker")).toBe("true");
    expect(marker.getAttribute("data-native-route-id")).toBe("/one/location");
    expect(marker.getAttribute("data-native-auth-default")).toBe(
      "authenticated",
    );
    expect(marker.getAttribute("data-native-data-default")).toBe("loaded");
  });
});
