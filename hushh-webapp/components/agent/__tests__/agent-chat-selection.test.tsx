import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionChip } from "@/components/agent/selection-chip";
import { storedMessageToAgentMessage } from "@/components/agent/agent-chat-workspace";
import type { AgentChatMessage } from "@/lib/services/agent-chat-client";

// History mapping is the load-bearing behavior: on reload a persisted selection
// must become a chip (kind:"selection") showing the clean display label, never
// the raw `I selected:` seed. These tests exercise the real mapping helper the
// workspace uses to hydrate history.
describe("storedMessageToAgentMessage — selection history mapping", () => {
  const base = {
    id: "m1",
    conversation_id: "c1",
    status: "complete" as const,
    created_at: null,
    completed_at: null,
  };

  it("maps a selection message to a chip using metadata.display, not the raw seed", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content: "I selected: {recipientKeyId:abc123}",
      metadata: { kind: "selection", display: "Abdul Zalil" },
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped).not.toBeNull();
    expect(mapped?.kind).toBe("selection");
    expect(mapped?.text).toBe("Abdul Zalil");
    expect(mapped?.text).not.toContain("I selected:");
  });

  it("does not treat plain assistant/user messages as selection chips", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "assistant",
      content: "Here is your answer.",
      metadata: null,
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.kind).toBeUndefined();
    expect(mapped?.text).toBe("Here is your answer.");
  });

  it("falls back gracefully to content when a selection lacks a display label", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content: "Cancelled",
      metadata: { kind: "selection" },
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.kind).toBe("selection");
    expect(mapped?.text).toBe("Cancelled");
  });

  it("drops non user/assistant roles", () => {
    const stored = {
      ...base,
      role: "system",
      content: "system prompt",
      metadata: null,
    } as unknown as AgentChatMessage;
    expect(storedMessageToAgentMessage(stored)).toBeNull();
  });
});

describe("SelectionChip render branch", () => {
  it("renders a chip for a selection message label", () => {
    render(<SelectionChip label="Abdul Zalil" />);
    const chip = screen.getByTestId("selection-chip");
    expect(chip.textContent).toContain("Abdul Zalil");
  });
});
