// @vitest-environment jsdom
import { fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const recipient = (over: Partial<OneLocationRecipient>): OneLocationRecipient => ({
  userId: "u1",
  displayName: "Carol",
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256-AES256-GCM",
  canReceiveLocation: true,
  ...over,
});

const baseProps = {
  recipients: [recipient({ userId: "u1", displayName: "Carol" })],
  active: false,
  busy: false,
  startedAtLabel: null,
  onTrigger: vi.fn(),
  onStop: vi.fn(),
  recipientLabel: (r: OneLocationRecipient) => r.displayName,
  isRecipientShareReady: (r: OneLocationRecipient) => r.canReceiveLocation,
  countdownSeconds: 3,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SosPanel", () => {
  it("shows TAP TO PANIC and the alert list when idle", () => {
    render(<SosPanel {...baseProps} />);
    expect(screen.getByText(/tap to panic/i)).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("tapping starts a countdown that can be cancelled (no trigger)", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);
    fireEvent.click(screen.getByRole("button", { name: /tap to panic/i }));
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    act(() => vi.advanceTimersByTime(5000));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("fires onTrigger when the countdown elapses", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} countdownSeconds={3} />);
    fireEvent.click(screen.getByRole("button", { name: /tap to panic/i }));
    act(() => vi.advanceTimersByTime(3000));
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("shows LIVE + I'm safe when active and calls onStop", () => {
    const onStop = vi.fn();
    render(<SosPanel {...baseProps} active startedAtLabel="10:57 AM" onStop={onStop} />);
    expect(screen.getByText(/live location active/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /i'm safe/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
