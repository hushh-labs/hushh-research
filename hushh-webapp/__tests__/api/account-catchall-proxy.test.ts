import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type AccountCatchAllRoute = {
  GET: (
    request: NextRequest,
    props: { params: Promise<{ path: string[] }> }
  ) => Promise<Response>;
  POST: (
    request: NextRequest,
    props: { params: Promise<{ path: string[] }> }
  ) => Promise<Response>;
};

let route: AccountCatchAllRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  route = await import("../../app/api/account/[...path]/route");
});

/**
 * Reusable request builder to centralize boilerplate configurations
 */
function createMockRequest(
  url: string,
  options: { method: "GET" | "POST"; headers?: Record<string, string>; body?: any }
) {
  return new NextRequest(url, {
    method: options.method,
    headers: {
      Authorization: "Bearer firebase-token",
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe("/api/account/[...path] proxy", () => {
  it("forwards identity refresh with authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, user_id: "user_1" })
    );

    const request = createMockRequest("http://localhost:3000/api/account/identity/refresh", { method: "POST" });

    const response = await route.POST(request, {
      params: Promise.resolve({ path: ["identity", "refresh"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/account/identity/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      })
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer firebase-token");
  });

  it("forwards phone claim requests through the account proxy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, phone_verified: true })
    );
    const body = { phone_id_token: "phone-id-token" };
    const request = createMockRequest("http://localhost:3000/api/account/phone/claim", { method: "POST", body });

    const response = await route.POST(request, {
      params: Promise.resolve({ path: ["phone", "claim"] }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/account/phone/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  });

  it("forwards alias list query parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, aliases: [] })
    );
    const request = createMockRequest("http://localhost:3000/api/account/email-aliases?view=all", {
      method: "GET",
      headers: { Authorization: "Bearer HCT:test" },
    });

    await route.GET(request, {
      params: Promise.resolve({ path: ["email-aliases"] }),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://backend.test/api/account/email-aliases?view=all"
    );
  });

  it("preserves forwarded account proxy query parameter ordering", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, aliases: [] })
    );

    const request = createMockRequest(
      "http://localhost:3000/api/account/email-aliases?view=all&sort=desc&limit=10",
      {
        method: "GET",
        headers: { Authorization: "Bearer HCT:test" },
      }
    );

    await route.GET(request, {
      params: Promise.resolve({ path: ["email-aliases"] }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const forwardedUrl = fetchMock.mock.calls[0]?.[0];

    expect(String(forwardedUrl)).toBe(
      "http://backend.test/api/account/email-aliases?view=all&sort=desc&limit=10"
    );
  });

  // --- NEW STABILITY & PROXY EXCEPTION FEATURES ---

  it("propagates HTTP error response statuses and bodies downstream directly from backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Malformed authentication token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const request = createMockRequest("http://localhost:3000/api/account/identity/refresh", { method: "POST" });
    const response = await route.POST(request, {
      params: Promise.resolve({ path: ["identity", "refresh"] }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "Malformed authentication token" });
  });

  it("gracefully catches unhandled downstream runtime exceptions and maps to 502 Bad Gateway", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Downstream socket disconnected abruptly"));

    const request = createMockRequest("http://localhost:3000/api/account/identity/refresh", { method: "POST" });
    const response = await route.POST(request, {
      params: Promise.resolve({ path: ["identity", "refresh"] }),
    });

    expect(response.status).toBe(502);
  });
});
