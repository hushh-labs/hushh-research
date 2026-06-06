import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type AccountCatchAllRoute = {
  GET: (request: NextRequest, props: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  POST: (request: NextRequest, props: { params: Promise<{ path: string[] }> }) => Promise<Response>;
};

let route: AccountCatchAllRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  route = await import("../../app/api/account/[...path]/route");
});

describe("/api/account/[...path] proxy", () => {
  
  it("forwards identity refresh with authorization", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ success: true, user_id: "user_1" })
    );
    const request = new NextRequest("http://localhost:3000/api/account/identity/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer firebase-token", "Content-Type": "application/json" },
    });

    const response = await route.POST(request, { params: Promise.resolve({ path: ["identity", "refresh"] }) });

    expect(response.status).toBe(200);
    const headers = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer firebase-token");
  });

  it("forwards phone claim requests", async () => {
    const body = { phone_id_token: "phone-id-token" };
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ success: true }));

    const request = new NextRequest("http://localhost:3000/api/account/phone/claim", {
      method: "POST",
      body: JSON.stringify(body),
    });

    await route.POST(request, { params: Promise.resolve({ path: ["phone", "claim"] }) });

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/phone/claim"),
      expect.objectContaining({ body: JSON.stringify(body) })
    );
  });

  // --- NEW FEATURES ADDED BELOW ---

  it("returns 502 when the backend request fails (network error)", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Connection timeout"));

    const request = new NextRequest("http://localhost:3000/api/account/status", { method: "GET" });
    const response = await route.GET(request, { params: Promise.resolve({ path: ["status"] }) });

    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  it("preserves Content-Type header when forwarding requests", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ status: "ok" }));

    const request = new NextRequest("http://localhost:3000/api/account/settings", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "key=value",
    });

    await route.POST(request, { params: Promise.resolve({ path: ["settings"] }) });

    const headers = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("forwards session cookies to the backend", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ success: true }));

    const request = new NextRequest("http://localhost:3000/api/account/profile", {
      method: "GET",
      headers: { cookie: "session_id=xyz123" },
    });

    await route.GET(request, { params: Promise.resolve({ path: ["profile"] }) });

    const headers = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("cookie")).toContain("session_id=xyz123");
  });
});