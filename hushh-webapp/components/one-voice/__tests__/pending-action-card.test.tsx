import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PendingActionCard,
  formatCountdown,
  pendingActionInstruction,
  pendingActionRole,
  resolvedLabel,
} from "@/components/one-voice/pending-action-card";
import type { PendingActionView } from "@/lib/one-voice/session-types";

const NOW = Date.parse("2026-09-15T10:00:00.000Z");

function pending(
  overrides: Partial<PendingActionView> = {},
): PendingActionView {
  return {
    pending_action_id: "pa_SECRET_0f9e8d7c",
    tool: "share_with",
    gateway_action_id: "location.share_selected",
    tier: "voice",
    summary: "Share your location with Priya Sharma for 1 hour",
    args: { person: { user_id: "usr_SECRET_priya" }, duration_hours: 1 },
    status: "pending",
    shown_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 90_000).toISOString(),
    result: null,
    riskLevel: "medium",
    requiresTap: false,
    entities: [
      {
        kind: "person",
        user_id: "usr_SECRET_priya",
        display_name: "Priya Sharma",
        relationship: "connected",
        has_location_key: true,
      },
    ],
    receiptToken: "rt_SECRET_token",
    resolvedStatus: null,
    resolvedResult: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PendingActionCard", () => {
  it("says 'Say yes, or tap Confirm' for a voice-tier action", () => {
    render(
      <PendingActionCard
        action={pending()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("one-voice-pending-instruction"),
    ).toHaveTextContent("Say yes, or tap Confirm");
    expect(pendingActionInstruction({ requiresTap: false })).toBe(
      "Say yes, or tap Confirm",
    );
  });

  it("says 'Tap Confirm to continue' when requires_tap is set", () => {
    render(
      <PendingActionCard
        action={pending({
          tier: "tap",
          requiresTap: true,
          tool: "accept_location_setup_consent",
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("one-voice-pending-instruction"),
    ).toHaveTextContent("Tap Confirm to continue");
    expect(pendingActionInstruction({ requiresTap: true })).toBe(
      "Tap Confirm to continue",
    );
  });

  it("focuses the card on mount and makes Cancel the first tab stop", () => {
    render(
      <PendingActionCard
        action={pending()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const card = screen.getByTestId("one-voice-pending-action");
    expect(card).toHaveFocus();
    const focusable = Array.from(
      card.querySelectorAll<HTMLElement>(
        "button, [href], input, [tabindex]:not([tabindex='-1'])",
      ),
    );
    expect(focusable[0]).toBe(screen.getByTestId("one-voice-pending-cancel"));
    expect(focusable[1]).toBe(screen.getByTestId("one-voice-pending-confirm"));
  });

  it("never renders the pending id, the receipt token, or an entity's user id", () => {
    const { container } = render(
      <PendingActionCard
        action={pending()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain("pa_SECRET_0f9e8d7c");
    expect(container.textContent).not.toContain("usr_SECRET_priya");
    expect(container.textContent).not.toContain("rt_SECRET_token");
    expect(container.innerHTML).not.toContain("rt_SECRET_token");
    expect(container.innerHTML).not.toContain("usr_SECRET_priya");
    expect(screen.getByTestId("one-voice-entity-name")).toHaveTextContent(
      "Priya Sharma",
    );
  });

  it("wires Confirm and Cancel and shows the spinner while busy", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <PendingActionCard
        action={pending()}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("one-voice-pending-confirm"));
    fireEvent.click(screen.getByTestId("one-voice-pending-cancel"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.rerender(
      <PendingActionCard
        action={pending()}
        onConfirm={onConfirm}
        onCancel={onCancel}
        busy
      />,
    );
    expect(screen.getByTestId("one-voice-pending-cancel")).toBeDisabled();
    expect(
      screen.getByTestId("one-voice-pending-confirm").getAttribute("aria-busy"),
    ).not.toBe("false");
  });

  it("counts down to expires_at and disables Confirm once expired", () => {
    render(
      <PendingActionCard
        action={pending()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("one-voice-pending-countdown")).toHaveTextContent(
      "1:30",
    );
    act(() => {
      // advanceTimersByTime also moves the fake clock by one second.
      vi.setSystemTime(NOW + 59_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("one-voice-pending-countdown")).toHaveTextContent(
      "0:30",
    );
    act(() => {
      vi.setSystemTime(NOW + 90_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("one-voice-pending-countdown")).toHaveTextContent(
      "Expired",
    );
    expect(screen.getByTestId("one-voice-pending-confirm")).toBeDisabled();
    expect(formatCountdown(65_000)).toBe("1:05");
  });

  it("uses the danger role for destructive tap-tier tools only", () => {
    expect(pendingActionRole({ tool: "delete_circle", tier: "tap" })).toBe(
      "danger",
    );
    expect(
      pendingActionRole({ tool: "trigger_save_my_soul", tier: "tap" }),
    ).toBe("danger");
    expect(
      pendingActionRole({ tool: "accept_location_setup_consent", tier: "tap" }),
    ).toBe("action");
    expect(pendingActionRole({ tool: "share_with", tier: "voice" })).toBe(
      "action",
    );
    render(
      <PendingActionCard
        action={pending({
          tool: "delete_circle",
          tier: "tap",
          requiresTap: true,
          summary: "Delete the Family circle",
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("one-voice-pending-confirm").className).toContain(
      "var(--app-destructive)",
    );
  });

  it("shows the resolved state without buttons, and Done only for executed", () => {
    const view = render(
      <PendingActionCard
        action={pending({ resolvedStatus: "executed", status: "executed" })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Done",
    );
    expect(screen.queryByTestId("one-voice-pending-confirm")).toBeNull();
    expect(screen.queryByTestId("one-voice-pending-cancel")).toBeNull();
    view.rerender(
      <PendingActionCard
        action={pending({ resolvedStatus: "failed", status: "failed" })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Didn't go through",
    );
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("an armed Save My Soul says it is sending the position, never Done", () => {
    const sos = (
      resolvedStatus: "executed" | "failed",
      result: Record<string, unknown>,
    ) =>
      pending({
        tool: "trigger_save_my_soul",
        gateway_action_id: "location.trigger_sos",
        tier: "tap",
        requiresTap: true,
        summary: "Send a Save My Soul alert to Priya Sharma",
        entities: [],
        status: resolvedStatus,
        resolvedStatus,
        resolvedResult: { status: "unused", ...result },
      });
    const { container, rerender } = render(
      <PendingActionCard
        action={sos("executed", {
          status: "sos_grants_created",
          grant_ids: ["grant_SECRET"],
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const card = screen.getByTestId("one-voice-pending-action");
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Armed · sending your position",
    );
    expect(card).toHaveAttribute("data-outcome", "pending");
    expect(card).toHaveAttribute(
      "aria-label",
      "Action armed · sending your position",
    );
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).not.toMatch(/\bSent\b/);
    expect(container.textContent).not.toContain("grant_SECRET");
    expect(screen.queryByTestId("one-voice-pending-confirm")).toBeNull();

    const cases: Array<
      ["executed" | "failed", string, string, "success" | "neutral"]
    > = [
      ["executed", "sos_sent", "Sent", "success"],
      ["executed", "sos_partial", "Partly sent", "neutral"],
      ["failed", "sos_not_sent", "Not sent", "neutral"],
      ["failed", "sos_unverified", "Couldn't confirm delivery", "neutral"],
      ["executed", "sos_stopped", "Stopped", "success"],
      ["executed", "sos_partially_stopped", "Partly stopped", "neutral"],
    ];
    for (const [resolved, status, label, kind] of cases) {
      rerender(
        <PendingActionCard
          action={sos(resolved, { status })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(
        screen.getByTestId("one-voice-pending-resolved"),
        status,
      ).toHaveTextContent(label);
      expect(
        screen.getByTestId("one-voice-pending-action"),
        status,
      ).toHaveAttribute("data-outcome", kind);
      expect(screen.queryByText("Done"), status).toBeNull();
    }
  });

  it("an armed alert the session dropped reads unconfirmed, not Sent and not Not sent", () => {
    const { container } = render(
      <PendingActionCard
        action={pending({
          tool: "trigger_save_my_soul",
          tier: "tap",
          requiresTap: true,
          summary: "Send a Save My Soul alert to Priya Sharma",
          entities: [],
          status: "executed",
          resolvedStatus: "executed",
          resolvedResult: {
            status: "sos_unverified",
            reason_code: "client_session_closed",
            spoken_facts: [
              "The connection dropped before delivery was confirmed. Ask 'did it go through?' or check Save My Soul.",
            ],
          },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Couldn't confirm delivery",
    );
    expect(screen.getByTestId("one-voice-pending-action")).toHaveAttribute(
      "data-outcome",
      "neutral",
    );
    expect(container.textContent).not.toMatch(/\bSent\b|Not sent|sending|Done/);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("emergency-contact cards say what changed: Added/Removed only for added/removed", () => {
    const contact = (
      tool: string,
      status: string,
      resolvedStatus: "executed" | "failed" = "executed",
    ) =>
      pending({
        tool,
        tier: "tap",
        requiresTap: true,
        summary: "Add Priya Sharma as an emergency contact",
        status: resolvedStatus,
        resolvedStatus,
        resolvedResult: { status, display_name: "Priya Sharma" },
      });
    const cases: Array<[string, string, string, "success" | "neutral"]> = [
      ["add_emergency_contact", "added", "Added", "success"],
      ["add_emergency_contact", "roster_full", "Not added", "neutral"],
      ["add_emergency_contact", "not_phone_verified", "Not added", "neutral"],
      ["add_emergency_contact", "not_connected", "Not added", "neutral"],
      ["add_emergency_contact", "already_contact", "Not added", "neutral"],
      ["remove_emergency_contact", "removed", "Removed", "success"],
      ["remove_emergency_contact", "not_a_contact", "No change", "neutral"],
    ];
    for (const [tool, status, label, kind] of cases) {
      const view = render(
        <PendingActionCard
          action={contact(tool, status)}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const resolved = screen.getByTestId("one-voice-pending-resolved");
      expect(resolved, `${tool}/${status}`).toHaveTextContent(label);
      expect(
        screen.getByTestId("one-voice-pending-action"),
        `${tool}/${status}`,
      ).toHaveAttribute("data-outcome", kind);
      expect(screen.queryByText("Done"), `${tool}/${status}`).toBeNull();
      // The success check marks only a real addition or removal.
      expect(
        resolved.querySelector("svg") !== null,
        `${tool}/${status} check`,
      ).toBe(kind === "success");
      view.unmount();
    }
    // A failed resolution keeps the ordinary failure label.
    expect(
      resolvedLabel({
        tool: "add_emergency_contact",
        resolvedStatus: "failed",
        resolvedResult: { status: "rejected" },
      }),
    ).toEqual({ label: "Didn't go through", kind: "neutral" });
    // Any executed action whose result is a truthful "nothing changed" is not Done.
    expect(
      resolvedLabel({
        tool: "turn_sharing_off",
        resolvedStatus: "executed",
        resolvedResult: { status: "already_off" },
      }),
    ).toEqual({ label: "No change", kind: "neutral" });
    expect(
      resolvedLabel({
        tool: "stop_share",
        resolvedStatus: "executed",
        resolvedResult: { status: "not_active" },
      }),
    ).toEqual({ label: "No change", kind: "neutral" });
    expect(
      resolvedLabel({
        tool: "delete_circle",
        resolvedStatus: "executed",
        resolvedResult: { status: "deleted" },
      }),
    ).toEqual({ label: "Done", kind: "success" });
  });

  it("derives the resolved label from the result status only for Save My Soul", () => {
    expect(
      resolvedLabel({
        resolvedStatus: "executed",
        resolvedResult: { status: "sos_grants_created" },
      }),
    ).toEqual({ label: "Armed · sending your position", kind: "pending" });
    // A mis-flagged sos_sent on a failed resolution is not a success.
    expect(
      resolvedLabel({
        resolvedStatus: "failed",
        resolvedResult: { status: "sos_sent" },
      }),
    ).toEqual({ label: "Sent", kind: "neutral" });
    expect(
      resolvedLabel({
        resolvedStatus: "executed",
        resolvedResult: { status: "share_created" },
      }),
    ).toEqual({ label: "Done", kind: "success" });
    expect(
      resolvedLabel({ resolvedStatus: "executed", resolvedResult: null }),
    ).toEqual({ label: "Done", kind: "success" });
    expect(
      resolvedLabel({
        resolvedStatus: "cancelled",
        resolvedResult: null,
      }),
    ).toEqual({ label: "Cancelled", kind: "neutral" });
    expect(
      resolvedLabel({ resolvedStatus: null, resolvedResult: null }),
    ).toBeNull();
  });
});
