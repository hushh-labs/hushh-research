// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.test",
}));

import { NextRequest } from "next/server";

import { POST } from "@/app/api/one/[...path]/route";

/**
 * The `/api/one` proxy buffers every response through `response.json()`.
 *
 * For an event-stream that is silent data loss: the parse fails, the `.catch`
 * turns it into `{}`, and the browser gets an empty object with status 200 --
 * no frames and no error. That is exactly how "Places near you" showed an empty
 * list on UAT while the backend was returning 23 KB of places. These pin the
 * passthrough, and pin that ordinary JSON routes still buffer as before.
 */

function nextRequest(body: string): NextRequest {
  return new NextRequest("https://app.test/api/one/places/stream", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body,
  });
}

function agentChatRequest(body: string): NextRequest {
  return new NextRequest("https://app.test/api/one/agent-chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer t",
      accept: "text/event-stream",
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("/api/one proxy", () => {
  it("passes an event-stream through instead of parsing it as JSON", async () => {
    const frames = 'event: results\ndata: {"event":"results","category":"hotels_stays","items":[]}\n\n';
    mocks.fetch.mockResolvedValue(
      new Response(frames, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const response = await POST(
      nextRequest(JSON.stringify({ lat: 1, lng: 2, categories: ["hotels_stays"] })) as never,
      { params: Promise.resolve({ path: ["places", "stream"] }) },
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    // The bytes must survive intact — this is what was being dropped.
    await expect(response.text()).resolves.toContain("hotels_stays");
  });

  it("keeps the agent-chat stream alive until the browser disconnects", async () => {
    mocks.fetch.mockResolvedValue(
      new Response('event: RUN_FINISHED\ndata: {}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const request = agentChatRequest(JSON.stringify({ run: "chat" }));

    await POST(request as never, {
      params: Promise.resolve({ path: ["agent-chat"] }),
    });

    const [, options] = mocks.fetch.mock.calls[0] ?? [];
    expect(options?.signal).toBe(request.signal);
  });

  it("still buffers an ordinary JSON route exactly as before", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [1, 2] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(
      nextRequest(JSON.stringify({ q: "x" })) as never,
      { params: Promise.resolve({ path: ["advisors", "search"] }) },
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ items: [1, 2] });
  });
});
