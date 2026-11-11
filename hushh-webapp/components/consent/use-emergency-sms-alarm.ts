"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { nativeFeedbackToast as toast } from "@/lib/capacitor/native-feedback";

import { HushhNotifications } from "@/lib/capacitor";
import { OneLocationService } from "@/lib/one-location/service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import {
  acknowledgeSmsAlarm,
  isSmsAlarmAcknowledged,
  pendingSmsAlarms,
  rememberSmsAlarm,
  SMS_ALARM_ACKNOWLEDGED_EVENT,
  SMS_ALERTS_CHANGED_EVENT,
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

/** Recover recent incoming alarms from authenticated state when push is unavailable. */
export function useEmergencySmsDeliveryRecovery({
  userId,
  isNativePlatform,
  getVaultOwnerToken,
  present,
}: {
  userId: string | undefined;
  isNativePlatform: boolean;
  getVaultOwnerToken: () => string | null;
  present: (alert: Record<string, string>) => void;
}): void {
  const readToken = useEffectEvent(getVaultOwnerToken);
  const presentAlert = useEffectEvent(present);

  useEffect(() => {
    if (!userId) return;
    const abort = new AbortController();
    let reading = false;
    let requested = false;
    const isForeground = () =>
      !abort.signal.aborted &&
      document.visibilityState === "visible" &&
      appInteractionCoordinator.getLifecycleSnapshot().state === "active" &&
      (isNativePlatform || document.hasFocus());

    const refresh = async () => {
      if (!isForeground()) return;
      requested = true;
      if (reading) return;
      reading = true;
      try {
        while (requested && isForeground()) {
          requested = false;
          const token = readToken();
          if (!token) return;
          const epoch = snapshotVaultSessionEpoch();
          try {
            const alerts = await OneLocationService.getRecentSmsAlerts(token, abort.signal);
            if (!isForeground() || !isVaultSessionEpochCurrent(epoch)) continue;
            for (const alert of alerts) {
              if (alert.user_id === userId && alert.type === "location_share_created" && alert.share_kind === "sos") {
                presentAlert(alert);
              }
            }
          } catch {
            // The shared Feed stream retries on reconnect or focus.
          }
        }
      } finally {
        reading = false;
      }
    };
    const onAlertsChanged = (event: Event) => {
      if ((event as CustomEvent<{ userId: string }>).detail?.userId === userId) void refresh();
    };
    const releaseVaultListener = subscribeVaultSessionEpoch(refresh);
    const releaseLifecycle = appInteractionCoordinator.subscribeLifecycle(refresh);
    window.addEventListener(SMS_ALERTS_CHANGED_EVENT, onAlertsChanged);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    void refresh();
    return () => {
      abort.abort();
      releaseVaultListener();
      releaseLifecycle();
      window.removeEventListener(SMS_ALERTS_CHANGED_EVENT, onAlertsChanged);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isNativePlatform, userId]);
}

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
export function useEmergencySmsAlarm(
  userId: string | undefined,
  isNativePlatform: boolean,
  nativeSessionRevision: string | null = null,
  nativeDeliveryDetail: string | null = null,
) {
  const useAppAudio = !isNativePlatform ||
    nativeSessionRevision === "push_not_requested" ||
    nativeSessionRevision === "push_blocked" ||
    nativeDeliveryDetail === "native_chat_key_unavailable";
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
    // App audio covers an active session even when device notifications are off.
    if (useAppAudio) {
      return appInteractionCoordinator.getLifecycleSnapshot().state === "active" &&
        playOneLocationNotificationSound("sos", grantId);
    }
    // Give custody to the native renderer if device notification access returns.
    stopOneLocationNotificationSound(grantId);
    // Keep the bridge start deadline separate from the share lifetime.
    void HushhNotifications.playEmergencySmsCue({
      userId,
      grantId,
      expiresAt: Date.now() + 2000,
    }).then((result) => {
      if (result.acknowledged) dismissEmergencySms(grantId);
    }).catch(() => undefined);
    return false;
  }, [dismissEmergencySms, useAppAudio, userId]);

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
      else if (isNativePlatform && useAppAudio) {
        for (const grantId of activeToastsRef.current) stopOneLocationNotificationSound(grantId);
      }
    });
    return () => { disposed = true; releaseLifecycle(); };
    // Native auth/key custody admits playback. Network registration may fail
    // offline; its completion only gives us another chance to restore receipts
    // if the initial bridge call preceded native key preparation.
  }, [dismissEmergencySms, isNativePlatform, nativeSessionRevision, startEmergencySms, useAppAudio, userId]);

  return { startEmergencySms, stopEmergencySms, dismissEmergencySms };
}
