import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const androidPlugin = readFileSync(
  join(
    process.cwd(),
    "android/app/src/main/java/com/hussh/app/plugins/HushhNotifications/HushhNotificationsPlugin.kt",
  ),
  "utf8",
);
const iosAppDelegate = readFileSync(
  join(process.cwd(), "ios/App/App/AppDelegate.swift"),
  "utf8",
);
const capacitorConfig = readFileSync(
  join(process.cwd(), "capacitor.config.ts"),
  "utf8",
);
const sharedFcmService = readFileSync(
  join(process.cwd(), "lib/notifications/fcm-service.ts"),
  "utf8",
);

describe("One Location emergency SMS native notification contract", () => {
  it("keeps the Android alarm channel aligned with the backend payload", () => {
    expect(androidPlugin).toContain(
      'EMERGENCY_SMS_CHANNEL_ID = "one_location_sms_emergency_v1"',
    );
    expect(androidPlugin).toContain("NotificationManager.IMPORTANCE_HIGH");
    expect(androidPlugin).toContain("AudioAttributes.USAGE_ALARM");
    expect(androidPlugin).toContain("longArrayOf(0, 240, 120, 240, 120, 520)");
    expect(androidPlugin).toContain("setBypassDnd(false)");
  });

  it("keeps the iOS category and custom alarm sound aligned with APNs", () => {
    expect(iosAppDelegate).toContain(
      'emergencySmsNotificationCategory = "ONE_LOCATION_SMS_EMERGENCY"',
    );
    expect(iosAppDelegate).toContain(
      'emergencySmsProfile = "one_location_sms_emergency"',
    );
    expect(iosAppDelegate).toContain(
      'emergencySmsSound = "one_location_sms_alarm.wav"',
    );
    expect(iosAppDelegate).toContain("prepareEmergencySmsSound()");
    expect(iosAppDelegate).toContain("completionHandler([.badge])");
  });

  it("keeps routine iOS foreground delivery badge-only", () => {
    expect(iosAppDelegate).toContain("if appState != .active");
    expect(iosAppDelegate).toContain(
      "completionHandler([.banner, .list, .sound, .badge])",
    );
    expect(capacitorConfig).toContain('presentationOptions: ["badge"]');
    expect(iosAppDelegate.indexOf("if appState != .active")).toBeLessThan(
      iosAppDelegate.indexOf("if profile == Self.emergencySmsProfile"),
    );
  });

  it("keeps the explicit emergency action routed to live location", () => {
    expect(iosAppDelegate).toContain('emergencySmsOpenAction = "ONE_LOCATION_SMS_OPEN"');
    expect(sharedFcmService).toContain(
      'actionId === ONE_LOCATION_SMS_OPEN_ACTION',
    );
    expect(sharedFcmService).toContain("resolveOneLocationNotificationHref(data)");
  });
});
