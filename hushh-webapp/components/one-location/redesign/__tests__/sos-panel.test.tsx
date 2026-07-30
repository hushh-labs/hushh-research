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
  emergency: {
    countryCode: "IN",
    countryName: "India",
    number: "112",
  },
  emergencyStatus: "resolved" as const,
  onResolveEmergencyNumber: vi.fn(),
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SosPanel", () => {
  it("renders the Save My Soul UI, selected recipients, and local dialer", () => {
    render(<SosPanel {...baseProps} />);

    expect(screen.getByText("SMS · Save my Soul")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Press and hold. An SMS with your live location goes to your people — even with no internet.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/SMS goes to Carol/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /call 112/i })).toHaveAttribute(
      "href",
      "tel:112",
    );
    expect(screen.getByText("India")).toBeInTheDocument();
    expect(screen.queryByText(/voice note/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("sms-safety-screen")).toHaveClass(
      "fixed",
      "inset-0",
      "bg-black",
    );
  });

  it("does not expose a dial link before the local number resolves", () => {
    render(
      <SosPanel {...baseProps} emergency={null} emergencyStatus="resolving" />,
    );

    expect(
      screen.getByRole("button", { name: "Finding local emergency number" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("link", { name: /emergency services/i }),
    ).toBeNull();
    expect(screen.queryByText("United States")).not.toBeInTheDocument();
  });

  it("offers a retry without inventing a number when country lookup fails", () => {
    const onResolveEmergencyNumber = vi.fn();
    render(
      <SosPanel
        {...baseProps}
        emergency={null}
        emergencyStatus="unavailable"
        onResolveEmergencyNumber={onResolveEmergencyNumber}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry local emergency number" }),
    );
    expect(onResolveEmergencyNumber).toHaveBeenCalledTimes(1);
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

  it("opens a 140-character short-message composer and fails closed above the limit", () => {
    render(<SosPanel {...baseProps} />);

    expect(
      screen.getByRole("button", { name: "Short text message" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Short text message" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Short text message" }),
    );
    const composer = screen.getByRole("textbox", {
      name: "Short text message",
    });
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });

    expect(screen.getByText("0/140")).toBeInTheDocument();
    expect(hold).toBeDisabled();

    fireEvent.change(composer, { target: { value: "a".repeat(140) } });
    expect(screen.getByText("140/140")).toBeInTheDocument();
    expect(hold).toBeEnabled();
    expect(screen.queryByText("character limit exceed")).toBeNull();

    fireEvent.change(composer, { target: { value: "a".repeat(141) } });
    expect(screen.getByText("141/140")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "character limit exceed",
    );
    expect(hold).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Come get me" }));
    expect(
      screen.queryByRole("textbox", { name: "Short text message" }),
    ).toBeNull();
    expect(hold).toBeEnabled();
  });

  it("sends a valid custom short message exactly once after the hold", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Short text message" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Short text message" }),
      { target: { value: "  Meet me by the north entrance.  " } },
    );

    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(
      "Meet me by the north entrance.",
    );
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
