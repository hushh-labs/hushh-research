import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPendingEmailDraftContext,
  getCalendarDirectiveFromToolEvent,
  getGmailEmailDraftPayload,
  getGmailInformationRequestReplyPayload,
} from "@/components/agent/agent-chat-workspace";
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
  it("never navigates the chat window to connect Google", () => {
    // The vault key is memory-only: any chat OAuth redirect would drop it.
    const source = readFileSync(
      join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain("window.location.assign(start.authorize_url)");
    expect(source).not.toContain("persistGoogleOAuthSameWindowAttempt");
    expect(source).not.toMatch(/location\.(assign|replace|href\s*=)\([^)]*authorize/);
    const connectAt = source.indexOf('if (type === "calendar.connect") {');
    const block = source.slice(connectAt, connectAt + 700);
    expect(block).toContain('runDirectiveConnect("calendar")');
    const runnerAt = source.indexOf("const runDirectiveConnect = ");
    const runner = source.slice(runnerAt, runnerAt + 3_000);
    expect(runner).toContain("connectCalendarInPlace(");
    expect(runner).toContain('purpose: "modify"');
    // A failed Calendar connect is still recorded.
    expect(runner).toContain('"one_calendar_action"');
  });

  it("keeps generic Calendar recovery in chat instead of routing to the page", () => {
    const source = readFileSync(join(process.cwd(), "components/agent/agent-chat-workspace.tsx"), "utf8");
    const start = source.indexOf("const openConnectorSurface = useCallback(");
    const block = source.slice(start, source.indexOf("const [recoveryCheckedForUid", start));
    expect(block).not.toContain("router.push(ROUTES.CALENDAR)");
    expect(block).toContain("calendarChatRecoveryRef.current()");
  });

  it("resumes Calendar through the full tool/directive handler path in an existing conversation", () => {
    const source = readFileSync(join(process.cwd(), "components/agent/agent-chat-workspace.tsx"), "utf8");
    const start = source.indexOf("calendarChatRecoveryRef.current = () => {");
    const recovery = source.slice(start, source.indexOf("const submitComposerText", start));
    expect(recovery).toContain("!conversationIdRef.current");
    expect(recovery).toContain("runAgentTurn(");
    expect(recovery).not.toContain("sendFollowUpTurn(");
    const handlerStart = source.indexOf("const runAgentTurn = async");
    const fullTurn = source.slice(handlerStart, source.indexOf("const sendFollowUpTurn = async", handlerStart));
    expect(fullTurn).toContain("onToolResult:");
    expect(fullTurn).toContain("onSpecialistDirective:");
  });

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
        confirmLabel: "Schedule meeting",
        googleMeet: true,
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
          confirmLabel: "Schedule meeting",
          googleMeet: true,
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
        confirmLabel: "Schedule meeting",
        googleMeet: true,
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
          confirmLabel: "Schedule meeting",
          googleMeet: true,
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

describe("getGmailInformationRequestReplyPayload", () => {
  it("keeps a source-bound One reply body on the live tool event", () => {
    const event = makeToolEvent(
      "open_gmail_information_request_reply",
      { status: "draft_opened" },
      { body: "Here are the requested details." },
    );

    expect(getGmailInformationRequestReplyPayload(event)).toEqual({
      body: "Here are the requested details.",
    });
  });

  it("rejects ordinary Gmail draft events", () => {
    expect(
      getGmailInformationRequestReplyPayload(
        makeToolEvent("open_gmail_email_draft", { status: "draft_opened" }, { body: "Nope" }),
      ),
    ).toBeNull();
  });
});

describe("getGmailEmailDraftPayload", () => {
  it("uses One's active tool-call draft without storing it in a directive", () => {
    const draft = getGmailEmailDraftPayload(
      makeToolEvent("open_gmail_email_draft", { status: "draft_opened" }, {
        request: "Send a hello email",
        to: "person@example.com",
        subject: "Hello",
        body: "Hello there",
      }),
    );

    expect(draft).toEqual({
      instruction: "Send a hello email",
      driveFileId: null,
      initialDraft: {
        to: "person@example.com",
        cc: "",
        bcc: "",
        subject: "Hello",
        body: "Hello there",
      },
    });
  });

  it("retains a resolved recipient while the bounded Email Draft Writer fills the missing body", () => {
    const draft = getGmailEmailDraftPayload(
      makeToolEvent("open_gmail_email_draft", { status: "draft_opened" }, {
        request: "Send a hello email",
        to: "pat@example.com",
        cc: "other@example.com",
        subject: "Hello",
      }),
    );

    expect(draft?.initialDraft).toEqual({
      to: "pat@example.com", cc: "other@example.com", bcc: "", subject: "Hello", body: "",
    });
  });
});

describe("buildPendingEmailDraftContext", () => {
  const draft = {
    to: "pat@example.com",
    cc: "priya@example.com",
    bcc: "",
    subject: "Details",
    body: "The details are attached.",
    driveFileId: "drive-file-1",
  };

  it("tells One exactly what the person sees on the card", () => {
    expect(buildPendingEmailDraftContext(draft, null, false)).toEqual({
      to: "pat@example.com",
      cc: "priya@example.com",
      bcc: "",
      subject: "Details",
      body: "The details are attached.",
      driveFileId: "drive-file-1",
      sourceBound: false,
    });
  });

  it("uses the server-derived envelope for a reply to the selected Gmail request", () => {
    expect(
      buildPendingEmailDraftContext(
        { ...draft, to: "", cc: "", subject: "" },
        { to: "requester@example.com", subject: "Re: Verification" },
        true,
      ),
    ).toEqual({
      to: "requester@example.com",
      cc: "",
      bcc: "",
      subject: "Re: Verification",
      body: "The details are attached.",
      sourceBound: true,
    });
  });

  it("sends nothing when no draft is on screen", () => {
    expect(buildPendingEmailDraftContext(null, null, false)).toBeNull();
    expect(
      buildPendingEmailDraftContext(
        { to: "", cc: "", bcc: "", subject: "", body: "  " },
        null,
        false,
      ),
    ).toBeNull();
  });
});
