import { describe, expect, it } from "vitest";
import { applySnapshot, removeConnection } from "@/lib/kai/plaid-vault/projection";
import { readFinancialNws } from "@/lib/kai/plaid-vault/nws-financial-report";
import { NOW } from "./fixtures";
import { linkedFirstPlatypus } from "./projection-fixture";

describe("owner net worth score projection", () => {
  it("uses committed records for the score and drops it when the final Item is removed", () => {
    const { snapshot, financial } = linkedFirstPlatypus();
    const report = readFinancialNws(financial);
    expect(report?.score).toEqual(expect.any(Number));
    expect(JSON.stringify(report)).not.toContain("access-sandbox");
    expect(readFinancialNws(applySnapshot(financial, "item_fp_a", {
      ...snapshot, item: { ...snapshot.item, error: { code: "ITEM_LOGIN_REQUIRED", message: "Reconnect" } },
    }, NOW))).toEqual(report);
    expect(readFinancialNws(removeConnection(financial, "item_fp_a", NOW))).toBeNull();
  });
});
