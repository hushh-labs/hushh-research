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
  it("refreshes recent Drive sharing only while chat history is open", () => {
    const sidebar = source.slice(source.indexOf("const renderHistorySidebar ="), source.indexOf("const getEmailDeliveryAuth ="));
    expect(sidebar).toContain('<DriveRecentSharing presentation="sidebar" active={isHistoryDrawerOpen && drawerMode === "chats"} onNeedsReviewChange={onDriveNeedsReviewChange} />');
    expect(source).toContain("open={isHistoryDrawerOpen}");
    expect(source).toContain("chats={renderHistorySidebar(");
    expect(source.match(/<DriveRecentSharing\b/g)).toHaveLength(1);
    expect(source).toContain('Drive ${driveReviewsPending === 1 ? "review needs" : "reviews need"} you');
  });

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

  it("runs post-setup onboarding as ordinary chat turns, with the tile grid retired", () => {
    // Founder decision (2026-09-27): the first message is fixed text typed out
    // through the same AgentBubble path as a real reply, then three questions
    // in chat. The old PostSetupWelcomeCard and its connector/agent tiles are
    // gone; a regression back to a card would reintroduce either name.
    expect(source).not.toContain("function PostSetupWelcomeCard(");
    expect(source).not.toContain("AgentFirstRunActions");
    expect(source).toMatch(
      // A centered time separator may open the group; the turn itself is still
      // the workspace's own AgentBubble.
      /renderBubble=\{\(message: ChatOnboardingBubbleMessage\) => \((?:(?!renderBubble)[\s\S]){0,400}?<AgentBubble message=\{message\} \/>/,
    );
    // Only an explicitly armed name answer is kept from the model; everything
    // else typed in the composer is an ordinary turn.
    const submit = source.slice(
      source.indexOf("const submitComposerText = async () => {"),
      source.indexOf("const handleSubmit = async"),
    );
    expect(submit).toContain("chatOnboarding.captureComposerText(typedText)");
    expect(submit.indexOf("chatOnboarding.captureComposerText")).toBeLessThan(
      submit.indexOf("transcriptUserScrollRef.current = false;"),
    );
    // Returning people with an empty chat keep the welcome panel and starters.
    expect(source).toContain("<AgentWelcomePanel");
    expect(source).toContain("prompts={welcomePrompts}");
  });

  it("keeps the dedicated-route history sidebar honest while it loads", () => {
    expect(source).toContain("setIsLoadingHistory(true);");
    expect(source).toContain("setIsLoadingHistory(false);");
    expect(source).toContain("warmAgentChatHistoryCache({");
    expect(source).toContain(
      'loading={isPuppySurface ? false : (isLoadingHistory && conversations.length === 0)}',
    );
  });

  it("keeps the One connector catalog reachable before any provider is connected", () => {
    expect(source).toContain("onOpenConnectors={!isPuppySurface");
    expect(source).toContain("openConnectorSurface(undefined, trigger)");
    expect(source).not.toContain("connectionsAvailable");
    expect(source).toContain("initialConnector={connectorPanelInitialConnector}");
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
    // Connect goes through the shared in-place connector (no chat redirect).
    expect(source).toContain("connectCalendarInPlace");
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

  it("keeps Calendar connection confirmation in place on the shared OAuth path", () => {
    const connectIndex = normalized.indexOf('type === "calendar.connect"');
    const block = normalized.slice(connectIndex, connectIndex + 1200);
    expect(block).toContain('runDirectiveConnect("calendar");');
    expect(block).not.toContain("location.assign");
    // The shared connector still owns the existing Calendar start + journey reset.
    const shared = readFileSync(
      join(process.cwd(), "lib/connections/google-connect-in-place.ts"),
      "utf8",
    );
    expect(shared).toContain("GoogleCalendarService.startConnect(");
    expect(shared).toContain("clearCalendarSetupOAuthReturn();");
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
