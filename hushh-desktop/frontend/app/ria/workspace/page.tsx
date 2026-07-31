"use client";

import { Suspense, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { buildRiaClientWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";

type WorkspaceTab = "overview" | "access" | "kai" | "explorer";

const WORKSPACE_TABS = new Set<WorkspaceTab>(["overview", "access", "kai", "explorer"]);

function RiaWorkspaceCompatibilityRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();

  const target = useMemo(() => {
    const clientId = (searchParams.get("clientId") || "").trim();
    const tab = (searchParams.get("tab") || "").trim();
    const testProfile = (searchParams.get("test_profile") || "").trim() === "1";

    if (!clientId) {
      return ROUTES.RIA_CLIENTS;
    }

    return buildRiaClientWorkspaceRoute(clientId, {
      tab: WORKSPACE_TABS.has(tab as WorkspaceTab) ? (tab as WorkspaceTab) : undefined,
      testProfile,
    });
  }, [searchParams]);

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return (
    <AppPageShell
      as="main"
      width="standard"
      nativeTest={{
        routeId: "/ria/workspace",
        marker: "native-route-ria-workspace",
        authState: loading ? "pending" : user ? "authenticated" : "anonymous",
        dataState: "redirect-valid",
      }}
    />
  );
}

export default function RiaWorkspaceCompatibilityPage() {
  return (
    <Suspense fallback={null}>
      <RiaWorkspaceCompatibilityRedirect />
    </Suspense>
  );
}
