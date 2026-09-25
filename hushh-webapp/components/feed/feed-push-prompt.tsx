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

  useEffect(() => {
    setPermission(browserPermission());
  }, [deliveryMode]);

  if (Capacitor.isNativePlatform() || deliveryMode === "push_active") {
    return null;
  }
  if (permission === "unsupported" || permission === "granted") return null;

  const enable = async () => {
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
          ? "Notifications are blocked for One in this browser. Allow them in site settings to get alerts."
          : "Get an alert when someone shares with you or asks you something."}
      </p>
      {permission === "default" ? (
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
      ) : null}
    </div>
  );
}
