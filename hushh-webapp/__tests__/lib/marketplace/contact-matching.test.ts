import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceContactLookups } from "@/lib/marketplace/contact-matching";

const readContactsMock = vi.fn();

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    readContacts: (...args: unknown[]) => readContactsMock(...args),
  },
}));

/**
 * The injected-source cases. Google Contacts feeds the SAME pipeline as the
 * device address book — normalization, dedupe, mobile-first ordering, the 1000
 * cap and the hashing all have exactly one implementation, and these pin that
 * a second source does not get a second copy of any of it.
 */
describe("buildMarketplaceContactLookups with an injected source", () => {
  const googleResult = {
    contacts: [
      { id: "g1", displayName: "Asha", phoneNumbers: ["98765 43210"] },
      { id: "g2", displayName: "Asha again", phoneNumbers: ["+91 98765 43210"] },
      { id: "g3", displayName: "Landline", phoneNumbers: ["+91 11 2345 6789"] },
    ],
    sourcePlatform: "google" as const,
    defaultRegion: null,
    limited: false,
    truncated: false,
    totalAvailable: 3,
  };

  it("dedupes across the source exactly as it does for the device book", async () => {
    const source = vi.fn(async () => googleResult);
    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: "+919000000000",
      source,
    });

    // Two spellings of one number collapse to one digest.
    const digests = new Set(result.lookups.map((l) => l.hash));
    expect(digests.size).toBe(result.lookups.length);
    expect(result.sourcePlatform).toBe("google");
    expect(result.limited).toBe(false);
  });

  it("sends the source only the limit, and nothing else", async () => {
    // A source has no business receiving the account phone number or the abort
    // signal. Both stay on this side of the seam.
    const source = vi.fn(async () => googleResult);
    await buildMarketplaceContactLookups({
      limit: 42,
      accountPhoneNumber: "+919000000000",
      source,
    });
    expect(source).toHaveBeenCalledWith({ limit: 42 });
  });

  it("reads a newly hydrated account phone after the Google source returns", async () => {
    let hydratedPhone: string | null = null;
    const source = vi.fn(async () => {
      hydratedPhone = "+919000000000";
      return googleResult;
    });

    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: null,
      resolveAccountPhoneNumber: () => hydratedPhone,
      source,
    });

    expect(result.region).toBe("IN");
    // The local and +91 spellings of Asha's number converge to one lookup.
    expect(result.lookups).toHaveLength(2);
  });

  it("still hashes on this side, never trusting the source for a digest", async () => {
    const source = vi.fn(async () => googleResult);
    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: "+919000000000",
      source,
    });
    for (const lookup of result.lookups) {
      expect(lookup.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("propagates truncation from the source", async () => {
    const source = vi.fn(async () => ({ ...googleResult, truncated: true }));
    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: "+919000000000",
      source,
    });
    expect(result.truncated).toBe(true);
  });

  it("classifies returned Google people without usable phones as uncheckable", async () => {
    const source = vi.fn(async () => ({
      ...googleResult,
      contacts: [
        { id: "g1", displayName: "Asha", phoneNumbers: ["98765 43210"] },
        { id: "g2", displayName: "No phone", phoneNumbers: [] },
        { id: "g3", displayName: "Blank phone", phoneNumbers: ["  "] },
      ],
    }));

    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: "+919000000000",
      source,
    });

    expect(result).toMatchObject({
      totalContacts: 3,
      readContactCount: 3,
      unreadContactCount: 0,
      uncheckableContactCount: 2,
    });
  });
});

describe("marketplace contact matching", () => {
  beforeEach(() => {
    readContactsMock.mockReset();
  });

  it("hashes normalized phone numbers and deduplicates equivalent local contacts", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "ios",
      defaultRegion: "US",
      contacts: [
        {
          id: "1",
          displayName: "Avery Stone",
          phoneNumbers: ["(415) 555-0101", "+1 415 555 0101"],
        },
        {
          id: "2",
          displayName: "Morgan Lee",
          phoneNumbers: ["+44 20 7946 0018"],
        },
      ],
    });

    const result = await buildMarketplaceContactLookups({ limit: 20 });

    expect(readContactsMock).toHaveBeenCalledWith({ limit: 20 });
    expect(result.totalContacts).toBe(2);
    expect(result.sourcePlatform).toBe("ios");
    expect(result.region).toBe("US");
    // The two Avery entries are the same E.164 and collapse to one lookup.
    expect(result.lookups).toHaveLength(2);
    expect(result.lookups[0]).toMatchObject({
      last4: "0101",
      lookupId: "lookup_1",
    });
    expect(result.lookups[1]).toMatchObject({
      last4: "0018",
      lookupId: "lookup_2",
    });
    expect(result.contacts.map((contact) => contact.displayName)).toEqual([
      "Avery Stone",
      "Morgan Lee",
    ]);
    for (const lookup of result.lookups) {
      expect(lookup.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(lookup.hash).not.toContain(lookup.last4);
    }
  });

  it("reads national numbers in the device region rather than assuming +1", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "IN",
      contacts: [
        { id: "1", displayName: "Asha", phoneNumbers: ["9876543210"] },
        { id: "2", displayName: "Asha (alt)", phoneNumbers: ["09876543210"] },
      ],
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.region).toBe("IN");
    // Both spellings are the same Indian mobile, so they dedupe to one hash —
    // and that hash must be of +919876543210, not +19876543210.
    expect(result.lookups).toHaveLength(1);

    const expectedDigest = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode("+919876543210"))
      .then((buffer) =>
        Array.from(new Uint8Array(buffer))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      );
    expect(result.lookups[0]!.hash).toBe(expectedDigest);
  });

  it("prefers the account's own region when the device does not report one", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: null,
      contacts: [{ id: "1", displayName: "Asha", phoneNumbers: ["9876543210"] }],
    });

    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: "+919000000000",
    });

    expect(result.region).toBe("IN");
    expect(result.lookups).toHaveLength(1);
  });

  it("keeps large books complete so the caller can batch without false unmatched rows", async () => {
    const mobiles = Array.from({ length: 999 }, (_, index) => ({
      id: `m${index}`,
      displayName: `Mobile ${index}`,
      phoneNumbers: [`+9198765${String(index).padStart(5, "0")}`],
    }));
    const landlines = Array.from({ length: 20 }, (_, index) => ({
      id: `l${index}`,
      displayName: `Landline ${index}`,
      phoneNumbers: [`+4420794600${String(index).padStart(2, "0")}`],
    }));
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "IN",
      contacts: [...landlines, ...mobiles],
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.lookups).toHaveLength(1019);
    expect(result.contacts).toHaveLength(1019);
    expect(result.truncated).toBe(false);
    expect(new Set(result.lookups.map((lookup) => lookup.lookupId)).size).toBe(
      1019,
    );
  });

  it("caps unique lookups at 5000 and marks only overflow coverage incomplete", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "US",
      contacts: Array.from({ length: 5001 }, (_, index) => ({
        id: `c${index}`,
        displayName: `Contact ${index}`,
        phoneNumbers: [`+1212${String(index).padStart(7, "0")}`],
      })),
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.lookups).toHaveLength(5000);
    expect(result.lookupLimitExceeded).toBe(true);
    expect(result.lookupLimitedContactCount).toBe(1);
    expect(result.contacts.filter((contact) => !contact.coverageComplete)).toHaveLength(1);
    expect(result.uncheckableContactCount).toBe(0);
  });

  it("caps a 5,000-contact two-number book deterministically without returning E.164", async () => {
    const contacts = Array.from({ length: 5000 }, (_, index) => ({
      id: `contact-${index}`,
      displayName: `Contact ${index}`,
      phoneNumbers: [
        `+919${String(index * 2).padStart(9, "0")}`,
        `+919${String(index * 2 + 1).padStart(9, "0")}`,
      ],
    }));
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "IN",
      contacts,
    });

    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");
    const first = await buildMarketplaceContactLookups({ limit: 5000 });

    expect(first.lookups).toHaveLength(5000);
    expect(first.lookupLimitExceeded).toBe(true);
    expect(digestSpy).toHaveBeenCalledTimes(5000);
    expect(first.lookupLimitedContactCount).toBe(2500);
    expect(first.contacts.slice(0, 2500).every((row) => row.coverageComplete)).toBe(true);
    expect(first.contacts.slice(2500).every((row) => !row.coverageComplete)).toBe(true);
    expect(first.contacts[0]?.lookupIds).toEqual(["lookup_1", "lookup_2"]);
    expect(first.contacts[2499]?.lookupIds).toEqual([
      "lookup_4999",
      "lookup_5000",
    ]);
    expect(JSON.stringify(first)).not.toContain("+919");
    digestSpy.mockRestore();
  });

  it("propagates partial-access and truncation flags from the platform", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "ios",
      defaultRegion: "US",
      limited: true,
      truncated: true,
      totalAvailable: 4000,
      contacts: [{ id: "1", displayName: "Ada", phoneNumbers: ["4155550101"] }],
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.limited).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("skips contact entries that are not usable phone numbers", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "IN",
      contacts: [
        { id: "1", displayName: "Short code", phoneNumbers: ["11"] },
        { id: "2", displayName: "Empty", phoneNumbers: [] },
        { id: "3", displayName: "Junk", phoneNumbers: ["n/a"] },
        { id: "4", displayName: "Real", phoneNumbers: ["9876543210"] },
      ],
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.lookups).toHaveLength(1);
    expect(
      result.contacts.find((contact) => contact.displayName === "Real")
        ?.lookupIds,
    ).toEqual(["lookup_1"]);
    expect(result.totalContacts).toBe(4);
    expect(result.uncheckableContactCount).toBe(3);
  });

  it("maps one deduplicated lookup back to every local contact that uses it", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "IN",
      contacts: [
        { id: "1", displayName: "Asha", phoneNumbers: ["9876543210"] },
        {
          id: "2",
          displayName: "Asha duplicate",
          phoneNumbers: ["+91 98765 43210"],
        },
      ],
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.lookups).toHaveLength(1);
    expect(result.contacts.map((contact) => contact.lookupIds)).toEqual([
      ["lookup_1"],
      ["lookup_1"],
    ]);
  });

  it("counts source rows that were not returned as unread contacts", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "ios",
      defaultRegion: "US",
      totalAvailable: 25,
      contacts: [
        { id: "1", displayName: "Ada", phoneNumbers: ["4155550101"] },
      ],
    });

    const result = await buildMarketplaceContactLookups();

    expect(result.readContactCount).toBe(1);
    expect(result.totalContacts).toBe(25);
    expect(result.unreadContactCount).toBe(24);
  });

  it("excludes the signed-in person's own verified number locally", async () => {
    readContactsMock.mockResolvedValue({
      sourcePlatform: "android",
      defaultRegion: "IN",
      contacts: [
        { id: "self", displayName: "Me", phoneNumbers: ["9000000000"] },
        { id: "friend", displayName: "Asha", phoneNumbers: ["9876543210"] },
      ],
    });

    const result = await buildMarketplaceContactLookups({
      accountPhoneNumber: "+919000000000",
    });

    expect(result.lookups).toHaveLength(1);
    expect(result.excludedSelfContactCount).toBe(1);
    expect(result.uncheckableContactCount).toBe(0);
    expect(
      result.contacts.find((contact) => contact.displayName === "Me")?.lookupIds,
    ).toEqual([]);
  });
});
