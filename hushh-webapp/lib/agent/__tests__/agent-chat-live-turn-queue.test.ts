import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentQueuedStack } from "@/components/agent/agent-queued-stack";
import { AgentChatSessionEpoch } from "@/lib/agent/agent-chat-session-epoch";
import {
  combineQueuedPromptText,
  takeJoinableRun,
  type QueuedAgentPrompt,
} from "@/lib/agent/agent-chat-prompt-queue";

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

    let release!: () => void;
    let released = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    void gate.then(() => { released = true; });
    const retire = vi.fn(() => { queue.stopAccepting(); release(); });
    const session = new AgentChatSessionEpoch(retire);
    const retiredEpoch = session.value;
    session.start();
    await Promise.resolve();
    expect(released).toBe(true);
    expect(retire).toHaveBeenCalledOnce();
    expect(session.isCurrent(retiredEpoch)).toBe(false);
    expect(queue.holds("client-a")).toBe(true);
    // Reopening the same conversation cannot turn an unknown old append into
    // delivery, or keep a fresh session waiting on that retired local gate.
    const fresh = new LiveTurnQueue(server.ports, wait);
    fresh.begin("conversation");
    expect(await fresh.offer("client-b", "new session")).toBe("joining");
    session.start();
    expect(retire).toHaveBeenCalledTimes(2);
    server.completeAppend(inflight);
    expect(await queue.settle()).toEqual({ joined: ["client-a"], waiting: [] });
    expect(queue.holds("client-a")).toBe(false);
    expect(server.ports.enqueue).toHaveBeenCalledTimes(2);
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

  it("stops the live turn and clubs returned updates plus un-offered draft without duplicating joined turns", async () => {
    const server = fakeServer();
    const queue = new LiveTurnQueue(server.ports);
    queue.begin("conversation");

    expect(await queue.offer("client-q0", "Already joined")).toBe("joining");
    const joined = server.drain();
    queue.apply({ phase: "joined", joined, returned: [] });

    expect(await queue.offer("client-q1", "First update")).toBe("joining");
    expect(await queue.offer("client-q2", "Second update")).toBe("joining");

    // Send immediately stops offering to the dying turn, appends the composer
    // draft without offering it, then stops the running turn.
    queue.stopAccepting();
    expect(await queue.offer("client-q3", "Draft third")).toBe("waiting");
    const stopped = await queue.stop();
    expect(stopped).toEqual({ stopped: true, waiting: ["client-q1", "client-q2"] });
    expect(await queue.settle()).toEqual({ joined: [], waiting: [] });

    const remaining: QueuedAgentPrompt[] = [
      { id: "client-q1", text: "First update", createdAtMs: 2, joinable: true, placement: "waiting" },
      { id: "client-q2", text: "Second update", createdAtMs: 3, joinable: true, placement: "waiting" },
      { id: "client-q3", text: "Draft third", createdAtMs: 4, joinable: true, placement: "waiting" },
    ];
    const [head, ...tail] = remaining;
    const { taken, rest } = takeJoinableRun(tail.map((prompt) => ({ prompt })));
    const together = [head!, ...taken.map((item) => item.prompt!)];
    expect(rest).toEqual([]);
    expect(combineQueuedPromptText(together)).toBe("First update\n\nSecond update\n\nDraft third");
  });

  it("surfaces Send now in the queued stack only while delivery is confirmed", () => {
    const onSendNow = vi.fn();
    const prompts: QueuedAgentPrompt[] = [
      { id: "q1", text: "Refine budget", createdAtMs: 1, joinable: true, placement: "waiting" },
      { id: "q2", text: "Add chart", createdAtMs: 2, joinable: true, placement: "waiting" },
    ];
    const baseProps = {
      prompts,
      hasComposerDraft: true,
      editingId: null,
      editingText: "",
      onEditStart: () => undefined,
      onEditChange: () => undefined,
      onEditSave: () => undefined,
      onEditCancel: () => undefined,
      onRemove: () => undefined,
      onSendNow,
    };
    const { rerender } = render(createElement(AgentQueuedStack, baseProps));

    const sendNowButton = screen.getByTestId("agent-chat-queue-send-now");
    expect(sendNowButton).toHaveTextContent("Send now");
    fireEvent.click(sendNowButton);
    expect(onSendNow).toHaveBeenCalledTimes(1);

    rerender(createElement(AgentQueuedStack, { ...baseProps, sendingImmediately: true }));
    expect(screen.queryByTestId("agent-chat-queue-send-now")).toBeNull();
    expect(screen.getByTestId("agent-chat-prompt-queue-header")).toHaveTextContent("Sending together now…");

    // Negative control: unconfirmed settlement blocks Send now until verified.
    rerender(createElement(AgentQueuedStack, { ...baseProps, deliveryUnconfirmed: true }));
    expect(screen.queryByTestId("agent-chat-queue-send-now")).toBeNull();
  });
});
