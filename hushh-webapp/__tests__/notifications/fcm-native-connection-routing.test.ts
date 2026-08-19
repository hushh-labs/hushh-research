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
    mocks.listeners.clear();
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
});
