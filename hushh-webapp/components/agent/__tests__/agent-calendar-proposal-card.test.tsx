import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentCalendarProposalCard } from "@/components/agent/agent-calendar-proposal-card";

describe("AgentCalendarProposalCard", () => {
  it("renders a create proposal with title, time range, and notify copy", () => {
    render(
      <AgentCalendarProposalCard
        action="create"
        title="Planning"
        startAt="2026-08-11T10:00:00+05:30"
        endAt="2026-08-11T10:30:00+05:30"
        attendees={["person@example.com"]}
        location="Room 4"
        sendUpdates
        conflicts={[]}
        confirmLabel="Schedule"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("agent-calendar-proposal-card")).toBeTruthy();
    expect(screen.getByText("Planning")).toBeTruthy();
    expect(screen.getByText("Room 4")).toBeTruthy();
    expect(screen.getByText(/Attendee: person@example.com/)).toBeTruthy();
    expect(screen.getByText("Attendees will be notified.")).toBeTruthy();
    expect(screen.getByText("Schedule")).toBeTruthy();
  });

  it("shows the no-notify copy when sendUpdates is false", () => {
    render(
      <AgentCalendarProposalCard
        action="reschedule"
        title="Client call"
        startAt="2026-08-11T10:00:00Z"
        endAt="2026-08-11T10:30:00Z"
        attendees={[]}
        location={null}
        sendUpdates={false}
        conflicts={[]}
        confirmLabel="Reschedule"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Attendees will not be notified.")).toBeTruthy();
  });

  it("summarizes more than 3 attendees", () => {
    render(
      <AgentCalendarProposalCard
        action="create"
        title="All hands"
        startAt="2026-08-11T10:00:00Z"
        endAt="2026-08-11T11:00:00Z"
        attendees={["a@x.com", "b@x.com", "c@x.com", "d@x.com"]}
        location={null}
        sendUpdates
        conflicts={[]}
        confirmLabel="Schedule"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/a@x.com, b@x.com, c@x.com \+1 more/)).toBeTruthy();
  });

  it("renders a conflicts callout when conflicts are present", () => {
    render(
      <AgentCalendarProposalCard
        action="create"
        title="Client call"
        startAt="2026-08-11T10:00:00Z"
        endAt="2026-08-11T10:30:00Z"
        attendees={[]}
        location={null}
        sendUpdates
        conflicts={[{ title: "Design review", startAt: "2026-08-11T10:00:00Z" }]}
        confirmLabel="Schedule anyway"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/Conflicts with an existing event/)).toBeTruthy();
    expect(screen.getByText(/Design review/)).toBeTruthy();
    expect(screen.getByText("Schedule anyway")).toBeTruthy();
  });

  it("renders the cancel variant distinctly and calls the right handlers", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <AgentCalendarProposalCard
        action="cancel"
        title="Design review"
        startAt="2026-08-11T10:00:00Z"
        endAt="2026-08-11T10:30:00Z"
        attendees={["person@example.com"]}
        location={null}
        sendUpdates
        conflicts={[]}
        confirmLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("Cancel on your calendar")).toBeTruthy();

    fireEvent.click(screen.getByTestId("agent-calendar-proposal-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("agent-calendar-proposal-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Untitled event' when title is missing", () => {
    render(
      <AgentCalendarProposalCard
        action="cancel"
        title={null}
        startAt={null}
        endAt={null}
        attendees={[]}
        location={null}
        sendUpdates={false}
        conflicts={[]}
        confirmLabel="Cancel"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Untitled event")).toBeTruthy();
  });

  it("shows busy state on the confirm button", () => {
    render(
      <AgentCalendarProposalCard
        action="create"
        title="Planning"
        startAt="2026-08-11T10:00:00Z"
        endAt="2026-08-11T10:30:00Z"
        attendees={[]}
        location={null}
        sendUpdates
        conflicts={[]}
        confirmLabel="Schedule"
        busy
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Working…")).toBeTruthy();
  });
});
