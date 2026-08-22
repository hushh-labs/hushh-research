import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import {
  DEFAULT_NEARBY_FILTERS,
  NwsNearbyService,
  availableTags,
  formatScore,
  laneCounts,
  type NearbyRecord,
} from "@/lib/services/nws-nearby-service";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function record(overrides: Partial<NearbyRecord> = {}): NearbyRecord {
  return {
    rank: 1,
    personId: "bootstrap_michael_hsing",
    displayName: "Michael R. Hsing",
    headline: "Chairman, President and CEO",
    organization: "Monolithic Power Systems",
    lane: "BUILDER",
    globalNws: 83.4022,
    nearbyRankScore: 83.4259,
    scoreStatus: "PROVISIONAL",
    confidence: { score: 0.9306, grade: "A" },
    publicLocation: {
      label: "Monolithic Power Systems public Kirkland office association",
      associationKind: "CURRENT_ORGANIZATION_OFFICE",
      granularity: "EXACT_PUBLIC_VENUE",
      distanceBand: "within 2 km",
      note: "Distance is to a public professional association, never a residence.",
    },
    reasons: ["High-authority roles at influential institutions"],
    warnings: [],
    tags: ["semiconductors", "founder", "board"],
    revalidationRequired: false,
    sources: [{ publisher: "MPS", title: "Management", url: "https://example.test" }],
    modelVersion: "nws-v2.2.0-bootstrap.2026-08-12",
    ...overrides,
  };
}

const COVERED = {
  coverage: {
    status: "COVERED",
    reasonCode: "APPROVED_BOOTSTRAP_MARKET",
    marketId: "us-wa-kirkland-bootstrap",
    marketLabel: "Kirkland public-association bootstrap",
    countryCode: "US",
    message: null,
    complete: false,
  },
  snapshot: {
    scoreStatus: "PROVISIONAL",
    complete: false,
    modelVersion: "m",
    dataMode: "VERIFIED_PUBLIC_BOOTSTRAP",
    verifiedAt: "2026-08-12",
  },
  summary: {
    returnedCount: 1,
    candidateCount: 11,
    searchPerformed: true,
    effectiveRadiusKm: 20,
  },
  scoreDefinition: "NWS estimates public professional network strength.",
  results: [record()],
};

function requestedUrl(): string {
  return String(mockApiFetch.mock.calls[0][0]);
}

function requestedBody(): Record<string, unknown> {
  const init = mockApiFetch.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue(jsonResponse(COVERED));
});

describe("NwsNearbyService.discover", () => {
  it("never puts the advisor's position in a URL", async () => {
    await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "coords", latitude: 47.6715, longitude: -122.2133 },
    });

    const url = requestedUrl();
    expect(url).toBe("/api/ria/nearby/discover");
    expect(url).not.toContain("47.");
    expect(url).not.toContain("-122.");
    expect((mockApiFetch.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("coarsens coordinates before they leave the browser", async () => {
    await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "coords", latitude: 47.671523, longitude: -122.213387 },
    });

    const body = requestedBody();
    expect(body.latitude).toBe(47.67);
    expect(body.longitude).toBe(-122.21);
    expect(JSON.stringify(body)).not.toContain("47.671523");
  });

  it("sends no country context with a coordinate", async () => {
    // A guessed country returns COUNTRY_CONTEXT_DOES_NOT_MATCH and hides real
    // results, and we hold no reverse geocode to make it a fact.
    await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "coords", latitude: 47.6715, longitude: -122.2133 },
    });

    expect(requestedBody()).not.toHaveProperty("country_code");
  });

  it("sends the country the advisor typed with a postcode", async () => {
    await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "postal", postalCode: " 110001 ", countryCode: "in" },
    });

    const body = requestedBody();
    expect(body.postal_code).toBe("110001");
    expect(body.country_code).toBe("IN");
    expect(body).not.toHaveProperty("latitude");
  });

  it("sends one tag at a time, because the upstream matches them as a subset", async () => {
    await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "postal", postalCode: "98033", countryCode: "US" },
      filters: { ...DEFAULT_NEARBY_FILTERS, tag: "founder" },
    });

    expect(requestedBody().tags).toEqual(["founder"]);
  });

  it("carries both scores so the list can rank by one and label the other", async () => {
    const result = await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "postal", postalCode: "98033", countryCode: "US" },
    });

    const row = result.results[0];
    expect(row.nearbyRankScore).toBeCloseTo(83.4259);
    expect(row.globalNws).toBeCloseTo(83.4022);
    // They differ, which is exactly why showing globalNws in rank order reads
    // as a sorting bug.
    expect(row.nearbyRankScore).not.toBe(row.globalNws);
  });

  it("passes an uncovered result through as a success, not an error", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        ...COVERED,
        coverage: {
          status: "NOT_COVERED",
          reasonCode: "NO_APPROVED_MARKET_DATA",
          marketId: null,
          marketLabel: null,
          countryCode: "IN",
          message: "no dataset",
          complete: false,
        },
        summary: { ...COVERED.summary, returnedCount: 0 },
        results: [],
      }),
    );

    const result = await NwsNearbyService.discover({
      idToken: "t",
      anchor: { kind: "coords", latitude: 28.6139, longitude: 77.209 },
    });

    expect(result.coverage.status).toBe("NOT_COVERED");
    expect(result.coverage.reasonCode).toBe("NO_APPROVED_MARKET_DATA");
    expect(result.results).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Kirkland");
  });

  it("separates failures the advisor can retry from ones they cannot", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({}, 503));
    await expect(
      NwsNearbyService.discover({
        idToken: "t",
        anchor: { kind: "postal", postalCode: "98033", countryCode: "US" },
      }),
    ).rejects.toThrow("This isn't set up yet.");

    mockApiFetch.mockResolvedValue(jsonResponse({}, 429));
    await expect(
      NwsNearbyService.discover({
        idToken: "t",
        anchor: { kind: "postal", postalCode: "98033", countryCode: "US" },
      }),
    ).rejects.toThrow("Busy right now. Try again in a moment.");

    mockApiFetch.mockResolvedValue(jsonResponse({}, 504));
    await expect(
      NwsNearbyService.discover({
        idToken: "t",
        anchor: { kind: "postal", postalCode: "98033", countryCode: "US" },
      }),
    ).rejects.toThrow("That took too long. Try again.");
  });
});

describe("NwsNearbyService.shortlist", () => {
  it("stores only the public fields the shortlist renders", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ id: "1", target_key: "nws:x" }));

    await NwsNearbyService.shortlist({ idToken: "t", record: record() });

    const body = requestedBody();
    expect(body.person_id).toBe("bootstrap_michael_hsing");
    expect(body.action).toBe("shortlist");

    const snapshot = body.snapshot as Record<string, unknown>;
    expect(snapshot.displayName).toBe("Michael R. Hsing");
    // Reasons, sources and warnings go stale the moment the upstream re-scores,
    // so they are deliberately not persisted.
    expect(snapshot).not.toHaveProperty("reasons");
    expect(snapshot).not.toHaveProperty("sources");
    expect(snapshot).not.toHaveProperty("warnings");
    expect(snapshot).not.toHaveProperty("globalNws");
    expect(snapshot).not.toHaveProperty("nearbyRankScore");
  });

  it("expresses un-shortlisting as a pass, matching the deck vocabulary", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ id: "1", target_key: "nws:x" }));

    await NwsNearbyService.shortlist({ idToken: "t", record: record(), action: "pass" });

    expect(requestedBody().action).toBe("pass");
  });
});

describe("filter helpers", () => {
  it("counts every lane, including the ones with nothing in them", () => {
    const counts = laneCounts([
      record({ personId: "a", lane: "BUILDER" }),
      record({ personId: "b", lane: "BUILDER" }),
      record({ personId: "c", lane: "CIVIC" }),
    ]);

    expect(counts.BUILDER).toBe(2);
    expect(counts.CIVIC).toBe(1);
    // An empty lane must report zero rather than be absent, so the control can
    // show it as unavailable instead of offering a dead option.
    expect(counts.CAPITAL).toBe(0);
    expect(counts.GENERAL).toBe(0);
  });

  it("offers only sectors present in the current results", () => {
    const tags = availableTags([
      record({ personId: "a", tags: ["founder", "technology"] }),
      record({ personId: "b", tags: ["civic", "founder"] }),
    ]);

    expect(tags).toEqual(["civic", "founder", "technology"]);
  });

  it("formats a missing score without inventing a number", () => {
    expect(formatScore(83.4259)).toBe("83.4");
    expect(formatScore(null)).toBe("—");
  });
});
