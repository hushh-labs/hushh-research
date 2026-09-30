import type { AgentTextAttachment } from "@/lib/agent/large-text-attachment";
import type { DriveSearchSelection } from "@/lib/services/drive-search-service";

export type QueuedAgentPrompt = {
  id: string;
  text: string;
  /** Pasted text queued with this turn; sent as its own part, shown as a chip. */
  attachments?: AgentTextAttachment[];
  createdAtMs: number;
  /**
   * An opaque, owner-selected Gmail information-request reference. It is
   * session-only and is revalidated by agent-chat ingress for this turn.
   */
  gmailInformationRequestWorkflowId?: string;
  /**
   * The owner typed this reply while completing the selected KYC request.
   * This is the explicit confirmation required for the restricted on-device
   * PKM writer; no email content is used as a write source.
   */
  kycInformationSaveConfirmed?: boolean;
  /**
   * Large pasted context is captured by the guarded background PKM lane after
   * the answer starts. It must not make the foreground turn wait for a full
   * decrypted inventory to hydrate.
   */
  deferPkmContext?: boolean;
  /** One selected saved Drive result. Owner authorization is rechecked at chat ingress. */
  driveSearchSelection?: DriveSearchSelection;
  /**
   * Only plain typed text may join One's running turn or share a turn with
   * other queued messages. A prompt that carries its own per-turn authority
   * (a person picker handle, a Drive file, a Gmail request) keeps its own turn.
   */
  joinable?: boolean;
  /**
   * `joining`: the running turn holds it and reads it at its next step.
   * Otherwise it waits and is sent as the next turn.
   */
  placement?: "waiting" | "joining";
};

export function enqueueAgentPrompt(
  queue: readonly QueuedAgentPrompt[],
  prompt: QueuedAgentPrompt,
): QueuedAgentPrompt[] {
  return [...queue, prompt];
}

export function editQueuedAgentPrompt(
  queue: readonly QueuedAgentPrompt[],
  id: string,
  text: string,
): QueuedAgentPrompt[] {
  // Editing a queued message changes its intent. The old file choice must be
  // made explicitly again instead of silently following the revised text, and
  // a copy the running turn held was withdrawn, so it waits again.
  return queue.map((prompt) =>
    prompt.id === id
      ? { ...prompt, text, driveSearchSelection: undefined, placement: "waiting" }
      : prompt,
  );
}

export function removeQueuedAgentPrompt(
  queue: readonly QueuedAgentPrompt[],
  id: string,
): QueuedAgentPrompt[] {
  return queue.filter((prompt) => prompt.id !== id);
}

/** Whether a queued prompt is plain typed text with no per-turn authority of its own. */
export function canJoinAgentTurn(prompt: QueuedAgentPrompt): boolean {
  return (
    prompt.joinable === true &&
    Boolean(prompt.text) &&
    !prompt.attachments?.length &&
    !prompt.driveSearchSelection &&
    !prompt.gmailInformationRequestWorkflowId &&
    !prompt.kycInformationSaveConfirmed
  );
}

/**
 * The joinable prompts at the head of the queue, which go out together as one
 * turn in the order they were queued. The first prompt that carries its own
 * authority ends the run and keeps its own turn.
 */
export function takeJoinableRun<T extends { prompt?: QueuedAgentPrompt }>(
  items: readonly T[],
): { taken: T[]; rest: T[] } {
  let end = 0;
  for (const item of items) {
    if (!item.prompt || !canJoinAgentTurn(item.prompt)) break;
    end += 1;
  }
  return { taken: items.slice(0, end), rest: items.slice(end) };
}

/** Several queued messages as one turn's text, in order, each its own paragraph. */
export function combineQueuedPromptText(prompts: readonly QueuedAgentPrompt[]): string {
  return prompts.map((prompt) => prompt.text.trim()).filter(Boolean).join("\n\n");
}

export function setQueuedPromptPlacement(
  queue: readonly QueuedAgentPrompt[],
  ids: ReadonlySet<string>,
  placement: NonNullable<QueuedAgentPrompt["placement"]>,
): QueuedAgentPrompt[] {
  return queue.map((prompt) => (ids.has(prompt.id) ? { ...prompt, placement } : prompt));
}

/** A tiny in-memory serial runner. The workspace owns lifecycle cancellation;
 * this primitive only guarantees that rapid enqueue calls start in FIFO order. */
export class SerialAgentOperationQueue<T> {
  private items: T[] = [];
  private draining = false;

  enqueue(item: T) {
    this.items.push(item);
  }

  replace(items: T[]) {
    this.items = items;
  }

  snapshot(): readonly T[] {
    return this.items;
  }

  async drain(run: (item: T) => Promise<void> | void): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const next = this.items.shift();
        if (next !== undefined) await run(next);
      }
    } finally {
      this.draining = false;
      if (this.items.length > 0) {
        void this.drain(run);
      }
    }
  }
}
