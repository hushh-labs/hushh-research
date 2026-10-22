import { Capacitor } from "@capacitor/core";
import { activeNotificationKeyId } from "./preview-keys";

type ReadBoundary = { threadId: string; keyId: string; sequence?: number; before?: number; messageId?: string; badgeCount?: number; badgeVersion?: number };
export const ChatSystemNotifications = {
  async clearRead(boundary: ReadBoundary): Promise<void> {
    if (boundary.keyId !== activeNotificationKeyId()) return;
    try {
      if (Capacitor.isNativePlatform()) {
        const { HushhNotifications } = await import("@/lib/capacitor");
        if (boundary.keyId !== activeNotificationKeyId()) return;
        await HushhNotifications.clearChatNotifications(boundary);
        return;
      }
      const registration = await navigator.serviceWorker?.getRegistration("/firebase-messaging-sw.js");
      if (boundary.keyId !== activeNotificationKeyId()) return;
      registration?.active?.postMessage({ type: "hushh:chat_read", ...boundary });
      for (const notification of await registration?.getNotifications() ?? []) {
        const data = notification.data as Record<string, unknown> | undefined;
        if (boundary.keyId !== activeNotificationKeyId() || data?.recipient_key_id !== boundary.keyId || (data.conversation_id || data.circle_id) !== boundary.threadId) continue;
        const value = Number(boundary.sequence === undefined ? data.chat_sent_at : data.chat_sequence);
        const limit = boundary.sequence ?? boundary.before;
        if (boundary.messageId && data.message_id === boundary.messageId || Number.isFinite(value) && value > 0 && limit !== undefined && value <= limit) notification.close();
      }
    } catch { /* Read receipts remain committed if OS cleanup is unavailable. */ }
  },
};
