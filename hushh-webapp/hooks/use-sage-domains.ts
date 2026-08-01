"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { PersonalKnowledgeModelService, type DomainSummary } from "@/lib/services/personal-knowledge-model-service";

/**
 * Shared by every standalone Sage tool page (Ask Sage, Self-assessment, and
 * the home page) that needs the same PKM domain list -- each dedicated page
 * fetches it independently rather than passing it down from the home page,
 * since a tool page can be opened directly without ever visiting Sage home.
 */
export function useSageDomains(): { domains: DomainSummary[]; loading: boolean } {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user?.uid || !vaultOwnerToken) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, false, vaultOwnerToken);
        if (!cancelled) setDomains(metadata.domains);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, vaultOwnerToken]);

  return { domains, loading };
}
