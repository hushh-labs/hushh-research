"use client";

import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";

import { useConsentNotificationState } from "@/components/consent/notification-provider";
import { Button } from "@/lib/morphy-ux/button";
import { NotificationSettingsService } from "@/lib/services/notification-settings-service";

type BrowserPermission = NotificationPermission | "unsupported";

function browserPermission(): BrowserPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

/**
 * The one place a web browser is asked for notification permission.
 *
 * Web push registers only after the browser grants permission, and the
 * provider deliberately never prompts on load. Nothing else asked, so a
 * browser that had not granted permission some other way never registered a
 * device: shares, Drive questions and answers reached nobody on the web
 * while the app was open. The request runs inside the tap, which browsers
 * require, and only then does the provider register this device.
 */
export function FeedPushPrompt() {
  const { deliveryMode, retryPushRegistration, isRetryingPushRegistration } =
    useConsentNotificationState();
  const [permission, setPermission] = useState<BrowserPermission>("unsupported");
  const awaitingSettings = useRef(false);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const native = Capacitor.isNativePlatform();

  useEffect(() => {
    if (!native) return;
    return NotificationSettingsService.onReturn(() => {
      if (!awaitingSettings.current) return;
      awaitingSettings.current = false;
      retryPushRegistration();
    });
  }, [native, retryPushRegistration]);

  useEffect(() => {
    setPermission(browserPermission());
  }, [deliveryMode]);

  if (deliveryMode === "push_active") {
    return null;
  }
  if (!native && (permission === "unsupported" || permission === "granted")) return null;

  const enable = async () => {
    if (native) {
      retryPushRegistration();
      return;
    }
    let result: BrowserPermission;
    try {
      result = await Notification.requestPermission();
    } catch {
      result = browserPermission();
    }
    setPermission(result);
    if (result === "granted") retryPushRegistration();
  };

  const openSettings = async () => {
    awaitingSettings.current = true;
    const opened = await NotificationSettingsService.open();
    if (!opened) awaitingSettings.current = false;
    setSettingsFailed(!opened);
  };

  return (
    <div
      role="status"
      data-testid="feed-push-prompt"
      className="mb-3 flex w-full items-center justify-between gap-3 rounded-[16px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3"
    >
      <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
        {native
          ? deliveryMode === "push_blocked"
            ? settingsFailed
              ? "Open your phone settings, choose One, and allow notifications."
              : "Allow notifications for One in your phone settings to get alerts when your answer is ready."
            : "Get an alert when your answer is ready, even when One is closed."
          : permission === "denied"
          ? "Notifications are blocked for One in this browser. Allow them in site settings to get alerts."
          : "Get an alert when someone shares with you or asks you something."}
      </p>
      {(native ? deliveryMode !== "push_blocked" : permission === "default") ? (
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="compact"
          disabled={isRetryingPushRegistration}
          onClick={() => void enable()}
        >
          Turn on
        </Button>
      ) : native ? (
        <Button type="button" variant="none" effect="fade" size="compact" onClick={() => void openSettings()}>
          Open settings
        </Button>
      ) : null}
    </div>
  );
}
