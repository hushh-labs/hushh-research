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
 * After a sync the owner started finishes, aggregate observations are assessed
 * by the memory agents and staged into Soul.md. Individual receipts stay in
 * Receipt Radar; no new shopping-domain transaction index is written. It
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
  partialScan = true,
}: {
  receipts: readonly ReceiptListItem[];
  accountKey: string | null | undefined;
  syncCompletion?: number;
  savedCompletionRef?: MutableRefObject<number>;
  autoSave?: boolean;
  partialScan?: boolean;
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
    if (!autoSave || receiptsRef.current.length === 0) { savedCompletionRef.current = syncCompletion; return; }
    const origin = { ...authorityRef.current, accountKey: accountKeyRef.current,
      receipts: [...receiptsRef.current], now: new Date() };
    if (!origin.userId || !origin.vaultKey || !origin.vaultOwnerToken || !origin.isVaultUnlocked) return;
    const run = (runRef.current += 1);
    const isCurrent = () => runRef.current === run && authorityRef.current.userId === origin.userId &&
      authorityRef.current.vaultKey === origin.vaultKey && authorityRef.current.vaultOwnerToken === origin.vaultOwnerToken &&
      authorityRef.current.isVaultUnlocked && accountKeyRef.current === origin.accountKey;
    const saveOnce = async (): Promise<"saved" | "failed" | "locked"> => {
      if (!isCurrent()) return "locked";
      try {
        await saveReceiptCanonicalIndexToMemory({
          userId: origin.userId!, vaultKey: origin.vaultKey!, vaultOwnerToken: origin.vaultOwnerToken!,
          receipts: origin.receipts, accountKey: origin.accountKey, now: origin.now, partialScan, isCurrent,
        });
        if (isCurrent()) savedCompletionRef.current = syncCompletion;
        return "saved";
      } catch {
        if (!isCurrent()) return "locked";
        console.error("[GmailReceiptMemorySave] Receipt trend assessment failed.");
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
    return () => { runRef.current += 1; };
  }, [autoSave, savedCompletionRef, syncCompletion, user?.uid, vaultKey, vaultOwnerToken, isVaultUnlocked, accountKey, partialScan]);

  return null;
}
