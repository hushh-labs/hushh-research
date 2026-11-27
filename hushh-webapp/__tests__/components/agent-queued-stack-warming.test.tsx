import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentQueuedStack } from "@/components/agent/agent-queued-stack";
import {
  SerialAgentOperationQueue,
  type QueuedAgentPrompt,
} from "@/lib/agent/agent-chat-prompt-queue";

const samplePrompt = (id: string, text: string): QueuedAgentPrompt => ({
  id,
  text,
  createdAtMs: 1_000,
  joinable: true,
  placement: "waiting",
});

describe("AgentQueuedStack warming wait experience", () => {
  it("renders the calm warming status and preserves edit/remove actions without showing Send now", () => {
    const onEditStart = vi.fn();
    const onRemove = vi.fn();
    render(
      <AgentQueuedStack
        prompts={[
          samplePrompt("p1", "Check my schedule"),
          samplePrompt("p2", "And summarize unread emails"),
        ]}
        warmingUp
        editingId={null}
        editingText=""
        onEditStart={onEditStart}
        onEditChange={vi.fn()}
        onEditSave={vi.fn()}
        onEditCancel={vi.fn()}
        onRemove={onRemove}
        onSendNow={vi.fn()}
      />,
    );

    expect(screen.getByText("2 queued")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-chat-queue-warming-status"),
    ).toHaveTextContent("Waking One · Sends automatically when ready");
    expect(screen.queryByTestId("agent-chat-queue-send-now")).toBeNull();

    fireEvent.click(screen.getByLabelText("Edit queued message 1"));
    expect(onEditStart).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByLabelText("Remove queued message 2"));
    expect(onRemove).toHaveBeenCalledWith("p2");
  });

  it("holds queued operations in snapshot during beforeShift so edits apply before dispatch", async () => {
    const queue = new SerialAgentOperationQueue<{ id: string; text: string }>();
    let releaseWarmup!: () => void;
    const warmupGate = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    const dispatched: string[] = [];

    queue.enqueue({ id: "1", text: "Original draft" });
    const drainPromise = queue.drain(
      async (item) => {
        dispatched.push(item.text);
      },
      async () => {
        await warmupGate;
      },
    );

    expect(queue.snapshot()).toEqual([{ id: "1", text: "Original draft" }]);
    queue.replace([{ id: "1", text: "Edited while waking" }]);
    queue.enqueue({ id: "2", text: "Follow-up while waking" });

    releaseWarmup();
    await drainPromise;

    expect(dispatched).toEqual([
      "Edited while waking",
      "Follow-up while waking",
    ]);
  });
});
