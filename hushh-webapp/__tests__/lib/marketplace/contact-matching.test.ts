import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMarketplaceContactLookups,
  buildMarketplaceContactLookupsFromQuery,
} from "@/lib/marketplace/contact-matching";

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
      contacts: [
        {
          id: "1",
          displayName: "Avery Stone",
          phoneNumbers: ["(415) 555-0101", "+1 415 555 0101"],
          emailAddresses: ["AVERY@example.com", "avery@example.com"],
        },
        {
          id: "2",
          displayName: "Morgan Lee",
          phoneNumbers: ["020 7946 0018"],
          emailAddresses: ["morgan@example.net"],
        },
      ],
    });

    const result = await buildMarketplaceContactLookups({ limit: 20 });

    expect(readContactsMock).toHaveBeenCalledWith({ limit: 20 });
    expect(result.totalContacts).toBe(2);
    expect(result.sourcePlatform).toBe("ios");
    expect(result.lookups).toHaveLength(2);
    expect(result.phoneLookups).toHaveLength(2);
    expect(result.emailLookups).toHaveLength(2);
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
    for (const lookup of result.emailLookups) {
      expect(lookup.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(lookup.hash).not.toContain("@");
    }
  });

  it("builds exact email and phone query lookups without raw identifiers", async () => {
    const emailResult = await buildMarketplaceContactLookupsFromQuery("Person@Example.com");
    expect(emailResult.phoneLookups).toHaveLength(0);
    expect(emailResult.emailLookups).toEqual([
      {
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(JSON.stringify(emailResult)).not.toContain("Person@Example.com");

    const phoneResult = await buildMarketplaceContactLookupsFromQuery("(415) 555-0101");
    expect(phoneResult.emailLookups).toHaveLength(0);
    expect(phoneResult.phoneLookups).toEqual([
      {
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        last4: "0101",
      },
    ]);
    expect(JSON.stringify(phoneResult)).not.toContain("415");

    await expect(buildMarketplaceContactLookupsFromQuery("RIA 12")).resolves.toEqual({
      phoneLookups: [],
      emailLookups: [],
    });
  });
});
