import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MapPin } from "lucide-react";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { FeedSmsAlertGroup } from "@/components/feed/feed-sms-alert-group";
import { groupFeedSmsAlerts } from "@/lib/feed/feed-sms-grouping";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

function actionable(overrides: Partial<FeedActionable> = {}): FeedActionable {
  return {
    id: "a-1",
    icon: MapPin,
    iconTone: "blue",
    title: "Row title",
    description: "Row description",
    actions: [],
    sortAt: 0,
    ...overrides,
  };
}

describe("FeedActionableRow", () => {
  it("groups repeat SMS by sender identity and preserves every incident's sent time and live link", () => {
    const base = actionable({ title: "Same name", person: { displayName: "Same name", photoUrl: null }, smsEmergency: { senderId: "sender-a" }, description: "Emergency SMS · Revoked", displayTimestamp: Date.parse("2026-08-12T09:00:00Z"), sortAt: 1 });
    const active = { ...base, id: "active", emphasis: "emergency" as const, description: "Emergency SMS · Active", href: "/one/location?grantId=active&open=1&section=shared", chevron: true, sortAt: 2 };
    const groups = groupFeedSmsAlerts([base, active, active, { ...base, id: "other", smsEmergency: { senderId: "sender-b" } }, { ...base, id: "unknown-a", smsEmergency: { senderId: "" } }, { ...base, id: "unknown-b", smsEmergency: { senderId: "" } }]);
    expect(groups).toHaveLength(4);
    const group = groups.find((entry) => entry.id === "sender-a")!;
    expect(group.items.map((item) => item.id)).toEqual(["active", "a-1"]);
    expect(group.activeCount).toBe(1);
    const { container } = render(<FeedSmsAlertGroup group={group} />);
    expect(screen.getByText("2 recent SMS alerts · 1 active")).toBeVisible();
    const disclosure = container.querySelector("details")!;
    fireEvent.click(container.querySelector("summary")!);
    // jsdom does not implement native details toggling; browser geometry and
    // keyboard disclosure are covered by the real-component layout fixture.
    disclosure.open = true;
    expect(screen.getByRole("link", { name: /Same name.*Emergency SMS · Active/ })).toHaveAttribute("href", active.href);
    expect(container.querySelectorAll('time[datetime="2026-08-12T09:00:00.000Z"]')).toHaveLength(3);
    expect(screen.getByText("Emergency SMS · Revoked")).toBeInTheDocument();
  });

  it("keeps SMS sent time in the text column and never invents a missing time", () => {
    const { container, rerender } = render(<FeedActionableRow item={actionable({ smsEmergency: { senderId: "sender-a" }, displayTimestamp: Date.parse("2026-08-12T09:00:00Z") })} />);
    const stamp = container.querySelector("time")!;
    expect(stamp).toHaveAttribute("datetime", "2026-08-12T09:00:00.000Z");
    expect(stamp.textContent).toContain("2026");
    expect(stamp.closest('[data-slot="settings-row-title"]')).not.toBeNull();
    rerender(<FeedActionableRow item={actionable({ smsEmergency: { senderId: "sender-a" }, displayTimestamp: null })} />);
    expect(screen.getByText("Sent time unavailable")).toBeInTheDocument();
    expect(container.querySelector("time")).toBeNull();
  });
  it("renders emergency SMS with the sender avatar instead of a separate alert icon", () => {
    render(
      <FeedActionableRow
        item={actionable({
          emphasis: "emergency",
          title: "Mom sent an SMS",
          description: "Emergency SMS — sharing live location with you now.",
          person: {
            displayName: "Mom",
            photoUrl: "https://cdn.example.test/mom.jpg",
          },
          href: "/one/location?grantId=g1&open=1&section=shared",
          chevron: true,
        })}
      />,
    );

    const avatar = screen.getByTestId("feed-actionable-avatar");
    expect(avatar).toHaveAttribute(
      "data-photo-url",
      "https://cdn.example.test/mom.jpg",
    );
    expect(screen.queryByTestId("feed-sms-emergency")).toBeNull();
    expect(screen.getByText("Mom sent an SMS")).toBeInTheDocument();
  });

  it("shows a small green live dot before the description on a live SOS card only", () => {
    const { container: liveContainer } = render(
      <FeedActionableRow
        item={actionable({
          emphasis: "emergency",
          title: "Mom sent an SMS",
          description: "Emergency SMS - Sent.",
          person: { displayName: "Mom", photoUrl: null },
        })}
      />,
    );
    expect(liveContainer.querySelector(".bg-emerald-500")).not.toBeNull();

    const { container: revokedContainer } = render(
      <FeedActionableRow
        item={actionable({
          title: "Mom sent an SMS",
          description: "Emergency SMS - Revoked",
          person: { displayName: "Mom", photoUrl: null },
        })}
      />,
    );
    expect(revokedContainer.querySelector(".bg-emerald-500")).toBeNull();
  });

  it("renders a routine actionable without the emergency frame", () => {
    render(<FeedActionableRow item={actionable({ title: "Routine row" })} />);

    expect(screen.queryByTestId("feed-sms-emergency")).toBeNull();
    expect(screen.getByText("Routine row")).toBeInTheDocument();
  });

  it("opens the existing full review without deciding the request", () => {
    const openDetails = vi.fn();
    const allow = vi.fn();
    const deny = vi.fn();
    render(<FeedActionableRow item={actionable({
      onSelect: openDetails,
      phoneActions: [{ key: "review", label: "Review", tone: "primary", run: openDetails }],
      actions: [
        { key: "deny", label: "Don't allow", tone: "ghost", run: deny },
        { key: "allow", label: "Allow", tone: "primary", run: allow },
      ],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Review", exact: true }));
    expect(openDetails).toHaveBeenCalledTimes(1);
    expect(allow).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it("renders a simple upcoming item in the compact Feed rhythm", () => {
    render(
      <FeedActionableRow
        item={actionable({
          id: "calendar:event-1",
          title: "Team standup",
          description: "All day",
          displayTimestamp: Date.parse("2026-08-12T15:45:00.000Z"),
          href: "/one/calendar",
          chevron: true,
        })}
      />,
    );

    const row = screen.getByTestId("feed-actionable-calendar:event-1");
    expect(row).toHaveAttribute("data-row-layout", "settings");
    expect(row.querySelector('[data-profile-role="name"]')).toHaveTextContent("Team standup");
    expect(row.querySelector('[data-slot="feed-domain-icon"] svg'))
      .toHaveAttribute("viewBox", "0 0 24 24");
    expect(row.querySelector('[data-slot="feed-event-time"]')).toBeInTheDocument();
    expect(row.querySelector('[data-slot="feed-event-description"]'))
      .toHaveTextContent("All day");
  });

  it("keeps the single Join action separate from the compact row action", () => {
    const onSelect = vi.fn();
    const join = vi.fn();
    render(
      <FeedActionableRow
        item={actionable({
          id: "calendar:event-2",
          title: "Hushh night",
          description: "Starting soon",
          onSelect,
          actions: [{ key: "join-meet", label: "Join Meet", tone: "primary", run: join }],
        })}
      />,
    );

    const row = screen.getByTestId("feed-actionable-calendar:event-2");
    expect(row).toHaveAttribute("data-row-layout", "settings");
    fireEvent.click(screen.getByText("Hushh night"));
    expect(onSelect).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Join Meet" }));
    expect(join).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(row.querySelector("button button")).toBeNull();
  });

  it("keeps trailing actions outside a whole-row button or link", () => {
    const action = {
      key: "review",
      label: "Review",
      tone: "primary" as const,
      run: vi.fn(),
    };
    const { container, rerender } = render(
      <FeedActionableRow
        item={actionable({
          href: "/one/consents",
          actions: [action],
        })}
      />,
    );

    expect(container.querySelector("a button")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();

    rerender(
      <FeedActionableRow
        item={actionable({
          href: null,
          onSelect: vi.fn(),
          actions: [{ ...action, key: "cancel", label: "Cancel" }],
        })}
      />,
    );

    expect(container.querySelector("button button")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("draws Accept and Decline as a check and a cross beside the request", async () => {
    const accept = vi.fn();
    const decline = vi.fn();
    render(
      <FeedActionableRow
        item={actionable({
          id: "connection:request-1",
          actions: [
            { key: "accept", label: "Accept", tone: "primary", run: accept },
            { key: "decline", label: "Decline", tone: "danger", confirm: true, run: decline },
          ],
        })}
      />,
    );

    const row = screen.getByTestId("feed-actionable-connection:request-1");
    // One compact row: the actions live in the trailing column, not on a line below.
    expect(row).toHaveAttribute("data-row-layout", "settings");
    expect(row.querySelector('[data-slot="settings-row-trailing"]')).not.toHaveClass("w-full", "pt-1");
    expect(screen.getByTestId("feed-action-buttons")).toHaveClass("flex-nowrap", "justify-end");

    // Icon-only controls keep their names, and each is its own 44px target.
    const acceptButton = screen.getByRole("button", { name: "Accept" });
    const declineButton = screen.getByRole("button", { name: "Decline (tap again to confirm)" });
    for (const button of [acceptButton, declineButton]) {
      expect(button).toHaveClass("!size-11");
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button).not.toHaveTextContent(/\S/);
    }
    expect(acceptButton.parentElement).toBe(declineButton.parentElement);

    // Accept answers at once; Decline is still the two-tap confirmation.
    fireEvent.click(acceptButton);
    expect(accept).toHaveBeenCalledOnce();
    // The row unlocks once Accept settles; only then can Decline arm.
    await act(async () => {});
    fireEvent.click(declineButton);
    expect(decline).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Confirm Decline" });
    expect(armed).toHaveTextContent("Sure?");
    fireEvent.click(armed);
    expect(decline).toHaveBeenCalledOnce();
  });

  it("leaves out the supporting line when a row has nothing to add", () => {
    render(
      <FeedActionableRow
        item={actionable({
          id: "gmail-needs-reply",
          title: "10 messages need your reply",
          description: "",
          actions: [{ key: "open-mail", label: "Open Mail", tone: "primary", run: vi.fn() }],
        })}
      />,
    );
    const row = screen.getByTestId("feed-actionable-gmail-needs-reply");
    expect(row).toHaveTextContent("10 messages need your reply");
    expect(row.querySelector('[data-slot="feed-event-description"]')).toBeNull();
    expect(row.querySelector('[data-slot="settings-row-description"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Open Mail" })).toBeInTheDocument();
  });

  it("keeps a single action beside the text on a compact row", () => {
    render(
      <FeedActionableRow
        item={actionable({
          id: "gmail-needs-reply",
          actions: [{ key: "open-mail", label: "Open Mail", tone: "primary", run: vi.fn() }],
        })}
      />,
    );
    const trailing = screen
      .getByTestId("feed-actionable-gmail-needs-reply")
      .querySelector('[data-slot="settings-row-trailing"]');
    expect(trailing).not.toHaveClass("w-full", "pt-1");
    expect(screen.getByRole("button", { name: "Open Mail" })).toHaveAttribute("data-profile-role", "action");
  });

  it("keeps the requested duration visible in compact mobile decision labels", () => {
    render(
      <FeedActionableRow
        item={actionable({
          actions: [
            {
              key: "approve",
              label: "Approve 4 hours more",
              tone: "primary",
              run: vi.fn(),
            },
            {
              key: "deny",
              label: "Deny",
              tone: "danger",
              confirm: true,
              run: vi.fn(),
            },
          ],
        })}
      />,
    );

    const approve = screen.getByRole("button", {
      name: "Approve 4 hours more",
    });
    const deny = screen.getByRole("button", {
      name: "Deny (tap again to confirm)",
    });
    expect(approve.querySelector(".sm\\:hidden")).toHaveTextContent(
      "Accept · 4h",
    );
    expect(approve.querySelector(".hidden.sm\\:inline")).toHaveTextContent(
      "Approve 4 hours more",
    );
    // "Deny" is already phone-sized; it is never relabelled "Decline".
    expect(deny.querySelector(".sm\\:hidden")).toBeNull();
    expect(deny).toHaveTextContent(/^Deny$/);
  });

  it("paints a resting Deny red and Allow green, with Allow trailing", () => {
    render(
      <FeedActionableRow
        item={actionable({
          // Listed Allow first on purpose: the success answer still trails.
          actions: [
            { key: "allow", label: "Allow", tone: "success", run: vi.fn() },
            {
              key: "deny",
              label: "Deny",
              tone: "danger",
              confirm: true,
              run: vi.fn(),
            },
          ],
        })}
      />,
    );

    const deny = screen.getByRole("button", {
      name: "Deny (tap again to confirm)",
    });
    const allow = screen.getByRole("button", { name: "Allow" });
    expect(
      deny.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Pale green wash with theme-aware legible text, not a solid fill.
    expect(allow).toHaveClass(
      "bg-[color:var(--app-success-tint)]",
      "text-[color:var(--app-success-deep)]",
      "dark:text-[color:var(--app-success-bright)]",
      "hover:bg-[color:var(--app-success-surface)]",
    );
    expect(allow).not.toHaveClass("bg-[color:var(--app-accent)]");
    // Red before anyone taps it: legible red on its own light wash.
    expect(deny).toHaveClass(
      "bg-[color:var(--app-destructive-tint)]",
      "text-[color:var(--app-destructive-deep)]",
    );
    expect(deny).not.toHaveClass("bg-[color:var(--app-neutral-fill)]");

    fireEvent.click(deny);

    const armed = screen.getByRole("button", { name: "Confirm Deny" });
    expect(armed).toHaveTextContent("Sure?");
    expect(armed).toHaveClass("bg-[color:var(--app-destructive)]");
    expect(armed).not.toHaveClass("bg-[color:var(--app-destructive-tint)]");
  });

  it("keeps an until-stopped approval explicit on mobile", () => {
    render(
      <FeedActionableRow
        item={actionable({
          actions: [
            {
              key: "approve",
              label: "Approve until you stop",
              tone: "primary",
              run: vi.fn(),
            },
            {
              key: "deny",
              label: "Deny",
              tone: "danger",
              confirm: true,
              run: vi.fn(),
            },
          ],
        })}
      />,
    );

    const approve = screen.getByRole("button", {
      name: "Approve until you stop",
    });
    expect(approve.querySelector(".sm\\:hidden")).toHaveTextContent(
      "Accept · Until off",
    );
  });

  it("keeps the destructive action in the accessible confirmation name", () => {
    render(
      <FeedActionableRow
        item={actionable({
          actions: [
            {
              key: "decline",
              label: "Decline",
              tone: "danger",
              confirm: true,
              run: vi.fn(),
            },
          ],
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Decline (tap again to confirm)",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Confirm Decline" }),
    ).toHaveTextContent("Sure?");
  });

  it("locks sibling actions synchronously while one action is in flight", async () => {
    let resolveApprove: (() => void) | undefined;
    const approve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApprove = resolve;
        }),
    );
    const deny = vi.fn().mockResolvedValue(undefined);
    render(
      <FeedActionableRow
        item={actionable({
          actions: [
            {
              key: "approve",
              label: "Approve",
              tone: "primary",
              run: approve,
            },
            {
              key: "deny",
              label: "Deny",
              tone: "danger",
              confirm: true,
              run: deny,
            },
          ],
        })}
      />,
    );
    const approveButton = screen.getByRole("button", { name: "Approve" });
    const denyButton = screen.getByRole("button", {
      name: "Deny (tap again to confirm)",
    });

    fireEvent.click(denyButton);
    expect(denyButton).toHaveTextContent("Sure?");

    act(() => {
      approveButton.click();
      denyButton.click();
    });

    expect(approve).toHaveBeenCalledOnce();
    expect(deny).not.toHaveBeenCalled();
    expect(approveButton).toBeDisabled();
    expect(denyButton).toBeDisabled();
    expect(denyButton).toHaveTextContent("Deny");

    await act(async () => {
      resolveApprove?.();
      await Promise.resolve();
    });

    expect(approveButton).not.toBeDisabled();
    expect(denyButton).not.toBeDisabled();
  });

  it("renders a revoked SOS card as a plain row with sender initials", () => {
    const { container } = render(
      <FeedActionableRow
        item={actionable({
          title: "Mom sent an SMS",
          description: "Emergency SMS - Revoked",
          person: { displayName: "Mom", photoUrl: null },
          href: "/one/location?grantId=g1&open=1&section=shared",
          chevron: true,
          // No `emphasis` — this is the confirmed "downgrade to plain row" behavior.
        })}
      />,
    );

    expect(screen.queryByTestId("feed-sms-emergency")).toBeNull();
    expect(screen.getByText("Mom sent an SMS")).toBeInTheDocument();
    expect(screen.getByTestId("feed-actionable-avatar")).toHaveTextContent("M");
    expect(container.querySelector('[data-icon-tone="red"]')).toBeNull();
  });

  describe("time label", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 12, 15, 45, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the formatted local time label when displayTimestamp is set", () => {
      render(
        <FeedActionableRow
          item={actionable({
            title: "Has a time",
            displayTimestamp: new Date(2026, 7, 12, 15, 45, 0).getTime(),
          })}
        />,
      );

      expect(screen.getByText(/^03:45\s?PM$/i)).toBeInTheDocument();
    });

    it("shows no time label when displayTimestamp is null", () => {
      render(
        <FeedActionableRow
          item={actionable({ title: "No time", displayTimestamp: null })}
        />,
      );

      expect(screen.queryByText(/Today -|Yesterday -/i)).toBeNull();
    });

    it("shows no time label when displayTimestamp is absent", () => {
      render(
        <FeedActionableRow item={actionable({ title: "No time field" })} />,
      );

      expect(screen.queryByText(/Today -|Yesterday -/i)).toBeNull();
    });

    it("keeps the spinning pulse dot and the time label together", () => {
      render(
        <FeedActionableRow
          item={actionable({
            title: "Running task",
            spinning: true,
            displayTimestamp: new Date(2026, 7, 12, 15, 45, 0).getTime(),
          })}
        />,
      );

      expect(screen.getByText(/^03:45\s?PM$/i)).toBeInTheDocument();
      expect(screen.getByText("Row description")).toBeInTheDocument();
    });
  });
});
