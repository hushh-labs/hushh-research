import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

type ServiceWorkerEvent = {
  data?: { json: () => unknown } | Record<string, unknown>;
  notification?: {
    close: () => void;
    data?: Record<string, unknown>;
  };
  waitUntil?: (promise: Promise<unknown>) => void;
};
type ServiceWorkerHandler = (event: ServiceWorkerEvent) => void;

function createHarness(options: {
  acknowledgeVisibleDelivery?: boolean;
  acknowledgeNotificationClick?: boolean;
  clientState?: "visible" | "hidden" | "none";
  clients?: Array<{
    visibilityState: "visible" | "hidden";
    focused?: boolean;
    acknowledgeDelivery?: boolean;
    acknowledgeClick?: boolean;
    hideBeforeDeliveryAck?: boolean;
    postMessageThrows?: boolean;
    navigate?: "success" | "failure" | "unavailable";
  }>;
  deliveredTags?: string[];
}) {
  const handlers = new Map<string, ServiceWorkerHandler>();
  const shown: Array<{ title: string; options?: Record<string, unknown> }> = [];
  const clientMessages: Array<Record<string, unknown>> = [];
  const clientMessagesByIndex: Array<
    Array<Record<string, unknown>>
  > = [];
  const openedUrls: string[] = [];
  const navigatedUrls: string[] = [];
  const closedTags: string[] = [];
  let focusCount = 0;
  const clientState = options.clientState ?? "visible";
  const definitions =
    options.clients ??
    (clientState === "none"
      ? []
      : [
          {
            visibilityState: clientState,
            focused: clientState === "visible",
            acknowledgeDelivery: options.acknowledgeVisibleDelivery,
            acknowledgeClick: options.acknowledgeNotificationClick,
            navigate: "success" as const,
          },
        ]);
  const clients = definitions.map((definition, clientIndex) => {
    clientMessagesByIndex[clientIndex] = [];
    const client: {
      visibilityState: "visible" | "hidden";
      focused: boolean;
      focus: () => Promise<undefined>;
      postMessage: (payload: Record<string, unknown>) => void;
      navigate?: (url: string) => Promise<unknown>;
    } = {
      visibilityState: definition.visibilityState,
      focused: definition.focused === true,
      focus: async () => {
        focusCount += 1;
        return undefined;
      },
      postMessage: (payload: Record<string, unknown>) => {
        if (definition.postMessageThrows) throw new Error("stale client");
        clientMessages.push(payload);
        clientMessagesByIndex[clientIndex]?.push(payload);
        if (definition.hideBeforeDeliveryAck) {
          client.visibilityState = "hidden";
        }
        if (
          definition.acknowledgeDelivery &&
          !definition.hideBeforeDeliveryAck &&
          typeof payload.delivery_id === "string" &&
          payload.delivery_id
        ) {
          queueMicrotask(() => {
            handlers.get("message")?.({
              data: {
                type: "hushh:fcm_push_ack",
                delivery_id: payload.delivery_id,
              },
            });
          });
        }
        if (
          definition.acknowledgeClick &&
          typeof payload.click_id === "string" &&
          payload.click_id
        ) {
          queueMicrotask(() => {
            handlers.get("message")?.({
              data: {
                type: "hushh:fcm_notification_click_ack",
                click_id: payload.click_id,
              },
            });
          });
        }
      },
    };
    if (definition.navigate !== "unavailable") {
      client.navigate = async (url: string) => {
        navigatedUrls.push(url);
        if (definition.navigate === "failure") {
          throw new Error("navigation failed");
        }
        return client;
      };
    }
    return client;
  });
  const serviceWorker = {
    __HUSHH_FCM_ACK_TIMEOUT_MS__: 5,
    clients: {
      matchAll: async () => clients,
      openWindow: async (url: string) => {
        openedUrls.push(url);
        return undefined;
      },
    },
    registration: {
      showNotification: async (
        title: string,
        notificationOptions?: Record<string, unknown>,
      ) => {
        shown.push({ title, options: notificationOptions });
      },
      getNotifications: async ({ tag }: { tag: string }) =>
        (options.deliveredTags || [])
          .filter((candidate) => candidate === tag)
          .map((candidate) => ({
            close: () => closedTags.push(candidate),
          })),
    },
    addEventListener: (type: string, handler: ServiceWorkerHandler) => {
      handlers.set(type, handler);
    },
  };
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "firebase-messaging-sw.js"),
    "utf8",
  );
  vm.runInNewContext(source, {
    self: serviceWorker,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Date,
    Math,
    Promise,
    encodeURIComponent,
  });

  return {
    shown,
    clientMessages,
    clientMessagesByIndex,
    openedUrls,
    navigatedUrls,
    closedTags,
    get focusCount() {
      return focusCount;
    },
    async push(type: string, data: Record<string, string> = { type }) {
      let pending = Promise.resolve<unknown>(undefined);
      handlers.get("push")?.({
        data: {
          json: () => ({
            notification: { title: type, body: "body" },
            data,
          }),
        },
        waitUntil: (promise) => {
          pending = promise;
        },
      });
      await pending;
    },
    async malformedPush() {
      let pending = Promise.resolve<unknown>(undefined);
      handlers.get("push")?.({
        data: {
          json: () => {
            throw new Error("malformed");
          },
        },
        waitUntil: (promise) => {
          pending = promise;
        },
      });
      await pending;
    },
    async click(data: Record<string, unknown> = {}) {
      let pending = Promise.resolve<unknown>(undefined);
      handlers.get("notificationclick")?.({
        notification: {
          close: () => undefined,
          data,
        },
        waitUntil: (promise) => {
          pending = promise;
        },
      });
      await pending;
    },
  };
}

describe("Firebase messaging service-worker lifecycle ownership", () => {
  it.each([
    "location_share_created",
    "connection_request",
    "consent_request",
    "kai_analysis_complete",
    "future_notification_type",
  ])(
    "suppresses %s system UI after the visible app acknowledges",
    async (type) => {
      const harness = createHarness({ acknowledgeVisibleDelivery: true });
      await harness.push(type);
      expect(harness.shown).toEqual([]);
    },
  );

  it("uses the system notification when the selected visible app cannot acknowledge", async () => {
    const harness = createHarness({ acknowledgeVisibleDelivery: false });
    await harness.push("connection_request");
    expect(harness.shown.map((item) => item.title)).toEqual([
      "connection_request",
    ]);
  });

  it("does not let a hidden tab suppress system presentation", async () => {
    const harness = createHarness({
      acknowledgeVisibleDelivery: true,
      clientState: "hidden",
    });
    await harness.push("consent_request");

    expect(harness.shown.map((item) => item.title)).toEqual([
      "consent_request",
    ]);
    expect(harness.clientMessages).toContainEqual({
      type: "hushh:fcm_feed_changed",
      reason: "push_received",
    });
  });

  it("elects one focused visible owner and sends refresh-only messages to peers", async () => {
    const harness = createHarness({
      clients: [
        { visibilityState: "visible", focused: false },
        {
          visibilityState: "visible",
          focused: true,
          acknowledgeDelivery: true,
        },
        { visibilityState: "hidden", focused: false },
      ],
    });
    await harness.push("connection_request");

    expect(harness.shown).toEqual([]);
    expect(harness.clientMessagesByIndex[0]).toEqual([
      { type: "hushh:fcm_feed_changed", reason: "push_received" },
    ]);
    expect(harness.clientMessagesByIndex[1]?.[0]).toEqual(
      expect.objectContaining({ type: "hushh:fcm_push_received" }),
    );
    expect(harness.clientMessagesByIndex[2]).toEqual([
      { type: "hushh:fcm_feed_changed", reason: "push_received" },
    ]);
  });

  it("falls back to system UI when the selected owner becomes hidden before ACK", async () => {
    const harness = createHarness({
      clients: [
        {
          visibilityState: "visible",
          focused: true,
          acknowledgeDelivery: true,
          hideBeforeDeliveryAck: true,
        },
      ],
    });
    await harness.push("consent_request");
    expect(harness.shown.map((item) => item.title)).toEqual([
      "consent_request",
    ]);
  });

  it.each(["consent_opened", "consent_resolved"])(
    "keeps background %s bookkeeping silent, including legacy payloads",
    async (type) => {
      const tag = "consent-request:request-1";
      const harness = createHarness({
        clientState: "none",
        deliveredTags: [tag],
      });
      await harness.push(type, {
        type,
        request_id: "request-1",
        notification_tag: tag,
      });
      expect(harness.shown).toEqual([]);
      expect(harness.closedTags).toEqual([tag]);
    },
  );

  it("honors the explicit silent presentation contract for future types", async () => {
    const harness = createHarness({ clientState: "none" });
    await harness.push("future_bookkeeping", {
      type: "future_bookkeeping",
      notification_presentation: "silent",
    });
    expect(harness.shown).toEqual([]);
  });

  it("applies the same visible-owner policy to malformed legacy payloads", async () => {
    const harness = createHarness({ acknowledgeVisibleDelivery: true });
    await harness.malformedPush();
    expect(harness.shown).toEqual([]);
  });

  it("uses a persistent vibrating system alert for background emergency SMS", async () => {
    const harness = createHarness({ clientState: "none" });
    await harness.push("location_share_created", {
      type: "location_share_created",
      share_kind: "sos",
      notification_profile: "one_location_sms_emergency",
    });

    expect(harness.shown[0]).toEqual({
      title: "location_share_created",
      options: expect.objectContaining({
        requireInteraction: true,
        renotify: true,
        silent: false,
        vibrate: [240, 120, 240, 120, 520],
        data: expect.objectContaining({ url: "/one/feed" }),
      }),
    });
  });

  it("routes a warm notification body tap to Feed without document navigation", async () => {
    const harness = createHarness({
      acknowledgeVisibleDelivery: true,
      acknowledgeNotificationClick: true,
    });
    await harness.click({
      type: "location_share_created",
      grant_id: "old-target",
    });

    expect(harness.focusCount).toBe(1);
    expect(harness.openedUrls).toEqual([]);
    expect(harness.navigatedUrls).toEqual([]);
    expect(harness.clientMessages).toContainEqual(
      expect.objectContaining({
        type: "hushh:fcm_notification_clicked",
        url: "/one/feed",
        reason: "notification_click",
      }),
    );
  });

  it("navigates a stale warm client when the click bridge does not acknowledge", async () => {
    const harness = createHarness({ acknowledgeNotificationClick: false });
    await harness.click({ type: "connection_request" });
    expect(harness.navigatedUrls).toEqual(["/one/feed"]);
    expect(harness.openedUrls).toEqual([]);
  });

  it("falls back immediately when posting to a stale warm client throws", async () => {
    const harness = createHarness({
      clients: [
        {
          visibilityState: "visible",
          focused: true,
          postMessageThrows: true,
          navigate: "success",
        },
      ],
    });
    await harness.click({ type: "connection_request" });
    expect(harness.navigatedUrls).toEqual(["/one/feed"]);
  });

  it("opens Feed when a stale client cannot be navigated", async () => {
    const harness = createHarness({
      clients: [
        {
          visibilityState: "visible",
          focused: true,
          navigate: "failure",
        },
      ],
    });
    await harness.click({ type: "connection_request" });
    expect(harness.openedUrls).toEqual(["/one/feed"]);
  });

  it("preserves consent identity while routing a body tap through Feed", async () => {
    const harness = createHarness({
      acknowledgeNotificationClick: true,
    });
    await harness.click({
      type: "consent_request",
      request_id: "request 1",
      bundle_id: "bundle&1",
    });
    expect(harness.clientMessages).toContainEqual(
      expect.objectContaining({
        type: "hushh:fcm_notification_clicked",
        url:
          "/one/feed?notificationRequestId=request%201&notificationBundleId=bundle%261",
      }),
    );
  });

  it("opens Feed for a cold notification body tap", async () => {
    const harness = createHarness({ clientState: "none" });
    await harness.click({ type: "location_share_created" });
    expect(harness.openedUrls).toEqual(["/one/feed"]);
  });
});
