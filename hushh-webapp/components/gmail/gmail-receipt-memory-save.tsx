"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { saveReceiptCanonicalIndexToMemory } from "@/lib/profile/gmail-receipt-memory-save";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { useVault } from "@/lib/vault/vault-context";

/** Product default for saving after a finished sync; an owner setting can override it later. */
export const RECEIPT_MEMORY_AUTO_SAVE_DEFAULT = true;

/** Quiet retries after a failed automatic save, before telling the owner. */
export const RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000];

/**
 * Keeps the owner's private memory of their receipts current, with no control.
 *
 * After a sync the owner started finishes, the finished list is saved once
 * through the existing governed writer (`gmail_receipt_memory_save_button`), so
 * Chat with One can answer from it without sending the owner back to Mail. It
 * renders nothing: the owner is never asked to save.
 *
 * It writes only when `syncCompletion` has moved past `savedCompletionRef`
 * (never on mount, on a partly loaded list, or for an empty list). The ref is
 * owned by the page, so a remount saves a finished sync once and never again.
 * A failed save is retried quietly a bounded number of times, then reported
 * once; the next finished sync saves again.
 */
export function GmailReceiptMemorySave({
  receipts,
  accountKey,
  syncCompletion = 0,
  savedCompletionRef,
  autoSave = RECEIPT_MEMORY_AUTO_SAVE_DEFAULT,
}: {
  receipts: readonly ReceiptListItem[];
  accountKey: string | null | undefined;
  syncCompletion?: number;
  savedCompletionRef?: MutableRefObject<number>;
  autoSave?: boolean;
}): null {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;
  const authorityRef = useRef({ userId: user?.uid, vaultKey, vaultOwnerToken, isVaultUnlocked });
  authorityRef.current = { userId: user?.uid, vaultKey, vaultOwnerToken, isVaultUnlocked };
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  // A newer finished sync, or leaving the page, ends an older save's retries.
  const runRef = useRef(0);
  useEffect(
    () => () => {
      runRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!savedCompletionRef || syncCompletion <= savedCompletionRef.current) return;
    savedCompletionRef.current = syncCompletion;
    if (!autoSave || receiptsRef.current.length === 0) return;

    const run = (runRef.current += 1);
    const saveOnce = async (): Promise<"saved" | "failed" | "locked"> => {
      const { userId, vaultKey: key, vaultOwnerToken: token, isVaultUnlocked: unlocked } =
        authorityRef.current;
      if (!userId || !key || !token || !unlocked) return "locked";
      try {
        await saveReceiptCanonicalIndexToMemory({
          userId,
          vaultKey: key,
          vaultOwnerToken: token,
          receipts: receiptsRef.current,
          accountKey: accountKeyRef.current,
        });
        return "saved";
      } catch (error) {
        console.error("[GmailReceiptMemorySave] Failed to save receipts:", error);
        return "failed";
      }
    };
    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        const outcome = await saveOnce();
        if (outcome !== "failed" || runRef.current !== run) return;
        const delay = RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          toast("We couldn't update your private receipt memory. It will retry after your next sync.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (runRef.current !== run) return;
      }
    })();
  }, [autoSave, savedCompletionRef, syncCompletion]);

  return null;
}
