// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.test",
}));

import { NextRequest } from "next/server";

import { GET } from "@/app/api/one/[...path]/route";

/**
 * Live research progress travels as an event-stream through the `/api/one`
 * proxy, the one the research service actually calls. Buffered through
 * `response.json()` it would reach the owner as one late blob at best, and
 * as `{}` with status 200 when the parse fails.
 */
function worldModelRequest(path: string, accept?: string): NextRequest {
  return new NextRequest(`https://app.test/api/one/world-model/${path}`, {
    method: "GET",
    headers: {
      authorization: "Bearer t",
      "x-hussh-chat-key": "hck1.synthetic",
      ...(accept ? { accept } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("/api/one world-model proxy", () => {
  it("pipes the research event-stream through with its content type", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const frames =
      'event: progress\ndata: {"stage":"coverage"}\n\n' +
      'event: result\ndata: {"status":"saved","pkm_written":false}\n\n';
    mocks.fetch.mockResolvedValue(
      new Response(frames, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const response = await GET(
      worldModelRequest("jobs/stream", "text/event-stream") as never,
      { params: Promise.resolve({ path: ["world-model", "jobs", "stream"] }) },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://backend.test/api/one/world-model/jobs/stream");
    expect((options.headers as Headers).get("accept")).toBe("text/event-stream");
    expect((options.headers as Headers).get("authorization")).toBe("Bearer t");
    expect((options.headers as Headers).get("x-hussh-chat-key")).toBe(
      "hck1.synthetic",
    );
    // A stream outlives the ordinary request deadline.
    expect(timeoutSpy).toHaveBeenCalledWith(285_000);
    // Every byte arrives as sent: nothing parsed, nothing dropped.
    await expect(response.text()).resolves.toBe(frames);
  });

  it("still buffers the plain status read exactly as before", async () => {
    const usage = JSON.stringify({ model_calls: 2, input_tokens: 120, output_tokens: 35 });
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "pending", pkm_written: false }), {
        status: 200,
        headers: { "content-type": "application/json", "x-hussh-pwm-usage": usage },
      }),
    );
    const response = await GET(worldModelRequest("jobs") as never, {
      params: Promise.resolve({ path: ["world-model", "jobs"] }),
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-hussh-pwm-usage")).toBe(usage);
    await expect(response.json()).resolves.toEqual({
      status: "pending",
      pkm_written: false,
    });
  });
});
