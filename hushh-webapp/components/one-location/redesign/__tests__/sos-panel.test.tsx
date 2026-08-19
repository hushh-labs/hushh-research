// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      // The "this browser cannot dial" explanation is a toast now, not a
      // permanent paragraph: it wrapped to four lines in a half-width grid
      // cell and buried the number it was trying to hand over. It carries the
      // number, because that is the part you can act on.
      await waitFor(() =>
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
          "112 copied",
          expect.objectContaining({
            description: expect.stringContaining(
              "Call 112 from your phone now",
            ),
          }),
        ),
      );
      // The button itself still confirms, so the state survives the toast.
      expect(screen.getByText("Copied 112")).toBeInTheDocument();
      expect(screen.getByText("Dial it from your phone")).toBeInTheDocument();
      expect(
        screen.queryByText(/Windows browsers cannot open emergency dialers/i),
      ).toBeNull();
    } finally {
      navigatorUserAgent.mockRestore();
      navigatorPlatform.mockRestore();
      if (clipboardDescriptor) {
        Object.defineProperty(
          window.navigator,
          "clipboard",
          clipboardDescriptor,
        );
      } else {
        delete (window.navigator as unknown as { clipboard?: unknown })
          .clipboard;
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

      // Header grammar shared with every other Location task flow: the <h1>
      // repeats the last breadcrumb crumb, and the top bar owns the trail.
      expect(
        screen.getByRole("heading", { level: 1, name: "Emergency help" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Hold SMS to alert your people and share your location.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("1 person will be alerted")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /call 112/i })).toHaveAttribute(
        "href",
        "tel:112",
      );
      expect(screen.getByText("India")).toBeInTheDocument();
      expect(screen.queryByText(/voice note/i)).not.toBeInTheDocument();
      // SOS renders INSIDE the signed-in shell so the top bar keeps the
      // "One › Location › SOS" breadcrumb. It must never re-open itself as a
      // fullscreen overlay, which is what hid the breadcrumb before.
      const screenEl = screen.getByTestId("sms-safety-screen");
      expect(screenEl).not.toHaveClass("fixed");
      expect(screenEl.className).not.toMatch(/\binset-0\b/);
      expect(screenEl.className).not.toMatch(/\bbg-black\b/);
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
    expect(screen.getByTestId("sos-status-label")).toHaveTextContent(
      "Hold to send location",
    );

    fireEvent.pointerDown(hold, { button: 0, pointerId: 2 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 2 });

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("sends a typed message after a continuous two-second hold on the send button", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.change(screen.getByLabelText("Add a message"), {
      target: { value: "Emergency" },
    });
    const send = screen.getByTestId("sos-send-custom-message");
    fireEvent.pointerDown(send, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(send, { pointerId: 1 });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith("Emergency");
  });

  // #5433: a typed message used to send on a single click, which made this
  // the one control on the screen where a quick accidental tap dispatched a
  // real emergency broadcast.
  it("does not send the custom message on a quick tap of the send button", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.change(screen.getByLabelText("Add a message"), {
      target: { value: "Emergency" },
    });
    const send = screen.getByTestId("sos-send-custom-message");
    fireEvent.pointerDown(send, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(send, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("does not send the custom message when the send-button hold is released early", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.change(screen.getByLabelText("Add a message"), {
      target: { value: "Emergency" },
    });
    const send = screen.getByTestId("sos-send-custom-message");
    fireEvent.pointerDown(send, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(1_500));
    fireEvent.pointerUp(send, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(1_000));

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("keeps the send button inert until the message box has text", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    const send = screen.getByTestId("sos-send-custom-message");
    expect(send).toBeDisabled();

    // Whitespace alone is not a message.
    fireEvent.change(screen.getByLabelText("Add a message"), {
      target: { value: "   " },
    });
    expect(send).toBeDisabled();

    fireEvent.pointerDown(send, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(send, { pointerId: 1 });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  // Regression: the send button's "Hold to send..." label snaps its hold
  // progress to 1 on fire, and used to only unwind once `busy` cleared with
  // `active` still false -- never true on a successful send, since `busy`
  // and `active` flip together. The label stayed stuck on screen for as
  // long as the alert stayed live.
  it("clears the send-button hold label once the alert goes live", () => {
    const onTrigger = vi.fn();
    const { rerender } = render(
      <SosPanel {...baseProps} onTrigger={onTrigger} />,
    );

    fireEvent.change(screen.getByLabelText("Add a message"), {
      target: { value: "Emergency" },
    });
    const send = screen.getByTestId("sos-send-custom-message");
    fireEvent.pointerDown(send, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(send, { pointerId: 1 });
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Parent goes busy while the request is in flight...
    rerender(<SosPanel {...baseProps} onTrigger={onTrigger} busy />);
    // ...then settles into the live state once it succeeds, same as a real
    // successful send: `busy` and `active` flip together.
    rerender(<SosPanel {...baseProps} onTrigger={onTrigger} active />);

    expect(screen.queryByText(/Hold to send…/)).toBeNull();
  });

  it("passes the selected fixed message and opens contacts from the Emergency contacts row", () => {
    const onTrigger = vi.fn();
    const onEditContacts = vi.fn();
    render(
      <SosPanel
        {...baseProps}
        onTrigger={onTrigger}
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

    fireEvent.click(screen.getByRole("button", { name: /will be alerted/i }));
    expect(onEditContacts).toHaveBeenCalledTimes(1);
  });

  it("counts the message to 140 characters and fails closed above the limit", () => {
    render(<SosPanel {...baseProps} />);

    // The design keeps one always-visible field; there is no separate
    // "write a message" toggle to open first.
    const composer = screen.getByRole("textbox", { name: "Add a message" });
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });

    // An empty field shows no counter — "0/140" is not information worth
    // printing before anyone has typed a character.
    expect(screen.queryByText("0/140")).toBeNull();
    expect(hold).toBeEnabled();

    fireEvent.change(composer, { target: { value: "a".repeat(140) } });
    expect(screen.getByText("140/140")).toBeInTheDocument();
    expect(hold).toBeEnabled();
    expect(screen.queryByText("Message is too long")).toBeNull();

    fireEvent.change(composer, { target: { value: "a".repeat(141) } });
    expect(screen.getByText("141/140")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Message is too long");
    expect(hold).toBeDisabled();

    // Picking a preset replaces the over-length text, which clears the block.
    fireEvent.click(screen.getByRole("button", { name: "Come get me" }));
    expect(composer).toHaveValue("Come get me");
    expect(hold).toBeEnabled();
  });

  it("sends a valid custom short message exactly once after the hold", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Add a message" }), {
      target: { value: "  Meet me by the north entrance.  " },
    });

    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith("Meet me by the north entrance.");
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

  it("shows 'Stop sharing' only while a session is active and calls onStopSos", () => {
    const onStopSos = vi.fn();
    const { rerender } = render(
      <SosPanel {...baseProps} active={false} onStopSos={onStopSos} />,
    );
    // Idle: no stop affordance, the core is the pressable SMS control.
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
    expect(screen.getByText("SMS")).toBeInTheDocument();
    expect(screen.queryByTestId("sos-sent-face")).toBeNull();

    // Live: the core becomes a receipt and the stop button appears.
    rerender(<SosPanel {...baseProps} active onStopSos={onStopSos} />);
    expect(screen.getByTestId("sos-sent-face")).toBeInTheDocument();
    expect(screen.getByText("SENT")).toBeInTheDocument();
    expect(screen.getByTestId("sos-status-label")).toHaveTextContent(
      "Live location",
    );
    const cancel = screen.getByRole("button", {
      name: "Cancel the alert and stop sharing your location",
    });
    expect(cancel).toHaveTextContent("Stop sharing");
    fireEvent.click(cancel);
    expect(onStopSos).toHaveBeenCalledTimes(1);
  });

  it("disables 'Stop sharing' and shows a spinner while stopping", () => {
    const onStopSos = vi.fn();
    render(<SosPanel {...baseProps} active stopBusy onStopSos={onStopSos} />);
    const cancel = screen.getByTestId("sos-cancel-alert");
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveTextContent("Stopping…");
    fireEvent.click(cancel);
    expect(onStopSos).not.toHaveBeenCalled();
  });

  it("returns the core to SMS once the session is no longer active (external revoke sync)", () => {
    const { rerender } = render(<SosPanel {...baseProps} active />);
    expect(screen.getByTestId("sos-sent-face")).toBeInTheDocument();
    // Simulate the incident being cleared elsewhere (e.g. Active shares → Stop),
    // which flips `active` back to false and must reset the SMS screen.
    rerender(<SosPanel {...baseProps} active={false} />);
    expect(screen.getByText("SMS")).toBeInTheDocument();
    expect(screen.queryByTestId("sos-sent-face")).toBeNull();
    expect(screen.getByTestId("sos-status-label")).toHaveTextContent(
      "Hold to send location",
    );
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
  });

  it("puts the emergency number and Stop sharing in ONE row, number left", () => {
    // They used to be stacked, which put two unrelated decisions on the axis
    // the eye reads as a sequence and buried the dialer under a control that
    // only exists once an alert is already running.
    // jsdom's default UA trips the Windows copy fallback, which swaps the
    // <a tel:> for a copy button. The row is the same either way; pin the
    // real dialer so this is testing the layout and not the fallback.
    const navigatorUserAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    const navigatorPlatform = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Linux x86_64");
    try {
    render(<SosPanel {...baseProps} active onStopSos={vi.fn()} />);

    const row = screen.getByTestId("sos-emergency-actions");
    const dialer = screen.getByRole("link", {
      name: "Call 112 emergency services (India)",
    });
    const stop = screen.getByTestId("sos-cancel-alert");

    // One row: both controls are inside it, and nothing else claims them.
    expect(row).toContainElement(dialer);
    expect(row).toContainElement(stop);
    expect(row.className).toContain("justify-between");
    // Number LEFT, Stop sharing RIGHT.
    expect(
      dialer.compareDocumentPosition(stop) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // `flex-wrap` is the narrow-screen escape hatch rather than a breakpoint,
    // and neither control may shrink when it fires.
    expect(row.className).toContain("flex-wrap");
    expect(stop.className).toContain("shrink-0");
    } finally {
      navigatorUserAgent.mockRestore();
      navigatorPlatform.mockRestore();
    }
  });

  it("centres the dialer when there is no alert to sit opposite", () => {
    render(<SosPanel {...baseProps} active={false} />);
    const row = screen.getByTestId("sos-emergency-actions");
    expect(row.className).toContain("justify-center");
    expect(row.className).not.toContain("justify-between");
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
  });

  it("keeps the SOS action in one centered stack on large screens", () => {
    const { container } = render(<SosPanel {...baseProps} />);
    // The press ring + controls must not split into a desktop grid. Width is
    // owned by the shell's AppPageShell container, not by this panel.
    expect(container.querySelector('[class*="lg:grid-cols-"]')).toBeNull();
    expect(container.querySelector('[class*="lg:grid-cols_"]')).toBeNull();
  });
});

describe("SosPanel — shell header contract", () => {
  // The regression this locks: SOS used to paint itself over the whole
  // viewport, which removed the top-bar breadcrumb and forced a second back
  // arrow into the content. Every Location task flow renders inside the shell
  // and lets the top bar own the single back control.
  it("renders inside the shell instead of a fullscreen overlay", () => {
    render(<SosPanel {...baseProps} />);
    const screenEl = screen.getByTestId("sms-safety-screen");

    expect(screenEl.className).not.toMatch(/\bfixed\b/);
    expect(screenEl.className).not.toMatch(/\binset-0\b/);
    expect(screenEl.className).not.toMatch(/\bz-\[/);
    expect(screenEl.className).not.toMatch(/\b(min-)?h-\[100dvh\]/);
  });

  it("titles the screen with the same words as its breadcrumb crumb", () => {
    render(<SosPanel {...baseProps} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Emergency help" }),
    ).toBeInTheDocument();
  });

  it("keeps the Emergency contacts action reachable above the SOS button", () => {
    const onEditContacts = vi.fn();
    render(<SosPanel {...baseProps} onEditContacts={onEditContacts} />);

    fireEvent.click(screen.getByRole("button", { name: /will be alerted/i }));
    expect(onEditContacts).toHaveBeenCalledTimes(1);
  });

  it("exposes no in-content back control — the top bar owns back", () => {
    render(<SosPanel {...baseProps} />);

    expect(screen.queryByRole("button", { name: /^back/i })).toBeNull();
    expect(screen.queryByLabelText("Back to Location")).toBeNull();
  });

  // #5253/#5251 removed the in-content back button; this redesign goes
  // further and drops the in-content Cancel too, since a second exit next to
  // a real emergency control invites the wrong tap under stress. The shell's
  // single back control is the only way out, same as every other Location
  // screen — `onClose` stays in the props contract (see SosPanelProps) but
  // the panel itself no longer wires it to a visible control.
  it("draws no in-content Cancel control — the shell's back control is the only exit", () => {
    render(<SosPanel {...baseProps} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("declares no inline <style> block — motion lives in globals.css", () => {
    const { container } = render(<SosPanel {...baseProps} />);
    expect(container.querySelector("style")).toBeNull();
  });
});

describe("SosPanel — no editing while the alert is live", () => {
  it("closes every way of editing the message while the alert is live", () => {
    render(<SosPanel {...baseProps} active />);

    // The ways in: the two presets and the message field. Stopping the alert is
    // the only escape, so none of these may respond while an alert is out.
    expect(screen.getByRole("button", { name: "Come get me" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "I'm not safe" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Add a message" }),
    ).toHaveAttribute("readonly");
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
