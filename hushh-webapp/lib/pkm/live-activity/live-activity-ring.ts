/**
 * Fixed-capacity, O(1) ring of this tab's live activity events. Repeats of the
 * same kind, subject and label inside the coalesce window merge into the tail
 * event instead of growing the ring. Pure data structure: no I/O, no owner.
 */

import {
  LIVE_ACTIVITY_COALESCE_WINDOW_MS,
  LIVE_ACTIVITY_RING_CAPACITY,
  LIVE_ACTIVITY_SCHEMA_VERSION,
  liveActivityCoalesceKey,
  type LiveActivityEvent,
  type LiveActivityInput,
} from "./live-activity-types";

export class LiveActivityRing {
  private readonly capacity: number;
  private readonly slots: (LiveActivityEvent | undefined)[];
  private start = 0;
  private count = 0;

  constructor(capacity: number = LIVE_ACTIVITY_RING_CAPACITY) {
    this.capacity = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : LIVE_ACTIVITY_RING_CAPACITY;
    this.slots = new Array(this.capacity);
  }

  get size(): number {
    return this.count;
  }

  /** O(1): merges into the tail event when the coalesce key matches within the window, else appends (evicting the oldest at capacity). Returns the stored event. */
  push(
    input: Required<LiveActivityInput>,
    streamId: string,
    nextSeq: () => number,
    coalesceWindowMs: number = LIVE_ACTIVITY_COALESCE_WINDOW_MS,
  ): LiveActivityEvent {
    const tailIndex = (this.start + this.count - 1) % this.capacity;
    const tail = this.count ? this.slots[tailIndex] : undefined;
    if (tail && liveActivityCoalesceKey(tail) === liveActivityCoalesceKey(input)
        && Math.abs(input.at - tail.lastAt) <= coalesceWindowMs) {
      const merged: LiveActivityEvent = Object.freeze({
        ...tail,
        quantity: input.quantity ?? tail.quantity,
        count: tail.count + 1,
        firstAt: Math.min(tail.firstAt, input.at),
        lastAt: Math.max(tail.lastAt, input.at),
      });
      this.slots[tailIndex] = merged;
      return merged;
    }
    const seq = nextSeq();
    const event: LiveActivityEvent = Object.freeze({
      v: LIVE_ACTIVITY_SCHEMA_VERSION,
      id: `${streamId}:${seq}`,
      streamId,
      seq,
      kind: input.kind,
      subject: input.subject,
      label: input.label,
      quantity: input.quantity,
      count: 1,
      firstAt: input.at,
      lastAt: input.at,
    });
    if (this.count < this.capacity) {
      this.slots[(this.start + this.count) % this.capacity] = event;
      this.count += 1;
    } else {
      this.slots[this.start] = event;
      this.start = (this.start + 1) % this.capacity;
    }
    return event;
  }

  /** Oldest first. */
  toArray(): LiveActivityEvent[] {
    const events: LiveActivityEvent[] = [];
    for (let offset = 0; offset < this.count; offset += 1) {
      const event = this.slots[(this.start + offset) % this.capacity];
      if (event) events.push(event);
    }
    return events;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
