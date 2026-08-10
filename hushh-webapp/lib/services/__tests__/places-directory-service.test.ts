// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetchStream: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetchStream: mocks.apiFetchStream,
    apiFetch: mocks.apiFetch,
  },
}));

import { PlacesDirectoryService } from "@/lib/services/places-directory-service";

/**
 * The parsing path the component tests never touch.
 *
 * Every test in `places-nearby.test.tsx` mocks `PlacesDirectoryService`
 * wholesale, so the code that turns provider bytes into rows had no coverage at
 * all -- which is exactly where the surface broke on UAT while every test was
 * green. These drive the real reader against real frame bytes.
 */

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

/** A Response whose body streams the given string pieces, as the server does. */
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

function collect() {
  const categories: { category: string; count: number }[] = [];
  const errors: string[] = [];
  let meta: unknown = null;
  return {
    categories,
    errors,
    get meta() {
      return meta;
    },
    handlers: {
      onMeta: (m: unknown) => {
        meta = m;
      },
      onCategory: (category: string, items: unknown[]) =>
        categories.push({ category, count: items.length }),
      onCategoryError: (_c: string, m: string) => errors.push(m),
    },
  };
}

const BASE = {
  idToken: "id-token",
  origin: { latitude: 12.9716, longitude: 77.5946 },
  categories: ["hotels_stays"],
  radiusMi: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlacesDirectoryService.streamNearby", () => {
  it("delivers rows from frames the server actually sends", async () => {
    const sink = collect();
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("meta", { categories: ["hotels_stays"], attribution: { source: "Google" } }),
        frame("results", { category: "hotels_stays", items: [PLACE] }),
        frame("done", { delivered: 1, failed: [], terminal: true }),
      ]),
    );

    await PlacesDirectoryService.streamNearby({ ...BASE, handlers: sink.handlers });

    expect(sink.categories).toEqual([{ category: "hotels_stays", count: 1 }]);
    expect(sink.meta).toBeTruthy();
  });

  it("reassembles a frame split across two reads", async () => {
    // The provider does not respect our frame boundaries; a row can arrive in
    // two pieces and must not be dropped.
    const whole = frame("results", { category: "hotels_stays", items: [PLACE] });
    const cut = Math.floor(whole.length / 2);
    const sink = collect();
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([whole.slice(0, cut), whole.slice(cut)]),
    );

    await PlacesDirectoryService.streamNearby({ ...BASE, handlers: sink.handlers });

    expect(sink.categories).toEqual([{ category: "hotels_stays", count: 1 }]);
  });

  it("delivers a final frame that arrives without a trailing blank line", async () => {
    // A stream can end on a frame whose terminator never comes. The last
    // category's rows must still be delivered rather than sitting in the buffer.
    const sink = collect();
    const unterminated = `event: results\ndata: ${JSON.stringify({
      event: "results",
      category: "hotels_stays",
      items: [PLACE],
    })}`;
    mocks.apiFetchStream.mockResolvedValue(streamingResponse([unterminated]));

    await PlacesDirectoryService.streamNearby({ ...BASE, handlers: sink.handlers });

    expect(sink.categories).toEqual([{ category: "hotels_stays", count: 1 }]);
  });

  it("delivers every category when the whole stream arrives as one chunk", async () => {
    // A buffering intermediary collapses the stream into one read. Correct
    // behaviour is still every row, just not progressively.
    const sink = collect();
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("meta", { categories: ["hotels_stays", "food_drink"] }) +
          frame("results", { category: "hotels_stays", items: [PLACE] }) +
          frame("results", { category: "food_drink", items: [PLACE] }) +
          frame("done", { delivered: 2, failed: [], terminal: true }),
      ]),
    );

    await PlacesDirectoryService.streamNearby({ ...BASE, handlers: sink.handlers });

    expect(sink.categories.map((c) => c.category)).toEqual([
      "hotels_stays",
      "food_drink",
    ]);
  });

  it("reports a failed category without rejecting the whole stream", async () => {
    const sink = collect();
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("category_error", { category: "transit", message: "upstream said no" }),
        frame("results", { category: "hotels_stays", items: [PLACE] }),
        frame("done", { delivered: 1, failed: ["transit"], terminal: true }),
      ]),
    );

    await PlacesDirectoryService.streamNearby({ ...BASE, handlers: sink.handlers });

    expect(sink.errors).toEqual(["upstream said no"]);
    expect(sink.categories).toEqual([{ category: "hotels_stays", count: 1 }]);
  });

  it("ignores heartbeats", async () => {
    const sink = collect();
    mocks.apiFetchStream.mockResolvedValue(
      streamingResponse([
        frame("heartbeat", {}),
        frame("results", { category: "hotels_stays", items: [PLACE] }),
      ]),
    );

    await PlacesDirectoryService.streamNearby({ ...BASE, handlers: sink.handlers });

    expect(sink.categories).toEqual([{ category: "hotels_stays", count: 1 }]);
  });

  it("sends coordinates in the body, never in the path", async () => {
    mocks.apiFetchStream.mockResolvedValue(streamingResponse([]));

    await PlacesDirectoryService.streamNearby({
      ...BASE,
      handlers: collect().handlers,
    });

    const [path, init] = mocks.apiFetchStream.mock.calls[0];
    expect(path).toBe("/api/one/places/stream");
    expect(path).not.toContain("lat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ lat: 12.9716, lng: 77.5946 });
  });
});
