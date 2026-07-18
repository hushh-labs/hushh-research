import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type RevokeRouteModule = {
  POST: (req: NextRequest) => Promise<Response>;
};

let route: RevokeRouteModule;

beforeEach(async () => {
  vi.restoreAllMocks();
  route = await import("../../../app/api/consent/revoke/route");
});

function createRequest(body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/consent/revoke", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("/api/consent/revoke POST", () => {
  it("requires userId and scope (400)", async () => {
    const res = await route.POST(
      createRequest(
        { userId: "user_123" },
        { "Content-Type": "application/json", Authorization: "Bearer t" },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("requires an Authorization header (401)", async () => {
    const res = await route.POST(
      createRequest(
        { userId: "user_123", scope: "vault.read.email" },
        { "Content-Type": "application/json" },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("forwards Authorization + body to the backend on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "revoked" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await route.POST(
      createRequest(
        { userId: "user_123", scope: "vault.read.email" },
        { "Content-Type": "application/json", Authorization: "Bearer vault_owner" },
      ),
    );

    expect(res.status).toBe(200);
    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://backend.test/api/consent/revoke");
    const headers = options?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer vault_owner");
    expect(JSON.parse(options?.body as string)).toEqual({
      userId: "user_123",
      scope: "vault.read.email",
    });
  });

  it("does NOT leak the backend JSON error body to the client", async () => {
    const sensitiveDetail = "token kid=internal-7 invalid for uid=UWHGeUyf...";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: sensitiveDetail, internal_trace: "stack" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await route.POST(
      createRequest(
        { userId: "user_123", scope: "vault.read.email" },
        { "Content-Type": "application/json", Authorization: "Bearer bad" },
      ),
    );

    expect(res.status).toBe(403);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("Failed to revoke consent");
    expect(JSON.stringify(data)).not.toContain(sensitiveDetail);
    expect(data.internal_trace).toBeUndefined();
  });

  it("does not leak plain-text backend error bodies either", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Traceback: internal-secret-path at db_client.py", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const res = await route.POST(
      createRequest(
        { userId: "user_123", scope: "vault.read.email" },
        { "Content-Type": "application/json", Authorization: "Bearer t" },
      ),
    );

    expect(res.status).toBe(500);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("Failed to revoke consent");
    expect(JSON.stringify(data)).not.toContain("internal-secret-path");
  });
});
