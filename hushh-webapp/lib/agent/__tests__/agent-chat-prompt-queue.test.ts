import { describe, expect, it } from "vitest";

import {
  editQueuedAgentPrompt,
  enqueueAgentPrompt,
  removeQueuedAgentPrompt,
  SerialAgentOperationQueue,
} from "@/lib/agent/agent-chat-prompt-queue";

describe("agent chat prompt queue", () => {
  const first = { id: "first", text: "First", createdAtMs: 1 };
  const second = { id: "second", text: "Second", createdAtMs: 2 };
  const third = { id: "third", text: "Third", createdAtMs: 3 };

  it("preserves FIFO insertion order", () => {
    const queue = [first, second].reduce(enqueueAgentPrompt, [] as Array<typeof first>);
    expect(enqueueAgentPrompt(queue, third).map((prompt) => prompt.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("edits in place without moving a pending prompt", () => {
    const queue = editQueuedAgentPrompt([first, second, third], "second", "Updated");
    expect(queue.map((prompt) => prompt.id)).toEqual(["first", "second", "third"]);
    expect(queue[1].text).toBe("Updated");
  });

  it("removes a pending prompt without affecting the remaining order", () => {
    expect(removeQueuedAgentPrompt([first, second, third], "second").map((prompt) => prompt.id)).toEqual([
      "first",
      "third",
    ]);
  });

  it("serializes rapid operations and begins the next only after the active work settles", async () => {
    const queue = new SerialAgentOperationQueue<string>();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.enqueue("calendar");
    queue.enqueue("second prompt");
    queue.enqueue("third prompt");
    const drain = queue.drain(async (operation) => {
      events.push(`start:${operation}`);
      if (operation === "calendar") await first;
      events.push(`end:${operation}`);
    });

    expect(events).toEqual(["start:calendar"]);
    releaseFirst?.();
    await drain;
    expect(events).toEqual([
      "start:calendar",
      "end:calendar",
      "start:second prompt",
      "end:second prompt",
      "start:third prompt",
      "end:third prompt",
    ]);
  });
});
