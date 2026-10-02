import { Capacitor } from "@capacitor/core";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import { getOrCreateRequestId } from "@/lib/observability/request-id";

/** Total Puppy turn budget, including cold pod admission and its streamed body. */
export const PUPPY_TURN_DEADLINE_MS = 205_000;

export type PuppyPodStreamResult = {
  model: string;
  modelReported: boolean;
  provider: string;
  grounded: boolean;
  runtimeMode: string;
  degraded?: string;
};

export type PuppyPodTurnInput = {
  hushhId: string;
  vaultOwnerToken?: string;
  message: string;
  conversationId: string;
  puppyDeviceId: string;
  puppyModel?: string;
  puppyCatalogVersion?: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  onToken: (text: string) => void;
};

/** One request identity ties the admitted stream to its explicit stop. */
export function streamDirectPuppyTurn(input: PuppyPodTurnInput, transport: {
  open: (body: string, signal: AbortSignal, requestId: string, dispatched: () => void) => Promise<Response | null>;
  stop: (requestId: string) => Promise<boolean>;
}): Promise<PuppyPodStreamResult> {
  const requestId = getOrCreateRequestId(null);
  let dispatched = false;
  return consumePuppyPodStream({
    signal: input.signal,
    onToken: input.onToken,
    cancel: () => dispatched ? transport.stop(requestId) : Promise.resolve(true),
    open: (signal) => transport.open(JSON.stringify({
      message: input.message, conversationId: input.conversationId,
      runtimeProvider: "puppy", puppyDeviceId: input.puppyDeviceId,
      puppyModel: input.puppyModel, puppyCatalogVersion: input.puppyCatalogVersion,
      history: input.history,
    }), signal, requestId, () => { dispatched = true; }),
  });
}

/** The web request must keep the caller's abort signal after response headers. */
export async function fetchDirectPuppyStream(url: string, init: RequestInit): Promise<Response> {
  return Capacitor.isNativePlatform()
    ? (await import("./native-sse-fetch")).nativeStreamFetch(url, init)
    : fetch(url, init);
}

/** Admission may outlive an HTTP abort; its losing continuation must not dispatch. */
async function openWhileActive(open: (signal: AbortSignal) => Promise<Response | null>, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([open(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Own the abort listener until the stream reaches a terminal event or fails. */
export async function consumePuppyPodStream(input: {
  signal?: AbortSignal;
  open: (signal: AbortSignal) => Promise<Response | null>;
  onToken: (text: string) => void;
  cancel?: () => Promise<boolean>;
}): Promise<PuppyPodStreamResult> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const deadline = setTimeout(() => controller.abort(
    new DOMException("Puppy stream timed out", "TimeoutError"),
  ), PUPPY_TURN_DEADLINE_MS);
  try {
    const response = await openWhileActive(input.open, controller.signal);
    if (!response?.body) throw new Error("PUPPY_DIRECT_BYOC_REQUIRED");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = "";
    let totalText = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), remainder);
        remainder = parsed.remainder;
        if (remainder.length > 131_072) throw new Error("PUPPY_STREAM_INVALID");
        for (const event of parsed.events) {
          if (event.event === "token") {
            const token = JSON.parse(event.data) as { text?: unknown };
            if (typeof token.text !== "string") throw new Error("PUPPY_STREAM_INVALID");
            totalText += token.text.length;
            if (totalText > 262_144) throw new Error("PUPPY_STREAM_TOO_LARGE");
            input.onToken(token.text);
          } else if (event.event === "error") {
            const failure = JSON.parse(event.data) as { code?: unknown };
            throw new Error(typeof failure.code === "string" ? failure.code : "PUPPY_STREAM_FAILED");
          } else if (event.event === "done") {
            const result = JSON.parse(event.data) as Record<string, unknown>;
            if (typeof result.model !== "string" || typeof result.modelReported !== "boolean")
              throw new Error("PUPPY_STREAM_INVALID");
            return {
              model: result.model,
              modelReported: result.modelReported,
              provider: String(result.provider ?? "puppy"),
              grounded: result.grounded === true,
              runtimeMode: String(result.runtimeMode ?? "puppy_relay"),
              ...(typeof result.degraded === "string" ? { degraded: result.degraded } : {}),
            };
          }
        }
      }
      throw new Error("PUPPY_STREAM_INTERRUPTED");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted && input.cancel) {
      // HTTP edges may retain the upstream request after browser abort.
      // A local reader stop alone cannot advertise authoritative cancellation.
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        input.cancel().catch(() => false),
        new Promise<boolean>((resolve) => { stopTimer = setTimeout(() => resolve(false), 12_000); }),
      ]).finally(() => clearTimeout(stopTimer));
      if (!stopped) throw new Error("PUPPY_CANCEL_UNCONFIRMED");
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
