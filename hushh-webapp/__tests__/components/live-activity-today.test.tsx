import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveActivityEvent, LiveActivityKind } from "@/lib/pkm/live-activity/live-activity-types";

const m = vi.hoisted(() => ({
  uid: "owner-a" as string | null,
  journal: new Map<string, LiveActivityEvent[]>(),
  listeners: new Set<() => void>(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: m.uid }) }));
vi.mock("@/lib/pkm/live-activity/live-activity-journal", () => ({
  peekLiveActivity: (userId: string) => m.journal.get(userId) ?? [],
  subscribeLiveActivity: (listener: () => void) => {
    m.listeners.add(listener);
    return () => { m.listeners.delete(listener); };
  },
}));
vi.mock("@/lib/pkm/live-activity/live-activity-copy", () => ({
  describeLiveActivity: (event: LiveActivityEvent) => `${event.kind} ${event.subject ?? ""}`.trim(),
}));

import { LiveActivityToday } from "@/components/profile/live-activity-today";

function event(seq: number, kind: LiveActivityKind, at: number, extra: Partial<LiveActivityEvent> = {}): LiveActivityEvent {
  return { v: 1, id: `s:${seq}`, streamId: "s", seq, kind, subject: null, label: null, quantity: null,
    count: 1, firstAt: at, lastAt: at, ...extra };
}

function startOfToday(): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

describe("LiveActivityToday", () => {
  beforeEach(() => {
    m.uid = "owner-a";
    m.journal.clear();
    m.listeners.clear();
  });
  afterEach(cleanup);

  it("renders nothing without activity today, then updates when the journal records", () => {
    m.journal.set("owner-a", [event(1, "section_opened", startOfToday() - 60_000, { subject: "location" })]);
    const { container } = render(<LiveActivityToday />);
    expect(container).toBeEmptyDOMElement();

    m.journal.set("owner-a", [event(2, "connector_connected", Date.now(), { subject: "gmail" })]);
    act(() => m.listeners.forEach(listener => listener()));
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("connector_connected gmail")).toBeInTheDocument();
    expect(screen.queryByText(/section_opened/)).toBeNull();
  });

  it("shows only the current owner's events and resets on an owner change", () => {
    const now = Date.now();
    m.journal.set("owner-a", [event(1, "place_saved", now, { label: "Office" })]);
    m.journal.set("owner-b", [event(2, "connection_accepted", now)]);
    const { rerender } = render(<LiveActivityToday />);
    expect(screen.getByText("place_saved")).toBeInTheDocument();
    expect(screen.queryByText("connection_accepted")).toBeNull();

    m.uid = "owner-b";
    rerender(<LiveActivityToday />);
    expect(screen.queryByText("place_saved")).toBeNull();
    expect(screen.getByText("connection_accepted")).toBeInTheDocument();

    m.uid = null;
    rerender(<LiveActivityToday />);
    expect(screen.queryByText("Today")).toBeNull();
  });

  it("adds the repeat count and pages after eight rows", () => {
    const now = Date.now();
    const events = Array.from({ length: 10 }, (_, index) =>
      event(index, "section_opened", now - index, { subject: `agent_${index}`, count: index === 0 ? 3 : 1 }));
    m.journal.set("owner-a", events);
    render(<LiveActivityToday />);
    expect(screen.getByText("section_opened agent_0 · 3 times")).toBeInTheDocument();
    expect(screen.getByText("section_opened agent_7")).toBeInTheDocument();
    expect(screen.queryByText("section_opened agent_8")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show more activity" }));
    expect(screen.getByText("section_opened agent_9")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more activity" })).toBeNull();
  });

  it("moves yesterday's rows out of Today at local midnight without a journal change", () => {
    vi.useFakeTimers();
    try {
      const lateEvening = new Date();
      lateEvening.setHours(23, 58, 0, 0);
      vi.setSystemTime(lateEvening);
      m.journal.set("owner-a", [event(1, "connector_connected", lateEvening.getTime(), { subject: "gmail" })]);
      render(<LiveActivityToday />);
      expect(screen.getByText("connector_connected gmail")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(3 * 60_000); });

      expect(screen.queryByText("Today")).toBeNull();
      expect(screen.queryByText("connector_connected gmail")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
