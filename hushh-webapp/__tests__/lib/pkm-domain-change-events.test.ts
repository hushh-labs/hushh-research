import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchLocalPkmDomainChanged,
  dispatchPkmDomainChanged,
  subscribeToPkmDomainChanges,
  subscribeToRemotePkmDomainChanges,
} from "@/lib/pkm/pkm-domain-change-events";

class FakeBroadcastChannel {
  private static peers = new Set<FakeBroadcastChannel>();
  private listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.peers.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.peers) {
      if (peer === this || peer.name !== this.name) continue;
      for (const listener of peer.listeners) {
        listener({ data } as MessageEvent<unknown>);
      }
    }
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.delete(listener);
  }
  close() {
    FakeBroadcastChannel.peers.delete(this);
  }
  static reset() {
    FakeBroadcastChannel.peers.clear();
  }
}

describe("PKM domain change events", () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("carries metadata only to same-tab and cross-tab subscribers", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToPkmDomainChanges((detail) =>
      received.push(detail),
    );
    dispatchPkmDomainChanged({
      userId: "owner-a",
      domain: "location",
      dataVersion: 8,
      updatedAt: "2026-09-20T00:00:00.000Z",
      operation: "stored",
    });
    expect(received).toEqual([
      {
        userId: "owner-a",
        domain: "location",
        dataVersion: 8,
        updatedAt: "2026-09-20T00:00:00.000Z",
        operation: "stored",
      },
    ]);
    expect(received[0]).not.toHaveProperty("locations");
    expect(received[0]).not.toHaveProperty("coordinates");
    unsubscribe();
  });

  it("accepts a valid event from another tab and drops malformed payloads", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToPkmDomainChanges((detail) =>
      received.push(detail),
    );
    const otherTab = new FakeBroadcastChannel("hushh-pkm-domain-change-v1");
    otherTab.postMessage({ userId: "owner-a", domain: "location" });
    otherTab.postMessage({
      userId: "owner-a",
      domain: "location",
      dataVersion: 9,
      updatedAt: null,
      operation: "stored",
    });
    expect(received).toHaveLength(1);
    unsubscribe();
    otherTab.close();
  });

  it("delivers only peer-tab events to the global invalidation subscriber", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToRemotePkmDomainChanges((detail) =>
      received.push(detail),
    );
    dispatchPkmDomainChanged({
      userId: "owner-a",
      domain: "location",
      dataVersion: 10,
      updatedAt: null,
      operation: "stored",
    });
    expect(received).toEqual([]);

    const otherTab = new FakeBroadcastChannel("hushh-pkm-domain-change-v1");
    otherTab.postMessage({
      userId: "owner-a",
      domain: "location",
      dataVersion: 11,
      updatedAt: null,
      operation: "cleared",
    });
    expect(received).toEqual([
      expect.objectContaining({ operation: "cleared", dataVersion: 11 }),
    ]);
    unsubscribe();
    otherTab.close();
  });

  it("can notify legacy local consumers without echoing to peer subscribers", () => {
    const local: unknown[] = [];
    const remote: unknown[] = [];
    const onLocal = (event: Event) =>
      local.push((event as CustomEvent<unknown>).detail);
    window.addEventListener("pkm-domain-changed", onLocal);
    const unsubscribe = subscribeToRemotePkmDomainChanges((detail) =>
      remote.push(detail),
    );
    const detail = {
      userId: "owner-a",
      domain: "location",
      dataVersion: null,
      updatedAt: null,
      operation: "cleared" as const,
    };

    dispatchLocalPkmDomainChanged(detail);

    expect(local).toEqual([detail]);
    expect(remote).toEqual([]);
    window.removeEventListener("pkm-domain-changed", onLocal);
    unsubscribe();
  });
});
