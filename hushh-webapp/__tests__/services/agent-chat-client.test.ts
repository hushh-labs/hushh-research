import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTransport = vi.hoisted(() => ({
  runAgent: vi.fn(),
  outcome: "success" as "success" | "interrupt",
}));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(public config: unknown) {}
    abortRun() {}
    async runAgent(parameters: unknown, subscriber: Record<string, (input: any) => void>) {
      mockTransport.runAgent(parameters, this.config);
      subscriber.onRunStartedEvent?.({ event: { type: "RUN_STARTED" } });
      subscriber.onTextMessageContentEvent?.({
        event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      });
      subscriber.onActivitySnapshotEvent?.({
        event: {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "activity-1",
          activityType: "one.scope_discovery.v1",
          content: {
            status: "ok",
            person: {
              displayName: "Alex Morgan",
              profilePath: "/people/1234567890abcdef",
              relationship: "connected",
            },
            requestableScopes: [],
          },
        },
      });
      if (mockTransport.outcome === "interrupt") {
        subscriber.onRunFinishedEvent?.({
          event: { type: "RUN_FINISHED" },
          outcome: "interrupt",
          interrupts: [{ id: "interrupt-1", toolCallId: "tool-1" }],
        });
        return;
      }
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
  beforeEach(() => {
    mockTransport.runAgent.mockClear();
    mockTransport.outcome = "success";
  });

  it("uses the canonical endpoint and official run fields", async () => {
    const tokens: string[] = [];
    const experiences: string[] = [];
    const result = await streamAgentChat({
      userId: "user-1",
      message: "Hello",
      conversationId: "thread-1",
      vaultOwnerToken: "owner-token",
      screenContext: { available_action_ids: [] },
      handlers: {
        onToken: (token) => tokens.push(token),
        onStructuredExperience: (experience) => experiences.push(experience.type),
      },
    });

    expect(result).toEqual({ conversationId: "thread-1", model: null, text: "Hello" });
    expect(tokens).toEqual(["Hello"]);
    expect(experiences).toEqual(["one.scope_discovery.v1"]);
    expect(mockTransport.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [], context: [], forwardedProps: expect.any(Object) }),
      expect.objectContaining({ url: "/api/one/agent-chat", threadId: "thread-1" }),
    );
  });

  it("uses the same AG-UI endpoint before vault unlock", async () => {
    await expect(streamAgentIntro({ message: "What is Hussh?" })).resolves.toMatchObject({
      text: "Hello",
    });
    expect(mockTransport.runAgent.mock.calls[0]?.[1]).toMatchObject({ url: "/api/one/agent-chat" });
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

  it("keeps an interrupted HITL run open instead of reporting completion", async () => {
    mockTransport.outcome = "interrupt";
    const controller = new AbortController();
    const onComplete = vi.fn();
    const onInterrupt = vi.fn(() => controller.abort());

    await streamAgentChat({
      userId: "user-1",
      message: "Request access",
      conversationId: "thread-hitl",
      vaultOwnerToken: "owner-token",
      signal: controller.signal,
      handlers: { onComplete, onInterrupt },
    });

    expect(onInterrupt).toHaveBeenCalledWith({ conversationId: "thread-hitl" });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("parsePendingConsentRequestIds", () => {
  it("reads request ids only from the pending-requests tool and dedupes them", async () => {
    const { parsePendingConsentRequestIds } = await import("@/lib/services/agent-chat-client");
    const content = JSON.stringify({
      status: "ok",
      pendingRequestIds: ["req_1", "req_1", " req_2 ", ""],
      pendingRequests: [{ requestId: "req_1", requesterLabel: "Alex" }],
    });
    expect(parsePendingConsentRequestIds("list_pending_information_requests", content)).toEqual([
      "req_1",
      "req_2",
    ]);
    expect(parsePendingConsentRequestIds("discover_person_information", content)).toEqual([]);
    expect(
      parsePendingConsentRequestIds(
        "list_pending_information_requests",
        JSON.stringify({ status: "failed", pendingRequestIds: ["req_1"] }),
      ),
    ).toEqual([]);
    expect(parsePendingConsentRequestIds("list_pending_information_requests", "not json")).toEqual([]);
  });
});
