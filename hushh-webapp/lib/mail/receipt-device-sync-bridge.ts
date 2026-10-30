"use client";

import { useCallback, useEffect } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { MailReceiptResourceService } from "@/lib/services/mail-receipt-resource-service";
import { useVault } from "@/lib/vault/vault-context";

import { registerReceiptSyncAuth, startBackgroundReceiptSync } from "./receipt-device-sync";

/**
 * App-level: once unlocked with Gmail connected (including right after a new
 * connection reaches the shared connector status), sync this device's receipts
 * in the background when none are saved. Owner change, lock, credential renewal,
 * sign-out and account reset end the sync; its late results are discarded.
 */
export function ReceiptDeviceSyncBridge(): null {
  const { user, userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const ownerId = userId ?? null;
  const unlocked = Boolean(ownerId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const idTokenProvider = useCallback(() => user?.getIdToken?.() ?? Promise.resolve(""), [user]);
  const gmail = useGmailConnectorStatus({ userId: ownerId, enabled: unlocked, idTokenProvider: user ? idTokenProvider : null });
  const status = gmail.status;
  const account = status?.connected === true && status.needs_reauth !== true && status.receipt_sync_available !== false
    ? status.google_sub || status.google_email || null : null;
  useEffect(() => (ownerId && user ? registerReceiptSyncAuth(ownerId, idTokenProvider) : undefined), [ownerId, user, idTokenProvider]);
  useEffect(() => {
    if (!unlocked || !ownerId || !vaultKey || !vaultOwnerToken || !account) return;
    let active = true;
    void startBackgroundReceiptSync({ userId: ownerId, vaultKey, vaultOwnerToken, isCurrent: () => active }).catch(() => undefined);
    return () => { active = false; MailReceiptResourceService.retireObsolete(ownerId); };
  }, [unlocked, ownerId, vaultKey, vaultOwnerToken, account]);
  return null;
}
