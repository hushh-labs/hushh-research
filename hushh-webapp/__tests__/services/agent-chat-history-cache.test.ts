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
  evictInMemoryAgentChatHistoryForTests,
  hydrateAgentChatHistoryFromEncryptedCache,
  loadAgentChatConversationHistory,
  peekAgentChatHistoryCache,
  warmAgentChatHistoryCache,
  isAgentChatHistorySnapshotCurrent,
} from "@/lib/agent/agent-chat-history-cache";
import { AGENT_CHAT_HISTORY_INVALIDATED_EVENT } from "@/lib/agent/agent-chat-history-events";
import {
  deleteEncryptedOwnerUiRecords,
  flushEncryptedOwnerUiWritesForTests,
  inspectRawMemoryUiCacheForTests,
  readEncryptedOwnerUiRecord,
  writeEncryptedOwnerUiRecord,
} from "@/lib/storage/encrypted-owner-ui-cache";

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

  it("single-flights list warming and warms the latest history independently", async () => {
    const input = { userId: "user-1", vaultOwnerToken: "token" };
    const [first, joined] = await Promise.all([
      warmAgentChatHistoryCache(input),
      warmAgentChatHistoryCache(input),
    ]);

    expect(first.conversations).toEqual([conversation]);
    expect(joined).toEqual(first);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledTimes(1);
    await loadAgentChatConversationHistory({ ...input, conversationId: conversation.id });

    await warmAgentChatHistoryCache(input);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(peekAgentChatHistoryCache("user-1")?.latestConversationId).toBe(
      "conversation-1",
    );
  });

  it("shows the conversation list while the newest transcript is still pending", async () => {
    let resolveHistory: ((value: typeof messages) => void) | undefined;
    mocks.history.mockImplementationOnce(() => new Promise<typeof messages>((resolve) => {
      resolveHistory = resolve;
    }));
    const input = { userId: "user-1", vaultOwnerToken: "token" };
    const result = await warmAgentChatHistoryCache(input);
    expect(result.conversations).toEqual([conversation]);
    expect(result.latestMessages).toEqual([]);
    expect(peekAgentChatHistoryCache(input.userId)?.conversations).toEqual([conversation]);
    resolveHistory?.(messages);
    await loadAgentChatConversationHistory({ ...input, conversationId: conversation.id });
    expect(peekAgentChatHistoryCache(input.userId)?.latestMessages).toEqual(messages);
  });

  it("cannot restore a late transcript after vault lock", async () => {
    let resolveHistory: ((value: typeof messages) => void) | undefined;
    mocks.history.mockImplementationOnce(() => new Promise<typeof messages>((resolve) => {
      resolveHistory = resolve;
    }));
    await warmAgentChatHistoryCache({ userId: "user-1", vaultOwnerToken: "token" });
    clearAgentChatHistoryCache("user-1");
    resolveHistory?.(messages);
    await vi.waitFor(() => expect(peekAgentChatHistoryCache("user-1")).toBeNull());
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

  it("clears a protected snapshot when a consent mutation invalidates Chat history", async () => {
    await warmAgentChatHistoryCache({ userId: "user-1", vaultOwnerToken: "token" });
    expect(peekAgentChatHistoryCache("user-1")).not.toBeNull();

    window.dispatchEvent(new CustomEvent(AGENT_CHAT_HISTORY_INVALIDATED_EVENT, {
      detail: { userId: "user-1" },
    }));

    expect(peekAgentChatHistoryCache("user-1")).toBeNull();
  });

  it("retains expired presentation while one refresh waits, and fences captured snapshots on invalidation", async () => {
    const input = { userId: "user-1", vaultOwnerToken: "token", vaultKey: "synthetic-key" };
    await warmAgentChatHistoryCache(input);
    await loadAgentChatConversationHistory({ ...input, conversationId: conversation.id });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      const retained = peekAgentChatHistoryCache(input.userId)!;
      expect(retained.isFresh).toBe(false);
      expect(retained.latestMessages).toEqual(messages);
      expect(isAgentChatHistorySnapshotCurrent(input.userId, retained)).toBe(true);
      expect(isAgentChatHistorySnapshotCurrent("other-owner", retained)).toBe(false);
      let settle!: (value: typeof conversation[]) => void;
      mocks.list.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
      const refresh = warmAgentChatHistoryCache({ ...input, force: true });
      const joined = warmAgentChatHistoryCache({ ...input, force: true });
      expect(refresh).toBe(joined);
      expect(peekAgentChatHistoryCache(input.userId)?.latestMessages).toEqual(messages);
      clearAgentChatHistoryCache(input.userId);
      expect(isAgentChatHistorySnapshotCurrent(input.userId, retained)).toBe(false);
      settle([conversation]);
      await expect(refresh).rejects.toThrow("cache was invalidated");
      expect(peekAgentChatHistoryCache(input.userId)).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it("prefetches only the canonical One main chat on cold load and avoids force-refresh history storms", async () => {
    const mainChat = { ...conversation, id: "conv-main", title: "One" };
    const side1 = { ...conversation, id: "conv-side-1", title: "Portfolio review" };
    const side2 = { ...conversation, id: "conv-side-2", title: "Tax planning" };
    mocks.list.mockResolvedValue([side1, mainChat, side2]);
    mocks.history.mockResolvedValue(messages);

    const input = { userId: "user-1", vaultOwnerToken: "token", vaultKey: "synthetic-key" };
    await warmAgentChatHistoryCache(input);
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-main" }),
    );

    mocks.history.mockClear();
    await warmAgentChatHistoryCache({ ...input, force: true });
    // Main chat is already cached; force-refreshing the sidebar list must not
    // fan out parallel GET /history calls across conversations.
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("seals chat history into encrypted owner UI storage with zero plaintext on disk and hydrates across reload", async () => {
    await deleteEncryptedOwnerUiRecords();
    const realVaultKey = "a1".repeat(32);
    const wrongVaultKey = "b2".repeat(32);
    const input = { userId: "user-enc-1", vaultOwnerToken: "token", vaultKey: realVaultKey };

    await warmAgentChatHistoryCache(input);
    await loadAgentChatConversationHistory({ ...input, conversationId: conversation.id });
    await flushEncryptedOwnerUiWritesForTests();
    expect(inspectRawMemoryUiCacheForTests().has("user-enc-1::chat-history:v1")).toBe(true);

    const rawRecord = inspectRawMemoryUiCacheForTests().get("user-enc-1::chat-history:v1")!;
    const serializedRaw = JSON.stringify(rawRecord);
    expect(serializedRaw).not.toContain("Portfolio review");
    expect(serializedRaw).not.toContain("Review my portfolio");

    // Simulate browser reload: RAM map is empty, encrypted replica remains.
    evictInMemoryAgentChatHistoryForTests("user-enc-1");
    expect(peekAgentChatHistoryCache("user-enc-1")).toBeNull();

    // Negative control: wrong vault key refuses authenticated decryption.
    const refusedWrongKey = await hydrateAgentChatHistoryFromEncryptedCache({
      userId: "user-enc-1",
      vaultKey: wrongVaultKey,
    });
    expect(refusedWrongKey).toBeNull();

    // Positive hydration: restores conversations + latest messages with isFresh=false for background sync.
    const hydrated = await hydrateAgentChatHistoryFromEncryptedCache({
      userId: "user-enc-1",
      vaultKey: realVaultKey,
    });
    expect(hydrated).not.toBeNull();
    expect(hydrated!.isFresh).toBe(false);
    expect(hydrated!.conversations).toEqual([conversation]);
    expect(hydrated!.latestMessages).toEqual(messages);

    // Vault lock / sign-out wipes encrypted replica.
    clearAgentChatHistoryCache("user-enc-1");
    await vi.waitFor(() => {
      expect(inspectRawMemoryUiCacheForTests().has("user-enc-1::chat-history:v1")).toBe(false);
    });
  });

  it("fences encrypted owner UI records against cross-owner or cross-namespace AAD substitution", async () => {
    await deleteEncryptedOwnerUiRecords();
    const vaultKey = "c3".repeat(32);
    await writeEncryptedOwnerUiRecord({
      ownerId: "owner-a",
      vaultKey,
      namespace: "files:list:root:live",
      value: { entries: [{ id: "file-secret", name: "tax-return.pdf" }], cursor: "", chunkBytes: 65536 },
    });

    const raw = inspectRawMemoryUiCacheForTests().get("owner-a::files:list:root:live")!;
    expect(JSON.stringify(raw)).not.toContain("tax-return.pdf");

    // Attempt to read under another owner or namespace fails AEAD authentication even if copied.
    const forged = await readEncryptedOwnerUiRecord({
      ownerId: "owner-b",
      vaultKey,
      namespace: "files:list:root:live",
    });
    expect(forged).toBeNull();

    const genuine = await readEncryptedOwnerUiRecord<{ entries: Array<{ name: string }> }>({
      ownerId: "owner-a",
      vaultKey,
      namespace: "files:list:root:live",
    });
    expect(genuine?.value.entries[0]?.name).toBe("tax-return.pdf");
  });
});
