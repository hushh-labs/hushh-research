import { registerPlugin } from "@capacitor/core";

/** Shared registration port implemented by web, Swift and Kotlin adapters. */
export interface HushhNotificationsPlugin {
  /** Register a device token through POST /api/notifications/register. */
  registerPushToken(options: {
    userId: string;
    token: string;
    platform: "web" | "ios" | "android";
    idToken: string;
    backendUrl?: string;
  }): Promise<{ success: boolean }>;

  /** Unregister device tokens through DELETE /api/notifications/unregister. */
  unregisterPushToken(options: {
    userId: string;
    idToken: string;
    platform?: "web" | "ios" | "android";
    token?: string;
    backendUrl?: string;
  }): Promise<{ success: boolean }>;
}

export const HushhNotifications = registerPlugin<HushhNotificationsPlugin>(
  "HushhNotifications",
  {
    web: () =>
      import("./plugins/notifications-web").then(
        (m) => new m.HushhNotificationsWeb(),
      ),
  },
);
