import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { CacheService } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { DirectMessagesResourceService as resource, type DirectMessageThread } from "@/lib/services/direct-messages-resource-service";
import { dispatchDirectMessagesUpdated, subscribeToDirectMessagesUpdated } from "@/lib/direct-messages/direct-message-events";

const thread: DirectMessageThread = {
  conversation: { id: "chat", peerPersonRef: "person", peerDisplayName: "Synthetic Person", peerPhotoUrl: null,
    createdAt: "2026-10-01T10:00:00Z", lastMessageAt: null, latestMessage: null, unreadCount: 0 },
  peerPersonRef: "person", peerDisplayName: "Synthetic Person", peerPhotoUrl: null,
  canSend: true, disconnectedNotice: null, nextBefore: null,
};
const message = { id: "row", conversationId: "chat", content: "Synthetic history", senderIsViewer: true, createdAt: "2026-10-01T10:00:00Z", readAt: null };

describe("DirectMessagesResourceService", () => {
  beforeEach(() => CacheService.getInstance().clear());
  afterEach(() => vi.useRealTimers());

  it("isolates owners and restores aliases without caching send permission", () => {
    resource.writeThread("owner-a", resource.beginRequest("owner-a"), "person:person", thread, [message]);
    expect(resource.readThread("owner-a", "conversation:chat")).toMatchObject({ messages: [message], thread: { canSend: false } });
    expect(resource.readThread("owner-b", "person:person")).toBeNull();
  });

  it("distinguishes a confirmed empty transcript from a miss and expires individual entries", () => {
    vi.useFakeTimers();
    resource.writeThread("owner", resource.beginRequest("owner"), "person:person", thread, []);
    expect(resource.readThread("owner", "person:person")?.messages).toEqual([]);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(resource.readThread("owner", "person:person")).toBeNull();
  });

  it.each(["sign-out", "clear", "message-change"])("fences late writes after %s", (reason) => {
    const session = resource.beginRequest("owner");
    resource.writeThread("owner", session, "person:person", thread, [message]);
    resource.writeRoute("owner", session, { token: "dm1.test", kind: "person", ref: "person" });
    if (reason === "sign-out") CacheService.getInstance().invalidateUser("owner");
    else if (reason === "clear") CacheService.getInstance().clear();
    else CacheSyncService.onDirectMessagesMutated("owner");
    // A new session must not revive an old request's authority to populate memory.
    resource.beginRequest("owner");
    resource.writeThread("owner", session, "person:person", thread, [message]);
    expect(resource.readThread("owner", "person:person")).toBeNull();
    if (reason !== "message-change") expect(resource.readRoute("owner", "dm1.test")).toBeNull();
  });

  it("retains a valid message-id pagination cursor when bounding a large snapshot", () => {
    const messages = Array.from({ length: 601 }, (_, index) => ({ ...message, id: `row-${index}` }));
    resource.writeThread("owner", resource.beginRequest("owner"), "person:person", thread, messages);
    const snapshot = resource.readThread("owner", "person:person");
    expect(snapshot?.messages).toHaveLength(600);
    expect(snapshot?.thread.nextBefore).toBe("row-1");
  });

  it("invalidates a message event once before multiple consumers start new requests", () => {
    const first = subscribeToDirectMessagesUpdated(() => {
      resource.writeThread("owner", resource.beginRequest("owner"), "person:person", thread, [message]);
    });
    const second = subscribeToDirectMessagesUpdated(() => undefined);
    try {
      dispatchDirectMessagesUpdated({ userId: "owner", conversationId: "chat", messageId: "event-once", source: "sse" });
      expect(resource.readThread("owner", "person:person")?.messages).toEqual([message]);
    } finally { first(); second(); }
  });
});
