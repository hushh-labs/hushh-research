import { beforeEach, describe, expect, it, vi } from "vitest";
import { CircleWarsService } from "@/lib/services/circle-wars-service";
import { ApiService } from "@/lib/services/api-service";

vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe("Circle Wars transport", () => {
  it("accepts active server state and sends owner consent through the shared platform transport", async () => {
    const active = { participation: { status: "active", team: { rank: 2, qualified_referrals: 4 } } };
    vi.mocked(ApiService.apiFetch).mockResolvedValue(new Response(JSON.stringify(active), { headers: { "Content-Type": "application/json" } }));
    expect(await CircleWarsService.optIn("in-memory-token", "existing-circle")).toEqual({ ...active, received_at_monotonic: expect.any(Number) });
    const [path, request] = vi.mocked(ApiService.apiFetch).mock.calls[0];
    expect(path).toBe("/api/one/referrals/circle-wars/participation");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer in-memory-token");
    expect(JSON.parse(request?.body as string)).toEqual({ circle_id: "existing-circle", consent: true });
    expect(request?.cache).toBe("no-store");
  });

  it("preserves server errors instead of inventing empty standings", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(new Response(JSON.stringify({ detail: { code: "CIRCLE_WARS_UNAVAILABLE" } }), { status: 503, headers: { "Content-Type": "application/json" } }));
    await expect(CircleWarsService.getLeaderboard("owner", 10)).rejects.toMatchObject({ status: 503 });
    expect(vi.mocked(ApiService.apiFetch).mock.calls[0][0]).toContain("limit=10&offset=10");
  });
});
