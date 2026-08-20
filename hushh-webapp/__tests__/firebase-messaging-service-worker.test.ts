import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

type ServiceWorkerHandler = (event: {
  data?: { json: () => unknown } | Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
}) => void;

function createHarness(options: { acknowledgeVisibleDelivery: boolean }) {
  const handlers = new Map<string, ServiceWorkerHandler>();
  const shown: Array<{ title: string; options?: Record<string, unknown> }> = [];
  const serviceWorker = {
    __HUSHH_FCM_ACK_TIMEOUT_MS__: 5,
    clients: {
      matchAll: async () => [
        {
          visibilityState: "visible",
          postMessage: (payload: { delivery_id?: string }) => {
            if (!options.acknowledgeVisibleDelivery || !payload.delivery_id)
              return;
            queueMicrotask(() => {
              handlers.get("message")?.({
                data: {
                  type: "hushh:fcm_push_ack",
                  delivery_id: payload.delivery_id,
                },
              });
            });
          },
        },
      ],
      openWindow: async () => undefined,
    },
    registration: {
      showNotification: async (
        title: string,
        notificationOptions?: Record<string, unknown>,
      ) => {
        shown.push({ title, options: notificationOptions });
      },
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
  });

  return {
    shown,
    async push(type: string, data: Record<string, string> = { type }) {
      let pending = Promise.resolve();
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
  };
}

describe("Firebase messaging service-worker foreground ownership", () => {
  it("suppresses the system banner only after the visible app acknowledges delivery", async () => {
    const harness = createHarness({ acknowledgeVisibleDelivery: true });
    await harness.push("location_share_created");
    expect(harness.shown).toEqual([]);
  });

  it("falls back to the system banner when the visible app does not acknowledge", async () => {
    const harness = createHarness({ acknowledgeVisibleDelivery: false });
    await harness.push("location_share_created");
    expect(harness.shown.map((item) => item.title)).toEqual([
      "location_share_created",
    ]);
  });

  it("keeps system delivery for notification families not rendered by the provider", async () => {
    const harness = createHarness({ acknowledgeVisibleDelivery: true });
    await harness.push("kai_analysis_complete");
    expect(harness.shown.map((item) => item.title)).toEqual([
      "kai_analysis_complete",
    ]);
  });

  it("uses a persistent vibrating system alert for background emergency SMS", async () => {
    const harness = createHarness({ acknowledgeVisibleDelivery: false });
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
      }),
    });
  });
});
