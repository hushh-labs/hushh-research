import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type SessionTokenRouteModule = {
  POST: (req: NextRequest) => Promise<Response>;
};

let route: SessionTokenRouteModule;

beforeEach(async () => {
  vi.restoreAllMocks();
  route = await import("../../../app/api/consent/session-token/route");
});

function createRequest(body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/consent/session-token", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("/api/consent/session-token POST", () => {
  it("requires an Authorization header (401)", async () => {
    const res = await route.POST(
      createRequest({ userId: "user_123" }, { "Content-Type": "application/json" }),
    );
    expect(res.status).toBe(401);
  });

  it("requires userId (400)", async () => {
    const res = await route.POST(
      createRequest(
        {},
        { "Content-Type": "application/json", Authorization: "Bearer firebase_id_token" },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("forwards the Authorization header to the backend on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "HCT:abc", expiresAt: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await route.POST(
      createRequest(
        { userId: "user_123" },
        { "Content-Type": "application/json", Authorization: "Bearer firebase_id_token" },
      ),
    );

    expect(res.status).toBe(200);
    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://backend.test/api/consent/issue-token");
    const headers = options?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer firebase_id_token");
  });

  it("does NOT leak the backend error body to the client (opaque trust-boundary error)", async () => {
    // Backend returns a detailed internal error; the proxy must not forward it.
    const sensitiveDetail =
      "token signature mismatch for uid=UWHGeUyf... using key kid=internal-signing-7";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: sensitiveDetail, internal_trace: "stack..." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await route.POST(
      createRequest(
        { userId: "user_123" },
        { "Content-Type": "application/json", Authorization: "Bearer bad_token" },
      ),
    );

    expect(res.status).toBe(401);
    const data = (await res.json()) as Record<string, unknown>;
    // Strengthened behavior: opaque message, no upstream payload pass-through.
    expect(data.error).toBe("Failed to issue session token");
    expect(JSON.stringify(data)).not.toContain(sensitiveDetail);
    expect(data.internal_trace).toBeUndefined();
  });

  it("does not leak plain-text backend error bodies either", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Traceback (most recent call last): internal-secret-path", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const res = await route.POST(
      createRequest(
        { userId: "user_123" },
        { "Content-Type": "application/json", Authorization: "Bearer some_token" },
      ),
    );

    expect(res.status).toBe(500);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("Failed to issue session token");
    expect(JSON.stringify(data)).not.toContain("internal-secret-path");
  });
});
