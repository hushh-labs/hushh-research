"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { DisconnectRowIcon, GmailAgentIcon, MemoryAgentIcon, SyncRowIcon } from "@/components/icons/agents";

/** The Mail workspace retains connection, authorization and operation ownership. */
export function MailActionsGroup({
  connected,
  needsReauthentication,
  configured,
  busy,
  onSync,
  onConnect,
  onRefresh,
  onOpenReceipts,
  onDisconnect,
}: {
  connected: boolean;
  needsReauthentication: boolean;
  configured: boolean;
  busy: boolean;
  onSync: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onOpenReceipts: () => void;
  onDisconnect: () => void;
}) {
  return (
    <SettingsGroup title="Actions" rowSizing="uniform" testId="mail-actions-group">
      {connected ? (
        <SettingsRow icon={SyncRowIcon} iconTone="capability" title="Sync now"
          description="Fetch new receipt mail messages and refresh extracted records."
          disabled={busy} chevron onClick={onSync} />
      ) : (
        <SettingsRow icon={GmailAgentIcon} iconTone="capability"
          title={needsReauthentication ? "Reconnect Mail" : "Connect Mail"}
          description="Review Mail data use, then authorize read-only receipt sync."
          disabled={busy || !configured} chevron onClick={onConnect} />
      )}
      <SettingsRow icon={SyncRowIcon} iconTone="capability" title="Refresh status"
        description="Re-check your Mail connection, sync status, and inbox details."
        disabled={busy} chevron onClick={onRefresh} />
      <SettingsRow icon={MemoryAgentIcon} iconTone="capability" title="Open receipts"
        description="Review synced receipts, merchants, and extracted totals."
        chevron onClick={onOpenReceipts} />
      {connected ? (
        <SettingsRow icon={DisconnectRowIcon} iconTone="capability" title="Disconnect Mail"
          description="Revoke Mail, stop future syncs, and delete Mail receipt data."
          tone="destructive" disabled={busy} chevron onClick={onDisconnect} />
      ) : null}
    </SettingsGroup>
  );
}
