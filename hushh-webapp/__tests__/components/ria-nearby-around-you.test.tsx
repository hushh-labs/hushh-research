/**
 * Regressions from real feedback on the first release of this pane.
 *
 * 1. Picking a lane emptied every other lane. Counts were derived from the
 *    filtered response, so choosing "Connectors" left the control unable to
 *    offer any way back.
 * 2. The postcode/coordinates form sat at the top of every visit, including
 *    when there were results and nothing to re-enter.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDiscover, mockListShortlist, mockShortlist } = vi.hoisted(() => ({
  mockDiscover: vi.fn(),
  mockListShortlist: vi.fn(),
  mockShortlist: vi.fn(),
}));

vi.mock("@/lib/services/nws-nearby-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/nws-nearby-service")
  >("@/lib/services/nws-nearby-service");
  return {
    ...actual,
    NwsNearbyService: {
      discover: mockDiscover,
      listShortlist: mockListShortlist,
      shortlist: mockShortlist,
    },
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "ria_1", getIdToken: async () => "token" } }),
}));

vi.mock("@/lib/one-location/use-current-location", () => ({
  useCurrentLocation: () => ({
    status: "idle",
    permission: null,
    snapshot: null,
    error: null,
    request: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { NearbyAroundYou } from "@/components/ria/nearby/nearby-around-you";

function record(over: Partial<Record<string, unknown>> = {}) {
  return {
    rank: 1,
    personId: "p1",
    displayName: "Michael R. Hsing",
    headline: "CEO",
    organization: "Monolithic Power Systems",
    lane: "BUILDER",
    globalNws: 83.4,
    nearbyRankScore: 83.4,
    scoreStatus: "PROVISIONAL",
    confidence: { score: 0.78, grade: "B" },
    publicLocation: {
      label: "MPS public Kirkland office",
      associationKind: "CURRENT_ORGANIZATION_OFFICE",
      granularity: "EXACT_PUBLIC_VENUE",
      distanceBand: "within 2 km",
      note: "n",
    },
    scoreBreakdown: {
      components: [
        { key: "graph_authority", label: "Graph authority", value: 0.91, weight: 0.3, contribution: 0.273 },
        { key: "freshness", label: "Freshness", value: 0.92, weight: 0.05, contribution: 0.046 },
      ],
      evidenceCount: 12,
      coverageMultiplier: 1,
      integrityPenalty: 0.034,
      localRelevance: 0.772,
      method: "Each component is scored 0-1, multiplied by its weight and summed.",
    },
    evidence: {
      citationCount: 2,
      sourceFamilyCount: 1,
      factCount: 4,
      independentSourceFamilies: false,
      reviewFlags: ["SINGLE_SOURCE_FAMILY"],
    },
    associationContext: {
      category: "BASED_HERE",
      definition:
        "Current verified public organization or civic association in this market; not a claim of physical presence or residence.",
    },
    reasons: ["High-authority roles"],
    warnings: [],
    tags: ["semiconductors"],
    revalidationRequired: false,
    sources: [
      {
        publisher: "MPS",
        title: "Management",
        url: "https://x.test",
        factTypes: ["identity", "current_role"],
        retrievedAt: "2026-08-13",
      },
    ],
    modelVersion: "m",
    ...over,
  };
}

const COVERED = {
  coverage: {
    status: "COVERED",
    reasonCode: "APPROVED_BOOTSTRAP_MARKET",
    marketId: "us-wa-kirkland-bootstrap",
    marketLabel: "Kirkland",
    countryCode: "US",
    message: null,
    complete: false,
  },
  snapshot: {
    scoreStatus: "PROVISIONAL",
    complete: false,
    modelVersion: "m",
    dataMode: "d",
    verifiedAt: "2026-08-12",
  },
  summary: {
    returnedCount: 7,
    candidateCount: 11,
    searchPerformed: true,
    effectiveRadiusKm: 20,
  },
  release: {
    releaseId: "us-wa-kirkland-public-association-2026-08-13",
    sourceRetrievedAt: "2026-08-13",
    sourcePolicyVersion: "public-association-v1",
  },
  reviewScope: { organizationAnchorCount: 13, marketCensusComplete: false },
  financialContext: {
    status: "NOT_PROFILED",
    capitalAccessNote: "PUBLIC_PROFESSIONAL_RELATIONSHIP_ONLY; not a measure of wealth.",
    notUsedForRanking: ["net_worth"],
  },
  scoreDefinition: "s",
  results: [
    record({ personId: "b1", lane: "BUILDER", displayName: "Builder One" }),
    record({ personId: "b2", lane: "BUILDER", displayName: "Builder Two" }),
    record({ personId: "c1", lane: "CONNECTOR", displayName: "Connector One" }),
    record({ personId: "b3", lane: "BUILDER", displayName: "Builder Three" }),
    record({ personId: "b4", lane: "BUILDER", displayName: "Builder Four" }),
    record({ personId: "b5", lane: "BUILDER", displayName: "Builder Five" }),
    record({ personId: "b6", lane: "BUILDER", displayName: "Builder Six" }),
  ],
};

const NOT_COVERED = {
  ...COVERED,
  coverage: {
    status: "NOT_COVERED",
    reasonCode: "NO_APPROVED_MARKET_DATA",
    marketId: null,
    marketLabel: null,
    countryCode: "IN",
    message: "no data",
    complete: false,
  },
  summary: { ...COVERED.summary, returnedCount: 0 },
  results: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListShortlist.mockResolvedValue([]);
  mockDiscover.mockResolvedValue(COVERED);
});

async function openAPlace() {
  fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
  const field = await screen.findByLabelText(/postcode/i);
  fireEvent.change(field, { target: { value: "98033" } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

describe("Around you", () => {
  it("does not show the location form until it is asked for", async () => {
    render(<NearbyAroundYou />);

    // Landing state offers one action and a quiet alternative — no form.
    expect(screen.queryByLabelText(/postcode/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use my location/i })).toBeInTheDocument();

    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    // With results on screen the form is gone again; "Change" summons it.
    expect(screen.queryByLabelText(/postcode/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
  });

  it("keeps every lane reachable after one is picked", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    const connectors = screen.getByRole("button", { name: /connectors/i });
    fireEvent.click(connectors);

    // Filtered down to the one connector...
    await waitFor(() => expect(screen.queryByText("Builder One")).not.toBeInTheDocument());
    expect(screen.getByText("Connector One")).toBeInTheDocument();

    // ...and Builders is still offered, with its true unfiltered count — six,
    // not the zero a count taken from the filtered response would have shown.
    const builders = screen.getByRole("button", { name: /builders/i });
    expect(builders).not.toBeDisabled();
    expect(within(builders).getByText("6")).toBeInTheDocument();

    fireEvent.click(builders);
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());
  });

  it("never offers a lane that has nothing behind it", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    // CAPITAL and GENERAL are empty in the approved dataset.
    expect(screen.queryByRole("button", { name: /capital/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /general/i })).not.toBeInTheDocument();
  });

  it("selecting a lane does not spend another upstream request", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    const before = mockDiscover.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /connectors/i }));
    await waitFor(() => expect(screen.getByText("Connector One")).toBeInTheDocument());

    expect(mockDiscover.mock.calls.length).toBe(before);
    // The upstream is asked for every lane; lane narrowing happens here.
    expect(mockDiscover.mock.calls[0][0].filters.lanes).toEqual([]);
  });

  it("offers the place picker when a location has nothing in it", async () => {
    mockDiscover.mockResolvedValue(NOT_COVERED);
    render(<NearbyAroundYou />);
    await openAPlace();

    await waitFor(() =>
      expect(screen.getByText(/no records here yet/i)).toBeInTheDocument(),
    );
    // The empty state is where the form is genuinely useful.
    expect(screen.getAllByRole("button", { name: /enter a place/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/kirkland/i)).not.toBeInTheDocument();
  });
});


describe("what the list actually shows", () => {
  it("shows a ranked few rather than everything the service returned", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    // Seven came back. Five are on screen — the top five by rank — and the
    // count says so rather than implying the list is complete.
    expect(screen.getByText("Builder Four")).toBeInTheDocument();
    expect(screen.queryByText("Builder Five")).not.toBeInTheDocument();
    expect(screen.getByText(/top 5 of 7/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show 2 more/i }));
    expect(screen.getByText("Builder Five")).toBeInTheDocument();
    expect(screen.getByText("Builder Six")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show .* more/i })).not.toBeInTheDocument();
  });

  it("collapses again when the filter changes underneath", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /show 2 more/i }));
    expect(screen.getByText("Builder Six")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /connectors/i }));
    await waitFor(() => expect(screen.getByText("Connector One")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));

    // Back to the top of a fresh list, not halfway down an expanded one.
    await waitFor(() => expect(screen.queryByText("Builder Six")).not.toBeInTheDocument());
  });

  it("does not offer Show more when everything already fits", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /connectors/i }));
    await waitFor(() => expect(screen.getByText("Connector One")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /show .* more/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 public record")).toBeInTheDocument();
  });
});


describe("filters only offer what exists", () => {
  it("hides a confidence grade with no records behind it", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    // One "All" before opening: the lane chip.
    expect(screen.getAllByRole("button", { name: /^All$/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));

    // The reviewed release grades every record B. Offering A would return an
    // empty screen — the same dead-option trap the empty lane chips had.
    expect(screen.getByRole("button", { name: /^B$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^A$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^C$/ })).not.toBeInTheDocument();

    // Two now: the lane chip plus the confidence "All", which always stands
    // because it can never come back empty.
    expect(screen.getAllByRole("button", { name: /^All$/ })).toHaveLength(2);
  });
});


describe("what the screen claims about completeness", () => {
  it("says the reviewed set is not everyone in the area", async () => {
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    // Seven records in one postcode reads like everyone there. It is a
    // reviewed set from a stated number of organisations.
    expect(
      screen.getByText(/reviewed from 13 organisations — not a complete list/i),
    ).toBeInTheDocument();
  });

  it("drops the caveat once a market really is a census", async () => {
    mockDiscover.mockResolvedValue({
      ...COVERED,
      reviewScope: { organizationAnchorCount: 13, marketCensusComplete: true },
    });
    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    expect(screen.queryByText(/not a complete list/i)).not.toBeInTheDocument();
  });

  it("still renders when an older service sends no review scope", async () => {
    const { reviewScope: _drop, ...withoutScope } = COVERED;
    mockDiscover.mockResolvedValue(withoutScope);
    render(<NearbyAroundYou />);
    await openAPlace();

    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());
    expect(screen.queryByText(/not a complete list/i)).not.toBeInTheDocument();
  });
});

describe("national index", () => {
  it("heads the pane with what the advisor typed, not the index name", async () => {
    // Every US postcode now resolves, and the label that comes back is the
    // name of the national index rather than anywhere recognisable.
    mockDiscover.mockResolvedValue({
      ...COVERED,
      coverage: {
        ...COVERED.coverage,
        reasonCode: "APPROVED_NATIONAL_INDEX",
        marketId: "us-national-public-association",
        marketLabel: "United States national public-association index",
      },
    });

    render(<NearbyAroundYou />);
    fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
    fireEvent.change(screen.getByLabelText(/postcode/i), { target: { value: "94010" } });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "US" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText("94010 US")).toBeInTheDocument());
    expect(
      screen.queryByText(/United States national public-association index/i),
    ).not.toBeInTheDocument();
  });

  it("says the list is partial when a source is down", async () => {
    // The index answers with whatever the healthy registry held, and that
    // shorter list is indistinguishable from a complete one.
    mockDiscover.mockResolvedValue({
      ...COVERED,
      sourceHealth: {
        status: "DEGRADED",
        queriedSourceCount: 2,
        successfulSources: ["SEC_SECTION16"],
        degradedSources: ["CMS_NPPES"],
      },
    });

    render(<NearbyAroundYou />);
    fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
    fireEvent.change(screen.getByLabelText(/postcode/i), { target: { value: "94010" } });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "US" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText(/Partial — a source is down/i)).toBeInTheDocument());
  });

  it("stays quiet when every source answered", async () => {
    mockDiscover.mockResolvedValue({
      ...COVERED,
      sourceHealth: {
        status: "HEALTHY",
        queriedSourceCount: 2,
        successfulSources: ["SEC_SECTION16", "CMS_NPPES"],
        degradedSources: [],
      },
    });

    render(<NearbyAroundYou />);
    fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
    fireEvent.change(screen.getByLabelText(/postcode/i), { target: { value: "94010" } });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "US" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());
    expect(screen.queryByText(/Partial —/i)).not.toBeInTheDocument();
  });

  it("blames the postcode, not the country, when a ZIP is unmapped", async () => {
    // Thousands of real deliverable US ZIPs are not census areas. An advisor
    // whose own mail ZIP is one of them should not be told the US is unmapped.
    mockDiscover.mockResolvedValue({
      ...NOT_COVERED,
      coverage: {
        ...NOT_COVERED.coverage,
        status: "LOCATION_UNRESOLVED",
        reasonCode: "POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX",
        countryCode: "US",
      },
    });

    render(<NearbyAroundYou />);
    fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
    fireEvent.change(screen.getByLabelText(/postcode/i), { target: { value: "20500" } });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "US" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() =>
      expect(screen.getByText(/That postcode isn't mapped/i)).toBeInTheDocument(),
    );
  });
});

describe("score regime", () => {
  // Values taken from the two live markets: a registry-discovered record leaves
  // the four graph-backed components at zero, a reviewed one populates them.
  function breakdown(graphBacked: number) {
    return {
      components: [
        { key: "graph_authority", label: "Graph authority", value: graphBacked, weight: 0.3, contribution: 0 },
        { key: "institutional_influence", label: "Institutional influence", value: 0.746, weight: 0.2, contribution: 0.149 },
        { key: "verified_track_record", label: "Verified track record", value: graphBacked, weight: 0.2, contribution: 0 },
        { key: "capital_access", label: "Capital access", value: graphBacked, weight: 0.1, contribution: 0 },
        { key: "evidence_confidence", label: "Evidence confidence", value: 0.81, weight: 0.08, contribution: 0.065 },
        { key: "trusted_reach", label: "Trusted reach", value: graphBacked, weight: 0.07, contribution: 0 },
        { key: "freshness", label: "Freshness", value: 0.98, weight: 0.05, contribution: 0.049 },
      ],
      evidenceCount: 5,
      coverageMultiplier: 1,
      integrityPenalty: 0,
      localRelevance: 1,
      method: "m",
    };
  }

  async function openFirstRecord(over: Record<string, unknown>) {
    mockDiscover.mockResolvedValue({
      ...COVERED,
      results: [record({ personId: "b1", displayName: "Builder One", ...over })],
    });

    render(<NearbyAroundYou />);
    fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
    fireEvent.change(screen.getByLabelText(/postcode/i), { target: { value: "94010" } });
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: "US" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Builder One"));
  }

  it("says what a registry-discovered score actually measured", async () => {
    // Two thirds of the weighting has nothing to read for these records, so
    // they land far below a reviewed one. Unlabelled, that reads as a weaker
    // person rather than a thinner source.
    await openFirstRecord({ scoreBreakdown: breakdown(0) });

    await waitFor(() =>
      expect(
        screen.getByText(/From public registry role and recency only/i),
      ).toBeInTheDocument(),
    );
  });

  it("stays silent for a reviewed record even though both call themselves provisional", async () => {
    // The live service reports score_kind PROFESSIONAL_NETWORK_PROVISIONAL for
    // reviewed and registry records alike, so the label cannot be the
    // discriminator — claiming a reviewed record has no relationship evidence
    // would be false.
    await openFirstRecord({
      scoreKind: "PROFESSIONAL_NETWORK_PROVISIONAL",
      scoreBreakdown: breakdown(0.6788),
    });

    await waitFor(() =>
      expect(screen.getByText(/Network strength, not net worth/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/From public registry role and recency only/i),
    ).not.toBeInTheDocument();
  });

  it("claims nothing when there is no breakdown to read", async () => {
    await openFirstRecord({ scoreBreakdown: null });

    await waitFor(() =>
      expect(screen.getByText(/Network strength, not net worth/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/From public registry role and recency only/i),
    ).not.toBeInTheDocument();
  });
});
