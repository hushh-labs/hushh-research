import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import { ConnectionsService } from "@/lib/services/connections-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConnectionsService", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("searchDirectory hits the directory endpoint with query + auth", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({ items: [{ userId: "u2", displayName: "Bo", photoUrl: null, email: null, relationship: "none" }], page: 1, hasMore: false }),
    );
    const out = await ConnectionsService.searchDirectory({ idToken: "tok", query: "bo", page: 1 });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toContain("/api/one/connections/directory");
    expect(path).toContain("query=bo");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(out.items[0].userId).toBe("u2");
  });

  it("sendRequest POSTs the addressee id", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ request: { id: "r1" } }));
    await ConnectionsService.sendRequest({ idToken: "tok", addresseeUserId: "u2" });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/one/connections/requests");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ addressee_user_id: "u2", message: undefined });
  });

  it("accept POSTs to the accept endpoint", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ result: { status: "accepted" } }));
    await ConnectionsService.accept({ idToken: "tok", requestId: "r1" });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/one/connections/requests/r1/accept");
    expect(opts.method).toBe("POST");
  });

  it("linkCircleInvite POSTs the peer id", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ result: { status: "connected" } }));
    await ConnectionsService.linkCircleInvite({ idToken: "tok", peerUserId: "u2" });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/one/connections/link-circle-invite");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(opts.body as string)).toEqual({ peer_user_id: "u2" });
  });

  it("preserves Circle provenance returned by the connection list", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        items: [
          {
            connectionId: "c1",
            userId: "u2",
            displayName: "Bo",
            photoUrl: null,
            createdAt: "2026-07-24T00:00:00Z",
            connectionKind: "circle",
            circleIds: ["circle-1"],
            circleNames: ["Family"],
            canRemoveDirect: false,
          },
        ],
      }),
    );

    const items = await ConnectionsService.listConnections({ idToken: "tok" });

    expect(items[0]).toMatchObject({
      connectionKind: "circle",
      circleNames: ["Family"],
      canRemoveDirect: false,
    });
  });

  it("prefers canonical Circle objects after direct removal", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        result: {
          removed: 1,
          stillConnected: true,
          connectionKind: "circle",
          circles: [{ id: "circle-1", name: "Family" }],
          circleIds: ["stale-circle"],
          circleNames: ["Stale name"],
          canRemoveDirect: false,
        },
      }),
    );

    const result = await ConnectionsService.removeConnection({
      idToken: "tok",
      connectionId: "connection-1",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/one/connections/connection-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result.stillConnected).toBe(true);
    expect(result.circleNames).toEqual(["Family"]);
    expect(result.circleIds).toEqual(["circle-1"]);
    expect(result.circles).toEqual([{ id: "circle-1", name: "Family" }]);
  });

  it("falls back to legacy parallel Circle arrays for old servers", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        result: {
          removed: 1,
          stillConnected: true,
          connectionKind: "circle",
          circleIds: ["circle-legacy"],
          circleNames: ["Legacy Family"],
          canRemoveDirect: false,
        },
      }),
    );

    const result = await ConnectionsService.removeConnection({
      idToken: "tok",
      connectionId: "connection-1",
    });

    expect(result.circles).toEqual([
      { id: "circle-legacy", name: "Legacy Family" },
    ]);
  });
});
