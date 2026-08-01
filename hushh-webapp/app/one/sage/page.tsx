"use client";

import { Sparkles } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SagePanel } from "@/components/sage/sage-panel";
import { useAuth } from "@/hooks/use-auth";

export default function SagePage() {
  const { user } = useAuth();

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/sage",
        marker: "native-route-sage",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Sage"
          title="Sage"
          description="Your personal researcher and second brain -- reads across everything Hushh knows about you and surfaces what actually connects."
          icon={Sparkles}
          accent="violet"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SagePanel />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
