import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SegmentedModeControl,
  type ShareMode,
} from "@/components/one-location/segmented-mode-control";

function ModeHarness() {
  const [mode, setMode] = useState<ShareMode>("share");
  return <SegmentedModeControl value={mode} onChange={setMode} />;
}

describe("One Location share and request mode", () => {
  it("keeps one selected tab in the keyboard order and wraps arrow navigation", () => {
    render(<ModeHarness />);
    const share = screen.getByRole("tab", { name: "share" });
    const request = screen.getByRole("tab", { name: "request" });

    expect(share).toHaveAttribute("aria-selected", "true");
    expect(share).toHaveAttribute("tabindex", "0");
    expect(request).toHaveAttribute("tabindex", "-1");

    share.focus();
    fireEvent.keyDown(share, { key: "ArrowRight" });
    expect(request).toHaveFocus();
    expect(request).toHaveAttribute("aria-selected", "true");
    expect(request).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(request, { key: "ArrowRight" });
    expect(share).toHaveFocus();
    expect(share).toHaveAttribute("aria-selected", "true");
  });

  it("supports Home, End, and pointer selection", () => {
    render(<ModeHarness />);
    const share = screen.getByRole("tab", { name: "share" });
    const request = screen.getByRole("tab", { name: "request" });

    fireEvent.keyDown(share, { key: "End" });
    expect(request).toHaveFocus();
    expect(request).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(request, { key: "Home" });
    expect(share).toHaveFocus();
    expect(share).toHaveAttribute("aria-selected", "true");

    fireEvent.click(request);
    expect(request).toHaveAttribute("aria-selected", "true");
  });
});
