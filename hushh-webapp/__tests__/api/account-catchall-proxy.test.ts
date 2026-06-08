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

describe("/api/account/[...path] proxy", () => {
  // --- Existing Functionality ---

  it("forwards identity refresh with authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, user_id: "user_1" })
    );
    const request = new NextRequest("http://localhost:3000/api/account/identity/refresh", {
      method: "POST",
      headers: {
        Authorization: "Bearer firebase-token",
        "Content-Type": "application/json",
      },
    });

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
  });

  it("preserves forwarded account proxy query parameter ordering", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, aliases: [] })
    );

    const request = new NextRequest(
      "http://localhost:3000/api/account/email-aliases?view=all&sort=desc&limit=10",
      { method: "GET", headers: { Authorization: "Bearer HCT:test" } }
    );

    await route.GET(request, {
      params: Promise.resolve({ path: ["email-aliases"] }),
    });

    const forwardedUrl = fetchMock.mock.calls[0]?.[0];
    expect(String(forwardedUrl)).toBe(
      "http://backend.test/api/account/email-aliases?view=all&sort=desc&limit=10"
    );
  });

  // --- New Features & Robustness Tests ---

  it("handles backend 500 errors gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 })
    );

    const request = new NextRequest("http://localhost:3000/api/account/test", {
      method: "GET",
      headers: { Authorization: "Bearer token" },
    });

    const response = await route.GET(request, {
      params: Promise.resolve({ path: ["test"] }),
    });

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Internal Server Error");
  });

  it("returns 401 when Authorization header is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const headers = init?.headers as Headers;
      if (!headers || !headers.get("Authorization")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      return Response.json({ success: true });
    });

    const request = new NextRequest("http://localhost:3000/api/account/profile", {
      method: "GET",
    });

    const response = await route.GET(request, {
      params: Promise.resolve({ path: ["profile"] }),
    });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("handles network failures during fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    const request = new NextRequest("http://localhost:3000/api/account/test", {
      method: "GET",
    });

    const response = await route.GET(request, {
      params: Promise.resolve({ path: ["test"] }),
    });

    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toBe("Account API unavailable");
  });
});
