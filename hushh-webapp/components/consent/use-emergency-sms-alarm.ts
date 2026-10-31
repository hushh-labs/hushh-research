"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";

import { HushhNotifications } from "@/lib/capacitor";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import {
  acknowledgeSmsAlarm,
  isSmsAlarmAcknowledged,
  pendingSmsAlarms,
  rememberSmsAlarm,
  SMS_ALARM_ACKNOWLEDGED_EVENT,
} from "@/lib/one-location/sms-alarm-state";
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
  getCurrentOwner: () => string | undefined,
  dismiss: (grantId: string) => void,
) {
  useEffect(() => {
    if (!userId) return;
    const release = installOneLocationNotificationSound();
    const activeToasts = activeToastsRef.current;
    let disposed = false;
    let nativeListener: { remove(): Promise<void> } | undefined;
    if (isNativePlatform && typeof HushhNotifications.addListener === "function") {
      void HushhNotifications.addListener("emergencySmsAcknowledged", (event) => {
        if (!disposed && event.userId === userId && activeToasts.has(event.grantId)) dismiss(event.grantId);
      }).then((listener) => {
        if (disposed) void listener.remove();
        else nativeListener = listener;
      }).catch(() => undefined);
    }
    const onAcknowledged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; grantId?: string }>).detail;
      if (detail?.userId === userId && detail.grantId && activeToasts.has(detail.grantId)) dismiss(detail.grantId);
    };
    const onStorage = () => {
      for (const grantId of activeToasts) {
        if (isSmsAlarmAcknowledged(userId, grantId) || isOneLocationGrantOpened(userId, grantId) || isOneLocationGrantUnwatched(userId, grantId)) {
          dismiss(grantId);
        }
      }
    };
    window.addEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, onAcknowledged);
    window.addEventListener(SMS_ALARM_ACKNOWLEDGED_EVENT, onAcknowledged);
    window.addEventListener(ONE_LOCATION_GRANT_UNWATCHED_EVENT, onAcknowledged);
    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      void nativeListener?.remove().catch(() => undefined);
      window.removeEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, onAcknowledged);
      window.removeEventListener(SMS_ALARM_ACKNOWLEDGED_EVENT, onAcknowledged);
      window.removeEventListener(ONE_LOCATION_GRANT_UNWATCHED_EVENT, onAcknowledged);
      window.removeEventListener("storage", onStorage);
      release();
      // A renderer reload is not acknowledgement. Native alarms outlive it;
      // only an explicit account withdrawal disposes the native owner here.
      if (isNativePlatform && getCurrentOwner() !== userId) void HushhNotifications.stopEmergencySmsCue({ userId }).catch(() => undefined);
      // Authentication teardown disposes runtime resources, never acknowledges
      // an alert the recipient has not opened or dismissed.
      for (const grantId of activeToasts) toast.dismiss(`one-location-share:${grantId}`);
      activeToasts.clear();
    };
  }, [activeToastsRef, getCurrentOwner, dismiss, isNativePlatform, userId]);
}

/** One authenticated provider owns foreground cue admission and disposal. */
export function useEmergencySmsAlarm(userId: string | undefined, isNativePlatform: boolean, nativeSessionRevision: string | null = null) {
  const activeToastsRef = useRef(new Set<string>());
  const currentOwnerRef = useRef(userId);
  useLayoutEffect(() => { currentOwnerRef.current = userId; }, [userId]);
  const getCurrentOwner = useCallback(() => currentOwnerRef.current, []);
  const stopEmergencySms = useCallback((grantId: string) => {
    stopOneLocationNotificationSound(grantId);
    if (isNativePlatform) void HushhNotifications.stopEmergencySmsCue({ userId, grantId }).catch(() => undefined);
    activeToastsRef.current.delete(grantId);
  }, [isNativePlatform, userId]);
  const dismissEmergencySms = useCallback((grantId: string) => {
    stopEmergencySms(grantId);
    toast.dismiss(`one-location-share:${grantId}`);
    if (userId && !isSmsAlarmAcknowledged(userId, grantId)) acknowledgeSmsAlarm(userId, grantId);
  }, [stopEmergencySms, userId]);

  useEmergencySmsAcknowledgements(userId, isNativePlatform, activeToastsRef, getCurrentOwner, dismissEmergencySms);

  const startEmergencySms = useCallback((grantId: string) => {
    if (!userId || isSmsAlarmAcknowledged(userId, grantId)) return false;
    rememberSmsAlarm(userId, grantId);
    activeToastsRef.current.add(grantId);
    // One renderer owns sound and vibration together on native platforms.
    if (!isNativePlatform) return playOneLocationNotificationSound("sos", grantId);
    // Keep the bridge start deadline separate from the share lifetime.
    void HushhNotifications.playEmergencySmsCue({
      userId,
      grantId,
      expiresAt: Date.now() + 2000,
    }).then((result) => {
      if (result.acknowledged) dismissEmergencySms(grantId);
    }).catch(() => undefined);
    return false;
  }, [dismissEmergencySms, isNativePlatform, userId]);

  useEffect(() => {
    if (!userId) return;
    const restore = (grantId: string, play = true) => {
      if (isSmsAlarmAcknowledged(userId, grantId) || isOneLocationGrantOpened(userId, grantId) || isOneLocationGrantUnwatched(userId, grantId)) {
        dismissEmergencySms(grantId);
        return;
      }
      const alreadyPresented = activeToastsRef.current.has(grantId);
      if (play) startEmergencySms(grantId);
      if (alreadyPresented) return;
      activeToastsRef.current.add(grantId);
      toast("Unacknowledged SMS alert", {
        id: `one-location-share:${grantId}`,
        description: "An SMS alert needs your attention. Dismiss the alarm to acknowledge it.",
        duration: Infinity,
        dismissible: false,
        action: { label: "Dismiss alarm", onClick: () => dismissEmergencySms(grantId) },
      });
    };
    for (const grantId of pendingSmsAlarms(userId)) restore(grantId, !isNativePlatform);
    let disposed = false;
    const restoreNative = () => {
      if (!isNativePlatform) return;
      const restoreLocal = () => { if (!disposed) for (const grantId of pendingSmsAlarms(userId)) restore(grantId); };
      if (typeof HushhNotifications.getPendingEmergencySmsAlarms !== "function") { restoreLocal(); return; }
      void HushhNotifications.getPendingEmergencySmsAlarms({ userId, grantIds: [...activeToastsRef.current] })
        .then((state) => {
          if (disposed) return;
          for (const grantId of state.acknowledgedGrantIds) dismissEmergencySms(grantId);
          for (const grantId of new Set([...pendingSmsAlarms(userId), ...state.grantIds])) {
            if (typeof grantId === "string" && grantId && !isSmsAlarmAcknowledged(userId, grantId)) restore(grantId);
          }
        }).catch(restoreLocal);
    };
    restoreNative();
    const releaseLifecycle = appInteractionCoordinator.subscribeLifecycle(() => {
      if (appInteractionCoordinator.getLifecycleSnapshot().state === "active") restoreNative();
    });
    return () => { disposed = true; releaseLifecycle(); };
    // Native auth/key custody admits playback. Network registration may fail
    // offline; its completion only gives us another chance to restore receipts
    // if the initial bridge call preceded native key preparation.
  }, [dismissEmergencySms, isNativePlatform, nativeSessionRevision, startEmergencySms, userId]);

  return { startEmergencySms, stopEmergencySms, dismissEmergencySms };
}
