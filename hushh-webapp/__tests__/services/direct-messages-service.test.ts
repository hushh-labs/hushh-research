import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const apiFetchStream = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch, apiFetchStream },
}));

import {
  DIRECT_MESSAGE_MAX_LENGTH,
  DirectMessagesService,
  normalizeDirectMessageContent,
} from "@/lib/services/direct-messages-service";

const conversation = {
  id: "conversation-1",
  peerPersonRef: "person-public-ref",
  peerDisplayName: "Priya Nair",
  peerPhotoUrl: null,
  createdAt: "2026-10-02T10:00:00.000Z",
  lastMessageAt: "2026-10-02T10:03:00.000Z",
  latestMessage: {
    id: "message-1",
    conversationId: "conversation-1",
    senderIsViewer: false,
    content: "Hello",
    createdAt: "2026-10-02T10:03:00.000Z",
    readAt: null,
  },
  unreadCount: 1,
};

describe("DirectMessagesService", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetchStream.mockReset();
  });

  it("loads the authenticated inbox without exposing raw peer ids", async () => {
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [conversation], unreadCount: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await DirectMessagesService.listConversations({
      idToken: "firebase-token",
    });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/one/messages/conversations",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    const options = apiFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).get("Authorization")).toBe(
      "Bearer firebase-token",
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        peerPersonRef: "person-public-ref",
        peerDisplayName: "Priya Nair",
        latestMessage: expect.objectContaining({ senderIsViewer: false }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("peerUserId");
  });

  it("sends through a public person reference and validates the response pair", async () => {
    const sentMessage = {
      ...conversation.latestMessage,
      id: "message-2",
      senderIsViewer: true,
      content: "Good morning",
    };
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          conversation: { ...conversation, latestMessage: sentMessage },
          message: sentMessage,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await DirectMessagesService.sendMessage({
      idToken: "firebase-token",
      recipientPersonRef: "person-public-ref",
      content: "  Good morning  ",
      replyToMessageId: "message-1",
    });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/one/messages",
      expect.objectContaining({ method: "POST" }),
    );
    const options = apiFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({
      recipientPersonRef: "person-public-ref",
      content: "Good morning",
      replyToMessageId: "message-1",
    });
    expect(result.message.senderIsViewer).toBe(true);
  });

  it("blocks empty and oversized sends before making a request", async () => {
    expect(() => normalizeDirectMessageContent("   ")).toThrow(
      "Write a message before sending.",
    );
    expect(() =>
      normalizeDirectMessageContent("x".repeat(DIRECT_MESSAGE_MAX_LENGTH + 1)),
    ).toThrow("Messages can be up to");

    await expect(
      DirectMessagesService.sendMessage({
        idToken: "firebase-token",
        recipientPersonRef: "person-public-ref",
        content: "   ",
      }),
    ).rejects.toThrow("Write a message before sending.");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows the server's accepted-connection refusal clearly", async () => {
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: "DIRECT_MESSAGE_CONNECTION_REQUIRED",
            message: "You can only message an accepted connection.",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      DirectMessagesService.sendMessage({
        idToken: "firebase-token",
        recipientPersonRef: "person-public-ref",
        content: "Hello",
      }),
    ).rejects.toThrow("You can only message an accepted connection.");
  });

  it("sends edit, deletion, and reaction actions through participant-scoped routes", async () => {
    const ownMessage = {
      ...conversation.latestMessage,
      senderIsViewer: true,
      reactions: [{ emoji: "😀", count: 1, reactedByViewer: true }],
    };
    apiFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { ...ownMessage, content: "Edited" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ scope: "me", message: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: ownMessage }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await DirectMessagesService.editMessage({
      idToken: "firebase-token",
      conversationId: "conversation-1",
      messageId: "message-1",
      content: " Edited ",
    });
    await DirectMessagesService.deleteMessage({
      idToken: "firebase-token",
      conversationId: "conversation-1",
      messageId: "message-1",
      scope: "me",
    });
    const reacted = await DirectMessagesService.reactToMessage({
      idToken: "firebase-token",
      conversationId: "conversation-1",
      messageId: "message-1",
      emoji: "😀",
    });

    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      "/api/one/messages/conversations/conversation-1/messages/message-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/one/messages/conversations/conversation-1/messages/message-1?scope=me",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      3,
      "/api/one/messages/conversations/conversation-1/messages/message-1/reaction",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(reacted.reactions).toEqual([{ emoji: "😀", count: 1, reactedByViewer: true }]);
  });

  it("uses the authenticated metadata-only realtime stream", async () => {
    const response = new Response(null, { status: 200 });
    apiFetchStream.mockResolvedValue(response);

    await expect(
      DirectMessagesService.openEvents({ idToken: "firebase-token" }),
    ).resolves.toBe(response);
    expect(apiFetchStream).toHaveBeenCalledWith(
      "/api/one/messages/events",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it.each(["scope", "conversation", "message"] as const)("rejects a deletion acknowledgement with mismatched %s", async (mismatch) => {
    const message = { ...conversation.latestMessage, senderIsViewer: true, deletedForEveryoneAt: "2026-10-06T10:01:00.000Z" };
    apiFetch.mockResolvedValue(new Response(JSON.stringify({
      scope: mismatch === "scope" ? "me" : "everyone",
      message: { ...message, conversationId: mismatch === "conversation" ? "another-conversation" : message.conversationId,
        id: mismatch === "message" ? "another-message" : message.id },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(DirectMessagesService.deleteMessage({
      idToken: "firebase-token", conversationId: "conversation-1", messageId: "message-1", scope: "everyone",
    })).rejects.toThrow("The deleted message could not be verified.");
  });
});
