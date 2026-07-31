"use client";

import { FileText } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Skeleton } from "@/components/ui/skeleton";
import { SelfReviewPanel } from "@/components/sage/self-review-panel";
import { useAuth } from "@/hooks/use-auth";
import { useSageDomains } from "@/hooks/use-sage-domains";

export default function SageReviewPage() {
  const { user } = useAuth();
  const { domains, loading } = useSageDomains();

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/sage/review",
        marker: "native-route-sage-review",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Sage"
          title="Self-assessment"
          description="Sage drafts a structured self-assessment from your real accumulated history -- only what you've actually told Kai, nothing invented."
          icon={FileText}
          accent="violet"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {loading ? <Skeleton className="h-64 w-full" /> : <SelfReviewPanel domains={domains} />}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
