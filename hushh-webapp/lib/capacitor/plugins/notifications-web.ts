/**
 * HushhNotifications Web Fallback Implementation
 *
 * Web fallback for push token registration.
 * Uses Next.js API routes as the source of truth.
 */

import { WebPlugin } from "@capacitor/core";
import type { HushhNotificationsPlugin } from "../index";

export class HushhNotificationsWeb extends WebPlugin implements HushhNotificationsPlugin {
  async deletePushToken(): Promise<void> {
    throw this.unavailable("Native push token deletion is unavailable on web.");
  }
  async prepareNotificationKey(options: { userId: string; deviceId: string }) {
    const { prepareNotificationDevice } = await import("@/lib/notifications/preview-keys");
    return prepareNotificationDevice(options.userId);
  }
  async clearNotificationKey(options: { userId: string }): Promise<void> {
    const { clearNotificationDevice } = await import("@/lib/notifications/preview-keys");
    await clearNotificationDevice(options.userId);
  }
  async clearChatNotifications(options: { threadId: string; keyId: string; sequence?: number; before?: number; messageId?: string }): Promise<void> {
    const { ChatSystemNotifications } = await import("@/lib/notifications/chat-system-notifications");
    await ChatSystemNotifications.clearRead(options);
  }
  async registerPushToken(options: {
    userId: string;
    token: string;
    deviceId?: string;
    previewKeyId?: string;
    previewPublicKey?: string;
    platform: "web" | "ios" | "android";
    idToken: string;
  }): Promise<{ success: boolean }> {
    const response = await fetch("/api/notifications/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.idToken}`,
      },
      body: JSON.stringify({
        user_id: options.userId,
        token: options.token,
        device_id: options.deviceId,
        preview_key_id: options.previewKeyId,
        preview_public_key: options.previewPublicKey,
        platform: options.platform,
      }),
    });

    return { success: response.ok };
  }

  async unregisterPushToken(options: {
    userId: string;
    idToken: string;
    platform?: "web" | "ios" | "android";
    deviceId?: string;
  }): Promise<{ success: boolean }> {
    const response = await fetch("/api/notifications/unregister", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.idToken}`,
      },
      body: JSON.stringify({
        user_id: options.userId,
        device_id: options.deviceId,
        ...(options.platform ? { platform: options.platform } : {}),
      }),
    });

    return { success: response.ok };
  }
}
