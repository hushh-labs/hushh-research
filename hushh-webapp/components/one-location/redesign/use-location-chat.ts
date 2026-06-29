"use client";

import { useCallback, useRef, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  stateChanged?: boolean;
  errored?: boolean;
}

export interface UseLocationChat {
  messages: ChatMessage[];
  busy: boolean;
  send: (message: string) => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
}

export const LOCATION_CHAT_ERROR_TEXT =
  "Sorry — that couldn't be processed. Try rephrasing.";

export function useLocationChat(params: {
  vaultOwnerToken: string;
  onStateChanged?: () => void;
}): UseLocationChat {
  const { vaultOwnerToken, onStateChanged } = params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const conversationIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const nextId = useCallback(() => `m-${seqRef.current++}`, []);

  const run = useCallback(
    async (message: string) => {
      setBusy(true);
      // Retry case: drop a trailing errored assistant bubble before re-asking.
      setMessages((prev) =>
        prev.length && prev[prev.length - 1]?.errored ? prev.slice(0, -1) : prev,
      );
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          message,
          conversationId: conversationIdRef.current,
        });
        conversationIdRef.current = result.conversationId;
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: result.response,
            stateChanged: result.stateChanged,
          },
        ]);
        if (result.stateChanged) onStateChanged?.();
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: LOCATION_CHAT_ERROR_TEXT,
            errored: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, onStateChanged, nextId],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      lastSentRef.current = message;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: message },
      ]);
      await run(message);
    },
    [busy, run, nextId],
  );

  const retry = useCallback(async () => {
    if (busy || !lastSentRef.current) return;
    await run(lastSentRef.current);
  }, [busy, run]);

  const clear = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
    lastSentRef.current = null;
  }, []);

  return { messages, busy, send, retry, clear };
}
