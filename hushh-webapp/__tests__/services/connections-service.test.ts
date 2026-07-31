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
    expect(JSON.parse(opts.body as string)).toEqual({
      addressee_user_id: "u2",
      message: undefined,
      requested_scope_handles: [],
      offered_scope_handles: [],
    });
  });

  it("accept POSTs to the accept endpoint", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ result: { status: "accepted" } }));
    await ConnectionsService.accept({ idToken: "tok", requestId: "r1" });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/one/connections/requests/r1/accept");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeUndefined();
  });

  it("loads counterpart-requestable and viewer-offerable scope catalogs", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        counterpartUserId: "u2",
        items: [{ handle: "scp-u2", label: "RIA Picks", description: "Picks" }],
        offerableItems: [{ handle: "scp-u1", label: "RIA Picks", description: "Picks" }],
      }),
    );

    const catalog = await ConnectionsService.getScopeCatalog({ idToken: "tok", counterpartUserId: "u2" });

    expect(mockApiFetch.mock.calls[0][0]).toBe("/api/one/connections/u2/scope-catalog");
    expect(catalog.items[0].handle).toBe("scp-u2");
    expect(catalog.offerableItems[0].handle).toBe("scp-u1");
  });

  it("sends both explicit scope selections when accepting a scoped request", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ result: { status: "accepted" } }));

    await ConnectionsService.accept({
      idToken: "tok",
      requestId: "r1",
      selectedRequestedScopeHandles: ["scp-ria"],
      selectedOfferedScopeHandles: [],
    });

    const [, opts] = mockApiFetch.mock.calls[0];
    expect(JSON.parse(opts.body as string)).toEqual({
      selected_requested_scope_handles: ["scp-ria"],
      selected_offered_scope_handles: [],
    });
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
});
