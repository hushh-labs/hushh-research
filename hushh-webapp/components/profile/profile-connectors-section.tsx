"use client";

import { useCallback } from "react";

import { ConnectorsPanel } from "@/components/agent/connectors-panel";
import type { ProfileStackEntry } from "@/components/profile/profile-stack-navigator";
import { useAuth } from "@/hooks/use-auth";
import type { ProfileDetail } from "@/lib/navigation/profile-routes";
import {
  activeChatConnectorRecoveryHost,
  saveCustomConnectorSettingsHandoff,
} from "@/lib/agent/drive-oauth-chat-recovery";
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
  // A sign-in that leaves the app must not lose what is underneath the pane.
  // Over a chat, the chat saves its unsent draft and the return reopens this
  // section over it. With no chat underneath, a built-in connector (Drive) has
  // nothing to save and goes ahead; a custom connector records only the
  // correlation needed to finish at /one/profile/connectors/oauth/return and
  // come back here (no draft, token or code).
  const prepareSignInReturn = useCallback(
    async (input: RecoveryInput) => {
      const chat = activeChatConnectorRecoveryHost();
      if (chat) return chat.prepare(input);
      if (!input.customConnector) return "ready" as const;
      const owner = snapshotValidatedAuthSessionOwner();
      if (
        input.reason !== "web_full_page" ||
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
  const clearSignInReturn = useCallback(async () => {
    await activeChatConnectorRecoveryHost()?.clear();
  }, []);
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
      onPrepareRecovery={prepareSignInReturn}
      onClearRecovery={clearSignInReturn}
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
