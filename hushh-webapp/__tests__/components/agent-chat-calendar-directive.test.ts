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
