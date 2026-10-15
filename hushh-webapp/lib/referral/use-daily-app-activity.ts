"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ReferralService } from "@/lib/services/referral-service";
import { Capacitor } from "@capacitor/core";

/** App entry/resume owns this write; dashboard reads never record attendance. */
export function useDailyAppActivity(): void {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let pending = false;
    let nextCheck = 0;
    const record = async (resumed = false) => {
      if (cancelled || pending || document.visibilityState === "hidden" || (!resumed && performance.now() < nextCheck)) return;
      pending = true;
      try {
        const idToken = await user.getIdToken();
        if (cancelled) return;
        const result = await ReferralService.recordAppOpen({ idToken });
        if (!cancelled) nextCheck = performance.now() + Math.max(0, Date.parse(result.next_day_at) - Date.parse(result.server_now));
      } catch { /* Keep the day unrecorded; online/resume or the next tick retries. */ }
      finally { pending = false; }
    };
    void record();
    const onOpen = () => { void record(true); };
    document.addEventListener("visibilitychange", onOpen);
    window.addEventListener("online", onOpen);
    const timer = window.setInterval(() => { void record(); }, 60_000);
    const nativeListener = Capacitor.isNativePlatform()
      ? import("@capacitor/app").then(({ App }) => App.addListener("appStateChange", ({ isActive }) => { if (isActive) onOpen(); }))
      : null;
    return () => { cancelled = true; window.clearInterval(timer);
      if (nativeListener) void nativeListener.then((handle) => handle.remove()).catch(() => {});
      document.removeEventListener("visibilitychange", onOpen); window.removeEventListener("online", onOpen); };
  }, [user]);
}
