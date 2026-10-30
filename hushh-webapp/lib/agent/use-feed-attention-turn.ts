"use client";

import { useEffect, useRef } from "react";

import { subscribeFeedAttention, takeFeedAttention } from "@/lib/agent/feed-attention";

/**
 * The chat's single hook-in for a tapped feed update: when one is armed for
 * this owner and the chat is ready (vault unlocked, chat key available), take
 * it exactly once and hand its id to `start`, which opens the turn.
 */
export function useFeedAttentionTurn(input: {
  ownerId: string | null;
  ready: boolean;
  start: (itemId: string) => void;
}): void {
  const startRef = useRef(input.start);
  useEffect(() => {
    startRef.current = input.start;
  });
  const { ownerId, ready } = input;
  useEffect(() => {
    if (!ownerId || !ready) return undefined;
    const consume = () => {
      const itemId = takeFeedAttention(ownerId);
      if (itemId) startRef.current(itemId);
    };
    consume();
    return subscribeFeedAttention(consume);
  }, [ownerId, ready]);
}
