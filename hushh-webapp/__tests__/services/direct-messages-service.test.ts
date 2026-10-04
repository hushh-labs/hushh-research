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
    });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/one/messages",
      expect.objectContaining({ method: "POST" }),
    );
    const options = apiFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({
      recipientPersonRef: "person-public-ref",
      content: "Good morning",
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
});
