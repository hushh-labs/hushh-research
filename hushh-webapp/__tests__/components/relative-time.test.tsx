import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { RelativeTime } from "@/components/app-ui/relative-time";

describe("RelativeTime Component - Hydration & Semantics", () => {
  it("renders the semantic time tag with absolute dateTime attribute for screen readers", () => {
    const testDate = new Date("2026-05-13T10:00:00Z");
    const { container } = render(<RelativeTime date={testDate} />);
    const timeNode = container.querySelector("time");

    expect(timeNode).toBeDefined();
    // The dateTime attribute guarantees A11y compliance regardless of the relative visual text
    expect(timeNode?.getAttribute("datetime")).toBe("2026-05-13T10:00:00.000Z");
  });

  it("provides an accessible title attribute for native browser hover tooltips", () => {
    const testDate = new Date("2026-05-13T10:00:00Z");
    const { container } = render(<RelativeTime date={testDate} />);
    const timeNode = container.querySelector("time");

    expect(timeNode?.getAttribute("title")).toBeTruthy();
  });

  it("handles invalid dates gracefully without crashing the UI", () => {
    // @ts-expect-error - Intentionally passing bad data
    const { getByText } = render(<RelativeTime date="not-a-real-date" />);
    expect(getByText("Invalid date")).toBeDefined();
  });
});