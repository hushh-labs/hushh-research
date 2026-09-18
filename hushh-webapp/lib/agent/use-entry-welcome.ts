"use client";

import { useEffect, useState } from "react";
import { loadAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

export type EntryWelcome = {
  userId: string;
  status: "loading" | "ready" | "unavailable";
  domains: string[];
  totalAttributes: number;
};

/** One session-only setup summary. Never stores private values or a transcript. */
export function useEntryWelcome({ userId, vaultKey, vaultOwnerToken, isVaultUnlocked }: {
  userId: string | undefined;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isVaultUnlocked: boolean;
}): EntryWelcome | null {
  const marker = useOneConversationSession((state) => state.pendingEntryWelcome);
  const consume = useOneConversationSession((state) => state.consumeEntryWelcome);
  const [welcome, setWelcome] = useState<EntryWelcome | null>(null);

  useEffect(() => {
    if (!userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setWelcome(null);
      return;
    }
    if (!marker || marker.userId !== userId) return;

    let active = true;
    setWelcome({ userId, status: "loading", domains: [], totalAttributes: 0 });
    void loadAgentPkmContext({ userId, vaultKey, vaultOwnerToken, metadataOnly: true })
      .then((context) => {
        if (!active) return;
        setWelcome({
          userId, status: "ready",
          domains: [...new Set(context.domains.filter(Boolean))],
          totalAttributes: Math.max(0, context.totalAttributes || 0),
        });
        // Acknowledge only after publishing the result: consuming earlier
        // reruns this effect and cancels its own asynchronous summary read.
        consume(userId);
      })
      .catch(() => {
        if (!active) return;
        setWelcome({ userId, status: "unavailable", domains: [], totalAttributes: 0 });
        consume(userId);
      });
    return () => { active = false; };
  }, [userId, isVaultUnlocked, vaultKey, vaultOwnerToken, marker, consume]);

  return isVaultUnlocked && vaultKey && vaultOwnerToken && welcome?.userId === userId
    ? welcome : null;
}
