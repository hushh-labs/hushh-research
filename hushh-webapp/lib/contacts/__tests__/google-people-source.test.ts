import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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

  it("passes the typed number through, not Google's canonical form", async () => {
    // `phone-normalization.ts` exists so both sides of the hash reach
    // byte-identical E.164 through ONE implementation. Google's parser and
    // libphonenumber-js need not agree at the edges, and the moment they
    // disagree the digest misses silently and the person is told nobody
    // matched. The normalizer sees what the user typed.
    respondWith({
      connections: [
        {
          resourceName: "people/1",
          names: [{ displayName: "Asha" }],
          phoneNumbers: [
            { value: "98765 43210", canonicalForm: "+919876543210" },
          ],
        },
      ],
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    expect(result.contacts[0].phoneNumbers).toEqual(["98765 43210"]);
  });

  it("falls back to the canonical form only when there is no typed value", async () => {
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

  it("drops contacts with no phone number", async () => {
    respondWith({
      connections: [
        { resourceName: "a", names: [{ displayName: "Has" }], phoneNumbers: [{ value: "+911" }] },
        { resourceName: "b", names: [{ displayName: "None" }], phoneNumbers: [] },
        { resourceName: "c", names: [{ displayName: "Blank" }], phoneNumbers: [{ value: "  " }] },
      ],
    });

    const result = await googlePeopleContactSource("tok")({ limit: 500 });
    // A contact with no number cannot produce a digest, so carrying it would
    // only inflate the count reported back to the person.
    expect(result.contacts).toHaveLength(1);
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
