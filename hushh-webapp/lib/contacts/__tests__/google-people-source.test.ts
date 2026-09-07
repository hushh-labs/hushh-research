import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_PEOPLE_REQUEST_TIMEOUT_MS,
  googleContactsAvailability,
  googlePeopleContactSource,
} from "../google-people-source";

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: () => mockIsNative(),
}));

let mockIsNative = () => false;

/**
 * The ingress mirror of the egress guards in `contact-signals.test.ts`.
 *
 * Those assert nothing phone-shaped leaves the sync toward the screen. These
 * assert nothing but a `HushhContactsReadResult` leaves this module toward the
 * hashing pipeline — and that the request itself asks Google for the minimum it
 * can be asked for.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;

function respondWith(...pages: unknown[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(String(url));
    const body = pages[Math.min(calls.length - 1, pages.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

beforeEach(() => {
  mockIsNative = () => false;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_CLIENT_ID === undefined) {
    delete process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;
  } else {
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID = ORIGINAL_CLIENT_ID;
  }
  vi.restoreAllMocks();
});

describe("googleContactsAvailability", () => {
  it("is unconfigured without a client id, so the feature is simply absent", () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;
    expect(googleContactsAvailability()).toBe("unconfigured");
  });

  it("is connectable on the web once a client id exists", () => {
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    expect(googleContactsAvailability()).toBe("connectable");
  });

  it("is unconfigured inside the native shell even with a client id", () => {
    // `capacitor.config.ts` sets `iosScheme: "App"`, so the page origin in the
    // iOS shell is `App://localhost`. Google will not accept a non-https custom
    // scheme as an Authorized JavaScript Origin and GIS will not initialise —
    // and native already has the real address book through the plugin, so there
    // is nothing to fall back to.
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    mockIsNative = () => true;
    expect(googleContactsAvailability()).toBe("unconfigured");
  });
});

describe("googlePeopleContactSource", () => {
  it("asks Google for the two fields the pipeline actually reads, and no more", async () => {
    const { calls } = respondWith({ connections: [], totalPeople: 0 });
    await googlePeopleContactSource("tok")({ limit: 500 });

    const url = new URL(calls[0]);
    expect(url.searchParams.get("personFields")).toBe("names,phoneNumbers");
    // Photos, addresses and organisations belong to people who are not our
    // users. There is no reason to receive them.
    expect(url.searchParams.get("personFields")).not.toContain("photos");
    expect(url.searchParams.get("personFields")).not.toContain("addresses");
    // Saved contacts only — not merged profiles Google infers from mail
    // traffic. Somebody emailed once is not somebody you meant to share.
    expect(url.searchParams.get("sources")).toBe("READ_SOURCE_TYPE_CONTACT");
  });

  it("never asks for a sync token", async () => {
    // A sync token is a durable handle to somebody's address book, and there is
    // nowhere in this design to keep one — nothing here is persisted.
    const { calls } = respondWith({ connections: [] });
    await googlePeopleContactSource("tok")({ limit: 500 });
    expect(calls[0]).not.toContain("requestSyncToken");
  });

  it("sends the token as a bearer header and never in the URL", async () => {
    const { calls, fetchMock } = respondWith({ connections: [] });
    await googlePeopleContactSource("secret-token")({ limit: 500 });

    expect(calls[0]).not.toContain("secret-token");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer secret-token");
    expect(init?.cache).toBe("no-store");
  });

  it("prefers Google's canonical E.164 over an ambiguous typed value", async () => {
    // A globally mixed Google address book can contain a US national display
    // value while the signed-in account is Indian. canonicalForm preserves the
    // contact's own country evidence; it still goes through our normalizer.
    respondWith({
      connections: [
        {
          resourceName: "people/us-1",
          names: [{ displayName: "US teammate" }],
          phoneNumbers: [
            { value: "(415) 555-0101", canonicalForm: "+14155550101" },
          ],
        },
      ],
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    expect(result.contacts[0].phoneNumbers).toEqual(["+14155550101"]);
  });

  it("uses a canonical form when there is no typed value", async () => {
    respondWith({
      connections: [
        {
          resourceName: "people/2",
          names: [{ displayName: "Only Canonical" }],
          phoneNumbers: [{ value: "", canonicalForm: "+919876500000" }],
        },
      ],
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    // Still goes THROUGH the normalizer downstream, never around it.
    expect(result.contacts[0].phoneNumbers).toEqual(["+919876500000"]);
  });

  it("falls back to the typed value when canonicalForm is malformed", async () => {
    respondWith({
      connections: [
        {
          resourceName: "people/typed-fallback",
          names: [{ displayName: "Typed fallback" }],
          phoneNumbers: [
            { value: "98765 43210", canonicalForm: "not-e164" },
          ],
        },
      ],
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    expect(result.contacts[0].phoneNumbers).toEqual(["98765 43210"]);
  });

  it("reports google, unlimited, and no region", async () => {
    respondWith({
      connections: [
        {
          resourceName: "people/3",
          names: [{ displayName: "Someone" }],
          phoneNumbers: [{ value: "+919876543210" }],
        },
      ],
      totalPeople: 1,
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });

    expect(result.sourcePlatform).toBe("google");
    // A People read is the whole address book, not a hand-picked subset. This
    // flag is the sole gate on the partial-read copy and its "Check more"
    // remedy, whose action would re-read and return the identical set.
    expect(result.limited).toBe(false);
    // Null, not the browser locale — and strictly better than the picker path.
    // A US-locale browser must not override an Indian account's own verified
    // number when deciding what `9876543210` means.
    expect(result.defaultRegion).toBeNull();
  });

  it("retains returned people with no usable phone as uncheckable rows", async () => {
    respondWith({
      connections: [
        { resourceName: "a", names: [{ displayName: "Has" }], phoneNumbers: [{ value: "+911" }] },
        { resourceName: "b", names: [{ displayName: "None" }], phoneNumbers: [] },
        { resourceName: "c", names: [{ displayName: "Blank" }], phoneNumbers: [{ value: "  " }] },
      ],
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    expect(result.contacts).toHaveLength(3);
    expect(result.contacts.map((contact) => contact.phoneNumbers)).toEqual([
      ["+911"],
      [],
      [],
    ]);
  });

  it("applies the read limit to person rows, including people with no phone", async () => {
    respondWith({
      connections: [
        { resourceName: "a", names: [{ displayName: "None 1" }], phoneNumbers: [] },
        { resourceName: "b", names: [{ displayName: "None 2" }], phoneNumbers: [] },
        { resourceName: "c", names: [{ displayName: "Has" }], phoneNumbers: [{ value: "+911" }] },
      ],
      totalPeople: 3,
    });

    const result = await googlePeopleContactSource("tok")({ limit: 2 });

    expect(result.contacts).toHaveLength(2);
    expect(result.contacts.every((contact) => contact.phoneNumbers.length === 0)).toBe(true);
    expect(result.totalAvailable).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("follows pages and reports truncation honestly", async () => {
    respondWith(
      {
        connections: [
          { resourceName: "a", names: [{ displayName: "One" }], phoneNumbers: [{ value: "+911" }] },
        ],
        nextPageToken: "page-2",
        totalPeople: 2,
      },
      {
        connections: [
          { resourceName: "b", names: [{ displayName: "Two" }], phoneNumbers: [{ value: "+912" }] },
        ],
        totalPeople: 2,
      },
    );

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    expect(result.contacts).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("stops after ten pages even when sparse pages keep returning a cursor", async () => {
    const { calls } = respondWith(
      ...Array.from({ length: 11 }, (_, page) => ({
        connections: [{ resourceName: `people/${page + 1}` }],
        nextPageToken: `page-${page + 2}`,
        totalPeople: 11,
      })),
    );

    const result = await googlePeopleContactSource("tok")({ limit: 10_000 });

    expect(calls).toHaveLength(10);
    expect(new URL(calls[9]).searchParams.get("pageToken")).toBe("page-10");
    expect(result.contacts).toHaveLength(10);
    expect(result.contacts.at(-1)?.id).toBe("people/10");
    expect(result).toMatchObject({ totalAvailable: 11, truncated: true });
  });

  it.each([false, true])(
    "reads 10,000 people and reports whether another page exists (%s)",
    async (hasMore) => {
      const { calls } = respondWith(
        ...Array.from({ length: 10 }, (_, page) => ({
          connections: Array.from({ length: 1000 }, (_, index) => ({
            resourceName: `people/${page * 1000 + index + 1}`,
            phoneNumbers: [{ value: "+14155550101" }],
          })),
          nextPageToken: page < 9 || hasMore ? `page-${page + 2}` : null,
          totalPeople: hasMore ? 10_001 : 10_000,
        })),
      );

      const result = await googlePeopleContactSource("tok")({ limit: 10_000 });

      expect(calls).toHaveLength(10);
      expect(calls.every((url) => new URL(url).searchParams.get("pageSize") === "1000")).toBe(true);
      expect(result.contacts).toHaveLength(10_000);
      expect(result.contacts.at(-1)?.id).toBe("people/10000");
      expect(result.truncated).toBe(hasMore);
      expect(result.totalAvailable).toBe(hasMore ? 10_001 : 10_000);
    },
  );

  it("aborts and rejects a stalled fetch at the request deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const reading = googlePeopleContactSource("tok")({ limit: 500 });
    const rejected = expect(reading).rejects.toThrow(/took too long.*try again/i);

    await vi.advanceTimersByTimeAsync(GOOGLE_PEOPLE_REQUEST_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(requestSignal?.aborted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while a successful response body is stalled", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const json = vi.fn(() => new Promise<unknown>(() => {}));
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return { ok: true, status: 200, json } as unknown as Response;
    });
    const reading = googlePeopleContactSource("tok")({ limit: 500 });
    const rejected = expect(reading).rejects.toThrow(/took too long.*try again/i);

    await vi.advanceTimersByTimeAsync(GOOGLE_PEOPLE_REQUEST_TIMEOUT_MS - 1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a completed page's deadline before advancing to the next page", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          connections: [{ resourceName: `people/${signals.length}` }],
          nextPageToken: signals.length === 1 ? "page-2" : null,
          totalPeople: 2,
        }),
      } as Response;
    });
    const reading = googlePeopleContactSource("tok")({ limit: 500 });

    await vi.advanceTimersByTimeAsync(40_000);
    const result = await reading;

    expect(result.contacts).toHaveLength(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says so when the token has expired rather than reporting an empty book", async () => {
    // An empty result and a refused one look identical downstream — one says
    // "nobody you know is here", which is a lie.
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      googlePeopleContactSource("stale")({ limit: 500 }),
    ).rejects.toThrow(/expired|connect again/i);
  });

  it("distinguishes app configuration failures from an expired token", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      googlePeopleContactSource("valid-but-unconfigured")({ limit: 500 }),
    ).rejects.toThrow(/unavailable for this app or account/i);
  });

  it("returns nothing but a read result — no raw response, no token", async () => {
    respondWith({
      connections: [
        {
          resourceName: "people/9",
          names: [{ displayName: "Asha" }],
          phoneNumbers: [{ value: "+919876543210", canonicalForm: "+919876543210" }],
        },
      ],
      nextPageToken: null,
      totalPeople: 1,
    });

    const result = await googlePeopleContactSource("super-secret")({ limit: 500 });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("canonicalForm");
    expect(serialized).not.toContain("nextPageToken");
    expect(Object.keys(result).sort()).toEqual(
      [
        "contacts",
        "defaultRegion",
        "limited",
        "sourcePlatform",
        "totalAvailable",
        "truncated",
      ].sort(),
    );
  });
});
