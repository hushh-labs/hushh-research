/**
 * The provisioning-narrative follower: a cursored reader, not an event pipe.
 *
 * The server speaks in ~40-second SSE SEGMENTS that end with an explicit
 * `segment_end` frame carrying `next_cursor`. End-of-stream carries NO meaning:
 * a clean close and a severed one (the proxy's old 45s abort, a network drop, a
 * backgrounded tab) both resolve to "reconnect at the last cursor actually
 * rendered". That single property is what makes every middlebox deadline on the
 * path harmless, and it is why this client's reconnect handler has no error
 * branch for mid-body death.
 *
 * TWO TRANSPORTS, ONE FRAME SHAPE. Web streams segments; native cannot stream
 * at all (Capacitor buffers whole responses), so it polls the JSON twin of the
 * same endpoint. Both paths hand the caller identical frames; the caller never
 * learns which ran. The poll is also the degradation target when the stream
 * fails repeatedly -- the ladder ends in polling, never in silence.
 *
 * THE CLIENT NEVER INVENTS A TERMINAL VERDICT. A dropped connection is "we lost
 * the thread", not "setup failed". Terminal comes only from a frame that says
 * so, which comes only from the registry row.
 */

import { Capacitor } from "@capacitor/core";

import { ApiService } from "@/lib/services/api-service";
import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

export interface PodLifecycleFrame {
  event: string;
  cursor: number;
  state: string | null;
  stage: string | null;
  progressPct: number;
  terminal: boolean;
  substrateStep?: string;
  stepOk?: boolean;
  reason?: string;
  hushhId?: string;
  hostReady?: boolean;
  health?: string;
}

export interface PodLifecycleFollowerOptions {
  /** Resume point; 0 means "from the beginning of what is retained". */
  cursor?: number;
  onFrame: (frame: PodLifecycleFrame) => void;
  /** Fired when the follower downgrades to polling or recovers. Informational. */
  onTransport?: (transport: "stream" | "poll") => void;
  signal?: AbortSignal;
  /** Poll cadence on native and after stream degradation. */
  pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 6_000;
/** Consecutive stream failures before falling back to the JSON poll. */
const STREAM_FAILURE_LADDER = 3;
/** The stream endpoint's segment is ~40s; allow slack before calling it idle. */
const SEGMENT_IDLE_TIMEOUT_MS = 70_000;

function toFrame(payload: Record<string, unknown>, event: string, terminal: boolean): PodLifecycleFrame {
  return {
    event,
    cursor: typeof payload.cursor === "number" ? payload.cursor : 0,
    state: typeof payload.state === "string" ? payload.state : null,
    stage: typeof payload.stage === "string" ? payload.stage : null,
    progressPct: typeof payload.progress_pct === "number" ? payload.progress_pct : 0,
    terminal,
    ...(typeof payload.substrate_step === "string"
      ? { substrateStep: payload.substrate_step, stepOk: payload.step_ok === true }
      : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(typeof payload.hushhId === "string" ? { hushhId: payload.hushhId } : {}),
    ...(typeof payload.hostReady === "boolean" ? { hostReady: payload.hostReady } : {}),
    ...(typeof payload.health === "string" ? { health: payload.health } : {}),
  };
}

async function pollOnce(
  cursor: number,
  onFrame: (frame: PodLifecycleFrame) => void
): Promise<{ cursor: number; terminal: boolean }> {
  const result = await ApiService.getPodLifecycle({ cursor });
  const snapshot = result?.snapshot;
  if (snapshot && typeof snapshot === "object") {
    onFrame(toFrame(snapshot as Record<string, unknown>, "snapshot", false));
  }
  let next = cursor;
  let terminal = Boolean(result?.terminal);
  for (const event of result?.events ?? []) {
    const frame = toFrame(event as Record<string, unknown>, "stage", false);
    next = Math.max(next, frame.cursor);
    onFrame(frame);
  }
  if (typeof result?.nextCursor === "number") {
    next = Math.max(next, result.nextCursor);
  }
  return { cursor: next, terminal };
}

async function streamSegment(
  cursor: number,
  onFrame: (frame: PodLifecycleFrame) => void,
  signal: AbortSignal | undefined
): Promise<{ cursor: number; terminal: boolean; reconnectAfterMs: number }> {
  const response = await ApiService.openPodLifecycleStream({ cursor, signal });
  let latest = cursor;
  let terminal = false;
  let reconnectAfterMs = 0;
  await consumeCanonicalKaiStream(
    response,
    (envelope: KaiStreamEnvelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      if (envelope.event === "segment_end") {
        const next = payload.next_cursor;
        if (typeof next === "number") latest = Math.max(latest, next);
        const wait = payload.reconnect_after_ms;
        if (typeof wait === "number") reconnectAfterMs = wait;
        return;
      }
      const frame = toFrame(payload, envelope.event, envelope.terminal);
      // Never rewind below what was already rendered: reconnects use
      // max(caller, latest) so a replayed frame cannot drag the surface back.
      latest = Math.max(latest, frame.cursor);
      terminal = terminal || envelope.terminal;
      onFrame(frame);
    },
    { signal, idleTimeoutMs: SEGMENT_IDLE_TIMEOUT_MS }
  );
  return { cursor: latest, terminal, reconnectAfterMs };
}

/**
 * Follow the narrative until terminal, abort, or the caller's ceiling. Returns
 * the final cursor so a later follower can resume where this one stood.
 */
export async function followPodLifecycle(
  options: PodLifecycleFollowerOptions
): Promise<{ cursor: number; terminal: boolean }> {
  const { onFrame, onTransport, signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  let cursor = Math.max(0, options.cursor ?? 0);
  let streamFailures = 0;
  // Native cannot stream, ever (Capacitor buffers whole responses) -- start on
  // the poll and stay there.
  let polling = Capacitor.isNativePlatform();
  onTransport?.(polling ? "poll" : "stream");

  while (!signal?.aborted) {
    if (polling) {
      try {
        const result = await pollOnce(cursor, onFrame);
        cursor = result.cursor;
        if (result.terminal) return { cursor, terminal: true };
      } catch {
        // A failed poll is a skipped beat, not a verdict. Keep the last known
        // state and try again -- the surface's copy never claims failure from
        // transport silence.
      }
      await sleep(pollIntervalMs, signal);
      continue;
    }

    try {
      const segment = await streamSegment(cursor, onFrame, signal);
      cursor = Math.max(cursor, segment.cursor);
      streamFailures = 0;
      if (segment.terminal) return { cursor, terminal: true };
      if (segment.reconnectAfterMs > 0) {
        await sleep(segment.reconnectAfterMs, signal);
      }
      // reconnect immediately at the cursor: segment_end is not an error,
      // not a retry, not a backoff.
    } catch {
      if (signal?.aborted) break;
      streamFailures += 1;
      if (streamFailures >= STREAM_FAILURE_LADDER) {
        // The ladder ends in polling, never in silence. Identical frames, so
        // nothing downstream changes except cadence.
        polling = true;
        onTransport?.("poll");
        continue;
      }
      await sleep(1_000 * streamFailures, signal);
    }
  }
  return { cursor, terminal: false };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
