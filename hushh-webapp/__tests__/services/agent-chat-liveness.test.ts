import { afterEach, expect, it, vi } from "vitest";
import { AGENT_CHAT_STREAM_IDLE_MS, createAgentStreamLiveness } from "@/lib/services/agent-chat-liveness";

afterEach(() => vi.useRealTimers());

it("keeps cold admission separate from the enforced stream silence budget", async () => {
  vi.useFakeTimers();
  let admit!: (response: Response) => void;
  const onSilent = vi.fn();
  const onBytes = vi.fn();
  const live = createAgentStreamLiveness(() => new Promise((resolve) => { admit = resolve; }), onSilent, onBytes);
  live.start();
  const pending = live.fetch({});
  await vi.advanceTimersByTimeAsync(114_000); // observed dev cold admission
  expect(onSilent).not.toHaveBeenCalled();
  expect(onBytes).not.toHaveBeenCalled(); // admission is not stream activity
  let push!: (bytes: Uint8Array) => void;
  admit(new Response(new ReadableStream({ start(controller) { push = (bytes) => controller.enqueue(bytes); } })));
  const response = await pending;
  const reader = response.body!.getReader();
  for (let elapsed = 0; elapsed < 180_000; elapsed += 15_000) {
    const read = reader.read();
    push(new TextEncoder().encode(": ping\n\n"));
    await read;
    await vi.advanceTimersByTimeAsync(15_000);
  }
  expect(onBytes).toHaveBeenCalledTimes(13); // headers + actual keep-alive bytes
  expect(onSilent).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(AGENT_CHAT_STREAM_IDLE_MS + 5_000);
  expect(onSilent).toHaveBeenCalledOnce(); // negative control: real silence still fails
  await reader.cancel();
  expect(vi.getTimerCount()).toBe(0);
});

it("settles a cancelled admission and discards its late response", async () => {
  vi.useFakeTimers();
  let admit!: (response: Response) => void;
  const onSilent = vi.fn();
  const onBytes = vi.fn();
  const live = createAgentStreamLiveness(() => new Promise((resolve) => { admit = resolve; }), onSilent, onBytes);
  live.start();
  const pending = live.fetch({});
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  live.stop();
  await failed;
  const cancelled = vi.fn();
  admit(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(AGENT_CHAT_STREAM_IDLE_MS + 5_000);
  expect(onBytes).not.toHaveBeenCalled();
  expect(onSilent).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels the original stream body after headers and rejects callback cancellation", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const caller = new AbortController();
  const live = createAgentStreamLiveness(async () => new Response(new ReadableStream({ cancel: cancelled })), vi.fn());
  live.start();
  const response = await live.fetch({ signal: caller.signal });
  const reader = response.body!.getReader();
  const pending = reader.read();
  caller.abort();
  live.stop();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  expect(vi.getTimerCount()).toBe(0);
  const lateCancelled = vi.fn();
  const stopAtHeaders = createAgentStreamLiveness(
    async () => new Response(new ReadableStream({ cancel: lateCancelled })), vi.fn(), () => stopAtHeaders.stop(),
  );
  stopAtHeaders.start();
  await expect(stopAtHeaders.fetch({})).rejects.toMatchObject({ name: "AbortError" });
  expect(lateCancelled).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});


it.each(["bytes", "depth"])("refuses an excessive %s frame before releasing it and cancels upstream", async (fault) => {
  const { AGENT_EVENT_MAX_BYTES, AGENT_EVENT_MAX_DEPTH, boundedAgentEvents } = await import("@/lib/services/agent-event-boundary");
  const cancel = vi.fn();
  const payload = fault === "bytes" ? "x".repeat(AGENT_EVENT_MAX_BYTES + 1)
    : "[".repeat(AGENT_EVENT_MAX_DEPTH + 1) + "0" + "]".repeat(AGENT_EVENT_MAX_DEPTH + 1);
  const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel });
  const reader = source.pipeThrough(boundedAgentEvents()).getReader();
  await expect(reader.read()).rejects.toThrow(fault === "bytes" ? "AGENT_EVENT_SIZE_EXCEEDED" : "AGENT_EVENT_DEPTH_EXCEEDED");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it("preserves fragmented UTF-8, multiline data, escaped brackets, comments and CRLF frames", async () => {
  const { boundedAgentEvents } = await import("@/lib/services/agent-event-boundary");
  const text = ': ping\r\n\r\ndata: {"text":"é [\\\" ]",\r\ndata: "items":[]}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const response = new Response(source.pipeThrough(boundedAgentEvents()));
  expect(await response.text()).toBe(text.replaceAll("\r\n", "\n"));
});

it("does not release a partial event to the SDK", async () => {
  const { boundedAgentEvents } = await import("@/lib/services/agent-event-boundary");
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(controller) { send = controller; } });
  const reader = source.pipeThrough(boundedAgentEvents()).getReader();
  let settled = false;
  const pending = reader.read().then((result) => { settled = true; return result; });
  send.enqueue(new TextEncoder().encode('data: {"text":"hello"}\n'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  send.enqueue(new TextEncoder().encode('\n'));
  expect((await pending).done).toBe(false);
  await reader.cancel();
});

it.each(["ok", "event-bytes", "event-depth", "event-items", "error-bytes", "error-depth", "error-items", "protocol"])(
  "bounds %s through the installed AG-UI transport before subscriber delivery", async (fault) => {
    const { HttpAgent } = await import("@ag-ui/client");
    const { boundAgentResponse, AGENT_EVENT_MAX_BYTES, AGENT_EVENT_MAX_DEPTH, AGENT_EVENT_MAX_COLLECTION_ENTRIES } = await import("@/lib/services/agent-event-boundary");
    const cancel = vi.fn();
    const event = (type: string) => `data: ${JSON.stringify({ type, threadId: "thread", runId: "run" })}\n\n`;
    const deep = "[".repeat(AGENT_EVENT_MAX_DEPTH + 1) + "0" + "]".repeat(AGENT_EVENT_MAX_DEPTH + 1);
    const payload = fault.includes("bytes") ? "x".repeat(AGENT_EVENT_MAX_BYTES + 1)
      : fault.includes("items") ? JSON.stringify({ type: "MESSAGES_SNAPSHOT", messages: Array(AGENT_EVENT_MAX_COLLECTION_ENTRIES + 1).fill(null) }) : deep;
    const body = fault === "ok" ? event("RUN_STARTED") + event("RUN_FINISHED")
      : fault.startsWith("event") ? `data: ${payload}\n\n` : payload;
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      if (fault === "ok") controller.close();
    }, cancel });
    const started = vi.fn();
    const refused = vi.fn();
    const agent = new HttpAgent({ url: "/fixture", fetch: async () => boundAgentResponse(new Response(source, {
      status: fault.startsWith("error") ? 503 : 200,
      headers: { "content-type": fault === "protocol" ? "application/x-protobuf" : "text/event-stream" },
    })) });
    const result = agent.runAgent({}, { onRunStartedEvent: started, onRunErrorEvent: refused });
    if (fault === "ok") {
      await result;
      expect(started).toHaveBeenCalledOnce();
    } else if (fault.startsWith("event")) {
      await result; // SDK represents RUN_ERROR through its terminal subscriber.
      expect(refused).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({
        type: "RUN_ERROR", code: fault.includes("bytes") ? "AGENT_EVENT_SIZE_EXCEEDED" : fault.includes("items") ? "AGENT_EVENT_COLLECTION_EXCEEDED" : "AGENT_EVENT_DEPTH_EXCEEDED",
      }) }));
      expect(started).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } else {
      await expect(result).rejects.toThrow(fault === "protocol" ? "AGENT_STREAM_PROTOCOL_UNSUPPORTED"
        : fault.includes("bytes") ? "AGENT_EVENT_SIZE_EXCEEDED" : fault.includes("items") ? "AGENT_EVENT_COLLECTION_EXCEEDED" : "AGENT_EVENT_DEPTH_EXCEEDED");
      expect(started).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    }
  },
);
