import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  history: vi.fn(),
  resourceEvent: vi.fn(),
  warmupEvent: vi.fn(),
}));

vi.mock("@/lib/services/agent-chat-client", () => ({
  listAgentChatConversations: mocks.list,
  getAgentChatHistory: mocks.history,
}));

vi.mock("@/lib/observability/client", () => ({
  trackCacheResourceResolved: mocks.resourceEvent,
  trackWarmupCompleted: mocks.warmupEvent,
}));

import {
  clearAgentChatHistoryCache,
  loadAgentChatConversationHistory,
  peekAgentChatHistoryCache,
  warmAgentChatHistoryCache,
} from "@/lib/agent/agent-chat-history-cache";

const conversation = {
  id: "conversation-1",
  title: "Portfolio review",
  status: "active",
  message_count: 2,
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
  last_message_at: "2026-07-20T00:00:00Z",
};

const messages = [
  {
    id: "message-1",
    conversation_id: "conversation-1",
    role: "user",
    status: "complete",
    content: "Review my portfolio",
    created_at: "2026-07-20T00:00:00Z",
  },
];

describe("agent chat history memory cache", () => {
  beforeEach(() => {
    clearAgentChatHistoryCache();
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([conversation]);
    mocks.history.mockResolvedValue(messages);
  });

  it("single-flights unlock warming and serves the latest history from memory", async () => {
    const input = { userId: "user-1", vaultOwnerToken: "token" };
    const [first, joined] = await Promise.all([
      warmAgentChatHistoryCache(input),
      warmAgentChatHistoryCache(input),
    ]);

    expect(first.latestMessages).toEqual(messages);
    expect(joined).toEqual(first);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledTimes(1);

    await warmAgentChatHistoryCache(input);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(peekAgentChatHistoryCache("user-1")?.latestConversationId).toBe(
      "conversation-1",
    );
  });

  it("loads non-latest conversations lazily and clears protected history on lock", async () => {
    await warmAgentChatHistoryCache({ userId: "user-1", vaultOwnerToken: "token" });
    mocks.history.mockClear();
    mocks.history.mockResolvedValue([{ ...messages[0], id: "message-2" }]);

    const loaded = await loadAgentChatConversationHistory({
      userId: "user-1",
      conversationId: "conversation-2",
      vaultOwnerToken: "token",
    });
    expect(loaded[0]?.id).toBe("message-2");
    expect(mocks.history).toHaveBeenCalledTimes(1);

    clearAgentChatHistoryCache("user-1");
    expect(peekAgentChatHistoryCache("user-1")).toBeNull();
  });

  it("does not let a late unlock warmup repopulate history after vault lock", async () => {
    let resolveList: ((value: (typeof conversation)[]) => void) | null = null;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise<(typeof conversation)[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    const warming = warmAgentChatHistoryCache({
      userId: "user-1",
      vaultOwnerToken: "token",
    });
    clearAgentChatHistoryCache("user-1");
    resolveList?.([conversation]);

    await expect(warming).rejects.toThrow("cache was invalidated");
    expect(peekAgentChatHistoryCache("user-1")).toBeNull();
    expect(mocks.history).not.toHaveBeenCalled();
  });
});
