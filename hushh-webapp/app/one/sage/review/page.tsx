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
      width="reading"
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
          leading={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--app-radius-lg)] bg-blue-500/10 px-2 text-blue-700 dark:text-blue-300 sm:h-11 sm:w-11 sm:px-3">
              <FileText className="h-5 w-5" aria-hidden />
            </span>
          }
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {loading ? <Skeleton className="h-64 w-full" /> : <SelfReviewPanel domains={domains} />}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
