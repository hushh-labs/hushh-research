import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "@/lib/services/api-service";
import { mergePersonScopePage, PersonProfileService, type ViewerPersonProfile } from "@/lib/services/person-profile-service";

vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: vi.fn() } }));

function page(number: number, revision = "a".repeat(64)): ViewerPersonProfile {
  return {
    personRef: "fixture-person", displayName: "Fixture Person", photoUrl: null, verifiedRole: null,
    relationship: { status: "none", connectionId: null, connectedAt: null, requestId: null },
    grants: [], requestHistory: [],
    requestableScopes: [{ scopeRef: `field-${number}`, label: "Test field", description: null, domain: "professional", sensitivity: null, wildcard: false }],
    scopeCatalog: { page: number, nextPage: number + 1, hasMore: true, limit: 100, totalCount: 601,
      catalogRevision: revision, paginationReset: false, domains: [{ domain: "professional", count: 601 }] },
  };
}

describe("recipient-bound catalog pages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges consecutive pages without duplicate fields", () => {
    const next = page(2);
    next.requestableScopes.push(page(1).requestableScopes[0]!);
    expect(mergePersonScopePage(page(1), next).requestableScopes.map(item => item.scopeRef)).toEqual(["field-1", "field-2"]);
  });

  it("replaces stale eligibility when the catalog revision changes", () => {
    const next = page(1, "b".repeat(64));
    next.scopeCatalog!.paginationReset = true;
    expect(mergePersonScopePage(page(2), next)).toBe(next);
  });

  it("rejects wrong-person and out-of-order pages", () => {
    expect(() => mergePersonScopePage(page(1), { ...page(2), personRef: "other-person" })).toThrow(/person/);
    expect(() => mergePersonScopePage(page(1), page(3))).toThrow(/changed/);
  });

  it("forwards pagination and filters through the existing endpoint", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(new Response(JSON.stringify(page(2))));
    await PersonProfileService.getViewer("fixture-person", "fixture-token", { page: 2, revision: "a".repeat(64), domain: "professional", query: "test employer" });
    const url = String(vi.mocked(ApiService.apiFetch).mock.calls[0]![0]);
    const query = new URL(url, "https://example.test").searchParams;
    expect(query.get("catalog_page")).toBe("2");
    expect(query.get("catalog_revision")).toBe("a".repeat(64));
    expect(query.get("catalog_domain")).toBe("professional");
    expect(query.get("catalog_query")).toBe("test employer");
    expect(vi.mocked(ApiService.apiFetch).mock.calls[0]![1]).toEqual(expect.objectContaining({ cache: "no-store" }));
  });

  it("rejects a response for another person before it reaches a card", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(new Response(JSON.stringify({ ...page(1), personRef: "other" })));
    await expect(PersonProfileService.getViewer("fixture-person", "fixture-token")).rejects.toThrow(/person/);
  });

  it("refuses to acknowledge a request response for a different recipient", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(new Response(JSON.stringify({ personRef: "other", bundleId: "synthetic" })));
    await expect(PersonProfileService.createInformationRequest({ personRef: "fixture-person", scopeRefs: ["opaque"], purpose: "Synthetic test", durationSeconds: 86400,
      connectorKeyId: "synthetic", idempotencyKey: "synthetic-idempotency", vaultOwnerToken: "synthetic-token" })).rejects.toThrow(/person/);
  });
});
