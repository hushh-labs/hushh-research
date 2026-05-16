import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("GET /api/vault/check database unavailable", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_ENV = "development";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("preserves upstream database-unavailable metadata", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "Database is temporarily unavailable.",
          code: "DATABASE_UNAVAILABLE",
          hint: "Start the local backend with the proxy-aware launcher.",
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        }
      )
    ) as typeof fetch;

    const route = await import("../../app/api/vault/check/route");
    const request = new NextRequest("http://localhost:3000/api/vault/check?userId=test-user");
    const response = await route.GET(request);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.code).toBe("DATABASE_UNAVAILABLE");
    expect(payload.hint).toContain("proxy-aware launcher");
  });
});
