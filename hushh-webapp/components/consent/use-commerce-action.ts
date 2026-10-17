"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { useCommerceSession } from "@/components/consent/use-commerce-session";

/** Serializes an explicit UI action, with account/view fences around every await. */
export function useCommerceAction({ user, capture }: ReturnType<typeof useCommerceSession>, scope: string) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef<object | null>(null);
  useEffect(() => { setBusy(false); setMessage(null); inFlight.current = null; }, [user, scope]);
  const run = useCallback(async (action: (token: string, current: () => boolean) => Promise<void>) => {
    if (!user || inFlight.current) return;
    const current = capture(); const currentView = capture(false);
    const actionId = {}; inFlight.current = actionId; setBusy(true); setMessage(null);
    try { const token = await user.getIdToken(); if (current()) await action(token, current); }
    catch (error) { if (current()) setMessage(error instanceof Error ? error.message : "This action could not be confirmed."); }
    finally { if (inFlight.current === actionId) { inFlight.current = null; if (currentView()) setBusy(false); } }
  }, [user, capture]);
  return { busy, message, setMessage, run };
}
