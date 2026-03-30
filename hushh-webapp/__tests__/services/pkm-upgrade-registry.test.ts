import { describe, expect, it } from "vitest";

import { runDomainUpgrade } from "@/lib/personal-knowledge-model/upgrade-registry";

describe("runDomainUpgrade", () => {
  it("treats unversioned data as a bootstrap into the current PKM contract", () => {
    const result = runDomainUpgrade({
      domain: "financial",
      domainData: {
        portfolio: {
          entities: {
            demo: {
              holdings: [{ symbol: "AAPL" }],
            },
          },
        },
      },
      currentVersion: 0,
    });

    expect(result.domainData).toEqual({
      portfolio: {
        entities: {
          demo: {
            holdings: [{ symbol: "AAPL" }],
          },
        },
      },
    });
    expect(result.newDomainContractVersion).toBe(2);
    expect(result.notes[0]).toContain("Personal Knowledge Model contract");
  });
});
