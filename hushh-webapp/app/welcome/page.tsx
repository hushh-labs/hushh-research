"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PublicKnowledgeWorkspace } from "@/components/app-ui/public-knowledge-workspace";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";
import { ROUTES } from "@/lib/navigation/routes";

const PUBLIC_KNOWLEDGE_TABS = new Set(["research", "blog", "developers"]);

/**
 * Public knowledge is intentionally separate from `/`: root remains the
 * anonymous onboarding entry, while this route owns the tabbed workspace.
 */
function WelcomeWorkspaceRoute() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const value = searchParams.get("tab");

  if (!value || !PUBLIC_KNOWLEDGE_TABS.has(value)) {
    return <WelcomeRouteRedirect router={router} />;
  }

  return <PublicKnowledgeWorkspace />;
}

function WelcomeRouteRedirect({ router }: { router: ReturnType<typeof useRouter> }) {
  useEffect(() => {
    router.replace(ROUTES.HOME);
  }, [router]);
  return <RouteSuspenseFallback label="Opening One…" />;
}

export default function WelcomePage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading workspace…" />}>
      <WelcomeWorkspaceRoute />
    </Suspense>
  );
}
