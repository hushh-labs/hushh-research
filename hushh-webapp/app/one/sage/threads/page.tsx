"use client";

import { FlaskConical } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ResearchThreadsPanel } from "@/components/sage/research-threads-panel";
import { useAuth } from "@/hooks/use-auth";

export default function SageThreadsPage() {
  const { user } = useAuth();

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/sage/threads",
        marker: "native-route-sage-threads",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Sage"
          title="Research threads"
          description="An ongoing investigation Sage keeps working on with you -- questions asked, papers traced, and what's still open."
          leading={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--app-radius-lg)] bg-blue-500/10 px-2 text-blue-700 dark:text-blue-300 sm:h-11 sm:w-11 sm:px-3">
              <FlaskConical className="h-5 w-5" aria-hidden />
            </span>
          }
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <ResearchThreadsPanel />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
