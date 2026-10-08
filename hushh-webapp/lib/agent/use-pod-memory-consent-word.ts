"use client";

import { useEffect, useState } from "react";

import { ApiService } from "@/lib/services/api-service";

/** "unknown" once a read failed or answered without a grant: never shown as still checking. */
export type PodMemoryConsentWord = "absent" | "granted" | "revoked" | "unknown";

/**
 * The pod's own word for the provider Memory Bank grant, so the Puppy header
 * can say it without opening anything. Re-read whenever `refreshKey` changes
 * (the panel bumps it when the settings menu closes, where the grant is
 * changed). Null while unknown: never a remembered or assumed grant.
 */
export function usePodMemoryConsentWord(hushhId: string | null, refreshKey: number): PodMemoryConsentWord | null {
  const [word, setWord] = useState<PodMemoryConsentWord | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!hushhId) { setWord(null); return; }
    void Promise.resolve()
      .then(() => ApiService.getPodMemoryStatus(hushhId))
      .then((status) => {
        const consent = status?.provider?.consent;
        if (!cancelled) setWord(consent === "granted" || consent === "revoked" || consent === "absent" ? consent : "unknown");
      })
      .catch(() => { if (!cancelled) setWord("unknown"); });
    return () => { cancelled = true; };
  }, [hushhId, refreshKey]);
  return word;
}

/** The grant in plain words, for the header chip's accessible name. */
export function podMemoryConsentPhrase(word: PodMemoryConsentWord | null): string {
  if (word === null) return "Provider memory: checking";
  if (word === "unknown") return "Provider memory: unknown";
  return word === "granted" ? "Provider memory: on" : "Provider memory: off";
}
