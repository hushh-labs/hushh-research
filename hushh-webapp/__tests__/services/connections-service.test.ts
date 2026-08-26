import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import {
  ConnectionsService,
  ConnectionsServiceRequestError,
} from "@/lib/services/connections-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConnectionsService", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("surfaces a safe FastAPI detail message for contact-sync failures", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "CONTACT_SYNC_RATE_LIMITED",
            message: "Contact sync is temporarily limited. Try again later.",
            internal_context: { lookup_hash: "must-not-leak" },
          },
        },
        429,
      ),
    );

    const error = await ConnectionsService.syncContacts({
      idToken: "tok",
      lookups: [],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionsServiceRequestError);
    expect(error).toMatchObject({
      status: 429,
      message: "Contact sync is temporarily limited. Try again later.",
    });
  });

  it("accepts string FastAPI detail without serializing object details", async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({ detail: "Verify your phone before syncing contacts." }, 403),
      )
      .mockResolvedValueOnce(
        jsonResponse({ detail: { code: "SCHEMA_NOT_READY" } }, 503),
      );

    await expect(
      ConnectionsService.syncContacts({ idToken: "tok", lookups: [] }),
    ).rejects.toThrow("Verify your phone before syncing contacts.");
    await expect(
      ConnectionsService.syncContacts({ idToken: "tok", lookups: [] }),
    ).rejects.toThrow("Request failed (503)");
  });

  it("preserves legacy error priority over FastAPI detail", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        {
          error: "Legacy service message.",
          detail: { message: "Lower-priority detail." },
        },
        503,
      ),
    );

    await expect(
      ConnectionsService.syncContacts({ idToken: "tok", lookups: [] }),
    ).rejects.toThrow("Legacy service message.");
  });

  it("syncContacts sends one opaque, bounded lookup batch", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        checkedLookupCount: 1,
        indeterminateLookupIds: [],
        items: [
          {
            lookupId: "lookup_1",
            userId: "u2",
            displayName: "Bo",
            photoUrl: null,
            outcome: "auto_connected",
            hash: "server-must-not-echo-this",
            last4: "0101",
          },
        ],
      }),
    );

    const controller = new AbortController();
    const result = await ConnectionsService.syncContacts({
      idToken: "tok",
      signal: controller.signal,
      lookups: [
        {
          lookupId: "lookup_1",
          hash: "a".repeat(64),
          last4: "0101",
        },
      ],
    });

    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/one/connections/contact-sync");
    expect(opts.signal).toBe(controller.signal);
    expect(JSON.parse(opts.body as string)).toEqual({
      lookups: [
        {
          lookup_id: "lookup_1",
          hash: "a".repeat(64),
          last4: "0101",
        },
      ],
    });
    expect(result.matches[0]).toMatchObject({
      userId: "u2",
      outcome: "auto_connected",
    });
    expect(result.indeterminateLookupIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("0101");
    expect(JSON.stringify(result)).not.toContain("server-must-not-echo-this");
  });

  it("rejects oversized contact batches before making a request", async () => {
    await expect(
      ConnectionsService.syncContacts({
        idToken: "tok",
        lookups: Array.from({ length: 1001 }, (_, index) => ({
          lookupId: `lookup_${index}`,
          hash: "a".repeat(64),
          last4: "0101",
        })),
      }),
    ).rejects.toThrow("at most 1000");
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed indeterminate lookup ids instead of implying unmatched", async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ items: [], checkedLookupCount: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [],
          checkedLookupCount: 1,
          indeterminateLookupIds: "lookup_1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [],
          checkedLookupCount: 1,
          indeterminateLookupIds: ["lookup_1", "lookup_1"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [],
          checkedLookupCount: 1,
          indeterminateLookupIds: ["unexpected"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              lookupId: "lookup_1",
              userId: "u2",
              outcome: "auto_connected",
            },
          ],
          checkedLookupCount: 1,
          indeterminateLookupIds: ["lookup_1"],
        }),
      );
    const lookup = { lookupId: "lookup_1", hash: "a".repeat(64), last4: "0101" };

    for (let index = 0; index < 5; index += 1) {
      await expect(
        ConnectionsService.syncContacts({ idToken: "tok", lookups: [lookup] }),
      ).rejects.toThrow("incomplete response");
    }
  });

  it("returns unique expected indeterminate lookup ids", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        items: [],
        checkedLookupCount: 2,
        indeterminateLookupIds: ["lookup_2"],
      }),
    );

    const result = await ConnectionsService.syncContacts({
      idToken: "tok",
      lookups: [
        { lookupId: "lookup_1", hash: "a".repeat(64), last4: "0101" },
        { lookupId: "lookup_2", hash: "b".repeat(64), last4: "0202" },
      ],
    });

    expect(result).toMatchObject({
      matches: [],
      indeterminateLookupIds: ["lookup_2"],
    });
  });

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

  it("cancel POSTs to the request cancellation endpoint", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ result: { status: "cancelled" } }));

    await ConnectionsService.cancel({ idToken: "tok", requestId: "r1" });

    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/one/connections/requests/r1/cancel");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok");
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

  it("searches a connected person's discoverable information scopes", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        counterpartUserId: "u2",
        items: [{ scope: "attr.financial.holdings", label: "Holdings", domain: "financial", path: "holdings", wildcard: false, match_reason: "substring_match" }],
      }),
    );

    const catalog = await ConnectionsService.searchInformationScopes({
      idToken: "tok",
      counterpartUserId: "u2",
      query: "holding",
    });

    expect(mockApiFetch.mock.calls[0][0]).toBe(
      "/api/one/connections/u2/information-scopes?query=holding",
    );
    expect(catalog.items[0].scope).toBe("attr.financial.holdings");
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

  it("loads a bounded, audience-filtered connection page", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        items: [{ connectionId: "c51", userId: "u51", displayName: "Same", connectedFromContacts: true }],
        page: 2,
        hasMore: true,
        totalCount: 5000,
        audience: "ria",
      }),
    );

    const result = await ConnectionsService.listConnectionsPage({
      idToken: "tok",
      page: 2,
      limit: 50,
      query: "same",
      audience: "ria",
    });

    expect(mockApiFetch.mock.calls[0][0]).toBe(
      "/api/one/connections?page=2&limit=50&audience=ria&query=same",
    );
    expect(result).toMatchObject({ page: 2, hasMore: true, totalCount: 5000 });
    expect(result.items[0]).toMatchObject({
      userId: "u51",
      connectedFromContacts: true,
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
