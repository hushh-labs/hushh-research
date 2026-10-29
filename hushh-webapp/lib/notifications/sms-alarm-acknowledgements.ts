import { Capacitor } from "@capacitor/core";
import { isOneLocationSmsEmergencyAlert, markOneLocationGrantOpened } from "@/lib/one-location/notifications";
import { acknowledgeSmsAlarm } from "@/lib/one-location/sms-alarm-state";

let pending: Array<Record<string, unknown>> = [];

export const smsAlarmAcknowledgements = {
  acknowledge(data: Record<string, unknown> | undefined, userId?: string | null) {
    if (data?.type !== "location_share_created" || !isOneLocationSmsEmergencyAlert({
      shareKind: typeof data.share_kind === "string" ? data.share_kind : undefined,
      notificationProfile: typeof data.notification_profile === "string" ? data.notification_profile : undefined,
    })) return;
    if (!userId) { pending = [...pending.slice(-15), data]; return; }
    if (data.user_id && data.user_id !== userId) return;
    const grantId = typeof data.grant_id === "string" ? data.grant_id.trim() : "";
    if (!grantId) return;
    acknowledgeSmsAlarm(userId, grantId);
    markOneLocationGrantOpened(userId, grantId);
    if (Capacitor.isNativePlatform()) {
      void import("@/lib/capacitor").then(({ HushhNotifications }) =>
        HushhNotifications.stopEmergencySmsCue({ userId, grantId })).catch(() => undefined);
    }
  },
  flush(userId?: string | null) {
    const queued = pending;
    pending = [];
    for (const data of queued) this.acknowledge(data, userId);
  },
  clear() { pending = []; },
};
