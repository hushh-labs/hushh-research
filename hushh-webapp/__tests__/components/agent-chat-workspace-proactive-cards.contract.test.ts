import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
  "utf8",
);

/**
 * agent-chat-workspace.tsx has no existing mount/render test coverage at all
 * (auth/vault/persona/kai-session all need to be mocked from scratch to
 * render it, a substantial undertaking of its own) -- so this guards the new
 * proactive-card wiring the same way this codebase already guards
 * gmail-nudges-section.tsx's loading contract: by asserting the load-bearing
 * conditions are present in source. The individual card components and the
 * useGmailNudges hook each have full render/behavior test coverage
 * elsewhere; this test exists only to catch someone silently loosening or
 * dropping a gating condition here.
 */
describe("Agent One proactive Gmail cards wiring contract", () => {
  it("imports both proactive card components", () => {
    expect(source).toContain(
      'import { AgentConnectAccessCard } from "@/components/agent/agent-connect-access-card"',
    );
    expect(source).toContain(
      'import { AgentGmailNudgeCard } from "@/components/agent/agent-gmail-nudge-card"',
    );
  });

  it("gates the connect card to page variant, chat access, a fresh conversation, and disconnected Gmail", () => {
    expect(source).toContain("!isPopover &&");
    const connectBlock = source.slice(
      source.indexOf("<AgentConnectAccessCard") - 400,
      source.indexOf("<AgentConnectAccessCard"),
    );
    expect(connectBlock).toContain("hasChatAccess");
    expect(connectBlock).toContain("!hasStartedConversation");
    expect(connectBlock).toContain("!gmailConnectCardDismissed");
    expect(connectBlock).toContain("gmailConnectorStatus.status?.connected === false");
  });

  it("gates the nudge card to page variant, chat access, a fresh conversation, connected Gmail, and pending nudges", () => {
    const nudgeBlock = source.slice(
      source.indexOf("<AgentGmailNudgeCard") - 400,
      source.indexOf("<AgentGmailNudgeCard"),
    );
    expect(nudgeBlock).toContain("hasChatAccess");
    expect(nudgeBlock).toContain("!hasStartedConversation");
    expect(nudgeBlock).toContain("!gmailNudgeCardDismissed");
    expect(nudgeBlock).toContain("gmailConnectorStatus.status?.connected === true");
    expect(nudgeBlock).toContain("gmailNudges.nudges.length > 0");
  });

  it("routes the connect CTA through GmailReceiptsService.startConnect, not a new endpoint", () => {
    expect(source).toContain("GmailReceiptsService.startConnect(");
  });

  it("mounts both cards before the welcome panel, in the same independent-state region as pendingAppAction/pendingSpecialistDirective", () => {
    const connectIndex = source.indexOf("<AgentConnectAccessCard");
    const nudgeIndex = source.indexOf("<AgentGmailNudgeCard");
    const welcomeIndex = source.indexOf("<AgentWelcomePanel");
    expect(connectIndex).toBeGreaterThan(-1);
    expect(nudgeIndex).toBeGreaterThan(connectIndex);
    expect(welcomeIndex).toBeGreaterThan(nudgeIndex);
  });
});

describe("Agent One proactive Calendar cards wiring contract", () => {
  // There are now two <AgentConnectAccessCard usages (Gmail's, then
  // Calendar's) -- anchor on Calendar's title, which is unique, rather than
  // a positional "second occurrence" that would silently break if a card is
  // ever reordered.
  const calendarConnectIndex = source.indexOf('title="See what\'s coming up"');
  const calendarEventIndex = source.indexOf("<AgentCalendarEventCard");

  it("imports the Calendar card component and both new hooks", () => {
    expect(source).toContain(
      'import { AgentCalendarEventCard } from "@/components/agent/agent-calendar-event-card"',
    );
    expect(source).toContain(
      'import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status"',
    );
    expect(source).toContain(
      'import { useCalendarUpcomingEvents } from "@/lib/calendar/use-calendar-upcoming-events"',
    );
  });

  it("defines the one-card-at-a-time priority flag", () => {
    expect(source).toContain("const gmailCardShowing =");
  });

  it("gates the connect card to page variant, chat access, a fresh conversation, disconnected Calendar, and Gmail's slot being empty", () => {
    expect(calendarConnectIndex).toBeGreaterThan(-1);
    const connectBlock = source.slice(calendarConnectIndex - 500, calendarConnectIndex);
    expect(connectBlock).toContain("hasChatAccess");
    expect(connectBlock).toContain("!hasStartedConversation");
    expect(connectBlock).toContain("!calendarConnectCardDismissed");
    expect(connectBlock).toContain("calendarConnectionStatus.connected === false");
    expect(connectBlock).toContain("!gmailCardShowing");
  });

  it("gates the event card to page variant, chat access, a fresh conversation, connected Calendar, pending events, and Gmail's slot being empty", () => {
    expect(calendarEventIndex).toBeGreaterThan(-1);
    const eventBlock = source.slice(calendarEventIndex - 500, calendarEventIndex);
    expect(eventBlock).toContain("hasChatAccess");
    expect(eventBlock).toContain("!hasStartedConversation");
    expect(eventBlock).toContain("!calendarEventCardDismissed");
    expect(eventBlock).toContain("calendarConnectionStatus.connected === true");
    expect(eventBlock).toContain("calendarEvents.events.length > 0");
    expect(eventBlock).toContain("!gmailCardShowing");
  });

  it("routes the proactive connect CTA through GoogleCalendarService.startConnect with accessLevel read, scoped to handleConnectCalendar", () => {
    const handlerIndex = source.indexOf("const handleConnectCalendar = useCallback");
    expect(handlerIndex).toBeGreaterThan(-1);
    // Bound to the handler body, not the pre-existing calendar.connect
    // specialist-directive branch elsewhere in the file, which legitimately
    // allows "manage" too.
    const handlerBody = source.slice(handlerIndex, handlerIndex + 700);
    expect(handlerBody).toContain("GoogleCalendarService.startConnect(");
    expect(handlerBody).toContain('accessLevel: "read"');
  });

  it("mounts both Calendar cards after Gmail's cards and before the welcome panel", () => {
    const gmailNudgeIndex = source.indexOf("<AgentGmailNudgeCard");
    const welcomeIndex = source.indexOf("<AgentWelcomePanel");
    expect(calendarConnectIndex).toBeGreaterThan(gmailNudgeIndex);
    expect(calendarEventIndex).toBeGreaterThan(calendarConnectIndex);
    expect(welcomeIndex).toBeGreaterThan(calendarEventIndex);
  });
});

// The in-chat, agent-initiated Calendar directive (delegateAgentId
// "agent_calendar", surfaced when the model proposes scheduling/rescheduling/
// cancelling an event or needs a fresh Calendar connection) is a different
// moment from the proactive pre-chat cards above -- it used to render through
// the generic, un-styled SpecialistDirectiveCard for both its "connect" and
// "execute_proposal" payload types. This guards the rework: the connect
// moment now reuses AgentConnectAccessCard (the same component the proactive
// card uses, unifying the two "connect Calendar" moments), and the proposal
// moment renders the new structured AgentCalendarProposalCard instead of a
// flattened summary sentence -- without changing what actually executes on
// confirm.
describe("Agent One in-chat Calendar directive cards wiring contract", () => {
  it("imports AgentCalendarProposalCard and the typed payload helper", () => {
    expect(source).toContain(
      'import { AgentCalendarProposalCard } from "@/components/agent/agent-calendar-proposal-card"',
    );
    expect(source).toContain("function getCalendarPayload(");
  });

  // The source has CRLF line endings, and the JSX conditional's `? (` and the
  // component tag it renders sit on different lines -- normalize whitespace
  // before matching instead of depending on an exact literal newline/indent.
  const normalized = source.replace(/\s+/g, " ");

  it("renders AgentConnectAccessCard, not SpecialistDirectiveCard, for the calendar.connect directive", () => {
    expect(normalized).toContain('"calendar.connect" ? ( <AgentConnectAccessCard');
  });

  it("wires the connect card's onConnect through GoogleCalendarService.startConnect, unchanged", () => {
    const connectIndex = normalized.indexOf('"calendar.connect" ? ( <AgentConnectAccessCard');
    const onConnectIndex = normalized.indexOf("onConnect={async () => {", connectIndex);
    const block = normalized.slice(onConnectIndex, onConnectIndex + 900);
    expect(block).toContain("GoogleCalendarService.startConnect(");
    expect(block).toContain("clearCalendarSetupOAuthReturn();");
  });

  it("renders AgentCalendarProposalCard, not SpecialistDirectiveCard, for the calendar.execute_proposal directive", () => {
    expect(normalized).toContain(
      '"calendar.execute_proposal" ? ( <AgentCalendarProposalCard',
    );
  });

  it("wires the proposal card's onConfirm through the pre-existing enqueueCalendarDirective, unchanged", () => {
    const proposalIndex = normalized.indexOf(
      '"calendar.execute_proposal" ? ( <AgentCalendarProposalCard',
    );
    const onConfirmIndex = normalized.indexOf("onConfirm={async () => {", proposalIndex);
    const block = normalized.slice(onConfirmIndex, onConfirmIndex + 500);
    expect(block).toContain("enqueueCalendarDirective(directive, token, user.uid);");
  });

  it("passes the structured event fields (not just summary) into AgentCalendarProposalCard", () => {
    const proposalIndex = source.indexOf("<AgentCalendarProposalCard");
    const block = source.slice(proposalIndex, proposalIndex + 1600);
    for (const prop of ["action=", "title=", "startAt=", "endAt=", "attendees=", "conflicts="]) {
      expect(block).toContain(prop);
    }
  });
});
