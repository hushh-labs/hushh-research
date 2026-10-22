"use client";

import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { openCommerceHostedWindow, validateCommerceHostedUrl } from "@/lib/services/scope-commerce-browser";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { useCommerceSession } from "./use-commerce-session";
import type { useCommerceAction } from "./use-commerce-action";

/** Own only the pending window; a verified provider destination has its own lifetime. */
export function useCommerceManagement(
  { user }: ReturnType<typeof useCommerceSession>,
  { busy, run, setMessage }: ReturnType<typeof useCommerceAction>,
  prepare: (token: string) => Promise<string>,
) {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const retire = () => { pending.current?.abort(); pending.current = null; };
    const unsubscribe = subscribeVaultSessionEpoch(retire);
    return () => { unsubscribe(); retire(); };
  }, [user]);
  return () => {
    if (!user || busy || pending.current) return;
    const popup = openCommerceHostedWindow();
    if (!Capacitor.isNativePlatform() && !popup) {
      setMessage("Allow pop-ups for One, then try again. Your unlocked session stays here.");
      return;
    }
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => { try { popup?.close(); } catch { /* Browser owns window policy. */ } }, { once: true });
    pending.current = controller;
    let handedOff = false;
    return run(async (token, current) => {
      const raw = await prepare(token);
      if (!current() || controller.signal.aborted) return;
      const url = validateCommerceHostedUrl(raw, "management");
      if (popup) popup.location.replace(url);
      else {
        const { Browser } = await import("@capacitor/browser");
        if (!current() || controller.signal.aborted) return;
        await Browser.open({ url });
      }
      handedOff = true;
    }).finally(() => {
      if (!handedOff) controller.abort();
      if (pending.current === controller) pending.current = null;
    });
  };
}
