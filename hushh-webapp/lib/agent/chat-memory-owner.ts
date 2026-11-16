"use client";

import { snapshotValidatedAuthSessionOwner, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import { createChatMemoryRuntime } from "./chat-memory-runtime";
import { rewriteChatMemory } from "./chat-memory-rewrite";

type Runtime = ReturnType<typeof createChatMemoryRuntime>;
type OwnerRuntime = {
  userId: string; epoch: number; token: string; vaultKey: string; runtime: Runtime;
  readToken: () => string | null; dispose: () => void;
};
let active: OwnerRuntime | null = null;

/** One unlocked owner writer survives Chat → Memory navigation and token rotation. Lock retires it. */
export function ownerChatMemory(input: {
  userId: string; vaultKey: string; vaultEpoch: number; token: string;
  readToken: () => string | null;
}): Runtime {
  if (active?.userId === input.userId && active.epoch === input.vaultEpoch && active.vaultKey === input.vaultKey) {
    active.token = input.token;
    active.readToken = input.readToken;
    return active.runtime;
  }
  active?.dispose();
  const liveToken = () => {
    const token = entry.readToken();
    return token && token.trim() ? token : null;
  };
  const current = () => active === entry && isVaultSessionEpochCurrent(input.vaultEpoch) &&
    snapshotValidatedAuthSessionOwner()?.userId === input.userId && Boolean(liveToken());
  const getSession = () => {
    if (!current()) return null;
    const vaultOwnerToken = liveToken();
    return vaultOwnerToken ? {
      userId: input.userId, vaultKey: input.vaultKey, vaultOwnerToken, isCurrent: current,
    } : null;
  };
  const runtime = createChatMemoryRuntime({ getSession, rewrite: async request => {
    const session = getSession();
    if (!session) throw new Error("MEMORY_LOCKED");
    return rewriteChatMemory(session, request);
  }, onConsolidated: async ({ messages }) => {
    if (!current() || !messages.length) return;
    const { peekActiveSharedWiki } = await import("@/lib/files/wiki/active-shared-wiki");
    const wiki = peekActiveSharedWiki();
    if (!wiki) return;
    const { SharedWikiKnowledgeWriter, SharedWikiProjectionEngine } = await import("@/lib/files/wiki");
    const writer = new SharedWikiKnowledgeWriter(wiki);
    const captured = await writer.captureEvents(
      messages.map((m) => ({
        conversationId: m.conversationId,
        eventId: m.id,
        role: m.role,
        content: m.content,
        consentDerived: m.consentDerived,
      })),
    );
    if (captured.status === "saved" && captured.saved_page_ids.length > 0) {
      const projections = new SharedWikiProjectionEngine(wiki);
      for (const pageId of captured.saved_page_ids) {
        await projections.syncPageLifecycle(pageId);
      }
    }
  } });
  const cleanups: Array<() => void> = [];
  const entry: OwnerRuntime = { userId: input.userId, epoch: input.vaultEpoch, token: input.token, vaultKey: input.vaultKey,
    runtime, readToken: input.readToken, dispose: () => {
      runtime.clear();
      entry.readToken = () => null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (active === entry) active = null;
    } };
  active = entry;
  const invalidate = () => { if (!current()) entry.dispose(); };
  cleanups.push(subscribeVaultSessionEpoch(invalidate), subscribeAuthSessionGeneration(invalidate),
    subscribeDurableOwnerReset(owner => { if (owner === input.userId) entry.dispose(); }));
  return runtime;
}
