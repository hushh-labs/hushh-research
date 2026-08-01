"use client";

import { BookOpen } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { NotesArchivePanel } from "@/components/sage/notes-archive-panel";
import { useAuth } from "@/hooks/use-auth";

export default function SageNotesPage() {
  const { user } = useAuth();

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/sage/notes",
        marker: "native-route-sage-notes",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Sage"
          title="Notes archive"
          description="Every raw note Kai has captured in your own words, across every domain, searchable in one place."
          icon={BookOpen}
          accent="violet"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <NotesArchivePanel />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
