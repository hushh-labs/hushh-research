import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgent = vi.fn();

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(public config: unknown) {}
    abortRun() {}
    async runAgent(parameters: unknown, subscriber: Record<string, (input: any) => void>) {
      runAgent(parameters, this.config);
      subscriber.onRunStartedEvent?.({ event: { type: "RUN_STARTED" } });
      subscriber.onTextMessageContentEvent?.({
        event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      });
      subscriber.onRunFinishedEvent?.({
        event: { type: "RUN_FINISHED" },
        outcome: "success",
      });
    }
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetchStream: vi.fn(),
    listAgentChatConversations: vi.fn(),
    getAgentChatHistory: vi.fn(),
    renameAgentChatConversation: vi.fn(),
    deleteAgentChatConversation: vi.fn(),
  },
}));

import {
  formatAgentChatErrorMessage,
  streamAgentChat,
  streamAgentIntro,
} from "@/lib/services/agent-chat-client";

describe("AG-UI Agent One client", () => {
  beforeEach(() => runAgent.mockClear());

  it("uses the canonical endpoint and official run fields", async () => {
    const tokens: string[] = [];
    const result = await streamAgentChat({
      userId: "user-1",
      message: "Hello",
      conversationId: "thread-1",
      vaultOwnerToken: "owner-token",
      screenContext: { available_action_ids: [] },
      handlers: { onToken: (token) => tokens.push(token) },
    });

    expect(result).toEqual({ conversationId: "thread-1", model: null, text: "Hello" });
    expect(tokens).toEqual(["Hello"]);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [], context: [], forwardedProps: expect.any(Object) }),
      expect.objectContaining({ url: "/api/one/agent-chat", threadId: "thread-1" }),
    );
  });

  it("uses the same AG-UI endpoint before vault unlock", async () => {
    await expect(streamAgentIntro({ message: "What is Hussh?" })).resolves.toMatchObject({
      text: "Hello",
    });
    expect(runAgent.mock.calls[0]?.[1]).toMatchObject({ url: "/api/one/agent-chat" });
  });

  it("never exposes unknown AG-UI runtime errors to the transcript", () => {
    const raw =
      'DB operation failed [<raw_sql>.execute_raw]: INSERT INTO one_adk_sessions [parameters: {"user":"owner-1","ciphertext":"secret"}]';

    const visible = formatAgentChatErrorMessage(raw);

    expect(visible).toBe("One couldn't complete that response. Please try again.");
    expect(visible).not.toContain("one_adk_sessions");
    expect(visible).not.toContain("owner-1");
    expect(visible).not.toContain("ciphertext");
  });

  it("maps typed database failures to stable actionable copy", () => {
    expect(
      formatAgentChatErrorMessage("private database detail", "DATABASE_EXECUTION_ERROR"),
    ).toBe("One's conversation history is temporarily unavailable. Please try again.");
  });
});
