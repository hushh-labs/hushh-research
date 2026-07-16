import { describe, expect, it } from "vitest";

import { getFinancialCompatibilityView } from "@/lib/kai/brokerage/financial-sources";

describe("financial reader compatibility", () => {
  it("produces the same active holdings from v6 and normalized v7 storage", () => {
    const v6 = getFinancialCompatibilityView({
      profile: { risk_tolerance: "balanced" },
      sources: {
        active_source: "statement",
        statement: {
          active_snapshot_id: "statement-1",
          snapshots: [
            {
              id: "statement-1",
              canonical_v2: {
                holdings: [{ symbol: "TEST", quantity: 2, market_value: 20 }],
              },
            },
          ],
        },
      },
    });
    const v7 = getFinancialCompatibilityView({
      pkm_contract_version: "7.0.0",
      financial_core_v7: {
        active_source: "statement",
        profile: { risk_tolerance: "balanced" },
        accounts: { account_1: { account_id: "account_1" } },
        securities: {
          security_1: { security_id: "security_1", symbol: "TEST" },
        },
        positions: {
          position_1: {
            account_id: "account_1",
            security_id: "security_1",
            quantity: 2,
            market_value: 20,
          },
        },
      },
      source_artifacts_v7: {
        statement_snapshots: [
          { id: "statement-1", artifact_ref: "sha256:statement-sentinel" },
        ],
      },
    });

    expect(v6.storageContract).toBe("v6");
    expect(v7.storageContract).toBe("v7");
    expect(v7.activePortfolio?.holdings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "TEST",
          quantity: 2,
          account_id: "account_1",
          security_id: "security_1",
          position_id: "position_1",
        }),
      ])
    );
    expect(v7.profile).toEqual(v6.profile);
    expect(v7.sourceArtifactRefs).toEqual(["sha256:statement-sentinel"]);
  });
});
