import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const apiFetchStream = vi.hoisted(() => vi.fn());
const clearRead = vi.hoisted(() => vi.fn());
const activeKey = vi.hoisted(() => vi.fn(() => "fixture-key"));
vi.mock("@/lib/notifications/preview-keys", () => ({ activeNotificationKeyId: activeKey }));
vi.mock("@/lib/notifications/chat-system-notifications", () => ({ ChatSystemNotifications: { clearRead } }));

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
    clearRead.mockReset(); activeKey.mockReset().mockReturnValue("fixture-key");
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

  it("forwards the retry identity and the owner-scoped read boundary without clearing later same-millisecond alerts", async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ conversation, message: conversation.latestMessage })));
    await DirectMessagesService.sendMessage({ idToken: "fixture", recipientPersonRef: "person-public-ref", content: "Hello", clientMessageId: "retry-uuid" });
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toMatchObject({ clientMessageId: "retry-uuid" });
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ readCount: 1, readAt: "2026-10-09T10:00:01Z", readThroughCreatedAt: "2026-10-09T10:00:00.123456Z" })));
    await DirectMessagesService.markConversationRead({ idToken: "fixture", ownerUserId: "alice", conversationId: "conversation-1", throughMessageId: "message-1", throughCreatedAt: "2026-10-09T09:00:00Z" });
    expect(activeKey).toHaveBeenCalledWith("alice");
    expect(apiFetch.mock.calls[1]![0]).toBe("/api/one/messages/conversations/conversation-1/read?throughMessageId=message-1");
    expect(clearRead).toHaveBeenCalledWith({ keyId: "fixture-key", threadId: "conversation-1", messageId: "direct-message:message-1", before: Date.parse("2026-10-09T10:00:00.123Z") - 1 });
    activeKey.mockReturnValue(null as unknown as string);
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ readCount: 0 })));
    await DirectMessagesService.markConversationRead({ idToken: "old-owner", ownerUserId: "alice", conversationId: "conversation-1", throughMessageId: "message-1" });
    expect(clearRead).toHaveBeenCalledTimes(1);
  });
});


describe("encrypted selection navigation", () => {
  it("puts only the server token in the browser href", async () => {
    apiFetch.mockResolvedValue(Response.json({ token: "dm1.opaque", kind: "conversation", ref: "internal-id" }));
    expect(await DirectMessagesService.routeHref({ idToken: "auth", conversationId: "internal-id" })).toBe("/one/messages?token=dm1.opaque");
    expect(apiFetch).toHaveBeenLastCalledWith("/api/one/messages/route-token", expect.objectContaining({ method: "POST", body: JSON.stringify({ conversationId: "internal-id" }), cache: "no-store" }));
  });
});
