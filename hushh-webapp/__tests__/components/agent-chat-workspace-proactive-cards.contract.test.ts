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
 * render it, a substantial undertaking of its own) -- so this guards a few
 * load-bearing behaviors by asserting they're present in source, the same
 * way this codebase already guards gmail-nudges-section.tsx's loading
 * contract.
 *
 * The proactive Gmail connect/nudge cards this block used to also cover
 * (#6779) were deleted, not hidden: they surfaced on every fresh chat
 * regardless of relevance (an unsolicited "Connect Mail & continue" prompt,
 * and a nudge digest that was flagging non-actionable mail -- an automated
 * "Welcome back to One" send, a NoBroker listing -- as if it needed a
 * reply). AgentConnectAccessCard and AgentGmailNudgeCard are gone from the
 * codebase; useGmailNudges() is still used by gmail-nudges-section.tsx on
 * the actual Gmail settings page, untouched.
 */
describe("Agent One chat workspace wiring contract", () => {
  it("uses one accessible quick-prompt rail for both empty and post-setup states", () => {
    expect(source).toContain("function AgentPromptSuggestions(");
    expect(source).toContain('data-testid="agent-chat-suggestions"');
    expect(source).toContain('aria-label="Suggestions"');
    const suggestions = source.slice(
      source.indexOf("function AgentPromptSuggestions("),
      source.indexOf("function AgentPromptSuggestions(") + 1800,
    );
    expect(suggestions).toContain('type="button"');
    expect(suggestions).toContain("disabled={disabled}");
    expect(suggestions).toContain("!min-h-11");
    expect(source).toContain("onClick={() => onPromptSelect(prompt)}");
    expect(source).toContain("setInput(prompt)");
  });

  it("keeps the dedicated-route history sidebar honest while it loads", () => {
    expect(source).toContain("setIsLoadingHistory(true);");
    expect(source).toContain("setIsLoadingHistory(false);");
    expect(source).toContain("warmAgentChatHistoryCache({");
    expect(source).toContain(
      'loading={isPuppySurface ? false : (isLoadingHistory && conversations.length === 0)}',
    );
  });

  it("keeps slow history warming out of the canonical chat interaction path", () => {
    const canSendBlock = source.slice(
      source.indexOf("const canSend ="),
      source.indexOf("const canToggleVoice ="),
    );
    expect(canSendBlock).not.toContain("isLoadingHistory");

    const runTurnGuard = source.slice(
      source.indexOf("if (!text.trim()"),
      source.indexOf("// Pre-model paste guard"),
    );
    expect(runTurnGuard).not.toContain("isLoadingHistory");

    expect(source).not.toContain('if (isLoadingHistory) return "Loading";');
  });

  it("does not reintroduce the deleted proactive Gmail connect/nudge cards", () => {
    expect(source).not.toContain("AgentConnectAccessCard");
    expect(source).not.toContain("AgentGmailNudgeCard");
    expect(source).not.toContain("gmailConnectCardDismissed");
    expect(source).not.toContain("gmailNudgeCardDismissed");
  });
});

describe("Agent One proactive Calendar cards wiring contract", () => {
  // Calendar's separate proactive cards were intentionally removed when the
  // shared chat shell was tightened to prevent setup noise and clipping. The
  // connected Calendar capability remains available through explicit chat
  // requests and the generic governed confirmation card below.
  it("does not mount the retired proactive Calendar surface", () => {
    expect(source).not.toContain(
      'import { AgentCalendarEventCard } from "@/components/agent/agent-calendar-event-card"',
    );
    expect(source).not.toContain(
      'import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status"',
    );
    expect(source).not.toContain(
      'import { useCalendarUpcomingEvents } from "@/lib/calendar/use-calendar-upcoming-events"',
    );
    expect(source).not.toContain("<AgentCalendarEventCard");
    expect(source).not.toContain('title="See what\'s coming up"');
  });

  it("keeps Calendar available through explicit governed directives", () => {
    expect(source).toContain("getCalendarDirectiveFromToolEvent");
    expect(source).toContain("runCalendarDirective");
    expect(source).toContain("GoogleCalendarService");
    expect(source).toContain('delegateAgentId === "agent_calendar"');
  });
});

// The in-chat, agent-initiated Calendar directive stays explicit and governed,
// but uses the shared confirmation surface. This keeps one interaction model
// for specialist actions and avoids reintroducing the retired proactive cards.
describe("Agent One in-chat Calendar directive cards wiring contract", () => {
  it("keeps Calendar directive parsing bounded to explicit action payloads", () => {
    const parserStart = source.indexOf(
      "export function getCalendarDirectiveFromToolEvent",
    );
    const parserEnd = source.indexOf(
      "function getConsentActionsPayload",
      parserStart,
    );
    const parser = source.slice(parserStart, parserEnd);
    expect(parser).toContain('type: "calendar.connect"');
    expect(parser).toContain('type: "calendar.execute_proposal"');
    expect(parser).toContain("proposalId");
    expect(parser).toContain("confirmLabel");
  });

  const normalized = source.replace(/\s+/g, " ");

  it("renders one generic governed confirmation surface for Calendar directives", () => {
    expect(normalized).toContain(
      'pendingSpecialistDirective.delegateAgentId === "agent_calendar" ? ( <SpecialistDirectiveCard',
    );
  });

  it("keeps Calendar connection confirmation on the existing OAuth path", () => {
    const connectIndex = normalized.indexOf('type === "calendar.connect"');
    const block = normalized.slice(connectIndex, connectIndex + 1200);
    expect(block).toContain("GoogleCalendarService.startConnect(");
    expect(block).toContain("clearCalendarSetupOAuthReturn();");
  });

  it("routes explicit proposal confirmation through the existing action queue", () => {
    const proposalIndex = normalized.indexOf(
      'type !== "calendar.execute_proposal"',
    );
    const block = normalized.slice(proposalIndex, proposalIndex + 900);
    expect(block).toContain(
      "enqueueCalendarDirective(directive, token, user.uid);",
    );
  });
});
