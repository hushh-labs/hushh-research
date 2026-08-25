import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceWorkerMessageListener: null as ((event: MessageEvent) => void) | null,
  requestInternalAppNavigation: vi.fn(),
  dispatchFeedStateChanged: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
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

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

import { prepareFCMListeners } from "@/lib/notifications/fcm-service";

describe("web system-notification click bridge", () => {
  beforeEach(() => {
    mocks.requestInternalAppNavigation.mockClear();
    mocks.dispatchFeedStateChanged.mockClear();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn(
          (eventName: string, listener: (event: MessageEvent) => void) => {
            if (eventName === "message") {
              mocks.serviceWorkerMessageListener = listener;
            }
          },
        ),
      },
    });
  });

  it("accepts Feed navigation and acknowledges the matching click id", async () => {
    await prepareFCMListeners();
    const postMessage = vi.fn();
    mocks.serviceWorkerMessageListener?.({
      data: {
        type: "hushh:fcm_notification_clicked",
        click_id: "click-1",
        url: "/one/feed?notificationRequestId=request-1",
      },
      source: { postMessage },
    } as unknown as MessageEvent);

    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledWith("action");
    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/feed?notificationRequestId=request-1",
      scroll: false,
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "hushh:fcm_notification_click_ack",
      click_id: "click-1",
    });
  });

  it("rejects a non-Feed URL carried by a stale or malformed worker", async () => {
    await prepareFCMListeners();
    mocks.serviceWorkerMessageListener?.({
      data: {
        type: "hushh:fcm_notification_clicked",
        click_id: "click-2",
        url: "https://example.com/phishing",
      },
      source: { postMessage: vi.fn() },
    } as unknown as MessageEvent);

    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/feed",
      scroll: false,
    });
  });
});
