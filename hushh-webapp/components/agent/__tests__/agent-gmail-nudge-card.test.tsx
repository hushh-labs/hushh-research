import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentGmailNudgeCard } from "@/components/agent/agent-gmail-nudge-card";
import type { GmailNudge } from "@/lib/services/gmail-receipts-service";

const needsReply: GmailNudge = {
  type: "needs_reply",
  thread_id: "t1",
  message_id: "m1",
  title: "Re: Contract review",
  sender: "Jordan Lee",
  sender_email: "jordan@example.com",
  received_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
};

const upcomingMeeting: GmailNudge = {
  type: "upcoming_meeting",
  thread_id: "t2",
  message_id: "m2",
  title: "1:1 sync",
  sender: "Priya Nair",
  sender_email: "priya@example.com",
  received_at: null,
  starts_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  meeting_url: "https://meet.example.com/xyz",
};

describe("AgentGmailNudgeCard", () => {
  it("renders nothing when there are no nudges", () => {
    const { container } = render(
      <AgentGmailNudgeCard nudges={[]} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a single nudge with singular lead copy and no fabricated read-only claim", () => {
    render(<AgentGmailNudgeCard nudges={[needsReply]} onDismiss={vi.fn()} />);

    expect(screen.getByTestId("agent-gmail-nudge-card")).toBeTruthy();
    expect(screen.getByText("Reading now. Touching nothing.")).toBeTruthy();
    expect(screen.getByText("One thing waiting on you:")).toBeTruthy();
    expect(screen.getByText("Re: Contract review")).toBeTruthy();
  });

  it("renders plural lead copy, a join link for meetings, and caps to 3 items", () => {
    const onDismiss = vi.fn();
    const extraReplies: GmailNudge[] = Array.from({ length: 3 }, (_, index) => ({
      ...needsReply,
      thread_id: `t-extra-${index}`,
      message_id: `m-extra-${index}`,
      title: `Extra thread ${index}`,
    }));

    render(
      <AgentGmailNudgeCard
        nudges={[upcomingMeeting, needsReply, ...extraReplies]}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("A few things waiting on you:")).toBeTruthy();
    // Meeting sorts first (time-sensitive), then replies by recency; capped to 3.
    expect(screen.getByText("1:1 sync")).toBeTruthy();
    const joinLink = screen.getByTestId("agent-gmail-nudge-join");
    expect(joinLink.getAttribute("href")).toBe("https://meet.example.com/xyz");

    fireEvent.click(screen.getByTestId("agent-gmail-nudge-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not render a join link for a meeting nudge with no meeting_url", () => {
    render(
      <AgentGmailNudgeCard
        nudges={[{ ...upcomingMeeting, meeting_url: null }]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("agent-gmail-nudge-join")).toBeNull();
  });
});
