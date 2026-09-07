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

import {
  FCM_MESSAGE_EVENT,
  prepareFCMListeners,
} from "@/lib/notifications/fcm-service";

describe("web system-notification click bridge", () => {
  beforeEach(() => {
    mocks.requestInternalAppNavigation.mockClear();
    mocks.dispatchFeedStateChanged.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
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

  it.each([
    ["location_share_created", "/one/feed"],
    ["location_access_approved", "/one/feed"],
    ["location_share_created", "/one/location?section=shared"],
    [
      "location_access_approved",
      "/one/location?grantId=old&requestId=old&section=people",
    ],
  ])(
    "routes %s from worker URL %s to Shared with me and acknowledges the tap",
    async (type, url) => {
      await prepareFCMListeners();
      const postMessage = vi.fn();
      mocks.serviceWorkerMessageListener?.({
        data: {
          type: "hushh:fcm_notification_clicked",
          click_id: "location-click",
          url,
          data: { type, request_id: "request-1", grant_id: "grant-1" },
        },
        source: { postMessage },
      } as unknown as MessageEvent);
      expect(
        mocks.requestInternalAppNavigation,
      ).toHaveBeenCalledExactlyOnceWith({
        href: "/one/location?section=shared",
        scroll: false,
      });
      expect(postMessage).toHaveBeenCalledWith({
        type: "hushh:fcm_notification_click_ack",
        click_id: "location-click",
      });
    },
  );

  it("does not accept an arbitrary Location URL without an incoming-share event", async () => {
    await prepareFCMListeners();
    mocks.serviceWorkerMessageListener?.({
      data: {
        type: "hushh:fcm_notification_clicked",
        url: "/one/location?section=shared",
        data: { type: "location_access_request" },
      },
      source: { postMessage: vi.fn() },
    } as unknown as MessageEvent);
    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/feed",
      scroll: false,
    });
  });

  it("does not ACK a visible-tab push until an authenticated consumer accepts it", async () => {
    await prepareFCMListeners();
    const postMessage = vi.fn();

    mocks.serviceWorkerMessageListener?.({
      data: {
        type: "hushh:fcm_push_received",
        delivery_id: "delivery-unaccepted",
        data: { type: "connection_request" },
      },
      source: { postMessage },
    } as unknown as MessageEvent);

    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "hushh:fcm_push_ack" }),
    );
  });

  it("does not refresh a hidden peer tab until its visibility hook catches up", async () => {
    await prepareFCMListeners();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    mocks.serviceWorkerMessageListener?.({
      data: { type: "hushh:fcm_feed_changed" },
    } as MessageEvent);

    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
  });

  it("ACKs only after the active notification consumer marks the payload accepted", async () => {
    await prepareFCMListeners();
    const postMessage = vi.fn();
    const accept = (event: Event) => {
      (event as CustomEvent<{ accepted: boolean }>).detail.accepted = true;
    };
    window.addEventListener(FCM_MESSAGE_EVENT, accept);

    try {
      mocks.serviceWorkerMessageListener?.({
        data: {
          type: "hushh:fcm_push_received",
          delivery_id: "delivery-accepted",
          data: { type: "connection_request", user_id: "active-user" },
        },
        source: { postMessage },
      } as unknown as MessageEvent);
    } finally {
      window.removeEventListener(FCM_MESSAGE_EVENT, accept);
    }

    expect(postMessage).toHaveBeenCalledWith({
      type: "hushh:fcm_push_ack",
      delivery_id: "delivery-accepted",
    });
  });
});
