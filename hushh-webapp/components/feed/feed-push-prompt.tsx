"use client";

import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";

import { useConsentNotificationState } from "@/components/consent/notification-provider";
import { Button } from "@/lib/morphy-ux/button";

type BrowserPermission = NotificationPermission | "unsupported";

function browserPermission(): BrowserPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

/** Explicit permission action for browser and native notification registration. */
export function FeedPushPrompt() {
  const { deliveryMode, retryPushRegistration, isRetryingPushRegistration } =
    useConsentNotificationState();
  const [permission, setPermission] = useState<BrowserPermission>("unsupported");

  useEffect(() => {
    if (Capacitor.isNativePlatform()) setPermission(deliveryMode === "push_blocked" ? "denied" : "default");
    else setPermission(browserPermission());
  }, [deliveryMode]);

  if (deliveryMode === "push_active") {
    return null;
  }
  if (permission === "unsupported" || permission === "granted") return null;

  const enable = async () => {
    if (Capacitor.isNativePlatform()) {
      if (permission === "denied") {
        const { NotificationSettingsService } = await import("@/lib/services/notification-settings-service");
        await NotificationSettingsService.open();
        return;
      }
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

  return (
    <div
      role="status"
      data-testid="feed-push-prompt"
      className="mb-3 flex w-full items-center justify-between gap-3 rounded-[16px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3"
    >
      <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
        {permission === "denied"
          ? Capacitor.isNativePlatform() ? "Allow notifications in device settings to get message alerts." : "Notifications are blocked for One in this browser. Allow them in site settings to get alerts."
          : "Get notifications for direct messages, Circle chats, and requests."}
      </p>
      {permission === "default" || (permission === "denied" && Capacitor.isNativePlatform()) ? (
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="compact"
          disabled={isRetryingPushRegistration}
          onClick={() => void enable()}
        >
          {permission === "denied" ? "Open settings" : "Turn on"}
        </Button>
      ) : null}
    </div>
  );
}
