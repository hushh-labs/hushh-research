"use client";

/**
 * Whether Kai may use the hub for this owner.
 *
 * Kai's analysis, chat, portfolio and market routes are hub content routes: the hub
 * refuses every one of them unless the owner chose Shared (owner_placement_guard.py).
 * For anyone else Kai is not served from the hub at all, so the Finance workspace
 * shows that Kai is coming to their own agent instead of calling a route that must
 * refuse. Placement uses the same rule as chat (`ownerContentIsPrivate`), and an
 * unreadable placement is never treated as Shared.
 */
import { useEffect, useState } from "react";

import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";

export type KaiPlacement = "checking" | "shared" | "private" | "unverified";

export async function readKaiPlacement(): Promise<Exclude<KaiPlacement, "checking">> {
  try {
    return (await ownerContentIsPrivate()) ? "private" : "shared";
  } catch (error) {
    return error instanceof Error && error.message === "AGENT_PRIVATE_RUNTIME_REQUIRED"
      ? "private"
      : "unverified";
  }
}

/** Placement for the signed-in owner, re-read when the owner or `attempt` changes. */
export function useKaiPlacement(userId: string | null | undefined, attempt = 0): KaiPlacement {
  const [state, setState] = useState<{ key: string; placement: KaiPlacement }>({
    key: "",
    placement: "checking",
  });
  const key = `${userId ?? ""}:${attempt}`;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void readKaiPlacement().then((placement) => {
      if (!cancelled) setState({ key, placement });
    });
    return () => {
      cancelled = true;
    };
  }, [key, userId]);
  return state.key === key ? state.placement : "checking";
}
