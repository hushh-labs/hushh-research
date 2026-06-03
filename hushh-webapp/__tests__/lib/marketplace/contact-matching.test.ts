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
      contacts: [
        {
          id: "1",
          displayName: "Avery Stone",
          phoneNumbers: ["(415) 555-0101", "+1 415 555 0101"],
        },
        {
          id: "2",
          displayName: "Morgan Lee",
          phoneNumbers: ["020 7946 0018"],
        },
      ],
    });

    const result = await buildMarketplaceContactLookups({ limit: 20 });

    expect(readContactsMock).toHaveBeenCalledWith({ limit: 20 });
    expect(result.totalContacts).toBe(2);
    expect(result.sourcePlatform).toBe("ios");
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
});
