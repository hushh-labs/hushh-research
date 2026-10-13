import { isKaiStreamEnvelope, type KaiStreamEnvelope } from "./kai-stream-types";
import { parseSSEBlocks } from "./sse-parser";

interface ConsumeOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  requireTerminal?: boolean;
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function readNextChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: {
    signal?: AbortSignal;
    idleTimeoutMs: number;
  }
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const { signal, idleTimeoutMs } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const settleResolve = (value: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      void reader.cancel().catch(() => undefined);
      settleReject(createAbortError());
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      settleReject(new Error("Stream timeout - no data received"));
    }, idleTimeoutMs);

    reader.read().then(settleResolve, settleReject);
  });
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
  let sawTerminal = false;

  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const { done, value } = await readNextChunkWithIdleTimeout(reader, {
      signal: options.signal,
      idleTimeoutMs,
    });
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    const parsed = parseSSEBlocks(chunk, buffer);
    buffer = parsed.remainder;

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
