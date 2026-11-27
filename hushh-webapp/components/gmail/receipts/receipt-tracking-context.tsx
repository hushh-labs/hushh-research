"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  type Ctx, type LoadedTracking, type ReceiptTrackingDoc, loadTracking, saveTracking,
} from "@/lib/mail/receipt-tracking";
import type { PrivateReceiptMailbox } from "@/lib/services/gmail-receipts-service";
import { DurableResourceError } from "@/lib/services/durable-resource-error";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";

export type TrackingStatus = "idle" | "loading" | "ready" | "error";

export interface ReceiptTrackingValue {
  status: TrackingStatus;
  doc: ReceiptTrackingDoc | null;
  /** Why the saved choices could not be opened. */
  error: string | null;
  /** Why the last choice could not be saved; the choice was not applied. */
  saveError: string | null;
  /** Applies one change and saves it. Resolves false, with `saveError` set, when it could not be saved. */
  apply: (change: (doc: ReceiptTrackingDoc, ctx: Ctx) => ReceiptTrackingDoc) => Promise<boolean>;
  retry: () => void;
}

const Context = createContext<ReceiptTrackingValue | null>(null);

export function useReceiptTracking(): ReceiptTrackingValue | null {
  return useContext(Context);
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 14) : Math.random().toString(36).slice(2, 16));

/**
 * Tracked bills and insight choices for the connected mailbox. The private agent
 * only receives encrypted information, and a failure leaves receipts usable.
 */
export function ReceiptTrackingProvider({
  userId, vaultKey, vaultOwnerToken, accountKey, privateMailbox, enabled, children,
}: {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  accountKey: string | null;
  privateMailbox?: PrivateReceiptMailbox;
  enabled: boolean;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<TrackingStatus>("idle");
  const [doc, setDoc] = useState<ReceiptTrackingDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef<LoadedTracking | null>(null);
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const ready = enabled && Boolean(userId && vaultKey && vaultOwnerToken && accountKey);

  const session = useCallback((mine: number) => ({
    userId: userId!, vaultKey: vaultKey!, vaultOwnerToken: vaultOwnerToken!, isCurrent: () => generation.current === mine,
  }), [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    const mine = ++generation.current;
    loaded.current = null;
    setDoc(null);
    setSaveError(null);
    if (!ready) { setStatus("idle"); setError(null); return; }
    setStatus("loading");
    setError(null);
    void loadTracking(session(mine), accountKey!, privateMailbox)
      .then((result) => {
        if (generation.current !== mine) return;
        loaded.current = result;
        setDoc(result.doc);
        setStatus("ready");
      })
      .catch((failure: unknown) => {
        if (generation.current !== mine) return;
        setError(failure instanceof DurableResourceError && failure.code === "storage_unavailable"
          ? "Encrypted storage isn’t available in this browser, so tracked bills can’t be saved."
          : "Your tracked bills couldn’t be opened. Your saved receipts are unchanged.");
        setStatus("error");
      });
    const stopListening = subscribeDurableOwnerReset((owner) => { if (owner === userId) setAttempt((value) => value + 1); });
    return () => { generation.current = mine + 1; stopListening(); };
  }, [ready, userId, vaultKey, vaultOwnerToken, accountKey, privateMailbox, attempt, session]);

  const apply = useCallback<ReceiptTrackingValue["apply"]>((change) => {
    const run = async (): Promise<boolean> => {
      const mine = generation.current;
      const current = loaded.current;
      if (!current || !ready) return false;
      const ctx: Ctx = { now: new Date(), id: newId };
      const attemptSave = async (base: LoadedTracking): Promise<LoadedTracking | null> => {
        const next = change(base.doc, ctx);
        if (next === base.doc) return base;
        const version = await saveTracking(session(mine), accountKey!, next, base.version, privateMailbox);
        return { doc: next, version };
      };
      try {
        let result: LoadedTracking | null;
        try {
          result = await attemptSave(current);
        } catch (failure) {
          // Another tab saved first: reread once and apply the same change on top of it.
          if (!(failure instanceof DurableResourceError) || failure.code !== "stale_version") throw failure;
          result = await attemptSave(await loadTracking(session(mine), accountKey!, privateMailbox));
        }
        if (generation.current !== mine || !result) return false;
        loaded.current = result;
        setDoc(result.doc);
        setSaveError(null);
        return true;
      } catch {
        if (generation.current === mine) setSaveError("Couldn’t save that choice. Nothing was changed, and your saved receipts are unchanged.");
        return false;
      }
    };
    const next = queue.current.then(run, run);
    queue.current = next;
    return next;
  }, [accountKey, privateMailbox, ready, session]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const value = useMemo<ReceiptTrackingValue>(
    () => ({ status: ready ? status : "idle", doc, error, saveError, apply, retry }),
    [ready, status, doc, error, saveError, apply, retry],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
