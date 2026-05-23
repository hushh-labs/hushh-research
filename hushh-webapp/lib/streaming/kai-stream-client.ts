import { isKaiStreamEnvelope, type KaiStreamEnvelope } from "./kai-stream-types";
import { parseSSEBlocks } from "./sse-parser";

/**
 * Maximum number of SSE frames accepted per stream connection (CWE-400).
 * Prevents a runaway stream from consuming unbounded memory across the
 * lifetime of a single connection.
 */
export const MAX_FRAMES_PER_STREAM = 10_000;

interface ConsumeOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  requireTerminal?: boolean;
}

export async function consumeCanonicalKaiStream(
  response: Response,
  onEnvelope: (envelope: KaiStreamEnvelope) => void,
  options: ConsumeOptions = {}
): Promise<void> {
  if (!response.ok) {
    throw new Error(`Stream response not OK: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response stream available");
  }

  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? 120000;
  let buffer = "";
  let lastActivity = Date.now();
  let sawTerminal = false;
  let totalFrames = 0;

  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (Date.now() - lastActivity > idleTimeoutMs) {
      reader.cancel();
      throw new Error("Stream timeout - no data received");
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    lastActivity = Date.now();
    const chunk = decoder.decode(value, { stream: true });
    const parsed = parseSSEBlocks(chunk, buffer);
    buffer = parsed.remainder;

    totalFrames += parsed.events.length;
    if (totalFrames > MAX_FRAMES_PER_STREAM) {
      reader.cancel();
      throw new Error(
        `Stream exceeded maximum frame count of ${MAX_FRAMES_PER_STREAM}`
      );
    }

    for (const frame of parsed.events) {
      const raw = JSON.parse(frame.data) as unknown;
      if (!isKaiStreamEnvelope(raw)) {
        throw new Error("Invalid stream envelope received");
      }
      if (raw.event !== frame.event) {
        throw new Error("SSE event mismatch between frame and envelope");
      }
      onEnvelope(raw);
      if (raw.terminal) {
        sawTerminal = true;
      }
    }
  }

  if (buffer.trim()) {
    const parsed = parseSSEBlocks("\n\n", buffer);
    totalFrames += parsed.events.length;
    if (totalFrames > MAX_FRAMES_PER_STREAM) {
      throw new Error(
        `Stream exceeded maximum frame count of ${MAX_FRAMES_PER_STREAM}`
      );
    }
    for (const frame of parsed.events) {
      const raw = JSON.parse(frame.data) as unknown;
      if (!isKaiStreamEnvelope(raw)) {
        throw new Error("Invalid stream envelope received");
      }
      if (raw.event !== frame.event) {
        throw new Error("SSE event mismatch between frame and envelope");
      }
      onEnvelope(raw);
      if (raw.terminal) {
        sawTerminal = true;
      }
    }
  }

  if ((options.requireTerminal ?? true) && !sawTerminal) {
    throw new Error("Stream ended without terminal event");
  }
}
