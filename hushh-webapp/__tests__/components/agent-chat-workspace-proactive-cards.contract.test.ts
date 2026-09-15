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
