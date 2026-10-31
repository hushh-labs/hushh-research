import { describe, expect, it } from "vitest";

import {
  combineQueuedPromptText,
  editQueuedAgentPrompt,
  enqueueAgentPrompt,
  removeQueuedAgentPrompt,
  SerialAgentOperationQueue,
  takeJoinableRun,
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
    const queue = editQueuedAgentPrompt(
      [
        first,
        {
          ...second,
          deferPkmContext: true,
          gmailInformationRequestWorkflowId: "workflow-1",
          kycInformationSaveConfirmed: true,
          driveSearchSelection: { jobId: "saved-search", position: 1 },
        },
        third,
      ],
      "second",
      "Updated",
    );
    expect(queue.map((prompt) => prompt.id)).toEqual(["first", "second", "third"]);
    expect(queue[1].text).toBe("Updated");
    expect(queue[1].deferPkmContext).toBe(true);
    expect(queue[1].gmailInformationRequestWorkflowId).toBe("workflow-1");
    expect(queue[1].kycInformationSaveConfirmed).toBe(true);
    expect(queue[1].driveSearchSelection).toBeUndefined();
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

  it("sends plain queued messages together as one turn, in order, stopping at one with its own authority", () => {
    const plain = (id: string, text: string) => ({ prompt: { id, text, createdAtMs: 1, joinable: true } });
    const withFile = {
      prompt: {
        id: "file",
        text: "Summarise this",
        createdAtMs: 1,
        joinable: true,
        driveSearchSelection: { jobId: "job", position: 0 },
      },
    };
    const { taken, rest } = takeJoinableRun([plain("a", "Also X"), plain("b", "Actually Y"), withFile, plain("c", "Z")]);

    expect(taken.map((item) => item.prompt.id)).toEqual(["a", "b"]);
    expect(rest.map((item) => item.prompt.id)).toEqual(["file", "c"]);
    expect(combineQueuedPromptText(taken.map((item) => item.prompt))).toBe("Also X\n\nActually Y");
    // Negative control: a person-picker prompt (not joinable) never rides along.
    expect(takeJoinableRun([{ prompt: { id: "p", text: "Pick", createdAtMs: 1, joinable: false } }]).taken).toEqual([]);
  });
});
