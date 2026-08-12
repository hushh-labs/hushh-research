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
    confidence: { score: 0.93, grade: "A" },
    publicLocation: {
      label: "MPS public Kirkland office",
      associationKind: "CURRENT_ORGANIZATION_OFFICE",
      granularity: "EXACT_PUBLIC_VENUE",
      distanceBand: "within 2 km",
      note: "n",
    },
    reasons: ["High-authority roles"],
    warnings: [],
    tags: ["semiconductors"],
    revalidationRequired: false,
    sources: [{ publisher: "MPS", title: "Management", url: "https://x.test" }],
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
    returnedCount: 3,
    candidateCount: 11,
    searchPerformed: true,
    effectiveRadiusKm: 20,
  },
  scoreDefinition: "s",
  results: [
    record({ personId: "b1", lane: "BUILDER", displayName: "Builder One" }),
    record({ personId: "b2", lane: "BUILDER", displayName: "Builder Two" }),
    record({ personId: "c1", lane: "CONNECTOR", displayName: "Connector One" }),
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

    // ...and Builders is still offered, with its true unfiltered count.
    const builders = screen.getByRole("button", { name: /builders/i });
    expect(builders).not.toBeDisabled();
    expect(within(builders).getByText("2")).toBeInTheDocument();

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
