"use client";

import { useContext, useEffect, useState } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { useAuth } from "@/hooks/use-auth";
import { peekFilesWikiOverviewCache } from "@/lib/files/files-cache";
import { FilesService, type WikiOverview } from "@/lib/files/service";
import { useFilesConnection } from "@/lib/files/use-files-connection";
import { ROUTES } from "@/lib/navigation/routes";
import {
  CORE_AGENT_MARKDOWN_IDS,
  CORE_AGENT_MARKDOWN_META,
  peekCoreAgentMarkdownFile,
} from "@/lib/pkm/agent-core-markdown-files";
import { useVault } from "@/lib/vault/vault-context";

export function MemoryKnowledgeHub({
  onNavigate,
}: {
  onNavigate?: (href: string) => void;
} = {}) {
  const appRouter = useContext(AppRouterContext);
  const navigateTo = (href: string) => {
    if (onNavigate) {
      onNavigate(href);
      return;
    }
    if (appRouter) {
      appRouter.push(href);
      return;
    }
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", href);
    }
  };
  const { userId } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const { hosting } = useFilesConnection(userId ?? undefined, vaultKey, vaultOwnerToken);
  const filesAvailable = Boolean(userId && vaultKey && vaultOwnerToken && hosting);

  const [wikiOverview, setWikiOverview] = useState<WikiOverview | null>(() =>
    userId ? peekFilesWikiOverviewCache(userId) : null,
  );

  useEffect(() => {
    if (!filesAvailable) {
      setWikiOverview(null);
      return;
    }
    const controller = new AbortController();
    void FilesService.wikiOverview(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setWikiOverview(next);
      })
      .catch(() => {
        // Keep cached summary when background refresh fails.
      });
    return () => controller.abort();
  }, [filesAvailable]);

  const pageCount = wikiOverview?.pages.length ?? 0;
  const pendingCount = wikiOverview?.candidateReceipts.length ?? 0;
  const wikiDescription = !filesAvailable
    ? "Open your Personal wiki folder in Files."
    : pageCount > 0 || pendingCount > 0
      ? [
          pageCount > 0 ? `${pageCount} ${pageCount === 1 ? "page" : "pages"}` : null,
          pendingCount > 0 ? `${pendingCount} to review` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "No saved pages yet · Open Personal wiki in Files";

  return (
    <div className="space-y-4">
      <SettingsGroup title="Wiki" separatorInset testId="memory-knowledge-wiki">
        <SettingsRow
          title="Personal wiki"
          description={wikiDescription}
          chevron
          ariaLabel="Open Personal wiki in Files"
          testId="memory-open-personal-wiki"
          onClick={() => navigateTo(`${ROUTES.ONE_FILES}?folder=personal-wiki`)}
        />
      </SettingsGroup>

      <SettingsGroup title="Core files" separatorInset testId="memory-knowledge-files">
        {CORE_AGENT_MARKDOWN_IDS.map((docId) => {
          const meta = CORE_AGENT_MARKDOWN_META[docId];
          const warm = peekCoreAgentMarkdownFile(userId, docId);
          const testIdSuffix = docId.replace(".md", "");
          return (
            <SettingsRow
              key={docId}
              title={meta.title}
              description={warm?.updatedAt ? `${meta.subtitle} · Saved` : meta.subtitle}
              chevron
              ariaLabel={`Open ${meta.title} in Files`}
              testId={`memory-open-core-${testIdSuffix}`}
              onClick={() =>
                navigateTo(
                  `${ROUTES.ONE_FILES}?folder=personal-wiki&doc=${encodeURIComponent(docId)}`,
                )
              }
            />
          );
        })}
      </SettingsGroup>
    </div>
  );
}
