import { calendarSlotProposalError, calendarSlotStarts } from "@/lib/calendar/calendar-slot-handoff";
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useOneConversationSession, useOneComposerDraft } from "@/lib/agent/one-conversation-session";
import { createPendingTextAttachment } from "@/lib/agent/large-text-attachment";

describe("One conversation session entry welcome", () => {
  beforeEach(() => {
    useOneConversationSession.getState().clearSession();
  });

  it("queues and consumes a post-setup marker without persisting personal content", () => {
    useOneConversationSession.getState().queueEntryWelcome("owner-a");

    expect(useOneConversationSession.getState().pendingEntryWelcome).toEqual({
      userId: "owner-a",
      kind: "post_setup",
    });

    useOneConversationSession.getState().consumeEntryWelcome("owner-a");
    expect(useOneConversationSession.getState().pendingEntryWelcome).toBeNull();
  });

  it("does not let one owner consume another owner's marker", () => {
    useOneConversationSession.getState().queueEntryWelcome("owner-a");

    useOneConversationSession.getState().consumeEntryWelcome("owner-b");
    expect(useOneConversationSession.getState().pendingEntryWelcome?.userId).toBe(
      "owner-a",
    );
  });

  it("clears the marker at the session boundary", () => {
    useOneConversationSession.getState().queueEntryWelcome("owner-a");
    useOneConversationSession.getState().clearSession();

    expect(useOneConversationSession.getState().pendingEntryWelcome).toBeNull();
  });

  it("preserves one authoritative draft and editor purpose across a Chat route remount", () => {
    const first = renderHook(() => useOneComposerDraft(true, "owner-a"));
    const context = first.result.current.context;
    const attachment = createPendingTextAttachment("Synthetic attachment", true);
    act(() => {
      first.result.current.setInput("Synthetic 👋\nSecond line");
      first.result.current.setAttachment(attachment);
      first.result.current.setExpanded(true);
    });
    first.unmount();
    const returning = renderHook(() => useOneComposerDraft(true, "owner-a"));
    expect(returning.result.current.ready).toBe(true);
    expect(returning.result.current.context).toBe(context);
    expect(returning.result.current.input).toBe("Synthetic 👋\nSecond line");
    expect(returning.result.current.attachment).toEqual(attachment);
    expect(returning.result.current.expanded).toBe(true);
    returning.unmount();
  });

  it("erases a departed owner and refuses stale callbacks after withdrawal or session clear", () => {
    const view = renderHook(({ owner }) => useOneComposerDraft(true, owner), { initialProps: { owner: "owner-a" as string | null } });
    const stale = view.result.current.setInput;
    act(() => stale("Synthetic old draft"));
    view.rerender({ owner: null });
    expect(useOneConversationSession.getState().composerDraft).toBeNull();
    expect(view.result.current.input).toBe("");
    view.rerender({ owner: "owner-b" });
    act(() => { stale("Late response"); view.result.current.setInput("Synthetic new draft"); });
    expect(view.result.current.input).toBe("Synthetic new draft");
    const replaced = view.result.current.setInput;
    act(() => useOneConversationSession.getState().clearSession());
    act(() => replaced("Late response"));
    expect(useOneConversationSession.getState().composerDraft).toBeNull();
    view.unmount();
  });

  it("allows intro editing without admitting or retaining a protected owner draft", () => {
    const view = renderHook(({ owner }) => useOneComposerDraft(true, owner), {
      initialProps: { owner: null as string | null },
    });
    const introEdit = view.result.current.setInput;
    act(() => introEdit("Synthetic introduction"));
    expect(view.result.current.input).toBe("Synthetic introduction");
    expect(view.result.current.ready).toBe(false);
    expect(useOneConversationSession.getState().composerDraft).toBeNull();
    view.rerender({ owner: "owner-a" });
    act(() => introEdit("Delayed intro callback"));
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.input).toBe("");
    view.rerender({ owner: null });
    expect(view.result.current.input).toBe("");
    expect(useOneConversationSession.getState().composerDraft).toBeNull();
    view.unmount();
  });
});

import { earliestCalendarSlot, calendarSlotInstruction, type CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
const slot: CalendarSlotHandoff = { ownerId: "owner", accountEmail: "owner@example.com", date: "2026-11-01", windowStart: "2026-11-01T05:30:00Z", windowEnd: "2026-11-01T07:30:00Z", durationMinutes: 15, timeZone: "America/New_York" };
it.each([15, 30, 60] as const)("preserves %s minutes and starts at the earliest still-fitting instant", durationMinutes => {
  const selection = { ...slot, durationMinutes };
  const now = Date.parse("2026-11-01T05:45:01Z");
  const start = Date.parse("2026-11-01T05:46:00Z");
  expect(earliestCalendarSlot(selection, now)).toEqual({ startAt: new Date(start).toISOString(), endAt: new Date(start + durationMinutes * 60000).toISOString() });
  expect(calendarSlotInstruction(selection, now)).toContain('"timeZone":"America/New_York"');
  const sessionId = useOneConversationSession.getState().sessionId;
  const handoff = useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: selection });
  expect(handoff.calendarSlot).toEqual(selection);
  expect(useOneConversationSession.getState().sessionId).toBe(sessionId);
  useOneConversationSession.getState().consumeHandoff(handoff.id);
  expect(useOneConversationSession.getState().pendingHandoff).toBeNull();
});
it("rejects expired and too-short windows instead of manufacturing a slot", () => {
  expect(earliestCalendarSlot(slot, Date.parse(slot.windowEnd))).toBeNull();
  expect(earliestCalendarSlot({ ...slot, windowEnd: "2026-11-01T05:40:00Z" }, 0)).toBeNull();
});


describe("Calendar slot proposal constraints", () => {
  const slot = { ownerId: "owner", accountEmail: "owner@example.com", date: "2030-01-17", windowStart: "2030-01-17T10:00:00Z", windowEnd: "2030-01-17T12:00:00Z", durationMinutes: 30 as const, timeZone: "Europe/London" };
  const proposal = { action: "create", title: "Meeting", attendees: ["guest@example.com"], startAt: slot.windowStart, endAt: "2030-01-17T10:30:00Z", conflicts: [] };
  it.each([
    { startAt: "2030-01-17T09:45:00Z", endAt: "2030-01-17T10:15:00Z" },
    { startAt: "2030-01-17T11:45:00Z", endAt: "2030-01-17T12:15:00Z" },
    { endAt: "2030-01-17T11:00:00Z" }, { startAt: null }, { endAt: "invalid" },
    { action: "cancel" }, { attendees: [] }, { conflicts: [{ title: "Busy" }] },
    { expiresAt: "2030-01-17T08:00:00Z" },
  ])("rejects an invalid or unavailable proposal: %j", changes => {
    expect(calendarSlotProposalError(slot, { ...proposal, ...changes }, Date.parse("2030-01-17T09:00:00Z"))).not.toBeNull();
  });
  it("accepts only fitting duration and rejects time elapsed before confirmation", () => {
    expect(calendarSlotProposalError(slot, proposal, Date.parse("2030-01-17T09:00:00Z"))).toBeNull();
    expect(calendarSlotProposalError(slot, proposal, Date.parse("2030-01-17T10:01:00Z"))).not.toBeNull();
    expect(calendarSlotStarts(slot, Date.parse("2030-01-17T09:00:00Z"))).toHaveLength(7);
    expect(calendarSlotStarts(slot, Date.parse("2030-01-17T11:45:00Z"))).toEqual([]);
  });
});
