import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/hermes/bridge-config", () => ({
  resolveHermesBridgeConfig: () => ({ baseUrl: "http://127.0.0.1:8642", apiKey: "synthetic-loopback-key" }),
}));
import { POST } from "@/app/api/hermes/chat/stream/route";
import { readNativeAdkTurn } from "@/lib/a2ui/native-adk-visual-stream";

afterEach(() => vi.unstubAllGlobals());

describe("local Puppy stream lifetime", () => {
  it("emits native text and bounded activity, without sending upstream tool details", async () => {
    const upstream = [
      'event: tool.started\r\ndata: {"tool_name":"read_files","arguments":"private-arguments"}\r\n\r\n',
      'event: tool.progress\r\ndata: {"delta":"private-progress"}\r\n\r\n',
      'event: assistant.delta\r\ndata: {"delta":"Native answer"}\r\n\r\n',
      "event: done\r\ndata: {}\r\n\r\n",
    ].join("");
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(upstream));
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(new NextRequest("http://localhost/api/hermes/chat/stream", {
      method: "POST",
      body: JSON.stringify({ sessionId: "synthetic-session", message: "Synthetic turn", onDevice: true }),
    }));
    const raw = response.clone().text();
    const turn = await readNativeAdkTurn(response, () => undefined);
    expect(turn).toMatchObject({
      sessionId: "synthetic-session", activity: ["read_files"], settledText: "Native answer", status: "complete",
    });
    expect(await raw).not.toMatch(/RUN_|private-arguments|private-progress|synthetic-loopback-key/);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      message: "Synthetic turn", provider: "lmstudio",
    });
  });

  it("reports incomplete upstream output as a failure with no fabricated completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'event: assistant.delta\ndata: {"delta":"Interrupted answer"}\n\n',
    )));
    const response = await POST(new NextRequest("http://localhost/api/hermes/chat/stream", {
      method: "POST",
      body: JSON.stringify({ sessionId: "synthetic-session", message: "Synthetic turn" }),
    }));
    expect(await readNativeAdkTurn(response, () => undefined)).toMatchObject({
      partialText: "Interrupted answer", status: "error", errorCode: "AGENT_ERROR",
    });
  });

  it("does not create a session or turn after preparation was cancelled", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const owner = new AbortController();
    owner.abort();
    const response = await POST(new NextRequest("http://localhost/api/hermes/chat/stream", {
      method: "POST", signal: owner.signal, body: JSON.stringify({ message: "Synthetic turn" }),
    }));
    expect(await response.text()).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["request", "reader"])("interrupts the same upstream stream on %s cancellation without another turn", async mode => {
    let signal: AbortSignal | undefined;
    const cancelled = vi.fn();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
        cancel: cancelled,
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    const owner = new AbortController();
    const response = await POST(new NextRequest("http://localhost/api/hermes/chat/stream", {
      method: "POST", signal: owner.signal,
      body: JSON.stringify({ sessionId: "synthetic-session", message: "Synthetic turn", onDevice: true }),
    }));
    const reader = response.body!.getReader();
    await reader.read(); // admission frame; the upstream is now waiting for text.
    expect(signal?.aborted).toBe(false);
    if (mode === "request") owner.abort();
    else await reader.cancel();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0]).endsWith("/synthetic-session/chat/stream")).toBe(true);
  });
});
