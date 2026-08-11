// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isWindowsDesktopEmCallUnsupported,
  SosPanel,
} from "@/components/one-location/redesign/sos-panel";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
const toastError = vi.mocked(toast.error);

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
  onStopSos: vi.fn(),
  stopBusy: false,
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
  it("detects Windows desktop callers as unsupported for tel: links", () => {
    expect(
      isWindowsDesktopEmCallUnsupported({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0",
        platform: "Win32",
      }),
    ).toBe(true);
  });

  it("supports fallback for Windows user agents that do not include the word windows", () => {
    expect(
      isWindowsDesktopEmCallUnsupported({
        userAgent: "Mozilla/5.0 (X11; Win32; x64) Chrome/140.0.0.0",
        platform: "Win32",
      }),
    ).toBe(true);
  });

  it("shows emergency copy fallback on Windows desktop and confirms copy status", async () => {
    vi.useRealTimers();
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    const navigatorUserAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (X11; Win32; x64) Chrome/140.0.0.0");
    const navigatorPlatform = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Win32");
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "clipboard",
    );

    try {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: clipboardWriteText,
        },
      });

      render(<SosPanel {...baseProps} />);

      const copyButton = screen.getByRole("button", {
        name: "Copy 112 emergency services (India)",
      });
      expect(copyButton).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /call 112 emergency services/i }),
      ).toBeNull();

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(clipboardWriteText).toHaveBeenCalledWith("112");
      await waitFor(() =>
        expect(screen.getByText("Number copied to clipboard.")).toBeInTheDocument(),
      );
    } finally {
      navigatorUserAgent.mockRestore();
      navigatorPlatform.mockRestore();
      if (clipboardDescriptor) {
        Object.defineProperty(window.navigator, "clipboard", clipboardDescriptor);
      } else {
        delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
      }
      vi.useFakeTimers();
    }

  });

  it("renders the Save My Soul UI, selected recipients, and local dialer", () => {
    const navigatorUserAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    const navigatorPlatform = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Linux x86_64");

    try {
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
    } finally {
      navigatorUserAgent.mockRestore();
      navigatorPlatform.mockRestore();
    }
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

  it("stays pressable when the trigger bails out without ever going busy", async () => {
    // Regression: handleTriggerSos returns early on a blocked permission, an
    // empty SMS contact list, or an incident that is already live -- all before
    // it sets `busy`. The panel's reset effect only runs on a busy true -> false
    // edge, so nothing released the fired latch: `progress` stayed at 1, the
    // ring showed a frozen countdown with the radar pulse running, and every
    // later press was silently ignored until the screen was remounted.
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });

    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Let the trigger promise settle so the latch is released.
    await act(async () => {
      await Promise.resolve();
    });

    // The ring must be back to its resting label, not a stuck countdown.
    expect(hold).toHaveTextContent("Hold 2 s");

    fireEvent.pointerDown(hold, { button: 0, pointerId: 2 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 2 });

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("sends a typed message straight from the send button in the message box", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.click(screen.getByRole("button", { name: "Short text message" }));
    fireEvent.change(screen.getByLabelText("Short text message"), {
      target: { value: "Emergency" },
    });
    fireEvent.click(screen.getByTestId("sos-send-custom-message"));

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith("Emergency");
  });

  it("keeps the send button inert until the message box has text", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.click(screen.getByRole("button", { name: "Short text message" }));
    const send = screen.getByTestId("sos-send-custom-message");
    expect(send).toBeDisabled();

    // Whitespace alone is not a message.
    fireEvent.change(screen.getByLabelText("Short text message"), {
      target: { value: "   " },
    });
    expect(send).toBeDisabled();

    fireEvent.click(send);
    expect(onTrigger).not.toHaveBeenCalled();
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

  it("fails closed and prompts to add a contact when none are ready", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} recipients={[]} onTrigger={onTrigger} />);
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    // The button stays pressable so the press can EXPLAIN what's missing, but a
    // full hold must never actually send an SMS with zero recipients.
    expect(hold).toBeEnabled();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(3_000));
    expect(onTrigger).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "Please add at least one contact in your SMS emergency contact list.",
    );
  });

  it("does not prompt to add a contact when at least one is ready", () => {
    render(<SosPanel {...baseProps} />);
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows 'Cancel the alert' only while a session is active and calls onStopSos", () => {
    const onStopSos = vi.fn();
    const { rerender } = render(
      <SosPanel {...baseProps} active={false} onStopSos={onStopSos} />,
    );
    // Idle state: no cancel affordance, core reads "SMS".
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
    expect(screen.getByText("SMS")).toBeInTheDocument();

    // Active ("SENT · Live now") state: the cancel button appears.
    rerender(<SosPanel {...baseProps} active onStopSos={onStopSos} />);
    expect(screen.getByText("SENT")).toBeInTheDocument();
    expect(screen.getByText("Live now")).toBeInTheDocument();
    const cancel = screen.getByRole("button", {
      name: "Cancel the alert and stop sharing your location",
    });
    expect(cancel).toHaveTextContent("Cancel the alert");
    fireEvent.click(cancel);
    expect(onStopSos).toHaveBeenCalledTimes(1);
  });

  it("disables 'Cancel the alert' and shows a spinner while stopping", () => {
    const onStopSos = vi.fn();
    render(
      <SosPanel {...baseProps} active stopBusy onStopSos={onStopSos} />,
    );
    const cancel = screen.getByTestId("sos-cancel-alert");
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveTextContent("Cancelling…");
    fireEvent.click(cancel);
    expect(onStopSos).not.toHaveBeenCalled();
  });

  it("resets the core to 'SMS' once the session is no longer active (external revoke sync)", () => {
    const { rerender } = render(<SosPanel {...baseProps} active />);
    expect(screen.getByText("SENT")).toBeInTheDocument();
    // Simulate the incident being cleared elsewhere (e.g. Active shares → Stop),
    // which flips `active` back to false and must reset the SMS screen.
    rerender(<SosPanel {...baseProps} active={false} />);
    expect(screen.getByText("SMS")).toBeInTheDocument();
    expect(screen.queryByText("Live now")).toBeNull();
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
  });

  it("keeps the SMS action in one centered stack on large screens", () => {
    const { container } = render(<SosPanel {...baseProps} />);
    const screenEl = screen.getByTestId("sms-safety-screen");
    // Mobile behavior preserved: still the full-screen black overlay.
    expect(screenEl).toHaveClass("fixed", "inset-0", "bg-black");
    // The inner container keeps the mobile strip and widens only enough to
    // keep the emergency action centered beneath the title/subtitle.
    const inner = screenEl.firstElementChild as HTMLElement;
    expect(inner).toHaveClass("max-w-[407px]", "lg:max-w-[520px]");
    // The press ring + controls must not split into a desktop grid.
    expect(container.querySelector('[class*="lg:grid-cols-"]')).toBeNull();
    expect(container.querySelector('[class*="lg:grid-cols_"]')).toBeNull();
  });
});

describe("SosPanel — no editing while the alert is live", () => {
  it("closes every way of editing the message while the alert is live", () => {
    render(<SosPanel {...baseProps} active />);

    // The three ways in: two presets and the custom toggle. Cancel is the only
    // escape, so none of these may respond while an alert is out.
    expect(screen.getByRole("button", { name: "Come get me" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "I'm not safe" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Short text message" }),
    ).toBeDisabled();
    expect(screen.getByTestId("sos-cancel-alert")).toBeTruthy();
  });

  it("leaves the message editable when nothing is live", () => {
    render(<SosPanel {...baseProps} />);

    expect(
      screen.getByRole("button", { name: "Come get me" }),
    ).not.toBeDisabled();
    expect(screen.queryByTestId("sos-sent-message")).toBeNull();
  });
});
