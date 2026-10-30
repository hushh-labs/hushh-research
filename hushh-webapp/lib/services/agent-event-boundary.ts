/** Bound each SSE event before the AG-UI SDK can parse or validate its payload. */
export const AGENT_EVENT_MAX_BYTES = 1024 * 1024;
export const AGENT_EVENT_MAX_DEPTH = 64;
export const AGENT_EVENT_MAX_COLLECTION_ENTRIES = 4096;
export const AGENT_RESPONSE_REFUSAL_MESSAGE =
  "The response could not be displayed safely. Reconnect to check the task's outcome.";

function validateFrame(frame: Uint8Array) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  const data = text.split("\n").filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  jsonBudget()(data);
}

function jsonBudget() {
  let depth = 0;
  let entries = 0;
  let quoted = false;
  let escaped = false;
  return (data: string) => { for (const character of data) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    // Bound issue amplification in constrained Zod collections, even when a
    // flat array is far smaller than the byte/depth budgets. Count structural
    // entries across the whole frame before invoking SDK schema validation.
    if (character === "," || character === ":" || character === "[" || character === "{") {
      if (++entries > AGENT_EVENT_MAX_COLLECTION_ENTRIES) throw new Error("AGENT_EVENT_COLLECTION_EXCEEDED");
    }
    if (character === "{" || character === "[") {
      if (++depth > AGENT_EVENT_MAX_DEPTH) throw new Error("AGENT_EVENT_DEPTH_EXCEEDED");
    } else if (character === "}" || character === "]") depth -= 1;
  } };
}

export function boundedAgentEvents() {
  let bytes: number[] = [];
  let lineLength = 0;
  let skipLf = false;
  const emit = (controller: TransformStreamDefaultController<Uint8Array>) => {
    const frame = Uint8Array.from(bytes);
    validateFrame(frame);
    controller.enqueue(frame);
    bytes = [];
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Normalize SSE line endings, including CRLF split between chunks. Never
      // release an unvalidated prefix of a frame to downstream JSON/Zod code.
      for (const original of chunk) {
        if (skipLf && original === 10) { skipLf = false; continue; }
        skipLf = original === 13;
        const byte = skipLf ? 10 : original;
        if (bytes.length >= AGENT_EVENT_MAX_BYTES) throw new Error("AGENT_EVENT_SIZE_EXCEEDED");
        bytes.push(byte);
        if (byte === 10) {
          if (lineLength === 0) emit(controller);
          lineLength = 0;
        } else lineLength += 1;
      }
    },
    flush(controller) { if (bytes.length) emit(controller); },
  });
}

export function boundAgentResponse(response: Response): Response {
  if (!response.body) return response;
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (response.ok && type && type !== "text/event-stream") {
    void response.body.cancel().catch(() => undefined);
    throw new Error("AGENT_STREAM_PROTOCOL_UNSUPPORTED");
  }
  // The SDK also parses non-2xx response bodies. Validate the complete bounded
  // error before releasing any prefix to its JSON parser or error subscriber.
  let errorBytes: number[] = [];
  const errorDecoder = new TextDecoder("utf-8", { fatal: true });
  const errorBudget = jsonBudget();
  const errorBoundary = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk) {
      if (errorBytes.length + chunk.length > AGENT_EVENT_MAX_BYTES) {
        throw new Error("AGENT_EVENT_SIZE_EXCEEDED");
      }
      errorBudget(errorDecoder.decode(chunk, { stream: true }));
      for (const byte of chunk) errorBytes.push(byte);
    },
    flush(controller) {
      const bytes = Uint8Array.from(errorBytes);
      errorBudget(errorDecoder.decode());
      errorBytes = [];
      controller.enqueue(bytes);
    },
  });
  const checked = response.body.pipeThrough(response.ok ? boundedAgentEvents() : errorBoundary);
  // AG-UI rethrows cancellation of an errored SSE reader from an unobserved
  // promise. Deliver a small terminal refusal event, never the unsafe payload,
  // and close cleanly so its ordinary RUN_ERROR path handles the refusal.
  const reader = response.ok ? checked.getReader() : null;
  const safe = reader ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          controller.error(error);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          return;
        }
        const code = error instanceof Error && /^AGENT_EVENT_(SIZE|DEPTH|COLLECTION)_EXCEEDED$/.test(error.message)
          ? error.message : "AGENT_STREAM_INVALID";
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "RUN_ERROR", code, message: AGENT_RESPONSE_REFUSAL_MESSAGE })}\n\n`));
        controller.close();
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }) : checked;
  return new Response(safe, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}
