import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    streamAgentChat: vi.fn(),
    listAgentChatConversations: vi.fn(),
    getAgentChatHistory: vi.fn(),
    renameAgentChatConversation: vi.fn(),
    deleteAgentChatConversation: vi.fn(),
  },
}));

import {
  deleteAgentChatConversation,
  getAgentChatHistory,
  listAgentChatConversations,
  renameAgentChatConversation,
  streamAgentChat,
} from "@/lib/services/agent-chat-client";
import { ApiService } from "@/lib/services/api-service";

function sseResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...headers,
    },
  });
}

describe("agent chat client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("streams simple token SSE frames", async () => {
    vi.spyOn(ApiService, "streamAgentChat").mockResolvedValue(
      sseResponse(
        [
          'event: start\ndata: {"conversation_id":"conversation-1","model":"gemini-2.5-pro"}\n\n',
          'event: token\ndata: {"token":"Hel"}\n\n',
          'event: token\ndata: {"token":"lo"}\n\n',
          'event: complete\ndata: {"conversation_id":"conversation-1","model":"gemini-2.5-pro"}\n\n',
        ],
        {
          "X-Agent-Conversation-Id": "conversation-1",
          "X-Agent-Model": "gemini-2.5-pro",
        }
      )
    );
    const tokens: string[] = [];
    const starts: string[] = [];
    const completes: string[] = [];

    const result = await streamAgentChat({
      userId: "user-1",
      message: "Hello",
      vaultOwnerToken: "vault-token",
      handlers: {
        onStart: ({ conversationId }) => starts.push(conversationId),
        onToken: (token) => tokens.push(token),
        onComplete: ({ conversationId }) => completes.push(conversationId),
      },
    });

    expect(result).toEqual({
      conversationId: "conversation-1",
      model: "gemini-2.5-pro",
      text: "Hello",
    });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(starts).toEqual(["conversation-1"]);
    expect(completes).toEqual(["conversation-1"]);
    expect(ApiService.streamAgentChat).toHaveBeenCalledWith({
      userId: "user-1",
      message: "Hello",
      conversationId: undefined,
      vaultOwnerToken: "vault-token",
      pkmContext: undefined,
      signal: undefined,
    });
  });

  it("streams live tool events alongside token frames", async () => {
    vi.spyOn(ApiService, "streamAgentChat").mockResolvedValue(
      sseResponse([
        'event: start\ndata: {"conversation_id":"conversation-1","model":"gemini-2.5-pro"}\n\n',
        'event: tool_start\ndata: {"call_id":"tool_1","action_id":"analysis.start","label":"Start analysis for NVDA","execution":"frontend","slots":{"symbol":"NVDA"},"message":"Starting Kai analysis for NVDA."}\n\n',
        'event: tool_waiting\ndata: {"call_id":"tool_1","action_id":"analysis.start","label":"Start analysis for NVDA","execution":"frontend","slots":{"symbol":"NVDA"},"message":"Starting Kai analysis for NVDA.","status":"waiting_for_frontend"}\n\n',
        'event: token\ndata: {"token":"Starting NVDA."}\n\n',
        'event: complete\ndata: {"conversation_id":"conversation-1","model":"gemini-2.5-pro"}\n\n',
      ])
    );
    const starts: string[] = [];
    const waits: string[] = [];

    const result = await streamAgentChat({
      userId: "user-1",
      message: "Start analysis of Nvidia",
      vaultOwnerToken: "vault-token",
      handlers: {
        onToolStart: (event) => {
          starts.push(`${event.actionId}:${event.slots.symbol}`);
        },
        onToolWaiting: (event) => {
          waits.push(event.status || "");
        },
      },
    });

    expect(result.text).toBe("Starting NVDA.");
    expect(starts).toEqual(["analysis.start:NVDA"]);
    expect(waits).toEqual(["waiting_for_frontend"]);
  });

  it("throws backend JSON errors before reading the stream", async () => {
    vi.spyOn(ApiService, "streamAgentChat").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Vault locked" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      streamAgentChat({
        userId: "user-1",
        message: "Hello",
        vaultOwnerToken: "vault-token",
      })
    ).rejects.toThrow("Vault locked");
  });

  it("throws streamed backend error events after notifying the handler", async () => {
    vi.spyOn(ApiService, "streamAgentChat").mockResolvedValue(
      sseResponse([
        'event: start\ndata: {"conversation_id":"conversation-1","model":"gemini-2.5-pro"}\n\n',
        'event: token\ndata: {"token":"Partial"}\n\n',
        'event: error\ndata: {"message":"Agent chat failed. Please try again."}\n\n',
      ])
    );
    const errors: string[] = [];

    await expect(
      streamAgentChat({
        userId: "user-1",
        message: "Hello",
        vaultOwnerToken: "vault-token",
        handlers: {
          onError: (message) => errors.push(message),
        },
      })
    ).rejects.toThrow("Agent chat failed. Please try again.");
    expect(errors).toEqual(["Agent chat failed. Please try again."]);
  });

  it("reads recent conversations and history", async () => {
    vi.spyOn(ApiService, "listAgentChatConversations").mockResolvedValue(
      new Response(
        JSON.stringify({
          conversations: [{ id: "conversation-1", title: "Hello", message_count: 2 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.spyOn(ApiService, "getAgentChatHistory").mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "message-1",
              conversation_id: "conversation-1",
              role: "user",
              status: "complete",
              content: "Hello",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      listAgentChatConversations({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        limit: 1,
      })
    ).resolves.toMatchObject([{ id: "conversation-1", title: "Hello" }]);
    await expect(
      getAgentChatHistory({
        conversationId: "conversation-1",
        vaultOwnerToken: "vault-token",
      })
    ).resolves.toMatchObject([{ id: "message-1", content: "Hello" }]);
  });

  it("renames and deletes conversations", async () => {
    vi.spyOn(ApiService, "renameAgentChatConversation").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "conversation-1",
          title: "Renamed chat",
          status: "active",
          message_count: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.spyOn(ApiService, "deleteAgentChatConversation").mockResolvedValue(
      new Response(JSON.stringify({ conversation_id: "conversation-1", deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      renameAgentChatConversation({
        conversationId: "conversation-1",
        title: "Renamed chat",
        vaultOwnerToken: "vault-token",
      })
    ).resolves.toMatchObject({ id: "conversation-1", title: "Renamed chat" });
    await expect(
      deleteAgentChatConversation({
        conversationId: "conversation-1",
        vaultOwnerToken: "vault-token",
      })
    ).resolves.toEqual({ conversation_id: "conversation-1", deleted: true });
  });
});
