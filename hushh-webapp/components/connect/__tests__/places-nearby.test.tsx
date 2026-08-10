// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamNearby: vi.fn(),
  searchNearby: vi.fn(),
  getDetails: vi.fn(),
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

vi.mock("@/lib/services/places-directory-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/places-directory-service")
  >("@/lib/services/places-directory-service");
  return {
    ...actual,
    PlacesDirectoryService: {
      streamNearby: mocks.streamNearby,
      searchNearby: mocks.searchNearby,
      getDetails: mocks.getDetails,
    },
  };
});

import { PlacesNearby } from "@/components/connect/places-nearby";

const ATTRIBUTION = {
  source: "Google",
  sourceUrl: "https://www.google.com/maps",
  termsUrl: "https://cloud.google.com/maps-platform/terms",
  notice: "Place data from Google Maps Platform.",
  retrievedAt: "2026-08-10T09:00:00.000Z",
};

function place(overrides: Record<string, unknown> = {}) {
  return {
    placeId: "place-1",
    name: "Hotel Vivanta",
    address: "12 Residency Rd",
    distanceMeters: 640,
    primaryType: "hotel",
    categoryLabel: "Hotel",
    category: "hotels_stays",
    businessStatus: "OPERATIONAL",
    ...overrides,
  };
}

/** Drives the component's handlers the way a real stream would. */
function streamOf(
  frames: { category: string; items: Record<string, unknown>[] }[],
  options: { failures?: { category: string; message: string }[] } = {},
) {
  return async (opts: {
    handlers: {
      onMeta?: (m: unknown) => void;
      onCategory: (c: string, i: unknown[]) => void;
      onCategoryError?: (c: string, m: string) => void;
    };
  }) => {
    opts.handlers.onMeta?.({ attribution: ATTRIBUTION });
    for (const frame of frames) {
      opts.handlers.onCategory(frame.category, frame.items);
    }
    for (const failure of options.failures ?? []) {
      opts.handlers.onCategoryError?.(failure.category, failure.message);
    }
  };
}

const getIdToken = async () => "id-token";

const LOCATED = {
  status: "ready",
  permission: "granted",
  snapshot: { latitude: 12.9716, longitude: 77.5946 },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locationState = {
    status: "idle",
    permission: null,
    snapshot: null,
    error: null,
  };
  mocks.streamNearby.mockImplementation(
    streamOf([{ category: "hotels_stays", items: [place()] }]),
  );
  mocks.getDetails.mockResolvedValue({
    placeId: "place-1",
    name: "Hotel Vivanta",
    address: "12 Residency Rd, Bengaluru",
    categoryLabel: "Hotel",
    phone: "080 6660 5660",
    website: "https://example.com",
    mapsUrl: "https://maps.google.com/?cid=1",
    businessStatus: "OPERATIONAL",
    weekdayDescriptions: ["Monday: Open 24 hours"],
  });
});

describe("PlacesNearby", () => {
  it("asks for location before touching the directory", () => {
    render(<PlacesNearby getIdToken={getIdToken} />);
    expect(screen.getByTestId("places-location-prompt")).toBeTruthy();
    expect(mocks.streamNearby).not.toHaveBeenCalled();
  });

  it("prompts the device only on the user's tap", () => {
    render(<PlacesNearby getIdToken={getIdToken} />);
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("places-use-location"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("searches from the shared snapshot once one exists", async () => {
    mocks.locationState = LOCATED;
    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.streamNearby).toHaveBeenCalled());
    expect(mocks.streamNearby.mock.calls[0][0]).toMatchObject({
      origin: { latitude: 12.9716, longitude: 77.5946 },
      radiusMi: 5,
    });
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
  });

  it("asks for every category in one sweep, not one call per chip", async () => {
    mocks.locationState = LOCATED;
    render(<PlacesNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(mocks.streamNearby).toHaveBeenCalled());

    expect(mocks.streamNearby.mock.calls[0][0].categories).toHaveLength(10);

    // Moving along the rail must not re-spend a provider call.
    fireEvent.click(screen.getByTestId("places-chip-food_drink"));
    fireEvent.click(screen.getByTestId("places-chip-hotels_stays"));
    expect(mocks.streamNearby).toHaveBeenCalledTimes(1);
  });

  it("shows rows before the sweep has finished", async () => {
    mocks.locationState = LOCATED;
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    mocks.streamNearby.mockImplementation(async (opts: never) => {
      const handlers = (opts as { handlers: { onCategory: (c: string, i: unknown[]) => void } })
        .handlers;
      handlers.onCategory("hotels_stays", [place()]);
      // The sweep is still open: later categories have not answered.
      await held;
      handlers.onCategory("food_drink", [
        place({ placeId: "place-2", name: "Third Wave Coffee", category: "food_drink" }),
      ]);
    });

    render(<PlacesNearby getIdToken={getIdToken} />);

    // This is the whole point of the stream: readable rows while it runs.
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    expect(screen.getByTestId("places-streaming")).toBeTruthy();
    expect(screen.queryByText("Third Wave Coffee")).toBeNull();

    release?.();
    await waitFor(() =>
      expect(screen.getByText("Third Wave Coffee")).toBeTruthy(),
    );
    await waitFor(() => expect(screen.queryByTestId("places-streaming")).toBeNull());
  });

  it("keeps the categories that worked when one of them fails", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockImplementation(
      streamOf([{ category: "hotels_stays", items: [place()] }], {
        failures: [{ category: "transit", message: "This category is unavailable." }],
      }),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    // One dead category is not a dead directory.
    expect(screen.queryByTestId("places-error")).toBeNull();
  });

  it("falls back to one response when the stream cannot run", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockRejectedValue(new Error("No response stream available"));
    mocks.searchNearby.mockResolvedValue({
      groups: [{ category: "hotels_stays", items: [place()] }],
      failed: [],
      meta: { categories: [], radiusMi: 5, limit: 8, attribution: ATTRIBUTION },
    });

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.searchNearby).toHaveBeenCalled());
    // Same rows, same surface. The reader is never shown a transport problem.
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    expect(screen.queryByTestId("places-error")).toBeNull();
  });

  it("offers a ZIP search when the device says no", async () => {
    mocks.locationState = {
      status: "denied",
      permission: "denied",
      snapshot: null,
      error: null,
    };
    render(<PlacesNearby getIdToken={getIdToken} />);

    const input = screen.getByTestId("places-postal-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "560001" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(mocks.streamNearby).toHaveBeenCalled());
    expect(mocks.streamNearby.mock.calls[0][0].origin).toEqual({
      postalCode: "560001",
    });
  });

  it("offers a ZIP when the coordinates are fine but match nothing", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockImplementation(streamOf([]));
    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByTestId("places-empty")).toBeTruthy());
    // An empty answer is not an error, and the way out stays on screen.
    expect(screen.queryByTestId("places-error")).toBeNull();
    expect(screen.getByTestId("places-postal-input")).toBeTruthy();
  });

  it("keeps the radius control usable when nothing came back", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockImplementation(streamOf([]));
    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByTestId("places-empty")).toBeTruthy());
    // Widening is the one thing that can fix an empty result.
    expect(screen.getByText("15 mi")).toBeTruthy();
  });

  it("re-sweeps when the radius changes", async () => {
    mocks.locationState = LOCATED;
    render(<PlacesNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(mocks.streamNearby).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("15 mi"));

    await waitFor(() => expect(mocks.streamNearby).toHaveBeenCalledTimes(2));
    expect(mocks.streamNearby.mock.calls[1][0].radiusMi).toBe(15);
  });

  it("lets the user retry a failure instead of stranding them", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockRejectedValue(new Error("Places are unavailable right now."));
    mocks.searchNearby.mockRejectedValue(
      new Error("Places are unavailable right now."),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByTestId("places-error")).toBeTruthy());
    // A failed sweep must still offer the ZIP box: "Try again" only re-runs the
    // anchor that just failed, which strands anyone whose ZIP was the problem.
    expect(screen.getByTestId("places-postal-input")).toBeTruthy();

    mocks.streamNearby.mockImplementation(
      streamOf([{ category: "hotels_stays", items: [place()] }]),
    );
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
  });

  it("carries the source credit the licence requires", async () => {
    mocks.locationState = LOCATED;
    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() =>
      expect(screen.getByTestId("places-attribution")).toBeTruthy(),
    );
    const footer = screen.getByTestId("places-attribution");
    expect(footer.textContent).toContain("Google");
    expect(footer.querySelector('a[href*="cloud.google.com/maps-platform/terms"]')).toBeTruthy();
  });

  it("does not credit a source it showed nothing from", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockImplementation(streamOf([]));
    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByTestId("places-empty")).toBeTruthy());
    expect(screen.queryByTestId("places-attribution")).toBeNull();
  });

  it("shows one row per place when two categories both return it", async () => {
    mocks.locationState = LOCATED;
    const shared = place({ placeId: "shared-1", name: "Phoenix Mall" });
    mocks.streamNearby.mockImplementation(
      streamOf([
        { category: "shops", items: [shared] },
        { category: "banking", items: [shared] },
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getAllByText("Phoenix Mall")).toHaveLength(1));
  });

  it("orders the merged view by distance, not by which category answered first", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockImplementation(
      streamOf([
        { category: "hotels_stays", items: [place({ placeId: "far", name: "Far Hotel", distanceMeters: 4000 })] },
        { category: "food_drink", items: [place({ placeId: "near", name: "Near Cafe", distanceMeters: 200, category: "food_drink" })] },
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByText("Near Cafe")).toBeTruthy());
    const rendered = screen.getByTestId("places-nearby").textContent ?? "";
    expect(rendered.indexOf("Near Cafe")).toBeLessThan(rendered.indexOf("Far Hotel"));
  });

  it("filters to one category without asking the server again", async () => {
    mocks.locationState = LOCATED;
    mocks.streamNearby.mockImplementation(
      streamOf([
        { category: "hotels_stays", items: [place()] },
        {
          category: "food_drink",
          items: [place({ placeId: "place-2", name: "Third Wave Coffee", category: "food_drink" })],
        },
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(screen.getByText("Third Wave Coffee")).toBeTruthy());

    fireEvent.click(screen.getByTestId("places-chip-hotels_stays"));

    await waitFor(() => expect(screen.queryByText("Third Wave Coffee")).toBeNull());
    expect(screen.getByText("Hotel Vivanta")).toBeTruthy();
    expect(mocks.streamNearby).toHaveBeenCalledTimes(1);
  });

  it("buys the dearer detail fields only when a row is opened", async () => {
    mocks.locationState = LOCATED;
    render(<PlacesNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());

    expect(mocks.getDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Hotel Vivanta"));

    await waitFor(() => expect(mocks.getDetails).toHaveBeenCalledTimes(1));
    expect(mocks.getDetails.mock.calls[0][0]).toMatchObject({ placeId: "place-1" });
  });

  it("shows posted hours and never claims 'open now'", async () => {
    mocks.locationState = LOCATED;
    render(<PlacesNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    fireEvent.click(screen.getByText("Hotel Vivanta"));

    await waitFor(() =>
      expect(screen.getByTestId("place-detail-hours")).toBeTruthy(),
    );
    expect(screen.getByText("Monday: Open 24 hours")).toBeTruthy();
    const surface = screen.getByTestId("place-detail-hours").textContent ?? "";
    expect(surface.toLowerCase()).not.toContain("open now");
  });

  it("keeps the surface open when the detail fetch fails", async () => {
    mocks.locationState = LOCATED;
    mocks.getDetails.mockRejectedValue(new Error("nope"));
    render(<PlacesNearby getIdToken={getIdToken} />);
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    fireEvent.click(screen.getByText("Hotel Vivanta"));

    await waitFor(() =>
      expect(screen.getByTestId("place-detail-partial")).toBeTruthy(),
    );
    // The row's own facts are still shown rather than an error page.
    expect(screen.getAllByText(/Hotel Vivanta/).length).toBeGreaterThan(0);
  });
});
