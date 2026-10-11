"use client";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { AuthService } from "@/lib/services/auth-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { refreshMemoryDocument, watchMemoryFreshness, clearMemoryDocument } from "@/lib/pkm/memory-refresh";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { AGENT_CHAT_HISTORY_INVALIDATED_EVENT } from "@/lib/agent/agent-chat-history-events";
import { LIVING_SOURCE_DOMAIN, syncLivingSources } from "@/lib/pkm/living-source-sync";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

/** Continuous unlocked-session updates only. Closed/locked operation requires
 * the separately reviewed owner-controlled runtime, never a browser key cache. */
export function LivingMemoryBridge() {
  const { user } = useAuth(); const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) return;
    const userId = user.uid; let stopped = false; let running = false; let pending = false; let sourceDirty = true;
    const stopWatch = watchMemoryFreshness(userId);
    const build = async () => {
      if (stopped) return;
      if (running) { pending = true; return; }
      running = true;
      do {
        pending = false;
        try {
          if (sourceDirty && !shouldSkipReviewerBackgroundWritesForAutomation()) {
            sourceDirty = false;
            const idToken = await AuthService.getIdToken();
            if (idToken && !stopped) await syncLivingSources({ userId, vaultKey, vaultOwnerToken, idToken });
          }
          if (stopped) break;
          const metadata = await PersonalKnowledgeModelService.getMetadata(userId, true, vaultOwnerToken);
          if (!metadata) throw new Error("Source inventory unavailable");
          if (stopped) break;
          await refreshMemoryDocument({ userId, vaultKey, vaultOwnerToken, domains: (metadata.domains ?? []).map((domain) => domain.key).filter(Boolean), force: true });
        } catch { sourceDirty = true; }
      } while (pending && !stopped);
      running = false;
    };
    const refreshSources = (event?: Event) => {
      const owner = (event as CustomEvent<{ userId?: string }> | undefined)?.detail?.userId;
      if (owner && owner !== userId) return;
      sourceDirty = true; void build();
    };
    const stopChanges = subscribeToPkmDomainChanges((detail) => {
      if (detail.userId === userId) { if (detail.domain !== LIVING_SOURCE_DOMAIN) pending = true; void build(); }
    });
    const stopCache = CacheService.getInstance().subscribe((event) => {
      if (event.type === "set" && event.key === CACHE_KEYS.ACCOUNT_IDENTITY(userId) && !running) refreshSources();
    });
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refreshSources);
    window.addEventListener(AGENT_CHAT_HISTORY_INVALIDATED_EVENT, refreshSources);
    window.addEventListener("online", refreshSources); window.addEventListener("focus", refreshSources);
    const timer = window.setInterval(() => void build(), 60_000);
    void build();
    return () => { stopped = true; stopChanges(); stopWatch(); stopCache(); window.clearInterval(timer);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refreshSources); window.removeEventListener(AGENT_CHAT_HISTORY_INVALIDATED_EVENT, refreshSources);
      window.removeEventListener("online", refreshSources); window.removeEventListener("focus", refreshSources); clearMemoryDocument(userId); };
  }, [user?.uid, vaultKey, vaultOwnerToken, isVaultUnlocked]);
  return null;
}
