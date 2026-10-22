"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { openCommerceHostedUrl, openCommerceHostedWindow, type CommerceHostedPurpose } from "@/lib/services/scope-commerce-browser";
import type { CommerceHostedSession } from "@/lib/services/scope-commerce-return";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { useCommerceSession } from "./use-commerce-session";
import type { useCommerceAction } from "./use-commerce-action";

/** The initiating document owns the window; current owner/vault state fences returns. */
export function useCommerceHostedFlow(
  { user }: ReturnType<typeof useCommerceSession>,
  { busy, setMessage, run }: ReturnType<typeof useCommerceAction>,
  prepare: (token: string, purpose: CommerceHostedPurpose) => Promise<CommerceHostedSession>,
  onReturn: (purpose: CommerceHostedPurpose) => Promise<void>,
) {
  const hostedController = useRef<AbortController | null>(null);
  const [hostedPending, setHostedPending] = useState(false);
  useEffect(() => {
    const retire = () => {
      hostedController.current?.abort();
      hostedController.current = null;
      setHostedPending(false);
    };
    const unsubscribe = subscribeVaultSessionEpoch(retire);
    return () => { unsubscribe(); retire(); };
  }, [user]);
  const startHosted = (purpose: CommerceHostedPurpose) => {
    if (!user || busy || hostedController.current) return;
    const popup = openCommerceHostedWindow();
    if (!Capacitor.isNativePlatform() && !popup) {
      setMessage("Allow pop-ups for One, then try again. Your unlocked session stays here.");
      return;
    }
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      try { popup?.close(); } catch { /* Browser owns popup policy. */ }
    }, { once: true });
    hostedController.current = controller;
    setHostedPending(true);
    return run(async (token, current) => {
      if (controller.signal.aborted) return;
      const session = await prepare(token, purpose);
      if (!current() || controller.signal.aborted) return;
      await openCommerceHostedUrl(session, purpose, popup, controller.signal);
      if (!current() || controller.signal.aborted) return;
      await onReturn(purpose);
    }).finally(() => {
      controller.abort();
      if (hostedController.current === controller) {
        hostedController.current = null;
        setHostedPending(false);
      }
    });
  };
  return { hostedPending, startHosted, cancelHosted: () => hostedController.current?.abort() };
}
