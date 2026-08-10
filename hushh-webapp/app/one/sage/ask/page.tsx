"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Skeleton } from "@/components/ui/skeleton";
import { AskSagePanel } from "@/components/sage/ask-sage-panel";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useSageDomains } from "@/hooks/use-sage-domains";
import { ApiService } from "@/lib/services/api-service";

export default function SageAskPage() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const { domains, loading } = useSageDomains();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || undefined;
  const autoAsk = searchParams.get("auto") === "1";
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([]);

  // Same cross-domain briefing call the Sage home page uses -- suggested
  // prompts live inside its response, there's no separate lightweight
  // endpoint for them. Best-effort: a failure here just means no chips,
  // never blocks the actual ask box below.
  useEffect(() => {
    if (!vaultOwnerToken || domains.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await ApiService.summarizeSageBriefing({
          vaultOwnerToken,
          domains: domains.map((d) => ({
            domain: d.key,
            displayName: d.displayName,
            summary: d.summary,
            attributeCount: d.attributeCount,
            lastUpdated: d.readableUpdatedAt || d.lastUpdated,
          })),
        });
        const data = response.ok ? await response.json() : null;
        if (!cancelled && Array.isArray(data?.suggested_prompts)) {
          setSuggestedPrompts(data.suggested_prompts.filter((p: unknown) => typeof p === "string"));
        }
      } catch {
        // Best-effort only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domains, vaultOwnerToken]);

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/sage/ask",
        marker: "native-route-sage-ask",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Sage"
          title="Ask Sage"
          description="A real question, researched live and personalized against what Sage knows about you -- ask a follow-up any time."
          leading={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--app-radius-lg)] bg-blue-500/10 px-2 text-blue-700 dark:text-blue-300 sm:h-11 sm:w-11 sm:px-3">
              <Search className="h-5 w-5" aria-hidden />
            </span>
          }
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <AskSagePanel
            domains={domains}
            suggestedPrompts={suggestedPrompts}
            initialQuery={initialQuery}
            autoAsk={autoAsk}
          />
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
