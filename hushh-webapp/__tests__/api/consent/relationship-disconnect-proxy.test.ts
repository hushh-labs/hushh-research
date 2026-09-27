import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type DisconnectRoute = {
  POST: (request: NextRequest) => Promise<Response>;
};

let route: DisconnectRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  route = await import("../../../app/api/consent/relationships/disconnect/route");
});

describe("/api/consent/relationships/disconnect proxy", () => {
  it("forwards the RIA disconnect with its body and authorization", async () => {
    // The RIA client workspace's Disconnect button posts here. There was no
    // route, so the web app answered 404 and the relationship stayed active.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ relationship_status: "disconnected", revoked_scopes: ["a"] })
    );
    const body = { investor_user_id: "investor-1", ria_profile_id: "ria-1" };
    const request = new NextRequest(
      "http://localhost:3000/api/consent/relationships/disconnect",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer firebase-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const response = await route.POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      relationship_status: "disconnected",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/consent/relationships/disconnect",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer firebase-token");
  });

  it("passes backend refusals through with their status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ detail: "Not your relationship" }, { status: 403 }),
    );
    const request = new NextRequest(
      "http://localhost:3000/api/consent/relationships/disconnect",
      {
        method: "POST",
        headers: { Authorization: "Bearer firebase-token" },
        body: JSON.stringify({ investor_user_id: "x", ria_profile_id: "y" }),
      },
    );

    const response = await route.POST(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ detail: "Not your relationship" });
  });
});
