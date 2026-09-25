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
import { useAuth } from "@/hooks/use-auth";
import { saveCustomConnectorSettingsHandoff } from "@/lib/agent/drive-oauth-chat-recovery";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

export default function ExternalConnectorsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [dataState, setDataState] = useState<"loading" | "loaded" | "unavailable-valid">("loading");
  const reportCatalogState = useCallback((state: "loading" | "loaded" | "unavailable-valid") => {
    setDataState(state);
  }, []);
  const prepareCustomConnectorReturn = useCallback(async (input: {
    attemptId: string;
    reason: "web_full_page" | "native_oauth" | "native_picker";
    customConnector?: { connectorId: string; revision: string };
  }) => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (input.reason !== "web_full_page" || !input.customConnector ||
        !user || owner?.userId !== user.uid || !isValidatedAuthSessionOwnerCurrent(owner)) {
      return "unavailable" as const;
    }
    try {
      saveCustomConnectorSettingsHandoff({
        ownerUserId: user.uid,
        attemptId: input.attemptId,
        customConnector: input.customConnector,
      });
      return "ready" as const;
    } catch {
      return "unavailable" as const;
    }
  }, [user]);

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
          onPrepareRecovery={prepareCustomConnectorReturn}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
