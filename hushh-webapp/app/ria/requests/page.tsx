"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { buildRiaConsentManagerHref } from "@/lib/consent/consent-sheet-route";
import { ROUTES } from "@/lib/navigation/routes";

function RiaRequestsAliasPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const view = searchParams.get("view")?.trim();
    router.replace(
      buildRiaConsentManagerHref(view === "active" || view === "previous" ? view : "pending", {
        from: ROUTES.RIA_CLIENTS,
      })
    );
  }, [router, searchParams]);

  return (
    <AppPageShell as="div" width="content" className="flex min-h-72 items-center justify-center">
      <HushhLoader variant="inline" label="Redirecting to consents…" />
    </AppPageShell>
  );
}

export default function RiaRequestsAliasPage() {
  return (
    <Suspense fallback={<HushhLoader variant="inline" label="Redirecting to consents…" />}>
      <RiaRequestsAliasPageContent />
    </Suspense>
  );
}
