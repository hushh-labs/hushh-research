/**
 * How long a turn's stream may be silent before the turn is treated as lost.
 * The server writes a `: ping` comment every 15 s while a model or tool call is
 * pending (sse-starlette's keep-alive), so this is six missed pings. It is keyed
 * on bytes, never on content: a slow model is not a dead connection.
 */
export const AGENT_CHAT_STREAM_IDLE_MS = 90_000;
const AGENT_CHAT_STREAM_WATCHDOG_TICK_MS = 5_000;

/**
 * Byte-level liveness for One's AG-UI stream. The serving instance can be
 * killed, redeployed or scaled down mid-turn; the stream then either stops
 * sending or closes without RUN_FINISHED / RUN_ERROR, and `@ag-ui/client`
 * completes such a run quietly. `fetch` is the HttpAgent transport with every
 * body chunk noted. `start` begins a run; its watchdog starts only when the
 * response body arrives, after separately bounded pod admission and HTTP work.
 */
export function createAgentStreamLiveness(
  transport: (init: RequestInit | undefined) => Promise<Response>,
  onSilent: () => void,
  onBytes: () => void = () => undefined,
) {
  let lastBytesAtMs = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;
  let active = false;
  let runAbort = new AbortController();
  const touch = () => {
    lastBytesAtMs = Date.now();
  };
  const stop = () => {
    active = false;
    generation += 1;
    runAbort.abort();
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  return {
    fetch: async (init: RequestInit | undefined): Promise<Response> => {
      const run = generation;
      const current = () => active && generation === run && !init?.signal?.aborted;
      if (!current()) throw new DOMException("Agent turn cancelled", "AbortError");
      // Stop this turn promptly without cancelling the shared pod admission.
      // Its late transport result is discarded, never attached to another run.
      const runSignal = runAbort.signal;
      const response = await new Promise<Response>((resolve, reject) => {
        const cancelled = () => {
          runSignal.removeEventListener("abort", cancelled);
          reject(new DOMException("Agent turn cancelled", "AbortError"));
        };
        runSignal.addEventListener("abort", cancelled, { once: true });
        transport(init).then((value) => {
          runSignal.removeEventListener("abort", cancelled);
          if (!current()) {
            void value.body?.cancel().catch(() => undefined);
            cancelled();
          } else resolve(value);
        }, (error) => {
          runSignal.removeEventListener("abort", cancelled);
          reject(error);
        });
      });
      const refuseStaleResponse = () => {
        if (current()) return;
        void response.body?.cancel().catch(() => undefined);
        throw new DOMException("Agent turn cancelled", "AbortError");
      };
      refuseStaleResponse();
      touch();
      onBytes();
      refuseStaleResponse();
      if (!response.ok || !response.body) return response;
      timer = setInterval(() => {
        if (!current() || Date.now() - lastBytesAtMs < AGENT_CHAT_STREAM_IDLE_MS) return;
        stop();
        onSilent();
      }, AGENT_CHAT_STREAM_WATCHDOG_TICK_MS);
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (current()) {
            touch();
            onBytes();
          }
          controller.enqueue(chunk);
        },
      }), { signal: init?.signal ?? undefined });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    start: () => {
      stop();
      runAbort = new AbortController();
      active = true;
      touch();
    },
    stop,
  };
}
