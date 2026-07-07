"use client";

import { useCallback, useRef, useState } from "react";

import {
  OneMarketplaceService,
  type PublishSlicesAction,
} from "@/lib/one-marketplace/service";
import { runMarketplaceDeliverySweep } from "@/lib/one-marketplace/delivery-sweep";

export interface MarketplaceChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  errored?: boolean;
}

export interface UseMarketplaceChat {
  messages: MarketplaceChatMessage[];
  busy: boolean;
  send: (message: string) => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
  publishCard: PublishSlicesAction | null;
  dismissPublishCard: () => void;
}

export const MARKETPLACE_CHAT_ERROR_TEXT =
  "Sorry — that couldn't be processed. Try rephrasing.";

/**
 * State + orchestration for the Information Marketplace chatbot. Sends messages,
 * renders replies. When a turn reports `stateChanged` (the agent approved/denied
 * a request server-side), it calls `onStateChanged` so the page refetches the
 * durable request inbox — no client-side action plumbing needed.
 *
 * A server-side agent approval can only flip a request to `approved`; it has no
 * browser/vault key to seal the encrypted slice. Since this chat runs in the
 * seller's unlocked browser, we run the delivery sweep right after a state change
 * so an agent approval seals + delivers immediately — matching what an
 * interactive Consent Guardian approval does in one step.
 */
export function useMarketplaceChat(params: {
  vaultOwnerToken: string;
  userId?: string | null;
  vaultKey?: string | null;
  onStateChanged?: () => void;
}): UseMarketplaceChat {
  const { vaultOwnerToken, userId, vaultKey, onStateChanged } = params;
  const [messages, setMessages] = useState<MarketplaceChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [publishCard, setPublishCard] = useState<PublishSlicesAction | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const changedRef = useRef(onStateChanged);
  changedRef.current = onStateChanged;

  const nextId = useCallback(() => `m-${seqRef.current++}`, []);

  const run = useCallback(
    async (message: string) => {
      setBusy(true);
      // Retry case: drop a trailing errored assistant bubble before re-asking.
      setMessages((prev) =>
        prev.length && prev[prev.length - 1]?.errored ? prev.slice(0, -1) : prev,
      );
      try {
        const result = await OneMarketplaceService.chat({
          vaultOwnerToken,
          message,
          conversationId: conversationIdRef.current,
        });
        conversationIdRef.current = result.conversationId;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: result.response },
        ]);
        if (result.clientAction?.type === "publish_slices") {
          setPublishCard(result.clientAction);
        }
        if (result.stateChanged) {
          // The agent just approved/denied server-side. Seal + deliver any
          // now-approved-but-undelivered slice from the seller's unlocked
          // browser before refreshing, so agent approval matches the Guardian's
          // approve-and-deliver in one step. Best-effort: the sweep skips (no
          // error) when the buyer has no recipient key yet.
          if (userId && vaultKey) {
            try {
              await runMarketplaceDeliverySweep({
                userId,
                vaultKey,
                vaultOwnerToken,
              });
            } catch (error) {
              console.warn("[MarketplaceChat] delivery sweep failed:", error);
            }
          }
          changedRef.current?.();
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: MARKETPLACE_CHAT_ERROR_TEXT,
            errored: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, userId, vaultKey, nextId],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setMessages((prev) => [...prev, { id: nextId(), role: "user", text: message }]);
      lastSentRef.current = message;
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
    setPublishCard(null);
  }, []);

  const dismissPublishCard = useCallback(() => setPublishCard(null), []);

  return { messages, busy, send, retry, clear, publishCard, dismissPublishCard };
}
