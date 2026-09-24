"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { ConnectorsPanel } from "@/components/agent/connectors-panel";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { ROUTES } from "@/lib/navigation/routes";

export default function ExternalConnectorsPage() {
  const router = useRouter();
  const [dataState, setDataState] = useState<"loading" | "loaded" | "unavailable-valid">("loading");
  const reportCatalogState = useCallback((state: "loading" | "loaded" | "unavailable-valid") => {
    setDataState(state);
  }, []);

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="flex min-h-[calc(100dvh-var(--app-bottom-nav-height,0px))] flex-col"
      nativeTest={{
        routeId: "profile-connectors",
        marker: "native-route-profile-connectors",
        authState: "authenticated",
        dataState,
      }}
    >
      <AppPageHeaderRegion className="sr-only">
        <h1>Connectors</h1>
      </AppPageHeaderRegion>
      <AppPageContentRegion className="min-h-0 flex-1">
        <ConnectorsPanel
          open
          surface="settings"
          onBack={() => router.push(ROUTES.PROFILE)}
          onCatalogStateChange={reportCatalogState}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
