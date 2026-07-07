import { describe, expect, it } from "vitest";

import {
  dedupeAdjacentAgentMessages,
  releaseAgentTurnSubmitLock,
  tryAcquireAgentTurnSubmitLock,
  type AgentChatDedupeMessage,
} from "@/lib/agent/agent-chat-turn-safety";

const baseMessage: AgentChatDedupeMessage = {
  role: "user",
  text: "What needs a reply today?",
  timestamp: "6:35 PM",
};

describe("agent chat turn safety", () => {
  it("collapses adjacent persisted duplicates with the same role, timestamp, and text", () => {
    const messages = dedupeAdjacentAgentMessages([
      baseMessage,
      { ...baseMessage, text: "  What needs   a reply today? " },
      { ...baseMessage, role: "assistant", text: "Here are the emails." },
    ]);

    expect(messages).toEqual([
      baseMessage,
      { ...baseMessage, role: "assistant", text: "Here are the emails." },
    ]);
  });

  it("keeps distinct messages and active stream/directive messages", () => {
    const directive = { kind: "prompt" };
    const messages: AgentChatDedupeMessage[] = [
      baseMessage,
      { ...baseMessage, timestamp: "6:36 PM" },
      { ...baseMessage, specialistDirective: directive },
      { ...baseMessage, streamEvents: [{ id: "progress" }] },
    ];

    expect(dedupeAdjacentAgentMessages(messages)).toEqual(messages);
  });

  it("blocks same-tick submissions until the active turn releases the lock", () => {
    const lock = { current: false };

    expect(tryAcquireAgentTurnSubmitLock(lock)).toBe(true);
    expect(tryAcquireAgentTurnSubmitLock(lock)).toBe(false);
    releaseAgentTurnSubmitLock(lock);
    expect(tryAcquireAgentTurnSubmitLock(lock)).toBe(true);
  });
});
