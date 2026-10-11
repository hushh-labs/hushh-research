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

import { documentRequestSetupHref } from "@/lib/consent/document-request-setup";
import {
  buildNotificationTapTarget,
  FCM_MESSAGE_EVENT,
  prepareFCMListeners,
} from "@/lib/notifications/fcm-service";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_ROUTE =
  "/one/consent?tab=pending&requestId=document_share_request%3A11111111-1111-4111-8111-111111111111";

/** The payload a consumer receives after the transport boundary reduced it. */
async function bridgedPushData(data: Record<string, unknown>) {
  await prepareFCMListeners();
  let received: Record<string, unknown> | undefined;
  const capture = (event: Event) => {
    received = (event as CustomEvent<{ data: Record<string, unknown> }>).detail.data;
  };
  window.addEventListener(FCM_MESSAGE_EVENT, capture);
  try {
    mocks.serviceWorkerMessageListener?.({
      data: { type: "hushh:fcm_push_received", data },
      source: { postMessage: vi.fn() },
    } as unknown as MessageEvent);
  } finally {
    window.removeEventListener(FCM_MESSAGE_EVENT, capture);
  }
  return received;
}

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

  it("builds a document-review route from only an allowlisted type and UUID", () => {
    const requestId = "11111111-1111-4111-8111-111111111111";

    expect(
      buildNotificationTapTarget({
        type: "document_share_review_ready",
        request_id: requestId,
        request_url: "https://example.com/ignored",
        deep_link: "/one/profile?ignored=true",
        file_name: "bank-statement.pdf",
      }),
    ).toBe(
      "/one/consent?tab=pending&requestId=document_share_request%3A11111111-1111-4111-8111-111111111111",
    );
  });

  it.each(["drive", "payouts", "price"] as const)(
    "keeps a %s setup step through the transport boundary and opens its screen",
    async (setup) => {
      const data = await bridgedPushData({
        type: "document_share_request",
        request_id: REQUEST_ID,
        setup,
        file_name: "bank-statement.pdf",
      });
      expect(data).toEqual({ type: "document_share_request", request_id: REQUEST_ID, setup });
      // Native taps route the reduced payload through this same builder.
      expect(buildNotificationTapTarget(data)).toBe(documentRequestSetupHref(setup));
    },
  );

  it.each([
    { type: "document_share_request", setup: "https://evil.example" },
    { type: "document_share_request", setup: "drive?x=1" },
    { type: "document_share_review_ready", setup: "drive" },
  ])("drops setup $setup on $type and keeps the review route", async (fields) => {
    const raw = { ...fields, request_id: REQUEST_ID };
    expect(await bridgedPushData(raw)).toEqual({ type: fields.type, request_id: REQUEST_ID });
    expect(buildNotificationTapTarget(raw)).toBe(REVIEW_ROUTE);
  });

  it("opens a Drive question's card for a question push", () => {
    expect(
      buildNotificationTapTarget({
        type: "document_share_answered",
        request_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(
      "/one/consent?tab=pending&requestId=drive_query_request%3A22222222-2222-4222-8222-222222222222",
    );
  });

  it("opens the live payment action for a requester payment push", () => {
    expect(buildNotificationTapTarget({
      type: "document_share_payment_ready",
      request_id: "11111111-1111-4111-8111-111111111111",
      deep_link: "/one/profile?ignored=true",
    })).toBe("/one/feed");
    expect(buildNotificationTapTarget({
      type: "document_share_payment_refunded",
      request_id: "11111111-1111-4111-8111-111111111111",
    })).toBe("/one/feed");
  });

  it.each([
    {
      type: "document_share_review_ready",
      request_id: "not-a-uuid",
    },
    {
      type: "document_share_unreviewed_future_event",
      request_id: "11111111-1111-4111-8111-111111111111",
    },
  ])("fails closed to Feed for an invalid document-share payload", (data) => {
    expect(buildNotificationTapTarget(data)).toBe("/one/feed");
  });

  it("opens the named conversation for a One replied push, never its deep_link", () => {
    const conversationId = "0b1f6c1e-3d4a-4c8b-9a51-6f2e7d8c9b0a";
    expect(
      buildNotificationTapTarget({
        type: "one_reply",
        conversation_id: conversationId,
        deep_link: "/one/profile?ignored=true",
        request_url: "https://example.com/ignored",
      }),
    ).toBe(`/?conversation=${conversationId}`);
    // A malformed id opens chat without selecting anything rather than Feed or a forged route.
    expect(
      buildNotificationTapTarget({ type: "one_reply", conversation_id: "../one/profile?x=1" }),
    ).toBe("/");
  });

  it("opens the asking chat for an answered information request, never its deep_link", () => {
    const bundle = "0f0e0d0c-0b0a-4908-8706-050403020100";
    expect(
      buildNotificationTapTarget({
        type: "information_request_updated",
        bundle_id: bundle,
        deep_link: "https://evil.example/phish",
      }),
    ).toBe(`/?informationRequest=${bundle}`);
    expect(
      buildNotificationTapTarget({ type: "information_request_updated", bundle_id: "../one/profile" }),
    ).toBe("/");
  });

  it("opens a fresh chat for a One-has-something push, never its deep_link", () => {
    expect(
      buildNotificationTapTarget({
        type: "one_feed_attention",
        feed_item_id: "4812",
        deep_link: "https://evil.example/phish",
      }),
    ).toBe("/?feedAttention=4812");
    // A malformed id lands on the durable Feed row, never a forged route.
    expect(
      buildNotificationTapTarget({ type: "one_feed_attention", feed_item_id: "../one/profile" }),
    ).toBe("/one/feed");
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

  it("ignores a worker URL for a document-review tap", async () => {
    await prepareFCMListeners();
    const requestId = "11111111-1111-4111-8111-111111111111";
    mocks.serviceWorkerMessageListener?.({
      data: {
        type: "hushh:fcm_notification_clicked",
        click_id: "document-click",
        url: "https://example.com/ignored",
        data: {
          type: "document_share_request",
          request_id: requestId,
          request_url: "https://example.com/ignored",
        },
      },
      source: { postMessage: vi.fn() },
    } as unknown as MessageEvent);

    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/consent?tab=pending&requestId=document_share_request%3A11111111-1111-4111-8111-111111111111",
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
