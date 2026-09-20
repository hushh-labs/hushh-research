import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  circleStateChangeClosesDetail,
  dispatchOneLocationStateChanged,
  subscribeToOneLocationStateChanges,
} from "@/lib/one-location/one-location-state-events";

class FakeBroadcastChannel {
  private static channels = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(private readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this) continue;
      for (const listener of peer.listeners) {
        listener({ data } as MessageEvent<unknown>);
      }
    }
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.delete(listener);
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset() {
    FakeBroadcastChannel.channels.clear();
  }
}

describe("One Location state events", () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("delivers a mutation once when DOM and BroadcastChannel carry the same event", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToOneLocationStateChanges((detail) =>
      received.push(detail),
    );

    dispatchOneLocationStateChanged("user-a", [
      "workspace",
      "circles",
      "sms_roster",
    ]);

    expect(received).toEqual([
      expect.objectContaining({
        userId: "user-a",
        domains: ["workspace", "circles", "sms_roster"],
        changedAt: expect.any(Number),
      }),
    ]);
    unsubscribe();
  });

  it("receives a mutation published by another tab", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToOneLocationStateChanges((detail) =>
      received.push(detail),
    );
    const otherTab = new FakeBroadcastChannel("hushh-one-location-state-v1");

    otherTab.postMessage({
      userId: "user-a",
      domains: ["sms_roster"],
      changedAt: 123,
    });

    expect(received).toEqual([
      { userId: "user-a", domains: ["sms_roster"], changedAt: 123 },
    ]);
    unsubscribe();
    otherTab.close();
  });

  it("preserves supporting-resource domains without accepting unknown values", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToOneLocationStateChanges((detail) =>
      received.push(detail),
    );
    const otherTab = new FakeBroadcastChannel("hushh-one-location-state-v1");

    otherTab.postMessage({
      userId: "user-a",
      domains: ["map_preferences", "activity", "coordinates"],
      changedAt: 127,
    });

    expect(received).toEqual([
      {
        userId: "user-a",
        domains: ["map_preferences"],
        changedAt: 127,
      },
    ]);
    unsubscribe();
    otherTab.close();
  });

  it("preserves terminal Circle context without exposing roster data", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToOneLocationStateChanges((detail) =>
      received.push(detail),
    );

    dispatchOneLocationStateChanged(
      "user-a",
      ["workspace", "circles"],
      {
        notificationType: "location_circle_deleted",
        circleId: "circle-1",
        memberUserId: "user-a",
        eventId: "delete-transition-1",
      },
    );

    expect(received).toEqual([
      expect.objectContaining({
        userId: "user-a",
        domains: ["workspace", "circles"],
        notificationType: "location_circle_deleted",
        circleId: "circle-1",
        memberUserId: "user-a",
        eventId: "delete-transition-1",
      }),
    ]);
    expect(received[0]).not.toHaveProperty("members");
    unsubscribe();
  });

  it("closes only when the current viewer loses access to the open Circle", () => {
    expect(
      circleStateChangeClosesDetail(
        {
          notificationType: "location_circle_member_removed",
          circleId: "circle-1",
          memberUserId: "viewer-a",
        },
        "viewer-a",
        "circle-1",
      ),
    ).toBe(true);
    expect(
      circleStateChangeClosesDetail(
        {
          notificationType: "location_circle_member_removed",
          circleId: "circle-1",
          memberUserId: "member-b",
        },
        "viewer-a",
        "circle-1",
      ),
    ).toBe(false);
    expect(
      circleStateChangeClosesDetail(
        {
          notificationType: "location_circle_deleted",
          circleId: "circle-1",
        },
        "viewer-a",
        "circle-1",
      ),
    ).toBe(true);
    expect(
      circleStateChangeClosesDetail(
        {
          notificationType: "location_circle_member_left",
          circleId: "circle-1",
          memberUserId: "viewer-a",
        },
        "viewer-a",
        "circle-1",
      ),
    ).toBe(true);
  });

  it("collapses the same backend transition rebroadcast by multiple tabs", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToOneLocationStateChanges((detail) =>
      received.push(detail),
    );
    const firstTab = new FakeBroadcastChannel("hushh-one-location-state-v1");
    const secondTab = new FakeBroadcastChannel("hushh-one-location-state-v1");

    firstTab.postMessage({
      userId: "user-a",
      domains: ["circles"],
      changedAt: 125,
      eventId: "circle-transition-1",
    });
    secondTab.postMessage({
      userId: "user-a",
      domains: ["circles"],
      changedAt: 126,
      eventId: "circle-transition-1",
    });

    expect(received).toHaveLength(1);
    unsubscribe();
    firstTab.close();
    secondTab.close();
  });

  it("keeps cross-tab Circle events scoped to the supplied account", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToOneLocationStateChanges((detail) => {
      if (detail.userId === "user-a") received.push(detail);
    });
    const otherTab = new FakeBroadcastChannel("hushh-one-location-state-v1");

    otherTab.postMessage({
      userId: "user-b",
      domains: ["circles"],
      changedAt: 124,
      notificationType: "location_circle_renamed",
      circleId: "circle-b",
    });

    expect(received).toEqual([]);
    unsubscribe();
    otherTab.close();
  });
});
