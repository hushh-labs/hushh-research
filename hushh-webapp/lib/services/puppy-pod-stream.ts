import { Capacitor } from "@capacitor/core";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

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

/** The web request must keep the caller's abort signal after response headers. */
export async function fetchDirectPuppyStream(url: string, init: RequestInit): Promise<Response> {
  return Capacitor.isNativePlatform()
    ? (await import("./native-sse-fetch")).nativeStreamFetch(url, init)
    : fetch(url, init);
}

/** Own the abort listener until the stream reaches a terminal event or fails. */
export async function consumePuppyPodStream(input: {
  signal?: AbortSignal;
  open: (signal: AbortSignal) => Promise<Response | null>;
  onToken: (text: string) => void;
}): Promise<PuppyPodStreamResult> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const deadline = setTimeout(() => controller.abort(
    new DOMException("Puppy stream timed out", "TimeoutError"),
  ), PUPPY_TURN_DEADLINE_MS);
  try {
    const response = await input.open(controller.signal);
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
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
