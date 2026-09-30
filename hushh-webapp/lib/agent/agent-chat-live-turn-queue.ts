/**
 * Messages the person sends while One is still working on a turn.
 *
 * A queued plain-text message is offered to the running turn, which reads it at
 * its next model step (after a tool or agent step returns). The server answers
 * where each message landed, by client message id only:
 *
 * - `joined`: One took it into the running turn. It leaves the queue and shows
 *   in the transcript above the reply it joined.
 * - `returned`: the turn could not take it (it was already writing its final
 *   answer, was stopped, or is a kind of turn that never takes extra input). It
 *   stays queued and is sent as the next turn.
 *
 * Exactly once: every id is offered at most once to a turn, and before the next
 * turn starts every offered id is settled from the server's own record, so a
 * message that already joined is never sent again and one that did not is never
 * dropped. Queued text lives only in this object and React state, never in web
 * storage, logs or analytics.
 */

export type QueuedInputStatus =
  | "queued"
  | "delivered"
  | "returned"
  | "withdrawn"
  | "unknown";

export type QueuedInputNotice = {
  phase: "joined" | "settled";
  joined: string[];
  returned: string[];
};

export type QueuedInputPorts = {
  enqueue: (conversationId: string, clientMessageId: string, text: string) => Promise<QueuedInputStatus>;
  withdraw: (conversationId: string, clientMessageId: string) => Promise<QueuedInputStatus>;
  status: (conversationId: string, clientMessageIds: string[]) => Promise<Record<string, QueuedInputStatus>>;
  stop: (conversationId: string) => Promise<{ stopped: boolean; returned: string[] }>;
};

export const QUEUED_INPUT_EVENT = "hussh.queued_input" as const;

const STATUSES = new Set<QueuedInputStatus>(["queued", "delivered", "returned", "withdrawn", "unknown"]);
const SETTLE_RETRY_DELAYS_MS = [400, 1_200] as const;

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 32)
    : [];
}

export function parseQueuedInputStatus(value: unknown): QueuedInputStatus {
  return typeof value === "string" && STATUSES.has(value as QueuedInputStatus)
    ? (value as QueuedInputStatus)
    : "unknown";
}

export function parseQueuedInputNotice(value: unknown): QueuedInputNotice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.phase !== "joined" && record.phase !== "settled") return null;
  return { phase: record.phase, joined: ids(record.joined), returned: ids(record.returned) };
}

export type LiveTurnSettlement = { joined: string[]; waiting: string[] };

export class LiveTurnQueue {
  private conversationId: string | null = null;
  private accepting = false;
  /** Ids the running turn holds and has not yet reported on. */
  private readonly held = new Set<string>();

  constructor(
    private readonly ports: QueuedInputPorts,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** A turn of this conversation is running and can be offered messages. */
  begin(conversationId: string): void {
    this.conversationId = conversationId;
    this.accepting = true;
  }

  /**
   * The turn's stream ended: offer nothing more. Offers already sent still
   * record what the server holds, which is why the caller waits for them
   * before settle().
   */
  stopAccepting(): void {
    this.accepting = false;
  }

  get liveConversationId(): string | null {
    return this.accepting ? this.conversationId : null;
  }

  holds(clientMessageId: string): boolean {
    return this.held.has(clientMessageId);
  }

  /** Offer a message to the running turn. Anything but `queued` means it waits. */
  async offer(clientMessageId: string, text: string): Promise<"joining" | "waiting"> {
    const conversationId = this.conversationId;
    if (!conversationId || !this.accepting) return "waiting";
    try {
      const status = await this.ports.enqueue(conversationId, clientMessageId, text);
      if (status !== "queued") return "waiting";
      // Recorded even if the turn ended meanwhile: the server holds it, so
      // only settle() may decide whether it joined.
      this.held.add(clientMessageId);
      return "joining";
    } catch {
      return "waiting";
    }
  }

  /** Apply a live notice; returns only ids this client offered to this turn. */
  apply(notice: QueuedInputNotice): LiveTurnSettlement {
    const joined = notice.joined.filter((id) => this.held.delete(id));
    const waiting = notice.returned.filter((id) => this.held.delete(id));
    return { joined, waiting };
  }

  /**
   * Take a message back before it joins. `joined` means the turn already read
   * it; the caller shows it where it landed instead of removing it.
   */
  async withdraw(clientMessageId: string): Promise<"withdrawn" | "joined" | "not_held"> {
    const conversationId = this.conversationId;
    if (!conversationId || !this.held.has(clientMessageId)) return "not_held";
    try {
      const status = await this.ports.withdraw(conversationId, clientMessageId);
      this.held.delete(clientMessageId);
      return status === "delivered" ? "joined" : "withdrawn";
    } catch {
      // Unknown outcome: keep it held, so settle() reads the server's record.
      return "not_held";
    }
  }

  /** Ask the running turn to end at its next step; what it held comes back. */
  async stop(): Promise<{ stopped: boolean; waiting: string[] }> {
    const conversationId = this.conversationId;
    if (!conversationId) return { stopped: false, waiting: [] };
    try {
      const result = await this.ports.stop(conversationId);
      const waiting = result.returned.filter((id) => this.held.delete(id));
      return { stopped: result.stopped, waiting };
    } catch {
      return { stopped: false, waiting: [] };
    }
  }

  /**
   * The turn ended. Resolve every message it still holds from the server's
   * record before anything else is sent, so none is sent twice or lost. Only if
   * the record cannot be read at all does a message fall back to the next turn.
   */
  async settle(): Promise<LiveTurnSettlement> {
    const conversationId = this.conversationId;
    this.conversationId = null;
    this.accepting = false;
    const pending = [...this.held];
    this.held.clear();
    if (!conversationId || pending.length === 0) return { joined: [], waiting: [] };
    for (let attempt = 0; attempt <= SETTLE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const statuses = await this.ports.status(conversationId, pending);
        const joined = pending.filter((id) => statuses[id] === "delivered");
        return { joined, waiting: pending.filter((id) => !joined.includes(id)) };
      } catch {
        const delay = SETTLE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await this.wait(delay);
      }
    }
    return { joined: [], waiting: pending };
  }
}
