import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LiveDataIndicator } from "@/components/app-ui/live-data-indicator";

describe("LiveDataIndicator Component - Streaming Semantics", () => {
  it("renders the correct default text for live status", () => {
    const { getByText } = render(<LiveDataIndicator status="live" />);
    // Asserts both the visual text and the hidden screen-reader text exist
    expect(getByText("Live")).toBeDefined();
    expect(getByText("Connection status: Live")).toBeDefined();
  });

  it("applies the motion-safe ping animation class when active", () => {
    const { container } = render(<LiveDataIndicator status="connecting" />);
    const pingElement = container.querySelector(".motion-safe\\:animate-ping");
    expect(pingElement).toBeDefined();
    expect(pingElement?.className).toContain("bg-amber-500");
  });

  it("omits the ping animation element to save CPU when offline", () => {
    const { container } = render(<LiveDataIndicator status="offline" />);
    const pingElement = container.querySelector(".motion-safe\\:animate-ping");
    expect(pingElement).toBeNull();
  });

  it("respects custom label overrides and securely updates the ARIA live region", () => {
    const { getByText } = render(
      <LiveDataIndicator status="live" label="Market Syncing" />
    );
    expect(getByText("Market Syncing")).toBeDefined();
    expect(getByText("Connection status: Market Syncing")).toBeDefined();
  });
});