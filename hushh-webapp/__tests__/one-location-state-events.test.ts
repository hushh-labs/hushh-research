import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
});
