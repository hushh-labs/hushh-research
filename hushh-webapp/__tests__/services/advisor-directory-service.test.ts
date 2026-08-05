import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import {
  AdvisorDirectoryService,
  formatAdvisorSubtitle,
  formatDistance,
  type AdvisorCard,
} from "@/lib/services/advisor-directory-service";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const EMPTY_RESULT = {
  items: [],
  meta: { grouped: false, hasMore: false, nextOffset: null, returned: 0 },
  attribution: { source: "FINRA BrokerCheck", url: "https://x" },
};

function requestedUrl(): URL {
  return new URL(String(mockApiFetch.mock.calls[0][0]), "https://app.test");
}

function requestedBody(): Record<string, unknown> {
  const init = mockApiFetch.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue(jsonResponse(EMPTY_RESULT));
});

describe("AdvisorDirectoryService.searchNearby", () => {
  it("never puts the user's position in a URL", async () => {
    // A query string lands in the server access log, browser history and any
    // Referer. Coordinates travel in the request body instead.
    await AdvisorDirectoryService.searchNearby({
      idToken: "id-token",
      latitude: 47.676912,
      longitude: -122.206045,
      radiusMi: 25,
    });

    const url = requestedUrl();
    expect(url.pathname).toBe("/api/one/advisors/search");
    expect(url.search).toBe("");
    expect(String(mockApiFetch.mock.calls[0][0])).not.toMatch(/47\.67|122\.20/);

    const init = mockApiFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(requestedBody()).toMatchObject({
      lat: 47.676912,
      lng: -122.206045,
      radiusMi: 25,
      limit: 10,
      offset: 0,
    });
  });

  it("falls back to a postal code when there are no coordinates", async () => {
    await AdvisorDirectoryService.searchNearby({
      idToken: "id-token",
      postalCode: "98033",
    });

    const body = requestedBody();
    expect(body.postalCode).toBe("98033");
    expect(body.lat).toBeUndefined();
    expect(requestedUrl().search).toBe("");
  });

  it("pages from the offset the server handed back", async () => {
    await AdvisorDirectoryService.searchNearby({
      idToken: "id-token",
      latitude: 1,
      longitude: 2,
      offset: 30,
    });

    expect(requestedBody().offset).toBe(30);
  });

  it("surfaces the server's message rather than a bare status", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        { detail: { code: "ONE_ADVISORS_UNAVAILABLE", message: "Try again shortly." } },
        429,
      ),
    );

    await expect(
      AdvisorDirectoryService.searchNearby({
        idToken: "id-token",
        latitude: 1,
        longitude: 2,
      }),
    ).rejects.toThrow("Try again shortly.");
  });

  it("never shows the reader our own plumbing", async () => {
    // A 503 means this deployment has no directory wired up. "not configured
    // on this backend" is a sentence no user should be made to read.
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "ONE_ADVISORS_UNAVAILABLE",
            message: "The advisor directory is not configured on this backend.",
          },
        },
        503,
      ),
    );

    await expect(
      AdvisorDirectoryService.searchNearby({
        idToken: "id-token",
        latitude: 1,
        longitude: 2,
      }),
    ).rejects.toThrow("Not available yet.");
  });

  it("still fails cleanly when the error body is unreadable", async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await expect(
      AdvisorDirectoryService.searchNearby({
        idToken: "id-token",
        latitude: 1,
        longitude: 2,
      }),
    ).rejects.toThrow("Advisors are unavailable right now.");
  });
});

describe("AdvisorDirectoryService.getProfile", () => {
  it("encodes the crd into the path", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ profile: { crd: "862222" } }));

    const profile = await AdvisorDirectoryService.getProfile({
      idToken: "id-token",
      crd: "862222",
    });

    expect(requestedUrl().pathname).toBe("/api/one/advisors/862222");
    expect(profile.crd).toBe("862222");
  });
});

describe("formatDistance", () => {
  it("always reads as approximate", () => {
    // FINRA geocodes to ZIP centroids, so a precise figure would be fiction.
    expect(formatDistance(0.47)).toBe("~0.5 mi");
    expect(formatDistance(2.04)).toBe("~2.0 mi");
    expect(formatDistance(12.4)).toBe("~12 mi");
  });

  it("renders nothing rather than inventing a distance", () => {
    // A ZIP search measures from the centroid it was given, so every row comes
    // back at exactly 0. "~0.1 mi" would be a number we made up.
    expect(formatDistance(0)).toBeNull();
    // A real, tiny coordinate distance still rounds up to the floor.
    expect(formatDistance(0.02)).toBe("~0.1 mi");
  });

  it("returns nothing when there is no usable distance", () => {
    expect(formatDistance(null)).toBeNull();
    expect(formatDistance(undefined)).toBeNull();
    expect(formatDistance(Number.NaN)).toBeNull();
    expect(formatDistance(-1)).toBeNull();
  });
});

describe("formatAdvisorSubtitle", () => {
  const base: AdvisorCard = {
    kind: "advisor",
    id: "1",
    name: "A Advisor",
    firmName: "Morgan Stanley",
    yearsExperience: 47.5,
    distanceMiles: 0.4,
    city: "Kirkland",
    state: "WA",
    phone: null,
  };

  it("reads as one short line", () => {
    expect(formatAdvisorSubtitle(base)).toBe("Morgan Stanley · 47 yrs");
  });

  it("drops the parts that do not exist", () => {
    expect(
      formatAdvisorSubtitle({ ...base, yearsExperience: null }),
    ).toBe("Morgan Stanley");
    expect(
      formatAdvisorSubtitle({ ...base, firmName: null, yearsExperience: null }),
    ).toBeNull();
  });

  it("describes a branch by its size, not a person's tenure", () => {
    expect(
      formatAdvisorSubtitle({
        ...base,
        kind: "branch",
        advisorCount: 74,
        firmName: null,
      }),
    ).toBe("74 advisors · Kirkland");
  });
});
