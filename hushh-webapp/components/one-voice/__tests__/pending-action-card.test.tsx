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
});
