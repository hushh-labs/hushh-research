/**
 * HushhNotifications Web Fallback Implementation
 *
 * Web fallback for push token registration.
 * Uses Next.js API routes as the source of truth.
 */

import { WebPlugin } from "@capacitor/core";
import type { HushhNotificationsPlugin } from "../index";

export class HushhNotificationsWeb extends WebPlugin implements HushhNotificationsPlugin {
  async registerPushToken(options: {
    userId: string;
    token: string;
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
        platform: options.platform,
      }),
    });

    return { success: response.ok };
  }

  async unregisterPushToken(options: {
    userId: string;
    idToken: string;
    platform?: "web" | "ios" | "android";
  }): Promise<{ success: boolean }> {
    const response = await fetch("/api/notifications/unregister", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.idToken}`,
      },
      body: JSON.stringify({
        user_id: options.userId,
        ...(options.platform ? { platform: options.platform } : {}),
      }),
    });

    return { success: response.ok };
  }
}
