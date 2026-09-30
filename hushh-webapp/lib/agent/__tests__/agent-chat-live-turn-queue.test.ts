import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LiveTurnQueue,
  parseQueuedInputNotice,
  type QueuedInputPorts,
  type QueuedInputStatus,
} from "@/lib/agent/agent-chat-live-turn-queue";

/** A fake server with the backend registry's rules: FIFO, id-idempotent, owner-free. */
function fakeServer() {
  const outcomes = new Map<string, QueuedInputStatus>();
  const pending: string[] = [];
  let open = true;
  const ports: QueuedInputPorts = {
    enqueue: vi.fn(async (_conversation, id) => {
      const known = outcomes.get(id);
      if (known) return known;
      const status = open ? "queued" : "returned";
      outcomes.set(id, status);
      if (open) pending.push(id);
      return status;
    }),
    withdraw: vi.fn(async (_conversation, id) => {
      const index = pending.indexOf(id);
      if (index >= 0) {
        pending.splice(index, 1);
        outcomes.set(id, "withdrawn");
        return "withdrawn";
      }
      return outcomes.get(id) ?? "withdrawn";
    }),
    status: vi.fn(async (_conversation, ids) =>
      Object.fromEntries(ids.map((id) => [id, outcomes.get(id) ?? "unknown"])),
    ),
    stop: vi.fn(async () => {
      open = false;
      const returned = pending.splice(0);
      for (const id of returned) outcomes.set(id, "returned");
      return { stopped: true, returned };
    }),
  };
  return {
    ports,
    /** The turn reaches a step boundary and takes everything waiting. */
    drain: () => {
      const ids = pending.splice(0);
      for (const id of ids) outcomes.set(id, "delivered");
      return ids;
    },
    /** The model callback took the message but has not sealed it yet. */
    startAppend: () => pending.splice(0),
    completeAppend: (ids: string[]) => {
      for (const id of ids) outcomes.set(id, "delivered");
    },
    /** The turn ends; whatever it did not take comes back. */
    close: () => {
      open = false;
      const ids = pending.splice(0);
      for (const id of ids) outcomes.set(id, "returned");
      return ids;
    },
  };
}

describe("live turn queue", () => {
  it("queues while One streams and lands a message the turn took, once", async () => {
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");

    expect(await queue.offer("client-a", "Also include Friday")).toBe("joining");
    const joined = server.drain();
    const notice = { phase: "joined" as const, joined, returned: [] };

    expect(queue.apply(notice)).toEqual({ joined: ["client-a"], waiting: [] });
    // A replayed notice (reconnect, duplicate event) lands nothing twice.
    expect(queue.apply(notice)).toEqual({ joined: [], waiting: [] });
    expect(await queue.settle()).toEqual({ joined: [], waiting: [] });
  });

  it("sends what the turn could not take as the next turn, in order", async () => {
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");
    await queue.offer("client-a", "first");
    await queue.offer("client-b", "second");

    const returned = server.close();
    expect(queue.apply({ phase: "settled", joined: [], returned })).toEqual({
      joined: [],
      waiting: ["client-a", "client-b"],
    });
  });

  it("never offers after the stream ended, and settles an in-flight offer from the server record", async () => {
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");
    const inFlight = queue.offer("client-a", "Also X");
    queue.stopAccepting();
    await inFlight; // the server received it before the turn ended...
    server.drain(); // ...and the turn read it at its last step.

    expect(await queue.offer("client-b", "late")).toBe("waiting");
    // Negative control for duplicates: without settling from the record this
    // message would be sent again as the next turn.
    expect(await queue.settle()).toEqual({ joined: ["client-a"], waiting: [] });
    expect(server.ports.enqueue).toHaveBeenCalledTimes(1);
  });

  it("reconnects by reading terminal outcomes and holds an unreadable receipt", async () => {
    const server = fakeServer();
    const wait = vi.fn(async () => undefined);
    const queue = new LiveTurnQueue(server.ports, wait);
    queue.begin("conversation");
    await queue.offer("client-a", "joins");
    await queue.offer("client-b", "waits");
    server.drain();
    await queue.offer("client-c", "comes back");
    server.close();

    expect(await queue.settle()).toEqual({ joined: ["client-a", "client-b"], waiting: ["client-c"] });

    const flaky = fakeServer();
    flaky.ports.status = vi.fn(async () => {
      throw new Error("offline");
    });
    const offline = new LiveTurnQueue(flaky.ports, wait);
    offline.begin("conversation");
    await offline.offer("client-d", "unknown fate");
    expect(await offline.settle()).toEqual({ joined: [], waiting: [], unresolved: ["client-d"] });
    expect(flaky.ports.status).toHaveBeenCalledTimes(3);
    expect(offline.holds("client-d")).toBe(true);
  });

  it("waits for a sealed append and never resends an unresolved message", async () => {
    const server = fakeServer();
    const wait = vi.fn(async () => undefined);
    const queue = new LiveTurnQueue(server.ports, wait);
    queue.begin("conversation");
    await queue.offer("client-a", "one exact message");
    const inflight = server.startAppend();

    // Negative control: a queued receipt after the stream closes does not
    // establish whether the append will succeed, nor permit a second turn.
    expect(await queue.settle()).toEqual({ joined: [], waiting: [], unresolved: ["client-a"] });
    expect(queue.holds("client-a")).toBe(true);
    expect(await queue.withdraw("client-a")).toBe("not_held");
    expect(server.ports.enqueue).toHaveBeenCalledTimes(1);

    server.completeAppend(inflight);
    expect(await queue.settle()).toEqual({ joined: ["client-a"], waiting: [] });
    expect(queue.holds("client-a")).toBe(false);
    expect(server.ports.enqueue).toHaveBeenCalledTimes(1);
  });

  it("stops the turn and brings every held message back unsent", async () => {
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");
    await queue.offer("client-a", "one");
    await queue.offer("client-b", "two");

    expect(await queue.stop()).toEqual({ stopped: true, waiting: ["client-a", "client-b"] });
    expect(await queue.settle()).toEqual({ joined: [], waiting: [] });
  });

  it("withdraws a message that has not joined, and reports one that already did", async () => {
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");
    await queue.offer("client-a", "keep");
    await queue.offer("client-b", "remove");

    expect(await queue.withdraw("client-b")).toBe("withdrawn");
    server.drain();
    expect(await queue.withdraw("client-a")).toBe("joined");
  });

  it("reads only well-formed notices, by id", () => {
    expect(parseQueuedInputNotice({ phase: "joined", joined: ["a", 3], returned: null })).toEqual({
      phase: "joined",
      joined: ["a"],
      returned: [],
    });
    expect(parseQueuedInputNotice({ phase: "text", joined: ["a"] })).toBeNull();
  });

  it("keeps queued text out of web storage, logs and analytics", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");
    await queue.offer("client-a", "My card ends 4242, also book Friday");
    server.drain();
    await queue.settle();

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    for (const file of [
      "lib/agent/agent-chat-live-turn-queue.ts",
      "lib/agent/agent-chat-prompt-queue.ts",
      "components/agent/agent-queued-stack.tsx",
    ]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|trackEvent|console\./);
    }
  });
});
