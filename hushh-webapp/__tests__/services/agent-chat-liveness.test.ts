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
  caller.abort();
  live.stop();
  await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
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
