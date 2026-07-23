// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const recipient = (
  overrides: Partial<OneLocationRecipient>,
): OneLocationRecipient => ({
  userId: "u1",
  displayName: "Carol",
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256-AES256-GCM",
  canReceiveLocation: true,
  ...overrides,
});

const baseProps = {
  recipients: [recipient({ userId: "u1", displayName: "Carol" })],
  active: false,
  busy: false,
  onTrigger: vi.fn(),
  onClose: vi.fn(),
  onEditContacts: vi.fn(),
  recipientLabel: (value: OneLocationRecipient) => value.displayName,
  isRecipientShareReady: (value: OneLocationRecipient) =>
    value.canReceiveLocation,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SosPanel", () => {
  it("renders the Save My Soul UI, selected recipients, and US dialer", () => {
    render(<SosPanel {...baseProps} />);

    expect(screen.getByText("SMS · Save my soul")).toBeInTheDocument();
    expect(screen.getByText(/SMS goes to Carol/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /call 911/i })).toHaveAttribute(
      "href",
      "tel:911",
    );
    expect(screen.queryByText(/voice note/i)).not.toBeInTheDocument();
  });

  it("does not send when the hold is released before two seconds", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });

    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(1_500));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(1_000));

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("sends exactly once after a continuous two-second hold", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });

    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(null);
  });

  it("passes the selected fixed message and exposes Edit and Cancel", () => {
    const onTrigger = vi.fn();
    const onClose = vi.fn();
    const onEditContacts = vi.fn();
    render(
      <SosPanel
        {...baseProps}
        onTrigger={onTrigger}
        onClose={onClose}
        onEditContacts={onEditContacts}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "I'm not safe" }));
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    expect(onTrigger).toHaveBeenCalledWith("I'm not safe");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEditContacts).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fails closed when no selected recipient is ready", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} recipients={[]} onTrigger={onTrigger} />);
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    expect(hold).toBeDisabled();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(3_000));
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
