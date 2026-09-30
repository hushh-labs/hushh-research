"use client";

import { useCallback } from "react";

import { ConnectorsPanel } from "@/components/agent/connectors-panel";
import type { ProfileStackEntry } from "@/components/profile/profile-stack-navigator";
import { useAuth } from "@/hooks/use-auth";
import type { ProfileDetail } from "@/lib/navigation/profile-routes";
import { saveCustomConnectorSettingsHandoff } from "@/lib/agent/drive-oauth-chat-recovery";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

type RecoveryInput = {
  attemptId: string;
  reason: "web_full_page" | "native_oauth" | "native_picker";
  customConnector?: { connectorId: string; revision: string };
};

/**
 * Connectors as a Profile section. Profile owns the open connector in its own
 * address (`profile_detail=connector:<id>`), so the pane header's title and
 * Back, deep links and the browser's Back all behave as they do for every
 * other Profile detail. The panel itself stays one mounted instance across
 * list and detail, so an OAuth sign-in in flight survives the move between
 * them.
 */
export function ProfileConnectorsSection({
  connectorId,
  onConnectorChange,
}: {
  connectorId: string | null;
  onConnectorChange: (connectorId: string | null) => void;
}) {
  const { user } = useAuth();
  // A custom connector's sign-in leaves the app for the provider and comes back
  // to /one/profile/connectors/oauth/return. Record only the correlation
  // needed to finish there and to return here; no draft, token or code.
  const prepareCustomConnectorReturn = useCallback(
    async (input: RecoveryInput) => {
      const owner = snapshotValidatedAuthSessionOwner();
      if (
        input.reason !== "web_full_page" ||
        !input.customConnector ||
        !user ||
        owner?.userId !== user.uid ||
        !isValidatedAuthSessionOwnerCurrent(owner)
      ) {
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
    },
    [user],
  );
  // Leaving Profile (for example "Connect a bank") is ordinary navigation;
  // the pane's own header owns Back, so the panel has nothing to go back to.
  const stayInProfile = useCallback(() => undefined, []);

  return (
    <ConnectorsPanel
      open
      surface="profile"
      activeConnector={connectorId}
      onActiveConnectorChange={onConnectorChange}
      onBack={stayInProfile}
      onPrepareRecovery={prepareCustomConnectorReturn}
    />
  );
}

/**
 * Profile's stack entry for Connectors. One entry serves the list and a
 * connector's detail: the panel is a single mounted instance, so a sign-in in
 * flight survives the move between them, while the detail still lives in the
 * address so the pane header titles it and its Back returns to the list.
 */
export function buildProfileConnectorsStackEntry({
  detail,
  updateView,
}: {
  detail: ProfileDetail | null;
  updateView: (
    next: { panel: "connectors"; detail: ProfileDetail | null },
    mode: "push" | "replace",
  ) => void;
}): ProfileStackEntry {
  const openConnectorId = detail?.startsWith("connector:")
    ? detail.slice("connector:".length)
    : null;
  return {
    key: "panel:connectors",
    title: "Connectors",
    description: openConnectorId
      ? undefined
      : "Google Workspace and finance connections.",
    content: (
      <ProfileConnectorsSection
        connectorId={openConnectorId}
        onConnectorChange={(connectorId) =>
          updateView(
            {
              panel: "connectors",
              detail: connectorId ? `connector:${connectorId}` : null,
            },
            connectorId && !openConnectorId ? "push" : "replace",
          )
        }
      />
    ),
  };
}
