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
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer firebase-token");
  });

  it("forwards alias list query parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, aliases: [] })
    );
    const request = new NextRequest("http://localhost:3000/api/account/email-aliases?view=all", {
      method: "GET",
      headers: {
        Authorization: "Bearer HCT:test",
      },
    });

    await route.GET(request, {
      params: Promise.resolve({ path: ["email-aliases"] }),
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://backend.test/api/account/email-aliases?view=all"
    );
  });
});
