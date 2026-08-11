// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetchStream: vi.fn(),
  apiFetch: vi.fn(),
  request: vi.fn(),
  refresh: vi.fn(),
}));

// The snapshot object is hoisted, not rebuilt per render. The real hook reads
// from a singleton bus and hands back the same reference until the position
// actually changes; a fresh object each render would retrigger the anchor
// effect forever, which tests the mock rather than the component.
const SNAPSHOT = { latitude: 12.9716, longitude: 77.5946 };

vi.mock("@/lib/one-location/use-current-location", () => ({
  useCurrentLocation: () => ({
    status: "ready",
    permission: "granted",
    snapshot: SNAPSHOT,
    error: null,
    request: mocks.request,
    refresh: mocks.refresh,
  }),
}));

// Deliberately NOT mocking places-directory-service: the point of this file is
// to exercise the component through the real client, which is the seam the
// component tests mock away and where the surface actually broke on UAT.
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetchStream: mocks.apiFetchStream,
    apiFetch: mocks.apiFetch,
  },
}));

import { PlacesNearby } from "@/components/connect/places-nearby";

const PLACE = {
  placeId: "p1",
  name: "Hotel Vivanta",
  address: "12 Residency Rd",
  distanceMeters: 640,
  primaryType: "hotel",
  categoryLabel: "Hotel",
  category: "hotels_stays",
  businessStatus: "OPERATIONAL",
};

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ event, ...data })}\n\n`;
}

function streamingResponse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader: () => ({
        read: async () =>
          i < pieces.length
            ? { done: false, value: encoder.encode(pieces[i++]) }
            : { done: true, value: undefined },
        releaseLock: () => undefined,
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

const getIdToken = async () => "id-token";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlacesNearby end to end through the real client", () => {
  it("renders rows from the exact bytes the backend emits", async () => {
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("meta", {
          categories: ["hotels_stays"],
          radiusMi: 5,
          limit: 8,
          attribution: {
            source: "Google",
            sourceUrl: "https://www.google.com/maps",
            termsUrl: "https://cloud.google.com/maps-platform/terms",
            notice: "Place data from Google Maps Platform.",
            retrievedAt: "2026-08-10T09:00:00.000Z",
          },
        }),
        frame("results", { category: "hotels_stays", items: [PLACE] }),
        frame("done", { delivered: 1, failed: [], terminal: true }),
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.apiFetchStream).toHaveBeenCalled());
    // The whole point: a real byte stream must become a visible row.
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    expect(screen.queryByTestId("places-empty")).toBeNull();
  });

  it("does not claim the area is empty when every category failed", async () => {
    // The provider answering "no" ten times is not the same as there being
    // nothing nearby, and saying "Nothing nearby" there is a lie the reader
    // cannot act on. This is what UAT showed.
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("meta", { categories: ["hotels_stays", "food_drink"] }),
        frame("category_error", { category: "hotels_stays", message: "upstream" }),
        frame("category_error", { category: "food_drink", message: "upstream" }),
        frame("done", { delivered: 0, failed: ["hotels_stays", "food_drink"], terminal: true }),
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.apiFetchStream).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("places-error")).toBeTruthy());
    expect(screen.queryByTestId("places-empty")).toBeNull();
  });

  it("still says nothing nearby when the provider genuinely returned nothing", async () => {
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("meta", { categories: ["hotels_stays"] }),
        frame("results", { category: "hotels_stays", items: [] }),
        frame("done", { delivered: 0, failed: [], terminal: true }),
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByTestId("places-empty")).toBeTruthy());
    expect(screen.queryByTestId("places-error")).toBeNull();
  });

  it("falls back when a proxy buffers the stream into JSON", async () => {
    // This is the exact UAT failure. The /api/one proxy did
    // `await response.json().catch(() => ({}))` on every response, so an
    // event-stream came back as `{}` with status 200: no frames, no error, and
    // a surface that said "Nothing nearby" while the backend had just sent
    // 23 KB of places. The stream must be recognised as not-a-stream so the
    // ordinary endpoint answers instead.
    mocks.apiFetchStream.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock: () => undefined }) },
    } as unknown as Response);
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        groups: [{ category: "hotels_stays", items: [PLACE] }],
        failed: [],
        meta: { categories: [], radiusMi: 5, limit: 8, attribution: null },
      }),
    } as unknown as Response);

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    expect(screen.queryByTestId("places-empty")).toBeNull();
  });

  it("does not re-sweep on its own after one successful sweep", async () => {
    // A sweep that refires invalidates its own in-flight results through the
    // sequence guard, so the surface can request forever and render nothing.
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("results", { category: "hotels_stays", items: [PLACE] }),
      ]),
    );

    render(<PlacesNearby getIdToken={getIdToken} />);

    await waitFor(() => expect(screen.getByText("Hotel Vivanta")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
  });
});
