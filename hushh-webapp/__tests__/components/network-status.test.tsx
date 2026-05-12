import React from "react";
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import { NetworkStatus } from "@/components/app-ui/network-status";

describe("NetworkStatus Component - Network Resilience", () => {
  it("renders nothing by default in a connected environment", () => {
    const { container } = render(<NetworkStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("appears with an assertive ARIA role when the browser fires an offline event", () => {
    const { getByRole, queryByRole } = render(<NetworkStatus />);

    // Should not be there initially
    expect(queryByRole("alert")).toBeNull();

    // Simulate network loss
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    const alertBox = getByRole("alert");
    expect(alertBox).toBeDefined();
    expect(alertBox.getAttribute("aria-live")).toBe("assertive");
    expect(alertBox.textContent).toContain("offline");
  });

  it("dismisses automatically when connection is restored", () => {
    const { queryByRole } = render(<NetworkStatus />);

    // Go offline
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(queryByRole("alert")).toBeDefined();

    // Come back online
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(queryByRole("alert")).toBeNull();
  });
});