import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ClipboardCopy } from "@/components/app-ui/clipboard-copy";

describe("ClipboardCopy Component - A11y & Microinteractions", () => {
  it("renders with the correct ARIA labels", () => {
    const { getByRole } = render(<ClipboardCopy value="test-key" label="Copy API Key" />);
    const button = getByRole("button");
    expect(button.getAttribute("aria-label")).toBe("Copy API Key");
    expect(button.getAttribute("title")).toBe("Copy API Key");
  });

  it("includes a polite aria-live region for screen reader feedback", () => {
    const { container } = render(<ClipboardCopy value="12345" />);
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeDefined();
    expect(liveRegion?.className).toContain("sr-only");
  });

  it("includes strict keyboard focus-visible states", () => {
    const { getByRole } = render(<ClipboardCopy value="test" />);
    const button = getByRole("button");
    expect(button.className).toContain("focus-visible:ring-2");
    expect(button.className).toContain("focus-visible:outline-none");
  });
});