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
export function FeedPushPrompt({ context = "feed" }: { context?: "feed" | "chat" | "location" } = {}) {
  const { deliveryMode, deliveryDetail, retryPushRegistration, isRetryingPushRegistration } =
    useConsentNotificationState();
  const [permission, setPermission] = useState<BrowserPermission>("unsupported");
  const quietNative = Capacitor.isNativePlatform() && (
    ["native_alerts_disabled", "native_sound_disabled", "native_emergency_sound_disabled"].includes(deliveryDetail ?? "")
    || (context === "chat" && ["native_chat_alerts_disabled", "native_chat_sound_disabled"].includes(deliveryDetail ?? ""))
  );

  useEffect(() => {
    if (Capacitor.isNativePlatform()) setPermission(deliveryMode === "push_blocked" || quietNative ? "denied" : "default");
    else setPermission(browserPermission());
  }, [deliveryMode, quietNative]);

  if (deliveryMode === "push_active" && !quietNative) {
    return null;
  }
  if (permission === "unsupported") return null;

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
    if (permission === "granted") { retryPushRegistration(); return; }
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
      <p data-profile-role="description" className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
        {quietNative ? "Device alerts or sounds are off. Enable them in notification settings to hear alerts."
          : permission === "denied"
          ? Capacitor.isNativePlatform() ? "Allow notifications in device settings to get message alerts." : "Notifications are blocked for One in this browser. Allow them in site settings to get alerts."
          : permission === "granted" ? "Reconnect notifications to receive message alerts."
          : context === "location" ? "Turn on device notifications for Save My Soul alerts, location shares, and requests when One is closed."
          : context === "chat" ? "Allow device notifications to hear new messages when you leave this chat."
          : "Get notifications for direct messages, Circle chats, and requests."}
      </p>
      {permission === "default" || permission === "granted" || (permission === "denied" && Capacitor.isNativePlatform()) ? (
        <Button
          data-profile-role="action"
          type="button"
          data-voice-control-id={context === "location" ? "one-location-notification-recovery" : undefined}
          variant="none"
          effect="fade"
          size="compact"
          className="min-h-11 shrink-0"
          disabled={isRetryingPushRegistration}
          onClick={() => void enable()}
        >
          {permission === "denied" ? "Open settings" : permission === "granted" ? "Retry" : "Turn on"}
        </Button>
      ) : null}
    </div>
  );
}
