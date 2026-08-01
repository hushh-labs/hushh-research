"use client";

import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Skeleton } from "@/components/ui/skeleton";
import { AskSagePanel } from "@/components/sage/ask-sage-panel";
import { useAuth } from "@/hooks/use-auth";
import { useSageDomains } from "@/hooks/use-sage-domains";

export default function SageAskPage() {
  const { user } = useAuth();
  const { domains, loading } = useSageDomains();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || undefined;
  const autoAsk = searchParams.get("auto") === "1";

  return (
    <AppPageShell
      as="main"
      width="standard"
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
          icon={Search}
          accent="violet"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <AskSagePanel domains={domains} initialQuery={initialQuery} autoAsk={autoAsk} />
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
