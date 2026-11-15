"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createChatMemoryRuntime, type ChatMemoryMessage } from "./chat-memory-runtime";
import { ownerChatMemory } from "./chat-memory-owner";

type SourceMessage = {
  id: string; serverMessageId?: string; role: "user" | "assistant"; text: string;
  attachments?: Array<{ text: string }>; status?: string; ephemeral?: boolean;
  restoredFromHistory?: boolean;
  consentBundleId?: string; consentAccess?: unknown; consentAccessEnded?: boolean;
  calendarMeeting?: unknown; receiptPrivate?: unknown;
};

/** Quiet owner-scoped maintenance; never joined to the main answer promise. */
export function useChatMemory(input: {
  userId: string | null | undefined; vaultKey: string | null; vaultEpoch: number;
  getToken: () => string | null; vaultOwnerToken: string | null; conversationId: string | null; messages: readonly SourceMessage[];
}) {
  const { userId, vaultKey, vaultEpoch, vaultOwnerToken, getToken, conversationId, messages: sourceMessages } = input;
  const registration = useRef<Promise<void>>(Promise.resolve());
  const requested = useRef(new Set<string>());
  const sessionKeyRef = useRef<string | null>(null);
  const latest = useRef(input);
  useLayoutEffect(() => { latest.current = input; }, [input]);
  const runtimeRef = useRef<ReturnType<typeof createChatMemoryRuntime> | null>(null);
  useEffect(() => {
    const token = latest.current.getToken();
    if (!userId || !vaultKey || !token) return;
    const nextSessionKey = `${userId}:${vaultEpoch}`;
    if (sessionKeyRef.current !== nextSessionKey) {
      sessionKeyRef.current = nextSessionKey;
      requested.current.clear();
    }
    const instance = ownerChatMemory({ userId, vaultKey, vaultEpoch, token,
      readToken: () => latest.current.getToken() });
    runtimeRef.current = instance;
    return () => { if (runtimeRef.current === instance) runtimeRef.current = null; };
  }, [userId, vaultKey, vaultEpoch, vaultOwnerToken]);
  const runtime = useMemo(() => ({
    trigger: async (reason: Parameters<ReturnType<typeof createChatMemoryRuntime>["trigger"]>[0]) => {
      const instance = runtimeRef.current;
      await registration.current;
      return instance?.trigger(reason) ?? false;
    },
    withdrawConversation: async (targetConversationId: string) => {
      const instance = runtimeRef.current;
      await instance?.withdrawConversation(targetConversationId);
    },
    peekPendingMessages: (excludeConversationId?: string) =>
      runtimeRef.current?.peekPendingMessages(excludeConversationId) ?? [],
    recordUsage: (usage: { requestId: string; inputTokens: number }) => runtimeRef.current?.recordUsage(usage) ?? Promise.resolve(),
    activity: () => runtimeRef.current?.activity(),
  }), []);
  useEffect(() => {
    if (!userId || !vaultKey || !conversationId || !getToken()) return;
    const occurrences = new Map<string, number>();
    const messages: Array<ChatMemoryMessage & { occurrence: number }> = [];
    for (const message of sourceMessages) {
      if (message.id === "agent-greeting" || message.ephemeral || message.status === "streaming" || message.status === "error") continue;
      const content = [message.text, ...(message.attachments ?? []).map(attachment => attachment.text)].filter(Boolean).join("\n\n");
      const baseIdentity = `${message.role}\n${content}`;
      const occurrence = (occurrences.get(baseIdentity) ?? 0) + 1;
      occurrences.set(baseIdentity, occurrence);
      // Historical transcript loads must never replay old turns or resurrect deleted facts.
      if (message.restoredFromHistory) continue;
      messages.push({
        id: message.serverMessageId ?? message.id,
        conversationId,
        role: message.role,
        content,
        occurrence,
        consentDerived: Boolean(message.consentBundleId || message.consentAccess || message.consentAccessEnded || message.receiptPrivate || message.calendarMeeting),
      });
    }
    const instance = runtimeRef.current;
    if (!instance || !messages.length) return;
    // UI and restored ADK ids differ. Content + per-conversation occurrence
    // identity survives closing-snapshot id updates without collapsing repeated
    // short confirmations ("Yes", "Save it") in the same conversation.
    const registered = Promise.all(messages.map(async ({ occurrence, ...message }) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(occurrence === 1 ? `${message.role}\n${message.content}` : `${message.role}\n#${occurrence}\n${message.content}`),
      );
      return { ...message, id: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
    })).then(async stable => {
      await instance.registerSnapshot({ conversationId, messages: stable });
      return stable;
    });
    registration.current = registered.then(() => undefined, () => undefined);
    void registered.then(stable => {
      const lastUser = stable.findLast(message => message.role === "user");
      if (
        lastUser &&
        !lastUser.consentDerived &&
        !requested.current.has(`${conversationId}:${lastUser.id}`) &&
        /\b(remember|memorize|forget|save (?:this|that|my|these)|keep (?:this|that) in mind)\b/i.test(lastUser.content)
      ) {
        requested.current.add(`${conversationId}:${lastUser.id}`);
        return instance.trigger("remember");
      }
      return false;
    }).catch(() => undefined);
  }, [runtime, userId, vaultKey, vaultOwnerToken, conversationId, sourceMessages, getToken]);
  return runtime;
}
