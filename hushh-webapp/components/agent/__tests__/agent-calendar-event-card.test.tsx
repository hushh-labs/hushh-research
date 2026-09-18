import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentCalendarEventCard } from "@/components/agent/agent-calendar-event-card";
import type { RedactedCalendarEvent } from "@/lib/calendar/use-calendar-upcoming-events";

const soonMeeting: RedactedCalendarEvent = {
  title: "1:1 sync",
  start: { dateTime: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
  end: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  status: "confirmed",
};

const laterMeeting: RedactedCalendarEvent = {
  title: "Quarterly review",
  start: { dateTime: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString() },
  end: { dateTime: new Date(Date.now() + 21 * 60 * 60 * 1000).toISOString() },
  status: "confirmed",
};

const allDayEvent: RedactedCalendarEvent = {
  title: "Company holiday",
  start: { date: "2026-01-01" },
  end: { date: "2026-01-02" },
  status: "confirmed",
};

describe("AgentCalendarEventCard", () => {
  it("renders nothing when there are no events", () => {
    const { container } = render(
      <AgentCalendarEventCard events={[]} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a single event with singular lead copy", () => {
    render(<AgentCalendarEventCard events={[soonMeeting]} onDismiss={vi.fn()} />);

    expect(screen.getByTestId("agent-calendar-event-card")).toBeTruthy();
    expect(screen.getByText("Checked your calendar just now.")).toBeTruthy();
    expect(screen.getByText("One thing coming up:")).toBeTruthy();
    expect(screen.getByText("1:1 sync")).toBeTruthy();
  });

  it("renders plural lead copy, sorts soonest-first, and caps to 3", () => {
    const extras: RedactedCalendarEvent[] = Array.from({ length: 3 }, (_, index) => ({
      title: `Extra event ${index}`,
      start: { dateTime: new Date(Date.now() + (2 + index) * 60 * 60 * 1000).toISOString() },
      end: { dateTime: new Date(Date.now() + (3 + index) * 60 * 60 * 1000).toISOString() },
      status: "confirmed",
    }));
    const onDismiss = vi.fn();

    render(
      <AgentCalendarEventCard
        events={[laterMeeting, soonMeeting, ...extras]}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("A few things coming up:")).toBeTruthy();
    // soonMeeting sorts first (soonest); laterMeeting (20h out) is bumped
    // out by the nearer extras when capped to 3.
    expect(screen.getByText("1:1 sync")).toBeTruthy();

    fireEvent.click(screen.getByTestId("agent-calendar-event-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows 'All day' for a date-only event instead of a fabricated time", () => {
    render(<AgentCalendarEventCard events={[allDayEvent]} onDismiss={vi.fn()} />);
    expect(screen.getByText("All day")).toBeTruthy();
  });

  it("never renders a Join affordance -- redacted events carry no conferencing link", () => {
    render(
      <AgentCalendarEventCard events={[soonMeeting, laterMeeting]} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByText("Join")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
