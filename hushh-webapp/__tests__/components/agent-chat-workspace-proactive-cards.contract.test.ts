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
  it("uses one accessible quick-prompt rail for both empty and post-setup states", () => {
    expect(source).toContain("function AgentPromptSuggestions(");
    expect(source).toContain('data-testid="agent-chat-suggestions"');
    expect(source).toContain('aria-label="Suggestions"');
    expect(source).toContain("variant=\"pill\"");
    expect(source).toContain("onClick={() => onPromptSelect(prompt)}");
    expect(source).toContain("setInput(prompt)");
  });

  it("keeps the dedicated-route history sidebar honest while it loads", () => {
    expect(source).toContain("setIsLoadingHistory(true);");
    expect(source).toContain("setIsLoadingHistory(false);");
    expect(source).toContain("warmAgentChatHistoryCache({");
    expect(source).toContain('loading={isLoadingHistory && conversations.length === 0}');
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
