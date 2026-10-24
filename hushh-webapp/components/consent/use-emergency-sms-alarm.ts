"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";

import { HushhNotifications } from "@/lib/capacitor";
import {
  isOneLocationGrantOpened,
  isOneLocationGrantUnwatched,
  ONE_LOCATION_GRANT_OPENED_EVENT,
  ONE_LOCATION_GRANT_UNWATCHED_EVENT,
  playOneLocationNotificationSound,
} from "@/lib/one-location/notifications";
import {
  installOneLocationNotificationSound,
  stopOneLocationNotificationSound,
} from "@/lib/one-location/notification-sound";

function useEmergencySmsAcknowledgements(
  userId: string | undefined,
  isNativePlatform: boolean,
  activeToastsRef: RefObject<Set<string>>,
  dismiss: (grantId: string) => void,
) {
  useEffect(() => {
    if (!userId) return;
    const release = installOneLocationNotificationSound();
    const activeToasts = activeToastsRef.current;
    const onAcknowledged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; grantId?: string }>).detail;
      if (detail?.userId === userId && detail.grantId) dismiss(detail.grantId);
    };
    const onStorage = () => {
      for (const grantId of activeToasts) {
        if (isOneLocationGrantOpened(userId, grantId) || isOneLocationGrantUnwatched(userId, grantId)) {
          dismiss(grantId);
        }
      }
    };
    window.addEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, onAcknowledged);
    window.addEventListener(ONE_LOCATION_GRANT_UNWATCHED_EVENT, onAcknowledged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, onAcknowledged);
      window.removeEventListener(ONE_LOCATION_GRANT_UNWATCHED_EVENT, onAcknowledged);
      window.removeEventListener("storage", onStorage);
      release();
      if (isNativePlatform) void HushhNotifications.stopEmergencySmsCue({}).catch(() => undefined);
      for (const grantId of [...activeToasts]) dismiss(grantId);
    };
  }, [activeToastsRef, dismiss, isNativePlatform, userId]);
}

/** One authenticated provider owns foreground cue admission and disposal. */
export function useEmergencySmsAlarm(userId: string | undefined, isNativePlatform: boolean) {
  const activeToastsRef = useRef(new Set<string>());
  const stopEmergencySms = useCallback((grantId: string) => {
    stopOneLocationNotificationSound(grantId);
    if (isNativePlatform) void HushhNotifications.stopEmergencySmsCue({ grantId }).catch(() => undefined);
    activeToastsRef.current.delete(grantId);
  }, [isNativePlatform]);
  const dismissEmergencySms = useCallback((grantId: string) => {
    stopEmergencySms(grantId);
    toast.dismiss(`one-location-share:${grantId}`);
  }, [stopEmergencySms]);

  useEmergencySmsAcknowledgements(userId, isNativePlatform, activeToastsRef, dismissEmergencySms);

  const startEmergencySms = useCallback((grantId: string, alarmExpiresAt?: number) => {
    if (!userId) return false;
    activeToastsRef.current.add(grantId);
    // One renderer owns sound and vibration together on native platforms.
    if (!isNativePlatform) return playOneLocationNotificationSound("sos", grantId, alarmExpiresAt);
    // Keep the bridge start deadline separate from the share lifetime.
    void HushhNotifications.playEmergencySmsCue({
      userId,
      grantId,
      expiresAt: Math.min(alarmExpiresAt ?? Infinity, Date.now() + 2000),
      alarmExpiresAt,
    }).catch(() => undefined);
    return false;
  }, [isNativePlatform, userId]);

  return { startEmergencySms, stopEmergencySms, dismissEmergencySms };
}
