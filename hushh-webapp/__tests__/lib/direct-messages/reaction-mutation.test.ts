import { describe, expect, it } from "vitest";
import { beginReaction, reconcileReactions, settleReaction } from "@/lib/direct-messages/reaction-mutation";
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

  it.each([false, true])("rebases a pending removal against refreshed counts, success=%s", (success) => {
    const token = {};
    const before = { ...original, reactions: [{ emoji: "❤️", count: 1, reactedByViewer: true }] };
    const pending = beginReaction(before, "❤️", token, true);
    const refreshed = { ...before, content: "Remote edit", reactions: [{ emoji: "❤️", count: 4, reactedByViewer: true }] };
    let current = reconcileReactions(pending, refreshed);
    expect(current.reactions).toEqual([{ emoji: "❤️", count: 3, reactedByViewer: false }]);
    current = settleReaction(current, "❤️", token, success ? { ...refreshed, reactions: [{ emoji: "❤️", count: 3, reactedByViewer: false }] } : undefined);
    expect(current.reactions).toEqual([{ emoji: "❤️", count: success ? 3 : 4, reactedByViewer: !success }]);
    expect(current.content).toBe("Remote edit");
  });

  it.each([false, true])("keeps concurrent intent through another emoji's completion, success=%s", (success) => {
    const heart = {}, smile = {};
    let current = beginReaction(original, "❤️", heart, false);
    current = beginReaction(current, "🙂", smile, false);
    const saved = { ...original, reactions: [{ emoji: "❤️", count: 1, reactedByViewer: true }] };
    current = settleReaction(current, "❤️", heart, saved);
    current = reconcileReactions(current, { ...saved, reactions: [...saved.reactions, { emoji: "🙂", count: 2, reactedByViewer: false }] });
    expect(current.reactions).toEqual([...saved.reactions, { emoji: "🙂", count: 3, reactedByViewer: true }]);
    current = settleReaction(current, "🙂", smile, success ? { ...original, reactions: [{ emoji: "🙂", count: 3, reactedByViewer: true }] } : undefined);
    expect(current.reactions).toEqual([...saved.reactions, { emoji: "🙂", count: success ? 3 : 2, reactedByViewer: success }]);
  });

  it.each([false, true])("keeps a newer confirmed projection after a delayed success=%s", (success) => {
    for (const removing of [false, true]) {
      const token = {};
      const pending = beginReaction({ ...original, reactions: [{ emoji: "❤️", count: 2, reactedByViewer: removing }] }, "❤️", token, removing);
      const confirmed = { ...original, reactions: [{ emoji: "❤️", count: 5, reactedByViewer: !removing }] };
      const current = reconcileReactions(pending, confirmed);
      const staleResult = { ...original, reactions: [{ emoji: "❤️", count: removing ? 1 : 3, reactedByViewer: !removing }] };
      expect(settleReaction(current, "❤️", token, success ? staleResult : undefined)).toBe(current);
      expect(current.reactions).toEqual(confirmed.reactions);
    }
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
