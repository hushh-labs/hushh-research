import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type KaiRouteModule = {
  GET: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  POST: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  DELETE: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
};

let kaiRoute: KaiRouteModule;

beforeEach(async () => {
  vi.restoreAllMocks();
  kaiRoute = await import("../../../app/api/kai/[...path]/route");
});

function createRequest(url: string, init: RequestInit): NextRequest {
  return new NextRequest(url, init);
}

describe("/api/kai/[...path] proxy", () => {
  it("forwards Authorization header for JSON POST routes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createRequest("http://localhost:3000/api/kai/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault_owner_token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: "user_123", message: "hello" }),
    });

    const res = await kaiRoute.POST(req, {
      params: Promise.resolve({ path: ["chat"] }),
    });

    expect(res.status).toBe(200);

    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://backend.test/api/kai/chat");

    const headers = options?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer vault_owner_token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("forwards Authorization for import multipart path without overriding multipart content-type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const formData = new FormData();
    formData.set("user_id", "user_123");
    formData.set("file", new Blob(["symbol,qty\nAAPL,1\n"], { type: "text/csv" }), "statement.csv");

    const req = createRequest("http://localhost:3000/api/kai/portfolio/import", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault_owner_token",
        "Content-Type": "multipart/form-data; boundary=testboundary",
      },
      body: "--testboundary--",
    });
    vi.spyOn(req, "formData").mockResolvedValue(formData);

    const res = await kaiRoute.POST(req, {
      params: Promise.resolve({ path: ["portfolio", "import"] }),
    });

    expect(res.status).toBe(200);

    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://backend.test/api/kai/portfolio/import");

    const headers = options?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer vault_owner_token");
    expect(headers.get("Content-Type")).toBeNull();
    expect(options?.body).toBeInstanceOf(FormData);
  });

  it("passes through SSE stream headers and forwards Authorization on stream path", async () => {
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ping\\ndata: {}\\n\\n"));
        controller.close();
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const req = createRequest(
      "http://localhost:3000/api/kai/analyze/stream?ticker=AAPL&user_id=user_123",
      {
        method: "GET",
        headers: { Authorization: "Bearer vault_owner_token" },
      }
    );

    const res = await kaiRoute.GET(req, {
      params: Promise.resolve({ path: ["analyze", "stream"] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");

    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://backend.test/api/kai/analyze/stream?ticker=AAPL&user_id=user_123");
    const headers = options?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer vault_owner_token");
  });

  it("does not bypass missing auth in production-sensitive flows and preserves backend 401", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Missing Authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createRequest("http://localhost:3000/api/kai/portfolio/import/stream", {
      method: "POST",
      body: JSON.stringify({ user_id: "user_123" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await kaiRoute.POST(req, {
      params: Promise.resolve({ path: ["portfolio", "import", "stream"] }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ detail: "Missing Authorization header" });

    const [, options] = fetchSpy.mock.calls[0] ?? [];
    const headers = options?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("passes through binary /voice/tts responses and preserves voice headers", async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(audioBytes, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Kai-TTS-Model": "gpt-4o-mini-tts",
          "X-Kai-TTS-Voice": "alloy",
          "X-Kai-TTS-Format": "mp3",
          "X-Kai-TTS-Audio-Bytes": "4",
        },
      })
    );

    const req = createRequest("http://localhost:3000/api/kai/voice/tts", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault_owner_token",
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "X-Voice-Turn-Id": "vturn_proxy_tts_1",
      },
      body: JSON.stringify({ user_id: "user_123", text: "hello" }),
    });

    const res = await kaiRoute.POST(req, {
      params: Promise.resolve({ path: ["voice", "tts"] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-Kai-TTS-Model")).toBe("gpt-4o-mini-tts");
    expect(res.headers.get("X-Kai-TTS-Voice")).toBe("alloy");
    expect(res.headers.get("X-Kai-TTS-Format")).toBe("mp3");
    expect(res.headers.get("X-Kai-TTS-Audio-Bytes")).toBe("4");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3, 4]);

    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://backend.test/api/kai/voice/tts");
    const headers = options?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer vault_owner_token");
    expect(headers.get("Accept")).toBe("audio/mpeg");
    expect(headers.get("X-Voice-Turn-Id")).toBe("vturn_proxy_tts_1");
  });
});
