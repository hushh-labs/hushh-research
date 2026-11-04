"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createChatMemoryRuntime, type ChatMemoryMessage } from "./chat-memory-runtime";
import { ownerChatMemory } from "./chat-memory-owner";

type SourceMessage = {
  id: string; serverMessageId?: string; role: "user" | "assistant"; text: string;
  attachments?: Array<{ text: string }>; status?: string; ephemeral?: boolean;
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
  const latest = useRef(input);
  useLayoutEffect(() => { latest.current = input; }, [input]);
  const runtimeRef = useRef<ReturnType<typeof createChatMemoryRuntime> | null>(null);
  useEffect(() => {
    const token = latest.current.getToken();
    if (!userId || !vaultKey || !token) return;
    requested.current.clear();
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
    recordUsage: (usage: { requestId: string; inputTokens: number }) => runtimeRef.current?.recordUsage(usage) ?? Promise.resolve(),
    activity: () => runtimeRef.current?.activity(),
  }), []);
  useEffect(() => {
    if (!userId || !vaultKey || !conversationId || !getToken()) return;
    const messages: ChatMemoryMessage[] = sourceMessages.filter(message =>
      message.id !== "agent-greeting" && !message.ephemeral && message.status !== "streaming" && message.status !== "error",
    ).map(message => ({
      id: message.serverMessageId ?? message.id, conversationId, role: message.role,
      content: [message.text, ...(message.attachments ?? []).map(attachment => attachment.text)].filter(Boolean).join("\n\n"),
      consentDerived: Boolean(message.consentBundleId || message.consentAccess || message.consentAccessEnded || message.receiptPrivate || message.calendarMeeting),
    }));
    const instance = runtimeRef.current;
    if (!instance) return;
    // UI and restored ADK ids differ. Content identity avoids replaying an old
    // source after refresh; repeated identical text needs no second extraction.
    const registered = Promise.all(messages.map(async message => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${message.role}\n${message.content}`));
      return { ...message, id: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
    })).then(stable => instance.registerSnapshot({ conversationId, messages: stable }));
    registration.current = registered.catch(() => undefined);
    void registered.then(() => {
      const lastUser = messages.findLast(message => message.role === "user");
      if (lastUser && !requested.current.has(`${conversationId}:${lastUser.id}`) && /\b(remember|memorize|forget|save (?:this|that|my|these)|keep (?:this|that) in mind)\b/i.test(lastUser.content)) {
        requested.current.add(`${conversationId}:${lastUser.id}`);
        return instance.trigger("remember");
      }
      return false;
    }).catch(() => undefined);
  }, [runtime, userId, vaultKey, vaultOwnerToken, conversationId, sourceMessages, getToken]);
  return runtime;
}
