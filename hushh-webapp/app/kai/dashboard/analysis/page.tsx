"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";

function LegacyKaiDashboardAnalysisRedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    router.replace(query ? `/kai/analysis?${query}` : "/kai/analysis");
  }, [router, searchParams]);

  return (
    <AppPageShell
      as="div"
      width="content"
      className="flex min-h-72 items-center justify-center"
      nativeTest={{
        routeId: "/kai/dashboard/analysis",
        marker: "native-route-kai-dashboard-analysis",
        authState: "authenticated",
        dataState: "redirect-valid",
      }}
    >
      <HushhLoader variant="inline" label="Redirecting to analysis…" />
    </AppPageShell>
  );
}

export default function LegacyKaiDashboardAnalysisRedirect() {
  return (
    <Suspense fallback={<HushhLoader variant="inline" label="Redirecting to analysis…" />}>
      <LegacyKaiDashboardAnalysisRedirectContent />
    </Suspense>
  );
}
