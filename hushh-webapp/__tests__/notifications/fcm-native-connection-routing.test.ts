import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  requestInternalAppNavigation: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
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

vi.mock("@/lib/utils/browser-navigation", () => ({
  assignWindowLocation: vi.fn(),
  requestInternalAppNavigation: mocks.requestInternalAppNavigation,
}));

import { prepareFCMListeners } from "@/lib/notifications/fcm-service";

describe("native connection notification actions", () => {
  beforeEach(() => {
    // Deliberately NOT clearing `listeners`: prepareFCMListeners guards on a
    // module-level `nativeListenersConfigured`, so it registers exactly once per
    // module instance. Clearing the map would leave every test after the first
    // with no listener to invoke, and they would pass vacuously via `onAction?.()`.
    mocks.requestInternalAppNavigation.mockClear();
  });

  it("opens the Connections consent view when a connection request is tapped", async () => {
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");
    expect(onAction).toBeTypeOf("function");

    onAction?.({
      actionId: "tap",
      notification: {
        data: {
          type: "connection_request",
          request_url: "/one/consent?tab=connections",
        },
      },
    });

    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/consent?tab=connections",
      scroll: false,
    });
  });

  it("opens the review sheet for the tapped request when the payload carries its id", async () => {
    // The Consent Center opens the incoming review sheet only from `?requestId`
    // (consent-center-page.tsx reads it into selectedId). Without the id a tap
    // could only ever land on the Connections list — issue #5422.
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");

    onAction?.({
      actionId: "tap",
      notification: {
        data: {
          type: "connection_request",
          request_id: "conn-req-1",
          request_url: "/one/consent?tab=pending&requestId=conn-req-1",
        },
      },
    });

    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledTimes(1);
    const href = String(
      mocks.requestInternalAppNavigation.mock.calls[0]?.[0]?.href || "",
    );
    expect(href).toContain("requestId=conn-req-1");
    expect(href).toContain("notificationAction=review");
  });

  it("re-applies the request id when an older backend sends the bare tab link", async () => {
    // Devices keep receiving whatever the deployed backend sends. A payload that
    // carries the id but the pre-fix deep link must still reach the sheet.
    await prepareFCMListeners();
    const onAction = mocks.listeners.get("notificationActionPerformed");

    onAction?.({
      actionId: "tap",
      notification: {
        data: {
          type: "connection_request",
          request_id: "conn-req-9",
          request_url: "/one/consent?tab=connections",
        },
      },
    });

    const href = String(
      mocks.requestInternalAppNavigation.mock.calls[0]?.[0]?.href || "",
    );
    expect(href).toContain("requestId=conn-req-9");
  });
});
