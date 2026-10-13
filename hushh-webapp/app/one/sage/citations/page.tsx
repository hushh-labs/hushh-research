"use client";

import { GitBranch } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { CitationLineagePanel } from "@/components/sage/citation-lineage-panel";
import { useAuth } from "@/hooks/use-auth";

export default function SageCitationsPage() {
  const { user } = useAuth();

  return (
    <AppPageShell
      as="main"
      width="expanded"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/sage/citations",
        marker: "native-route-sage-citations",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Sage"
          title="Citation lineage"
          description="Trace a paper's real citation graph -- what it builds on, and what builds on it."
          icon={GitBranch}
          accent="violet"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <CitationLineagePanel />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
