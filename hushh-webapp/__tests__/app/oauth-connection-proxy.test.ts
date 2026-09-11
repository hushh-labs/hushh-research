import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({ getDeveloperApiUrl: () => "https://backend.example.test" }));
import { DELETE, GET } from "@/app/api/oauth/[...path]/route";

const ref = "oar_0123456789abcdef0123456789abcdef";
afterEach(() => vi.unstubAllGlobals());

describe("owner OAuth connection proxy", () => {
  it("forwards authenticated review requests without caching", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ client_name: "Assistant" })));
    vi.stubGlobal("fetch", upstream);
    const response = await GET(new NextRequest(`https://one.example.test/api/oauth/authorize/${ref}`, {
      headers: { Authorization: "Bearer synthetic-owner-session" },
    }), { params: Promise.resolve({ path: ["authorize", ref] }) });
    expect(upstream).toHaveBeenCalledWith(`https://backend.example.test/oauth/authorize/${ref}`, expect.objectContaining({
      method: "GET", cache: "no-store", body: undefined,
    }));
    expect(new Headers(upstream.mock.calls[0][1].headers).get("authorization")).toBe("Bearer synthetic-owner-session");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves an empty disconnect response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const response = await DELETE(new NextRequest(`https://one.example.test/api/oauth/connections/${ref}`, {
      method: "DELETE", headers: { Authorization: "Bearer synthetic-owner-session" },
    }), { params: Promise.resolve({ path: ["connections", ref] }) });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("refuses undeclared read and delete paths before any upstream request", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const method of [GET, DELETE]) {
      const response = await method(new NextRequest("https://one.example.test/api/oauth/unknown"), {
        params: Promise.resolve({ path: ["..", "account"] }),
      });
      expect(response.status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
