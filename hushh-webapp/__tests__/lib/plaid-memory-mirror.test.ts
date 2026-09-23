import { describe, expect, it } from "vitest";

import { isPlaidMirrorStale, upsertPlaidSource } from "@/lib/kai/brokerage/financial-sources";
import type { PlaidPortfolioStatusResponse } from "@/lib/kai/brokerage/portfolio-sources";

function status(): PlaidPortfolioStatusResponse {
  return {
    configured: true,
    items: [
      {
        item_id: "item_1",
        institution_id: "ins_109508",
        institution_name: "First Platypus Bank",
        status: "active",
        sync_status: "failed",
        last_synced_at: "2026-09-23T10:00:00Z",
        last_refresh_requested_at: "2026-09-23T09:59:00Z",
        last_error_code: "ITEM_LOGIN_REQUIRED",
        last_error_message: "the login details of this item have changed",
        last_webhook_type: "HOLDINGS",
        last_webhook_code: "DEFAULT_UPDATE",
        latest_refresh_run: { run_id: "run_1" } as never,
        accounts: [
          {
            account_id: "acc_1",
            name: "Plaid IRA",
            official_name: "Plaid Gold Standard 0% Interest IRA",
            mask: "5555",
            type: "investment",
            subtype: "ira",
            balances: { current: 320.76 },
            item_id: "item_1",
          },
        ],
      },
    ],
    aggregate: {
      item_count: 1,
      account_count: 1,
      holdings_count: 0,
      institution_names: ["First Platypus Bank"],
      sync_status: "idle",
      last_synced_at: "2026-09-23T10:00:00Z",
    },
  } as PlaidPortfolioStatusResponse;
}

describe("Plaid mirror in financial memory", () => {
  it("keeps facts about the connection and drops app telemetry", () => {
    const next = upsertPlaidSource({}, status(), "plaid", "2026-09-23T10:01:00Z");
    const plaid = (next.sources as Record<string, Record<string, unknown>>).plaid;
    const [item] = plaid.items as Array<Record<string, unknown>>;
    expect(item).toMatchObject({
      item_id: "item_1",
      institution_name: "First Platypus Bank",
      status: "active",
      last_synced_at: "2026-09-23T10:00:00Z",
    });
    const serialized = JSON.stringify(item);
    for (const leaked of [
      "last_error_message",
      "last_error_code",
      "last_webhook_type",
      "last_webhook_code",
      "latest_refresh_run",
      "last_refresh_requested_at",
      "sync_status",
      "official_name",
      "the login details",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    const [account] = item.accounts as Array<Record<string, unknown>>;
    expect(account).toMatchObject({ account_id: "acc_1", name: "Plaid IRA", mask: "5555", subtype: "ira" });
  });

  it("re-projects a mirror written in the old shape", () => {
    const current = upsertPlaidSource({}, status(), "plaid", "2026-09-23T10:01:00Z");
    expect(isPlaidMirrorStale(current, status())).toBe(false);
    const oldShape = structuredClone(current) as Record<string, any>;
    oldShape.sources.plaid.signature = String(oldShape.sources.plaid.signature).replace(
      "plaid-mirror-v2::",
      "",
    );
    expect(isPlaidMirrorStale(oldShape, status())).toBe(true);
  });
});
