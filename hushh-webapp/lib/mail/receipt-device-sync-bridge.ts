"use client";

import { useCallback, useEffect } from "react";

import { usePrivateMailSession } from "./private-mail-session";
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
  const { user, userId, isAuthenticated, loading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken, ownerTokenStatus } = useVault();
  const ownerId = userId ?? null;
  const unlocked = Boolean(!loading && isAuthenticated && !sessionVerificationRequired && ownerId && isVaultUnlocked && ownerTokenStatus === "valid" && vaultKey && vaultOwnerToken);
  const idTokenProvider = useCallback(() => user?.getIdToken?.() ?? Promise.resolve(""), [user]);
  const mail = usePrivateMailSession();
  const selected = mail?.private ? mail.selected : null;
  const slot = selected?.receiptSyncAvailable ? selected.accountId : null;
  const grant = selected?.credentialId;
  const gmail = useGmailConnectorStatus({ userId: ownerId, enabled: unlocked && !mail?.private && !mail?.resolving, idTokenProvider: user ? idTokenProvider : null });
  const status = gmail.status;
  const account = mail?.resolving ? null : mail?.private ? slot : status?.connected === true && !status.revoked && status.needs_reauth !== true && status.receipt_sync_available !== false
    ? status.google_sub || status.google_email || null : null;
  useEffect(() => (ownerId && user ? registerReceiptSyncAuth(ownerId, idTokenProvider) : undefined), [ownerId, user, idTokenProvider]);
  useEffect(() => {
    if (!unlocked || !ownerId || !vaultKey || !vaultOwnerToken || !account) return;
    let active = true;
    void startBackgroundReceiptSync({ userId: ownerId, vaultKey, vaultOwnerToken, isCurrent: () => active }, slot && grant ? {account: slot, getIdToken: idTokenProvider, isCurrent: () => active, privateMailbox: { accountId: slot, credentialId: grant }} : undefined).catch(() => undefined);
    return () => { active = false; MailReceiptResourceService.retireObsolete(ownerId); };
  }, [unlocked, ownerId, vaultKey, vaultOwnerToken, account, slot, grant, idTokenProvider]);
  return null;
}
