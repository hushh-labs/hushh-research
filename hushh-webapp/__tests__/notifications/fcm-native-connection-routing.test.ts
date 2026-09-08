import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  requestInternalAppNavigation: vi.fn(),
  dispatchFeedStateChanged: vi.fn(),
  platform: "ios",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => mocks.platform,
  },
}));

vi.mock("@capacitor-firebase/messaging", () => ({
  FirebaseMessaging: {
    addListener: vi.fn(
      async (eventName: string, listener: (payload: unknown) => void) => {
        mocks.listeners.set(eventName, listener);
        return { remove: vi.fn() };
      },
    ),
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    registerPushToken: vi.fn(),
  },
}));

vi.mock("@/lib/utils/browser-navigation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/utils/browser-navigation")>();
  mocks.requestInternalAppNavigation.mockImplementation(
    actual.requestInternalAppNavigation,
  );
  return {
    ...actual,
    assignWindowLocation: vi.fn(),
    requestInternalAppNavigation: mocks.requestInternalAppNavigation,
  };
});

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

import { prepareFCMListeners } from "@/lib/notifications/fcm-service";
import {
  acknowledgeInternalAppNavigation,
  consumePendingInternalAppNavigation,
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";

describe("native system-notification routing", () => {
  beforeEach(() => {
    // prepareFCMListeners registers once per module instance, so retain the
    // listener map and clear only assertions between cases.
    mocks.requestInternalAppNavigation.mockClear();
    mocks.dispatchFeedStateChanged.mockClear();
    mocks.platform = "ios";
    consumePendingInternalAppNavigation();
  });

  it.each([
    "connection_request",
    "consent_request",
    "location_share_expired",
    "kai_analysis_complete",
    "future_notification_type",
  ])("opens Feed when a %s notification body is tapped", async (type) => {
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");
    expect(onAction).toBeTypeOf("function");

    onAction?.({
      actionId: "tap",
      notification: {
        data: {
          type,
          request_id: "request-1",
          request_url: "/one/location?grantId=legacy-target",
        },
      },
    });

    const href = String(
      mocks.requestInternalAppNavigation.mock.calls[0]?.[0]?.href || "",
    );
    expect(href).toMatch(/^\/one\/feed(?:\?|$)/);
    if (type === "consent_request") {
      expect(href).toContain("notificationRequestId=request-1");
    }
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("action");
  });

  describe.each(["ios", "android"])(
    "%s incoming Location system taps",
    (platform) => {
      it.each([
        ["location_share_created", "tap"],
        ["location_access_approved", "tap"],
        [
          "location_share_created",
          "com.apple.UNNotificationDefaultActionIdentifier",
        ],
        [
          "location_access_approved",
          "com.apple.UNNotificationDefaultActionIdentifier",
        ],
      ])(
        "retains %s (%s) until the router mounts, without stale detail intent",
        async (type, actionId) => {
          mocks.platform = platform;
          await prepareFCMListeners();
          mocks.listeners.get("notificationActionPerformed")?.({
            actionId,
            notification: {
              data: {
                type,
                grant_id: "grant-1",
                request_id: "request-1",
                request_url:
                  "/one/location?grantId=grant-1&requestId=request-1&section=people",
                deep_link: "/one/location",
              },
            },
          });

          expect(
            mocks.requestInternalAppNavigation,
          ).toHaveBeenCalledExactlyOnceWith({
            href: "/one/location?section=shared",
            scroll: false,
          });
          expect(consumePendingInternalAppNavigation()).toEqual({
            href: "/one/location?section=shared",
            scroll: false,
          });
          expect(consumePendingInternalAppNavigation()).toBeNull();
        },
      );

      it("delivers a warm tap once and does not replay it after router acknowledgement", async () => {
        mocks.platform = platform;
        await prepareFCMListeners();
        const listener = vi.fn((event: Event) => {
          const request = (event as CustomEvent<InternalAppNavigationRequest>)
            .detail;
          acknowledgeInternalAppNavigation(request);
        });
        window.addEventListener(
          INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
          listener,
        );
        try {
          mocks.listeners.get("notificationActionPerformed")?.({
            actionId: "tap",
            notification: { data: { type: "location_share_created" } },
          });
        } finally {
          window.removeEventListener(
            INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
            listener,
          );
        }
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0][0] as CustomEvent).detail.href).toBe(
          "/one/location?section=shared",
        );
        expect(consumePendingInternalAppNavigation()).toBeNull();
      });

      it("refreshes foreground receipt without navigating away", async () => {
        mocks.platform = platform;
        await prepareFCMListeners();
        mocks.listeners.get("notificationReceived")?.({
          data: { type: "location_share_created" },
        });
        expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("arrived");
        expect(mocks.requestInternalAppNavigation).not.toHaveBeenCalled();
        expect(consumePendingInternalAppNavigation()).toBeNull();
      });
    },
  );

  it("keeps an explicit consent Review action on its confirmation route", async () => {
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");

    onAction?.({
      actionId: "CONSENT_REVIEW",
      notification: {
        data: {
          type: "consent_request",
          request_id: "consent-1",
          request_url: "/one/consent?tab=pending",
        },
      },
    });

    const href = String(
      mocks.requestInternalAppNavigation.mock.calls[0]?.[0]?.href || "",
    );
    expect(href).toContain("/one/consent");
    expect(href).toContain("requestId=consent-1");
    expect(href).toContain("notificationAction=review");
  });

  it("ignores dismiss actions", async () => {
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");
    onAction?.({
      actionId: "dismiss",
      notification: { data: { type: "connection_request" } },
    });
    expect(mocks.requestInternalAppNavigation).not.toHaveBeenCalled();
  });

  it("keeps the explicit emergency action on the validated live-location route", async () => {
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");
    onAction?.({
      actionId: "ONE_LOCATION_SMS_OPEN",
      notification: {
        data: {
          type: "location_share_created",
          notification_profile: "one_location_sms_emergency",
          request_url: "/one/location?grantId=emergency-1&section=shared",
        },
      },
    });

    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/location?grantId=emergency-1&section=shared",
      scroll: false,
    });
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("action");
  });
});
