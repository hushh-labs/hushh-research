export type QueuedAgentPrompt = {
  id: string;
  text: string;
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
  return queue.map((prompt) => (prompt.id === id ? { ...prompt, text } : prompt));
}

export function removeQueuedAgentPrompt(
  queue: readonly QueuedAgentPrompt[],
  id: string,
): QueuedAgentPrompt[] {
  return queue.filter((prompt) => prompt.id !== id);
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
