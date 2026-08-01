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
      width="expanded"
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
          icon={FlaskConical}
          accent="violet"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <ResearchThreadsPanel />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
