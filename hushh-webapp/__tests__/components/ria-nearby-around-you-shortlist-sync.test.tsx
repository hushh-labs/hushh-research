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

vi.mock("@/components/ria/nearby/nearby-record-sheet", () => ({
  NearbyRecordSheet: ({
    record,
    open,
    onShortlist,
    shortlisted,
  }: {
    record: { displayName: string | null; personId: string } | null;
    open: boolean;
    onShortlist: (record: { displayName: string | null; personId: string }) => void;
    shortlisted: boolean;
  }) =>
    record && open ? (
      <button type="button" onClick={() => onShortlist(record)}>
        {shortlisted ? "Shortlisted" : "Shortlist"}
      </button>
    ) : null,
}));

import { NearbyAroundYou } from "@/components/ria/nearby/nearby-around-you";

function record() {
  return {
    rank: 1,
    personId: "b1",
    displayName: "Builder One",
    headline: "CEO",
    organization: "Monolithic Power Systems",
    lane: "BUILDER",
    globalNws: 83.4,
    nearbyRankScore: 83.4,
    scoreStatus: "PROVISIONAL",
    scoreKind: null,
    rankingBasis: null,
    confidence: { score: 0.78, grade: "B" },
    publicLocation: {
      label: "MPS public Kirkland office",
      associationKind: "CURRENT_ORGANIZATION_OFFICE",
      granularity: "EXACT_PUBLIC_VENUE",
      distanceBand: "within 2 km",
      note: "n",
    },
    scoreBreakdown: null,
    evidence: null,
    associationContext: null,
    reasons: ["High-authority roles"],
    warnings: [],
    tags: ["semiconductors"],
    revalidationRequired: false,
    sources: [],
    modelVersion: "m",
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
    returnedCount: 1,
    candidateCount: 1,
    searchPerformed: true,
    effectiveRadiusKm: 20,
  },
  release: null,
  reviewScope: { organizationAnchorCount: 1, marketCensusComplete: false },
  financialContext: null,
  scoreDefinition: "s",
  results: [record()],
};

async function openAPlace() {
  fireEvent.click(screen.getByRole("button", { name: /enter a place/i }));
  const field = await screen.findByLabelText(/postcode/i);
  fireEvent.change(field, { target: { value: "98033" } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

function shortlistedProspectsSection() {
  return screen.getByRole("heading", { name: /shortlisted prospects/i }).closest("section");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListShortlist.mockResolvedValue([]);
  mockDiscover.mockResolvedValue(COVERED);
});

describe("Around You shortlist sync", () => {
  it("adds a newly shortlisted record to the discoverable prospects list after persistence succeeds", async () => {
    mockShortlist.mockResolvedValue({
      id: "shortlist-b1",
      target_key: "nws:b1",
      status: "shortlisted",
      profile: {
        displayName: "Builder One",
        headline: "CEO",
        organization: "Monolithic Power Systems",
      },
      updated_at: "2026-08-27T00:00:00.000Z",
    });

    render(<NearbyAroundYou />);
    await openAPlace();
    await waitFor(() => expect(screen.getByText("Builder One")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Builder One"));
    fireEvent.click(await screen.findByRole("button", { name: /^shortlist$/i }));

    await waitFor(() =>
      expect(
        within(shortlistedProspectsSection()!).getAllByText("Builder One"),
      ).toHaveLength(1),
    );
  });
});
