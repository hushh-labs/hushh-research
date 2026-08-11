import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceContactLookups } from "@/lib/marketplace/contact-matching";

const readContactsMock = vi.fn();

vi.mock("@/lib/capacitor", () => ({
  HushhContacts: {
    readContacts: (...args: unknown[]) => readContactsMock(...args),
  },
}));

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
      displayName: "Avery Stone",
    });
    expect(result.lookups[1]).toMatchObject({
      last4: "0018",
      displayName: "Morgan Lee",
    });
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

  it("caps lookups at the backend limit and keeps mobile numbers first", async () => {
    // The backend rejects the whole request past 1000 lookups, so the cap has
    // to be applied here. Landlines are dropped before mobiles because an
    // SMS-verified account can never be a landline.
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

    expect(result.lookups).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    const landlineNames = result.lookups.filter((lookup) =>
      lookup.displayName?.startsWith("Landline"),
    );
    // 999 mobiles take precedence, leaving room for exactly one landline.
    expect(landlineNames).toHaveLength(1);
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
    expect(result.lookups[0]!.displayName).toBe("Real");
    expect(result.totalContacts).toBe(4);
  });
});
