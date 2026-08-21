// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchNearby: vi.fn(),
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

vi.mock("@/lib/services/insurance-agent-directory-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/insurance-agent-directory-service")
  >("@/lib/services/insurance-agent-directory-service");
  return {
    ...actual,
    InsuranceAgentDirectoryService: { searchNearby: mocks.searchNearby },
  };
});

import { InsuranceAgentsNearby } from "@/components/connect/insurance-agents-nearby";

const AGENCY = {
  id: "13342248",
  name: "B G I Agency Network Inc.",
  phone: "(206) 726-0906",
  email: "lkoehler@bginetwork.com",
  website: "https://agency.nationwide.com/wa/kirkland/98033/b-g-i",
  products: ["Auto", "Commercial", "Farm", "Home"],
  agencyType: "Standard Independent",
  tier: null,
  hours: {
    days: [
      { day: "MONDAY", intervals: [{ start: 900, end: 1700 }] },
      { day: "TUESDAY", intervals: [{ start: 900, end: 1700 }] },
      { day: "WEDNESDAY", intervals: [{ start: 900, end: 1700 }] },
      { day: "THURSDAY", intervals: [{ start: 900, end: 1700 }] },
      { day: "FRIDAY", intervals: [{ start: 900, end: 1730 }] },
      { day: "SATURDAY", intervals: [] },
      { day: "SUNDAY", intervals: [] },
    ],
    note: null,
  },
  distanceMiles: 0.22,
  address: {
    line1: "10829 NE 68th St",
    line2: "Ste 202",
    city: "Kirkland",
    region: "WA",
    postalCode: "98033",
    formatted: "10829 NE 68th St, Ste 202, Kirkland, WA 98033",
  },
  city: "Kirkland",
  state: "WA",
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    items: [AGENCY],
    meta: {
      hasMore: false,
      nextOffset: null,
      returned: 1,
      available: 1,
      limit: 10,
      radiusMi: 10,
      truncated: false,
      cache: "cold",
      resolvedLocation: { city: "Kirkland", state: "WA", zip: "98033" },
    },
    // The locator supplies no terms or error-reporting URL, unlike BrokerCheck.
    attribution: {
      source: "Nationwide Agency Locator",
      sourceUrl: "https://agency.nationwide.com",
      notice: "Agency data retrieved from the Nationwide agency locator.",
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

describe("InsuranceAgentsNearby", () => {
  it("asks for location before touching the directory", () => {
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    expect(
      screen.getByTestId("insurance-agents-location-prompt"),
    ).toBeTruthy();
    expect(mocks.searchNearby).not.toHaveBeenCalled();
  });

  it("prompts the device only on the user's tap", () => {
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("insurance-agents-use-location"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("searches from the shared snapshot once one exists", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalled());
    expect(mocks.searchNearby.mock.calls[0][0]).toMatchObject({
      latitude: 47.6769,
      longitude: -122.206,
      radiusMi: 10,
      offset: 0,
    });
    await waitFor(() =>
      expect(screen.getByText("B G I Agency Network Inc.")).toBeTruthy(),
    );
  });

  it("shows what the agency can insure, which is what separates two of them", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    // Capped at three so the row stays one line on a phone.
    await waitFor(() =>
      expect(screen.getByText("Auto · Commercial · Farm")).toBeTruthy(),
    );
    expect(screen.getByText("~0.2 mi away")).toBeTruthy();
  });

  it("drops the status almost every agency shares, keeps the rare one", async () => {
    // Sampling a full page returned "Standard Independent" for 49 of 50 rows.
    // A label on almost every row is noise; the outlier is the whole signal.
    mocks.searchNearby.mockResolvedValue(
      result({
        items: [
          { ...AGENCY, id: "1", name: "Ordinary Agency" },
          {
            ...AGENCY,
            id: "2",
            name: "Standout Agency",
            agencyType: "Elite",
          },
        ],
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByText("Ordinary Agency")).toBeTruthy());
    expect(screen.queryByText("Standard Independent")).toBeNull();
    expect(screen.getByText("Elite")).toBeTruthy();
  });

  it("offers a ZIP search when the device says no", async () => {
    mocks.locationState = {
      status: "denied",
      permission: "denied",
      snapshot: null,
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    expect(screen.getByText("Location is off")).toBeTruthy();
    fireEvent.change(screen.getByTestId("insurance-agents-postal-input"), {
      target: { value: "98033" },
    });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalled());
    expect(mocks.searchNearby.mock.calls[0][0]).toMatchObject({
      postalCode: "98033",
    });
  });

  it("offers a ZIP when the coordinates are fine but match nobody", async () => {
    // The locator answers 200 with zero rows outside its coverage, so this is
    // an empty list rather than an error — and a dead end without a way out.
    mocks.searchNearby.mockResolvedValue(
      result({
        items: [],
        meta: {
          hasMore: false,
          nextOffset: null,
          returned: 0,
          available: 0,
          limit: 10,
          radiusMi: 10,
          truncated: false,
          cache: "cold",
          resolvedLocation: null,
        },
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 0, longitude: -30 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    await waitFor(() =>
      expect(screen.getByTestId("insurance-agents-empty")).toBeTruthy(),
    );
    expect(screen.getByText("Nothing nearby")).toBeTruthy();
    expect(screen.getByTestId("insurance-agents-postal-input")).toBeTruthy();
  });

  it("still offers the ZIP box after a ZIP search fails", async () => {
    // A failed ZIP must not strand the reader on a "Try again" that only
    // re-runs the ZIP that just failed. Mirrors the advisers directory.
    mocks.locationState = {
      status: "denied",
      permission: "denied",
      snapshot: null,
      error: "Location is off for Hussh.",
    };
    mocks.searchNearby.mockRejectedValueOnce(
      new Error("That search could not be completed."),
    );

    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    fireEvent.change(screen.getByTestId("insurance-agents-postal-input"), {
      target: { value: "00000" },
    });
    fireEvent.click(screen.getByText("Search"));

    expect(await screen.findByTestId("insurance-agents-error")).toBeTruthy();

    fireEvent.change(screen.getByTestId("insurance-agents-postal-input"), {
      target: { value: "98033" },
    });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({
      postalCode: "98033",
    });
  });

  it("re-searches when the radius changes", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("25 mi"));
    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({ radiusMi: 25 });
  });

  it("filters fetched agencies locally and can clear a no-match search", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await screen.findByText("B G I Agency Network Inc.");

    fireEvent.change(screen.getByTestId("insurance-agents-search"), {
      target: { value: "kirkland" },
    });
    await waitFor(() =>
      expect(screen.getByText("B G I Agency Network Inc.")).toBeTruthy(),
    );

    fireEvent.change(screen.getByTestId("insurance-agents-search"), {
      target: { value: "not a match" },
    });
    expect(await screen.findByTestId("insurance-agents-search-empty")).toBeTruthy();
    expect(mocks.searchNearby).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Clear search"));
    expect(await screen.findByText("B G I Agency Network Inc.")).toBeTruthy();
  });

  it("widens an empty agency search from its helpful zero state", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 1, longitude: 2 },
      error: null,
    };
    mocks.searchNearby.mockResolvedValue(result({ items: [] }));
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await screen.findByTestId("insurance-agents-empty");

    fireEvent.click(screen.getByText("Search within 25 mi"));
    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({ radiusMi: 25 });
  });

  it("pages from the offset the server returned", async () => {
    mocks.searchNearby.mockResolvedValue(
      result({
        meta: {
          hasMore: true,
          nextOffset: 10,
          returned: 1,
          available: 50,
          limit: 10,
          radiusMi: 10,
          truncated: true,
          cache: "cold",
          resolvedLocation: null,
        },
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByText("Show more")).toBeTruthy());
    fireEvent.click(screen.getByText("Show more"));
    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalledTimes(2));
    expect(mocks.searchNearby.mock.calls[1][0]).toMatchObject({ offset: 10 });
  });

  it("credits the locator without inventing links it does not provide", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    const credit = await waitFor(() =>
      screen.getByTestId("insurance-agents-attribution"),
    );
    expect(credit.textContent).toContain("Nationwide Agency Locator");
    // BrokerCheck's licence needs these; the locator supplies neither, and a
    // link with no href is not a weaker credit but a broken one.
    expect(credit.textContent).not.toContain("Terms");
    expect(credit.textContent).not.toContain("Report an error");
  });

  it("does not credit a source it showed nothing from", async () => {
    mocks.searchNearby.mockResolvedValue(
      result({
        items: [],
        meta: {
          hasMore: false,
          nextOffset: null,
          returned: 0,
          available: 0,
          limit: 10,
          radiusMi: 10,
          truncated: false,
          cache: "cold",
          resolvedLocation: null,
        },
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    await waitFor(() =>
      expect(screen.getByTestId("insurance-agents-empty")).toBeTruthy(),
    );
    expect(screen.queryByTestId("insurance-agents-attribution")).toBeNull();
  });

  it("says so when the data came from a cache rather than live", async () => {
    mocks.searchNearby.mockResolvedValue(
      result({
        meta: {
          hasMore: false,
          nextOffset: null,
          returned: 1,
          available: 1,
          limit: 10,
          radiusMi: 10,
          truncated: false,
          cache: "warm",
          resolvedLocation: null,
        },
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    const credit = await waitFor(() =>
      screen.getByTestId("insurance-agents-attribution"),
    );
    expect(credit.textContent).toContain("cached");
  });

  it("lets the user retry a failure instead of stranding them", async () => {
    mocks.searchNearby.mockRejectedValueOnce(new Error("Upstream is down."));
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);

    await waitFor(() =>
      expect(screen.getByTestId("insurance-agents-error")).toBeTruthy(),
    );
    expect(screen.getByText("Upstream is down.")).toBeTruthy();

    mocks.searchNearby.mockResolvedValue(result());
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() =>
      expect(screen.getByText("B G I Agency Network Inc.")).toBeTruthy(),
    );
  });

  it("keeps the page on screen when Show more fails", async () => {
    mocks.searchNearby.mockResolvedValueOnce(
      result({
        meta: {
          hasMore: true,
          nextOffset: 10,
          returned: 1,
          available: 50,
          limit: 10,
          radiusMi: 10,
          truncated: false,
          cache: "cold",
          resolvedLocation: null,
        },
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(screen.getByText("Show more")).toBeTruthy());

    mocks.searchNearby.mockRejectedValueOnce(new Error("Page failed."));
    fireEvent.click(screen.getByText("Show more"));

    await waitFor(() => expect(screen.getByText("Page failed.")).toBeTruthy());
    // The row already on screen must survive a failed extra page.
    expect(screen.getByText("B G I Agency Network Inc.")).toBeTruthy();
  });

  it("drops a stale paging cursor when a fresh search fails", async () => {
    mocks.searchNearby.mockResolvedValueOnce(
      result({
        meta: {
          hasMore: true,
          nextOffset: 10,
          returned: 1,
          available: 50,
          limit: 10,
          radiusMi: 10,
          truncated: false,
          cache: "cold",
          resolvedLocation: null,
        },
      }),
    );
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(screen.getByText("Show more")).toBeTruthy());

    mocks.searchNearby.mockRejectedValueOnce(new Error("Search failed."));
    fireEvent.click(screen.getByText("25 mi"));

    await waitFor(() =>
      expect(screen.getByTestId("insurance-agents-error")).toBeTruthy(),
    );
    // The old cursor points into a list that no longer exists.
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("shows posted hours, collapsed, and never claims 'open now'", async () => {
    // The payload carries bare HHMM with no timezone and this app is read from
    // India against US agencies, so an open/closed verdict would be wrong by
    // half a day — and would send someone to call a closed office.
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await waitFor(() =>
      expect(screen.getByText("B G I Agency Network Inc.")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("B G I Agency Network Inc."));

    // Mon-Thu share an interval and collapse; Friday differs and stands alone.
    await waitFor(() =>
      expect(screen.getByText("Mon–Thu 9am–5pm · Fri 9am–5:30pm")).toBeTruthy(),
    );
    expect(screen.queryByText(/open now/i)).toBeNull();
    expect(screen.queryByText(/closed now/i)).toBeNull();
  });

  it("opens one agency without a second request", async () => {
    mocks.locationState = {
      status: "ready",
      permission: "granted",
      snapshot: { latitude: 47.6769, longitude: -122.206 },
      error: null,
    };
    render(<InsuranceAgentsNearby getIdToken={getIdToken} />);
    await waitFor(() =>
      expect(screen.getByText("B G I Agency Network Inc.")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("B G I Agency Network Inc."));

    // Everything the surface shows arrived with the row; the locator returns
    // full agency data inline, so opening one fetches nothing.
    await waitFor(() =>
      expect(
        screen.getByText("10829 NE 68th St, Ste 202, Kirkland, WA 98033"),
      ).toBeTruthy(),
    );
    expect(mocks.searchNearby).toHaveBeenCalledTimes(1);
  });
});
