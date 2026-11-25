import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBubble } from "@/components/agent/workspace/agent-bubble";
import {
  storedMessageToAgentMessage,
  type AgentMessage,
} from "@/components/agent/workspace/agent-message-transforms";
import { advanceToNaturalWordBoundary } from "@/components/agent/workspace/use-animated-stream-text";
import {
  aliasAgentThoughtSummaryServerId,
  appendThinkingSummaryChunk,
  clearAgentThoughtSummariesForTests,
  setAgentThoughtSummary,
} from "@/lib/agent/agent-thought-summary-store";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  advanceVaultSessionEpoch,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

describe("AgentBubble thought process trigger and modal/sheet", () => {
  beforeEach(() => {
    clearAgentThoughtSummariesForTests();
    publishValidatedAuthSessionOwner("owner-1");
  });

  afterEach(() => {
    clearAgentThoughtSummariesForTests();
    publishValidatedAuthSessionOwner(null);
    vi.restoreAllMocks();
  });

  it("omits the top-right info icon when the model emits no thought summary", () => {
    const message: AgentMessage = {
      id: "msg-no-thought",
      role: "assistant",
      text: "Hey there! How can I help?",
      timestamp: "10:00 AM",
      status: "done",
    };

    render(<AgentBubble message={message} />);

    expect(
      screen.queryByTestId("agent-bubble-thought-trigger"),
    ).not.toBeInTheDocument();
  });

  it("shows the top-right info icon when thoughts exist and opens the thought process modal on click", () => {
    const message: AgentMessage = {
      id: "msg-with-thought",
      role: "assistant",
      text: "QUIC multiplexes independent streams over UDP.",
      thinkingSummary:
        "**Comparing Transports**\n\nHighlighting how QUIC avoids TCP head-of-line blocking.",
      timestamp: "10:01 AM",
      status: "done",
    };

    render(<AgentBubble message={message} />);

    const trigger = screen.getByTestId("agent-bubble-thought-trigger");
    expect(trigger).toHaveAttribute("aria-label", "View thought process");

    fireEvent.click(trigger);

    expect(screen.getByTestId("agent-thought-process-sheet")).toBeInTheDocument();
    expect(screen.getByText("Thought process")).toBeInTheDocument();
    expect(screen.getByText("Comparing Transports")).toBeInTheDocument();
    expect(
      screen.getByText(/Highlighting how QUIC avoids TCP head-of-line blocking/),
    ).toBeInTheDocument();
  });

  it("surfaces the live thought trigger while thinking before response text arrives", () => {
    const message: AgentMessage = {
      id: "msg-live-thought",
      role: "assistant",
      text: "",
      thinkingSummary: "**Analyzing Request**\n\nBreaking down the steps.",
      isThinkingStreaming: true,
      timestamp: "10:02 AM",
      status: "streaming",
    };

    render(<AgentBubble message={message} />);

    const trigger = screen.getByTestId("agent-bubble-thought-trigger");
    expect(trigger).toHaveAttribute("aria-label", "View live thought process");
    expect(trigger).toHaveAttribute("data-streaming", "true");

    fireEvent.click(trigger);
    expect(screen.getByTestId("agent-thought-streaming-badge")).toHaveTextContent(
      "Live",
    );
  });

  it("hides thought summaries on consent-shared or redacted-receipt bubbles", () => {
    const consentMessage: AgentMessage = {
      id: "msg-consent",
      role: "assistant",
      text: "Shared answer.",
      thinkingSummary: "Should stay hidden on shared answers.",
      consentBundleId: "bundle-1",
      timestamp: "10:03 AM",
      status: "done",
    };
    const redactedMessage: AgentMessage = {
      id: "msg-receipt",
      role: "assistant",
      text: "Receipt summary.",
      thinkingSummary: "Should stay hidden on private receipt answers.",
      receiptRedacted: true,
      timestamp: "10:04 AM",
      status: "done",
    };

    const { rerender } = render(<AgentBubble message={consentMessage} />);
    expect(
      screen.queryByTestId("agent-bubble-thought-trigger"),
    ).not.toBeInTheDocument();

    rerender(<AgentBubble message={redactedMessage} />);
    expect(
      screen.queryByTestId("agent-bubble-thought-trigger"),
    ).not.toBeInTheDocument();
  });

  it("restores session-bound thought summaries by serverMessageId and purges on vault epoch change", () => {
    const epoch = snapshotVaultSessionEpoch();
    setAgentThoughtSummary({
      ownerId: "owner-1",
      vaultEpoch: epoch,
      conversationId: "conv-1",
      messageId: "msg-local-1",
      text: "**Step 1**\n\nChecked context.",
    });
    aliasAgentThoughtSummaryServerId({
      conversationId: "conv-1",
      messageId: "msg-local-1",
      serverMessageId: "evt-server-1",
    });

    const restored = storedMessageToAgentMessage({
      id: "evt-server-1",
      conversation_id: "conv-1",
      role: "assistant",
      status: "complete",
      content: "Final answer.",
      created_at: "2026-11-22T18:00:00Z",
    });
    expect(restored?.thinkingSummary).toBe("**Step 1**\n\nChecked context.");

    advanceVaultSessionEpoch();
    const afterLock = storedMessageToAgentMessage({
      id: "evt-server-1",
      conversation_id: "conv-1",
      role: "assistant",
      status: "complete",
      content: "Final answer.",
      created_at: "2026-11-22T18:00:00Z",
    });
    expect(afterLock?.thinkingSummary).toBeUndefined();
  });

  it("preserves surrogate pairs and separates consecutive multi-step thought headings cleanly", () => {
    const emojiText = "Hello 👋 world";
    // Index 7 splits the surrogate pair of 👋 (`\uD83D\uDC4B` at indices 6..7)
    const boundary = advanceToNaturalWordBoundary(emojiText, 0, 7);
    expect(emojiText.slice(0, boundary)).not.toContain("\uFFFD");
    expect(boundary).toBeGreaterThanOrEqual(8);

    const merged = appendThinkingSummaryChunk(
      "**First Step**\n\nChecked the request.",
      "**Second Step**\n\nFormulating the answer.",
    );
    expect(merged).toBe(
      "**First Step**\n\nChecked the request.\n\n**Second Step**\n\nFormulating the answer.",
    );
  });
});
