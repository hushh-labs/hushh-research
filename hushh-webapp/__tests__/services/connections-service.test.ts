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
});
