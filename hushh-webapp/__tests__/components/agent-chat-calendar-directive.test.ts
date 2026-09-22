import { describe, expect, it } from "vitest";

import { getCalendarDirectiveFromToolEvent } from "@/components/agent/agent-chat-workspace";
import type { AgentChatToolEvent } from "@/lib/services/agent-chat-client";

function makeToolEvent(
  toolName: string,
  result: unknown,
  slots: Record<string, unknown> = {},
): AgentChatToolEvent {
  return {
    callId: "call-1",
    actionId: "action-1",
    name: toolName,
    label: toolName,
    execution: "frontend",
    slots,
    message: "",
    requiresConfirmation: false,
    trustedActivationRequired: false,
    raw: {
      toolName,
      result: typeof result === "string" ? result : JSON.stringify(result),
    },
  };
}

describe("getCalendarDirectiveFromToolEvent", () => {
  it("returns null for non-calendar tools", () => {
    const event = makeToolEvent("search_pkm", { results: [] });
    expect(getCalendarDirectiveFromToolEvent(event)).toBeNull();
  });

  it("extracts explicit directive from backend tool result", () => {
    const directive = {
      kind: "action",
      delegateAgentId: "agent_calendar",
      payload: {
        type: "calendar.execute_proposal",
        proposalId: "gcal_test_explicit",
        action: "create",
        summary: "Schedule 'Study Session' on Friday, Sep 4",
        confirmLabel: "Schedule",
        expiresAt: "2026-09-04T12:00:00Z",
      },
    };
    const event = makeToolEvent("propose_calendar_event", {
      status: "confirmation_required",
      proposal_id: "gcal_test_explicit",
      directive,
      message: "The app is showing the exact calendar change for owner confirmation.",
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result).toEqual({
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: directive.payload,
      },
      message: "Schedule 'Study Session' on Friday, Sep 4",
      stateChanged: true,
    });
  });

  it("extracts directive from legacy confirmation_required tool result without explicit directive", () => {
    const event = makeToolEvent("propose_calendar_event", {
      status: "confirmation_required",
      proposal_id: "gcal_test_legacy",
      plan: {
        title: "Study Session",
        start_at: "2026-09-04T16:00:00+05:30",
        end_at: "2026-09-04T17:00:00+05:30",
      },
      conflicts: [],
      message: "The app is showing the exact calendar change for owner confirmation.",
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result).toMatchObject({
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: {
          type: "calendar.execute_proposal",
          proposalId: "gcal_test_legacy",
          action: "create",
          confirmLabel: "Schedule",
        },
      },
      stateChanged: true,
    });
  });

  it("marks confirmLabel as 'Schedule anyway' when conflicts are detected", () => {
    const event = makeToolEvent("propose_calendar_event", {
      status: "confirmation_required",
      proposal_id: "gcal_test_conflicts",
      plan: {
        title: "Study Session",
      },
      conflicts: [{ title: "Existing meeting" }],
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result?.directive.payload.confirmLabel).toBe("Schedule anyway");
  });

  it("carries structured event fields through the explicit-directive path untouched", () => {
    const directive = {
      kind: "action",
      delegateAgentId: "agent_calendar",
      payload: {
        type: "calendar.execute_proposal",
        proposalId: "gcal_structured",
        action: "create",
        summary: "Schedule 'Planning'",
        confirmLabel: "Schedule",
        expiresAt: "2026-09-04T12:00:00Z",
        title: "Planning",
        startAt: "2026-08-11T10:00:00+05:30",
        endAt: "2026-08-11T10:30:00+05:30",
        attendees: ["person@example.com"],
        location: "Room 4",
        sendUpdates: true,
        conflicts: [],
      },
    };
    const event = makeToolEvent("propose_calendar_event", {
      status: "confirmation_required",
      proposal_id: "gcal_structured",
      directive,
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result?.directive.payload).toEqual(directive.payload);
  });

  it("normalizes the legacy path to the governed proposal envelope", () => {
    const event = makeToolEvent("propose_calendar_event", {
      status: "confirmation_required",
      proposal_id: "gcal_legacy_structured",
      plan: {
        title: "Study Session",
        start_at: "2026-09-04T16:00:00+05:30",
        end_at: "2026-09-04T17:00:00+05:30",
        attendees: ["a@example.com"],
        location: "Library",
        send_updates: true,
      },
      conflicts: [],
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result).toMatchObject({
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: {
          type: "calendar.execute_proposal",
          proposalId: "gcal_legacy_structured",
          action: "create",
          summary: "Schedule 'Study Session'",
          confirmLabel: "Schedule",
          expiresAt: "",
        },
      },
      stateChanged: true,
    });
    expect(result?.directive.payload).not.toHaveProperty("startAt");
    expect(result?.directive.payload).not.toHaveProperty("attendees");
    expect(result?.directive.payload).not.toHaveProperty("location");
  });

  it("normalizes a legacy cancel proposal without exposing event details", () => {
    const event = makeToolEvent("propose_calendar_cancellation", {
      status: "confirmation_required",
      proposal_id: "gcal_legacy_cancel",
      plan: {
        event_id: "evt-1",
        send_updates: true,
        current_event: {
          title: "Design review",
          start: { dateTime: "2026-08-11T10:00:00+05:30" },
          end: { dateTime: "2026-08-11T10:30:00+05:30" },
          location: "Room 4",
          attendees: [{ email: "person@example.com", response_status: "accepted" }],
        },
      },
      conflicts: [],
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result).toMatchObject({
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: {
          type: "calendar.execute_proposal",
          proposalId: "gcal_legacy_cancel",
          action: "cancel",
          summary: "Cancel 'evt-1'",
          confirmLabel: "Cancel",
          expiresAt: "",
        },
      },
      stateChanged: true,
    });
    expect(result?.directive.payload).not.toHaveProperty("eventId");
    expect(result?.directive.payload).not.toHaveProperty("attendees");
  });

  it("keeps legacy conflicts in the governed confirmation label", () => {
    const event = makeToolEvent("propose_calendar_event", {
      status: "confirmation_required",
      proposal_id: "gcal_legacy_conflicts",
      plan: { title: "Study Session" },
      conflicts: [{ title: "Existing meeting", start: { dateTime: "2026-09-04T16:00:00Z" } }],
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result?.directive.payload).toMatchObject({
      type: "calendar.execute_proposal",
      proposalId: "gcal_legacy_conflicts",
      action: "create",
      summary: "Schedule 'Study Session'",
      confirmLabel: "Schedule anyway",
      expiresAt: "",
    });
    expect(result?.directive.payload).not.toHaveProperty("conflicts");
  });

  it("extracts connection directive when Google Calendar requires authorization", () => {
    const event = makeToolEvent("propose_calendar_event", {
      status: "connection_required",
      message: "Connect Google Calendar before scheduling.",
    });

    const result = getCalendarDirectiveFromToolEvent(event);
    expect(result).toMatchObject({
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: {
          type: "calendar.connect",
          accessLevel: "manage",
        },
      },
    });
  });
});
