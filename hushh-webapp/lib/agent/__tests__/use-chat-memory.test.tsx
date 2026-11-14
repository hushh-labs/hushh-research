import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  registerSnapshot: vi.fn(async () => undefined),
  withdrawConversation: vi.fn(async () => undefined),
  peekPendingMessages: vi.fn(() => []),
  recordUsage: vi.fn(async () => undefined),
  trigger: vi.fn(async () => true),
  activity: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../chat-memory-owner", () => ({
  ownerChatMemory: vi.fn(() => runtimeMocks),
}));

import { useChatMemory } from "../use-chat-memory";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";

describe("useChatMemory chat-switching and vault-lock boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
  });

  afterEach(() => {
    CacheService.getInstance().clear();
  });

  it("ignores restored historical turns when switching chats while capturing live turns in that reopened chat", async () => {
    const getToken = () => "vault-token";
    const { rerender } = renderHook(
      ({ conversationId, messages }) =>
        useChatMemory({
          userId: "owner-1",
          vaultKey: "vault-key",
          vaultEpoch: 1,
          vaultOwnerToken: "vault-token",
          getToken,
          conversationId,
          messages,
        }),
      {
        initialProps: {
          conversationId: "chat-old",
          messages: [
            { id: "hist-1", role: "user" as const, text: "Old deleted preference from last week", restoredFromHistory: true },
            { id: "hist-2", role: "assistant" as const, text: "Noted last week.", restoredFromHistory: true },
          ],
        },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(runtimeMocks.registerSnapshot).not.toHaveBeenCalled();

    rerender({
      conversationId: "chat-old",
      messages: [
        { id: "hist-1", role: "user" as const, text: "Old deleted preference from last week", restoredFromHistory: true },
        { id: "hist-2", role: "assistant" as const, text: "Noted last week.", restoredFromHistory: true },
        { id: "live-3", role: "user" as const, text: "New live preference in reopened chat" },
      ],
    });

    await vi.waitFor(() => expect(runtimeMocks.registerSnapshot).toHaveBeenCalledOnce());
    const call = runtimeMocks.registerSnapshot.mock.calls[0]![0] as {
      conversationId: string;
      messages: Array<{ id: string; content: string }>;
    };
    expect(call.conversationId).toBe("chat-old");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.content).toBe("New live preference in reopened chat");
  });

  it("preserves distinct source ids for repeated short confirmations and does not re-fire remember on token renewal or restored history", async () => {
    let token = "vault-token-1";
    const { rerender } = renderHook(
      ({ vaultOwnerToken, messages }) =>
        useChatMemory({
          userId: "owner-1",
          vaultKey: "vault-key",
          vaultEpoch: 1,
          vaultOwnerToken,
          getToken: () => token,
          conversationId: "chat-live",
          messages,
        }),
      {
        initialProps: {
          vaultOwnerToken: "vault-token-1",
          messages: [
            { id: "h0", role: "user" as const, text: "Remember my old deleted note", restoredFromHistory: true },
            { id: "m1", role: "assistant" as const, text: "Save home address?" },
            { id: "m2", role: "user" as const, text: "Yes" },
            { id: "m3", role: "assistant" as const, text: "Save travel seat preference?" },
            { id: "m4", role: "user" as const, text: "Yes" },
            { id: "m5", role: "user" as const, text: "Remember that I study robotics." },
          ],
        },
      },
    );

    await vi.waitFor(() => expect(runtimeMocks.registerSnapshot).toHaveBeenCalledOnce());
    const call = runtimeMocks.registerSnapshot.mock.calls[0]![0] as {
      messages: Array<{ id: string; role: string; content: string }>;
    };
    const yesTurns = call.messages.filter((message) => message.content === "Yes");
    expect(yesTurns).toHaveLength(2);
    expect(yesTurns[0]!.id).not.toBe(yesTurns[1]!.id);
    await vi.waitFor(() => expect(runtimeMocks.trigger).toHaveBeenCalledTimes(1));

    // Renewing vaultOwnerToken or attaching serverMessageId must not re-fire `trigger("remember")`.
    token = "vault-token-2";
    rerender({
      vaultOwnerToken: "vault-token-2",
      messages: [
        { id: "h0", role: "user" as const, text: "Remember my old deleted note", restoredFromHistory: true },
        { id: "m1", role: "assistant" as const, text: "Save home address?" },
        { id: "m2", role: "user" as const, text: "Yes" },
        { id: "m3", role: "assistant" as const, text: "Save travel seat preference?" },
        { id: "m4", role: "user" as const, text: "Yes" },
        { id: "m5", serverMessageId: "srv-m5", role: "user" as const, text: "Remember that I study robotics." },
      ],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(runtimeMocks.trigger).toHaveBeenCalledTimes(1);
  });

  it("purges non-financial decrypted PKM domain caches when invalidating all domains for a locked user", () => {
    const cache = CacheService.getInstance();
    cache.set(CACHE_KEYS.DOMAIN_DATA("owner-1", "one_memory"), { markdown: "secret" }, CACHE_TTL.SESSION);
    cache.set(CACHE_KEYS.DOMAIN_DATA("owner-1", "identity"), { legal_name: "Owner" }, CACHE_TTL.SESSION);
    cache.set("pkm_domain_resource_owner-1_one_memory_all", { data: { markdown: "secret" } }, CACHE_TTL.SESSION);
    cache.set(CACHE_KEYS.DOMAIN_DATA("owner-2", "one_memory"), { markdown: "other-owner" }, CACHE_TTL.SESSION);

    PkmDomainResourceService.invalidateAllForUser("owner-1", {
      includeDevice: false,
      includeBackingCaches: true,
    });

    expect(cache.get(CACHE_KEYS.DOMAIN_DATA("owner-1", "one_memory"))).toBeNull();
    expect(cache.get(CACHE_KEYS.DOMAIN_DATA("owner-1", "identity"))).toBeNull();
    expect(cache.get("pkm_domain_resource_owner-1_one_memory_all")).toBeNull();
    expect(cache.get(CACHE_KEYS.DOMAIN_DATA("owner-2", "one_memory"))).toEqual({ markdown: "other-owner" });
  });
});

