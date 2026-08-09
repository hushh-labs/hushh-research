// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchNearby: vi.fn(),
  getProfile: vi.fn(),
  request: vi.fn(),
  refresh: vi.fn(),
  locationState: {
    status: "idle" as string,
    permission: null as string | null,
    snapshot: null as { latitude: number; longitude: number } | null,
    error: null as string | null,
  },
}));

vi.mock("@/lib/one-location/use-current-location", () => ({
  useCurrentLocation: () => ({
    ...mocks.locationState,
    request: mocks.request,
    refresh: mocks.refresh,
  }),
}));

vi.mock("@/lib/services/advisor-directory-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/advisor-directory-service")
  >("@/lib/services/advisor-directory-service");
  return {
    ...actual,
    AdvisorDirectoryService: {
      searchNearby: mocks.searchNearby,
      getProfile: mocks.getProfile,
    },
  };
});

import { AdvisorsNearby } from "@/components/connect/advisors-nearby";

const ADVISOR = {
  kind: "advisor" as const,
  id: "862222",
  crd: "862222",
  name: "Christine Cote",
  firmName: "Morgan Stanley",
  yearsExperience: 47.5,
  hasDisclosures: true,
  distanceMiles: 0.47,
  city: "Kirkland",
  state: "WA",
  phone: "914-225-1000",
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    items: [ADVISOR],
    meta: {
      grouped: false,
      hasMore: false,
      nextOffset: null,
      returned: 1,
      available: 1,
      limit: 10,
      radiusMi: 10,
      radiusRequested: 10,
      radiusAdjusted: false,
      truncated: false,
    },
    attribution: {
      source: "FINRA BrokerCheck",
      sourceUrl: "https://brokercheck.finra.org",
      termsUrl: "https://brokercheck.finra.org/terms-and-conditions",
      notice: "Data retrieved from FINRA BrokerCheck.",
      errorReporting: "https://www.finra.org/investors/about-brokercheck",
      retrievedAt: "2026-08-05T09:00:00.000Z",
    },
    ...overrides,
  };
}

const getIdToken = async () => "id-token";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locationState = {
    status: "idle",
    permission: null,
    snapshot: null,
    error: null,
  };
  mocks.searchNearby.mockResolvedValue(result());
});

describe("AdvisorsNearby", () => {
  it("asks for location before touching the directory", () => {
    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(screen.getByTestId("advisors-location-prompt")).toBeTruthy();
    expect(mocks.searchNearby).not.toHaveBeenCalled();
  });

  it("prompts the device only on the user's tap", () => {
    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("advisors-use-location"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("searches from the shared snapshot once one exists", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(1));
    expect(mocks.searchNearby.mock.calls[0][0]).toMatchObject({
      latitude: 47.6769,
      longitude: -122.206,
      radiusMi: 10,
      offset: 0,
    });
    expect(await screen.findByText("Christine Cote")).toBeTruthy();
    expect(screen.getByText("Morgan Stanley · 47 yrs")).toBeTruthy();
    expect(screen.getByText("~0.5 mi")).toBeTruthy();
  });

  it("offers a ZIP search when the device says no", async () => {
    mocks.locationState = {
      status: "denied",
      permission: "denied",
      snapshot: null,
      error: "Location is off for Hussh.",
    };

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(screen.getByText("Location is off")).toBeTruthy();
    fireEvent.change(screen.getByTestId("advisors-postal-input"), {
      target: { value: "98033" },
    });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(1));
    expect(mocks.searchNearby.mock.calls[0][0]).toMatchObject({
      postalCode: "98033",
    });
  });

  it("still offers the ZIP box after a ZIP search fails", async () => {
    // The reported dead end: a ZIP that errors leaves "Try again" as the only
    // control, and that re-runs the ZIP that just failed. Switching tabs and
    // back was the only way to get the input again, because that remounts the
    // component and clears the anchor.
    mocks.locationState = {
      status: "denied",
      permission: "denied",
      snapshot: null,
      error: "Location is off for Hussh.",
    };
    mocks.searchNearby.mockRejectedValueOnce(
      new Error("That search could not be completed."),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    fireEvent.change(screen.getByTestId("advisors-postal-input"), {
      target: { value: "00000" },
    });
    fireEvent.click(screen.getByText("Search"));

    expect(await screen.findByTestId("advisors-error")).toBeTruthy();

    const retryInput = screen.getByTestId("advisors-postal-input");
    fireEvent.change(retryInput, { target: { value: "98033" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({
      postalCode: "98033",
    });
    expect(await screen.findByText("Christine Cote")).toBeTruthy();
  });

  it("re-searches when the radius changes", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };

    render(<AdvisorsNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("25 mi"));

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({ radiusMi: 25 });
  });

  it("pages from the offset the server returned", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(
      result({ meta: { ...result().meta, hasMore: true, nextOffset: 10 } }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);
    const more = await screen.findByText("Show more");
    fireEvent.click(more);

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({ offset: 10 });
  });

  it("renders branch results without pretending they are people", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 40.75, longitude: -73.99 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(
      result({
        items: [
          {
            kind: "branch",
            id: "408168",
            name: "Morgan Stanley",
            firmName: null,
            advisorCount: 74,
            advisorNames: [],
            distanceMiles: 0.5,
            city: "New York",
            state: "NY",
            phone: null,
          },
        ],
        meta: { ...result().meta, grouped: true },
      }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(await screen.findByText("Offices")).toBeTruthy();
    expect(screen.getByText("74 advisors · New York")).toBeTruthy();
  });

  it("opens an office surface for a branch instead of an adviser profile", async () => {
    // Grouped results are what dense metros and wider radii return, so an
    // office row is the only thing a reader can act on there. Leaving it inert
    // made 10 mi and 25 mi look broken next to 5 mi.
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 41.88, longitude: -87.63 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(
      result({
        items: [
          {
            kind: "branch",
            id: "408168",
            name: "J.P. MORGAN SECURITIES LLC",
            firmName: null,
            advisorCount: 74,
            advisorNames: ["A ADVISOR", "B ADVISOR"],
            distanceMiles: 0.7,
            city: "CHICAGO",
            state: "IL",
            phone: "312-555-0100",
          },
        ],
        meta: { ...result().meta, grouped: true },
      }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    fireEvent.click(await screen.findByText("J.P. MORGAN SECURITIES LLC"));

    // The office's own facts, not a person's credentials.
    expect(await screen.findByText("Advisors at this office")).toBeTruthy();
    expect(screen.getByText("A ADVISOR")).toBeTruthy();
    expect(screen.getByText("and 72 more")).toBeTruthy();

    // A branch carries no CRD, so no profile fetch may be attempted.
    expect(mocks.getProfile).not.toHaveBeenCalled();
  });

  it("surfaces the narrowed radius the server actually used", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(
      result({
        meta: {
          ...result().meta,
          radiusMi: 1.6,
          radiusRequested: 25,
          radiusAdjusted: true,
        },
      }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(await screen.findByText("Within 1.6 mi.")).toBeTruthy();
  });

  it("offers a ZIP when the coordinates are fine but match nobody", async () => {
    // Someone in India has working GPS and an empty list — FINRA is US-only.
    // A dead-end "none nearby" row leaves them with nothing to do.
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 19.076, longitude: 72.8777 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(result({ items: [] }));

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(await screen.findByTestId("advisors-empty")).toBeTruthy();
    expect(screen.getByText("Nothing nearby")).toBeTruthy();

    fireEvent.change(screen.getByTestId("advisors-postal-input"), {
      target: { value: "98033" },
    });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({
      postalCode: "98033",
    });
  });

  it("carries the source credit the licence requires, not just a name", async () => {
    // BrokerCheck's Terms permit reuse under §5 only with the source named, the
    // Terms linked, a way to report an error, and the retrieval date shown.
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };

    render(<AdvisorsNearby getIdToken={getIdToken} />);
    await screen.findByText("Christine Cote");

    const footer = screen.getByTestId("advisors-attribution");
    const href = (name: RegExp) =>
      within(footer).getByRole("link", { name }).getAttribute("href");

    expect(href(/FINRA BrokerCheck/i)).toBe("https://brokercheck.finra.org");
    expect(href(/^Terms$/i)).toBe(
      "https://brokercheck.finra.org/terms-and-conditions",
    );
    expect(href(/Report an error/i)).toBe(
      "https://www.finra.org/investors/about-brokercheck",
    );
    expect(within(footer).getByText(/Retrieved/)).toBeTruthy();
  });

  it("says so when the data came from a cache rather than live", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(
      result({ meta: { ...result().meta, cache: "warm" } }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);
    await screen.findByText("Christine Cote");

    expect(
      within(screen.getByTestId("advisors-attribution")).getByText(/cached/),
    ).toBeTruthy();
  });

  it("does not credit a source it showed nothing from", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 19.076, longitude: 72.8777 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(result({ items: [] }));

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    await screen.findByTestId("advisors-empty");
    expect(screen.queryByText("FINRA BrokerCheck")).toBeNull();
  });

  it("lets the user retry a failure instead of stranding them", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockRejectedValueOnce(new Error("Not available yet."));

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(await screen.findByTestId("advisors-error")).toBeTruthy();
    expect(screen.getByText("Not available yet.")).toBeTruthy();

    mocks.searchNearby.mockResolvedValue(result());
    fireEvent.click(screen.getByText("Try again"));

    expect(await screen.findByText("Christine Cote")).toBeTruthy();
  });

  it("keeps the radius control available when nothing came back", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(result({ items: [] }));

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    await screen.findByTestId("advisors-empty");
    expect(screen.getByText("25 mi")).toBeTruthy();
  });

  it("keeps the page on screen when Show more fails", async () => {
    // A failed extra page must not take the results the user is already
    // reading with it.
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValueOnce(
      result({ meta: { ...result().meta, hasMore: true, nextOffset: 10 } }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);
    expect(await screen.findByText("Christine Cote")).toBeTruthy();

    mocks.searchNearby.mockRejectedValueOnce(new Error("Try again shortly."));
    fireEvent.click(screen.getByText("Show more"));

    await waitFor(() =>
      expect(screen.getByText("Try again shortly.")).toBeTruthy(),
    );
    expect(screen.getByText("Christine Cote")).toBeTruthy();
    expect(screen.queryByTestId("advisors-error")).toBeNull();
  });

  it("drops a stale paging cursor when a fresh search fails", async () => {
    // Otherwise "Show more" survives the failure and pages into a list that no
    // longer exists.
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValueOnce(
      result({ meta: { ...result().meta, hasMore: true, nextOffset: 10 } }),
    );

    render(<AdvisorsNearby getIdToken={getIdToken} />);
    expect(await screen.findByText("Show more")).toBeTruthy();

    mocks.searchNearby.mockRejectedValueOnce(new Error("Not available yet."));
    fireEvent.click(screen.getByText("25 mi"));

    expect(await screen.findByTestId("advisors-error")).toBeTruthy();
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("shows a failure without wiping the surface", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockRejectedValue(new Error("Try again shortly."));

    render(<AdvisorsNearby getIdToken={getIdToken} />);

    expect(await screen.findByText("Try again shortly.")).toBeTruthy();
  });
});
