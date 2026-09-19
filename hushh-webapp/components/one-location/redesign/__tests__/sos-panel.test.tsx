// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import { isSosShareReadyRecipient } from "@/lib/one-location/sos-trigger";
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
  it("renders the Save My Soul workflow without an emergency call control", () => {
    render(<SosPanel {...baseProps} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Save My Soul" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 contact · Live location")).toBeInTheDocument();
    expect(screen.queryByText(/Call 112/i)).toBeNull();
    expect(screen.queryByTestId("sos-emergency-actions")).toBeNull();
    expect(screen.queryByText(/voice note/i)).toBeNull();
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
      "Hold 2 seconds",
    );

    fireEvent.pointerDown(hold, { button: 0, pointerId: 2 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 2 });

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("keeps typed messages staged until the hold completes", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);

    fireEvent.change(screen.getByLabelText("Add a message"), {
      target: { value: "Emergency" },
    });

    expect(screen.queryByTestId("sos-send-custom-message")).toBeNull();
    expect(onTrigger).not.toHaveBeenCalled();

    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(hold, { pointerId: 1 });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith("Emergency");
  });

  it("passes the selected fixed message and exposes emergency contacts edit", () => {
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

    fireEvent.click(
      screen.getByRole("button", { name: "Edit emergency contacts" }),
    );
    expect(onEditContacts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("counts the message to 140 characters and fails closed above the limit", () => {
    render(<SosPanel {...baseProps} />);

    // The design keeps one always-visible field; there is no separate
    // "write a message" toggle to open first.
    const composer = screen.getByRole("textbox", { name: "Add a message" });
    const hold = screen.getByRole("button", {
      name: /press and hold for two seconds/i,
    });

    // An empty field is a valid alert: the payload is the location.
    expect(screen.queryByText("0/140")).toBeNull();
    fireEvent.focus(composer);
    expect(screen.getByText("0/140")).toBeInTheDocument();
    expect(hold).toBeEnabled();

    fireEvent.change(composer, { target: { value: "a".repeat(140) } });
    expect(screen.getByText("140/140")).toBeInTheDocument();
    expect(hold).toBeEnabled();
    expect(screen.queryByText("Message is too long")).toBeNull();

    fireEvent.change(composer, { target: { value: "a".repeat(141) } });
    expect(screen.getByText("141/140")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Message is too long",
    );
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
    expect(screen.queryByRole("button", {
      name: /press and hold for two seconds/i,
    })).toBeNull();
    expect(screen.getByText("No emergency contacts")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add emergency contacts" }),
    ).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(onTrigger).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not flash the empty state while the SMS Circle roster is refreshing", () => {
    const { rerender } = render(
      <SosPanel {...baseProps} recipients={[]} recipientsLoading />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Updating your SMS Circle",
    );
    expect(screen.queryByText("No emergency contacts")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add emergency contacts" }),
    ).toBeNull();

    rerender(<SosPanel {...baseProps} recipients={[]} recipientsLoading={false} />);
    expect(screen.getByText("No emergency contacts")).toBeInTheDocument();
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

  it("shows 'Stop alert' only while a session is active and confirms onStopSos", () => {
    const onStopSos = vi.fn();
    const { rerender } = render(
      <SosPanel {...baseProps} active={false} onStopSos={onStopSos} />,
    );
    // Idle: no stop affordance, the core is the pressable SOS control.
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
    expect(screen.getByText("SMS")).toBeInTheDocument();
    expect(screen.queryByTestId("sos-sent-face")).toBeNull();

    // Live: the core becomes a receipt and the stop button appears.
    rerender(<SosPanel {...baseProps} active onStopSos={onStopSos} />);
    expect(screen.getByTestId("sos-sent-face")).toBeInTheDocument();
    expect(screen.getByText("SENT")).toBeInTheDocument();
    expect(screen.getByTestId("sos-status-label")).toHaveTextContent(
      "Alert active",
    );
    const cancel = screen.getByRole("button", {
      name: "Stop Save My Soul alert",
    });
    expect(cancel).toHaveTextContent("Stop alert");
    fireEvent.click(cancel);
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Stop Save My Soul alert?",
      }),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop alert" }));
    expect(onStopSos).toHaveBeenCalledTimes(1);
  });

  it("disables 'Stop alert' and shows a spinner while stopping", () => {
    const onStopSos = vi.fn();
    render(<SosPanel {...baseProps} active stopBusy onStopSos={onStopSos} />);
    const cancel = screen.getByTestId("sos-cancel-alert");
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveTextContent("Stopping...");
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
      "Hold 2 seconds",
    );
    expect(screen.queryByTestId("sos-cancel-alert")).toBeNull();
  });

  it("keeps the emergency call control removed in idle and active states", () => {
    const { rerender } = render(<SosPanel {...baseProps} active={false} />);
    expect(screen.queryByTestId("sos-emergency-actions")).toBeNull();
    rerender(<SosPanel {...baseProps} active />);
    expect(screen.queryByTestId("sos-emergency-actions")).toBeNull();
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
      screen.getByRole("heading", { level: 1, name: "Save My Soul" }),
    ).toBeInTheDocument();
  });

  it("keeps the contacts action reachable in the emergency contacts row", () => {
    const onEditContacts = vi.fn();
    render(<SosPanel {...baseProps} onEditContacts={onEditContacts} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Edit emergency contacts" }),
    );
    expect(onEditContacts).toHaveBeenCalledTimes(1);
  });

  it("exposes no in-content back control — the top bar owns back", () => {
    render(<SosPanel {...baseProps} />);

    expect(screen.queryByRole("button", { name: /^back/i })).toBeNull();
    expect(screen.queryByLabelText("Back to Location")).toBeNull();
  });

  it("does not render a body Cancel control; top shell owns back", () => {
    const onClose = vi.fn();
    render(<SosPanel {...baseProps} onClose={onClose} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "Come get me" })).toBeNull();
    expect(screen.queryByRole("button", { name: "I'm not safe" })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Add a message" }),
    ).toBeNull();
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

describe("SosPanel — readiness predicate", () => {
  // The hub's ordinary predicate ignores the phone claim; the trigger refuses
  // a contact without one. The panel must count and enable from the same rule
  // the trigger applies, or it offers a hold that reaches nobody.
  const keyed = recipient({
    userId: "u2",
    displayName: "Dev",
    phoneVerified: false,
    keyId: "k2",
    publicKeyJwk: { kty: "EC" },
    canReceiveLocation: true,
  });

  it("fails closed for a keyed contact whose phone is not verified when given the SOS rule", () => {
    const onTrigger = vi.fn();
    render(
      <SosPanel
        {...baseProps}
        recipients={[keyed]}
        isRecipientShareReady={isSosShareReadyRecipient}
        onTrigger={onTrigger}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /press and hold for two seconds/i }),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("the Location page hands the SOS rule to the panel through the hub", () => {
    const page = fs.readFileSync(
      path.resolve(__dirname, "../../../../app/one/location/page.tsx"),
      "utf8",
    );
    const hub = fs.readFileSync(
      path.resolve(__dirname, "../location-redesign-hub.tsx"),
      "utf8",
    );
    expect(page).toContain(
      "isSosRecipientShareReady: isSosShareReadyRecipient",
    );
    const panelProps = hub.slice(hub.indexOf("<SosPanel"));
    expect(panelProps).toContain(
      "vm.isSosRecipientShareReady ?? vm.isRecipientShareReady",
    );
  });
});
