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
});
