import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { HoldToConfirm } from "@/components/app-ui/hold-to-confirm";

describe("HoldToConfirm Component - Safety & A11y", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders with correct ARIA instructions for screen readers", () => {
    const { getByRole } = render(<HoldToConfirm onConfirm={() => {}} label="Delete Key" />);
    const button = getByRole("button");
    
    expect(button.getAttribute("aria-label")).toContain("Hold for 1.5 seconds");
  });

  it("executes the callback only after the full duration is reached", () => {
    const onConfirmMock = vi.fn();
    const { getByRole } = render(<HoldToConfirm onConfirm={onConfirmMock} holdDurationMs={1000} />);
    const button = getByRole("button");

    // Start holding
    fireEvent.pointerDown(button);

    // Advance time halfway (should not trigger yet)
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onConfirmMock).not.toHaveBeenCalled();

    // Advance time to completion
    act(() => {
      vi.advanceTimersByTime(550);
    });
    expect(onConfirmMock).toHaveBeenCalledOnce();
  });

  it("resets progress safely if the pointer is released early", () => {
    const onConfirmMock = vi.fn();
    const { getByRole } = render(<HoldToConfirm onConfirm={onConfirmMock} holdDurationMs={1000} />);
    const button = getByRole("button");

    // Start holding
    fireEvent.pointerDown(button);

    // Advance time halfway
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Release early
    fireEvent.pointerUp(button);

    // Advance the remaining time
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // Verify the action was aborted
    expect(onConfirmMock).not.toHaveBeenCalled();
  });

  it("supports full keyboard holding via the Space key", () => {
    const onConfirmMock = vi.fn();
    const { getByRole } = render(<HoldToConfirm onConfirm={onConfirmMock} holdDurationMs={1000} />);
    const button = getByRole("button");

    fireEvent.keyDown(button, { key: " " });

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(onConfirmMock).toHaveBeenCalledOnce();
  });
});