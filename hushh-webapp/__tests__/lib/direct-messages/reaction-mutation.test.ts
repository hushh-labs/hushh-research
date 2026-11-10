import { describe, expect, it } from "vitest";
import { beginReaction, settleReaction } from "@/lib/direct-messages/reaction-mutation";
import type { DirectMessage } from "@/lib/services/direct-messages-service";

const original: DirectMessage = { id: "message", conversationId: "chat", senderIsViewer: false,
  content: "Before edit", createdAt: "2026-11-09T00:00:00Z", readAt: null, reactions: [] };

describe("reaction mutation ordering", () => {
  it.each([false, true])("keeps concurrent emojis and the latest body when completion succeeds=%s", (success) => {
    const heart = {}, smile = {};
    let message = beginReaction(original, "❤️", heart, false);
    message = beginReaction(message, "🙂", smile, false);
    message = { ...message, content: "Latest edit", readAt: "2026-11-09T00:01:00Z" };
    message = settleReaction(message, "❤️", heart, success ? { ...original, reactions: [{ emoji: "❤️", count: 2, reactedByViewer: true }] } : undefined);
    expect(message.content).toBe("Latest edit");
    expect(message.readAt).toBe("2026-11-09T00:01:00Z");
    expect(message.reactions).toContainEqual({ emoji: "🙂", count: 1, reactedByViewer: true });
    message = settleReaction(message, "🙂", smile);
    expect(message.reactions).toEqual(success ? [{ emoji: "❤️", count: 2, reactedByViewer: true }] : []);
  });

  it("keeps an authoritative projection after an optimistic removal or addition", () => {
    const lease = {};
    for (const removing of [false, true]) {
      const optimistic = beginReaction({ ...original, reactions: [{ emoji: "❤️", count: 1, reactedByViewer: removing }] }, "❤️", lease, removing);
      const latest = { ...optimistic, content: "Remote", reactions: [{ emoji: "❤️", count: 2, reactedByViewer: false }] };
      expect(settleReaction(latest, "❤️", lease)).toBe(latest);
      const deleted = { ...optimistic, deletedForEveryoneAt: "2026-11-09T00:02:00Z" };
      expect(settleReaction(deleted, "❤️", lease).reactions).toEqual([]);
    }
  });
});
