"use client";

// App-shell owner for a "One has something for you" push tap.
//
// The tap opens `/?feedAttention=<feed row id>`. After the vault is unlocked,
// this arms one pending request (memory only, the id only) and clears the
// query; the chat then starts a fresh conversation in which One writes its
// message about that update. While the vault is locked it waits: the effect
// re-runs on unlock. Nothing is stored in the browser.

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { armFeedAttention, clearFeedAttention, FEED_ATTENTION_QUERY } from "@/lib/agent/feed-attention";
import { ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

export function AgentFeedAttentionNotifier(): null {
  const { user } = useAuth();
  const { vaultKey } = useVault();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ownerId = user?.uid ?? null;
  const requested = searchParams?.get(FEED_ATTENTION_QUERY) ?? null;

  // A different person (or none) never inherits another's pending update.
  useEffect(() => {
    if (!ownerId) clearFeedAttention();
  }, [ownerId]);

  useEffect(() => {
    if (pathname !== ROUTES.HOME || !ownerId || requested === null) return;
    if (!vaultKey) return; // re-runs once the vault is unlocked
    armFeedAttention(ownerId, requested.trim());
    router.replace(ROUTES.HOME, { scroll: false });
  }, [ownerId, pathname, requested, router, vaultKey]);

  return null;
}
