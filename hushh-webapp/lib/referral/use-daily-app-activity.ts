"use client";

import { useEffect, useRef } from "react";
import type { User } from "firebase/auth";
import { ReferralService } from "@/lib/services/referral-service";
import { Capacitor } from "@capacitor/core";

/** Mounted only while the authenticated referral dashboard is being viewed. */
export function useDailyAppActivity(user: User | null | undefined, onRecorded: () => void): void {
  const callback = useRef(onRecorded);
  useEffect(() => { callback.current = onRecorded; }, [onRecorded]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let pending = false;
    let nativeActive = true;
    let nextCheck = 0;
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    const isVisible = () => document.visibilityState === "visible";
    const record = async (resumed = false) => {
      if (cancelled || pending || !nativeActive || !isVisible() || (!resumed && performance.now() < nextCheck)) return;
      pending = true;
      try {
        const idToken = await user.getIdToken();
        if (cancelled || !nativeActive || !isVisible()) return;
        const result = await ReferralService.recordAppOpen({ idToken });
        if (!cancelled) {
          const delay = Date.parse(result.next_day_at) - Date.parse(result.server_now);
          if (!Number.isFinite(delay) || delay <= 0 || delay > 86_400_000) {
            throw new Error("Dashboard day boundary is unavailable");
          }
          nextCheck = performance.now() + delay;
          clearTimeout(midnightTimer);
          midnightTimer = setTimeout(() => { void record(); }, delay + 25);
          callback.current();
        }
      } catch { /* Keep the day unrecorded; online/resume or the next tick retries. */ }
      finally { pending = false; }
    };
    void record();
    const onOpen = () => { void record(true); };
    document.addEventListener("visibilitychange", onOpen);
    window.addEventListener("online", onOpen);
    const timer = window.setInterval(() => { void record(); }, 60_000);
    const nativeListener = Capacitor.isNativePlatform()
      ? import("@capacitor/app").then(({ App }) => App.addListener("appStateChange", ({ isActive }) => { nativeActive = isActive; if (isActive) onOpen(); }))
      : null;
    return () => { cancelled = true; window.clearInterval(timer); clearTimeout(midnightTimer);
      if (nativeListener) void nativeListener.then((handle) => handle.remove()).catch(() => {});
      document.removeEventListener("visibilitychange", onOpen); window.removeEventListener("online", onOpen); };
  }, [user]);
}
