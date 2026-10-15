import { describe, expect, it } from "vitest";

import { isPrivatePkmExportScope } from "@/lib/consent/pkm-scope-policy";

describe("financial export policy (mirror of the server's domain_contracts)", () => {
  it.each([
    "attr.wallet.*",
    "attr.wallet.summary",
    "attr.wallet.summary.card_1",
    "attr.wallet.secrets.pan",
    "attr.wallet.runtime.*",
    "attr.one_memory.*",
    "attr.wallet.*",
    "attr.wallet.artwork.*",
    "attr.wallet.secrets.pan",
    "attr.one_memory.markdown",
    "attr.one_memory.markdown.text",
    "attr.financial.*",
    "attr.financial.analysis_history.*",
    "attr.financial.sources.*",
    "attr.financial.sources.plaid.items",
    "attr.financial.runtime.*",
    "attr.financial.portfolio.holdings.account_mask",
    "attr.financial.portfolio.holdings.symbol_cusip",
    "attr.financial.portfolio.account_info.routing_number",
    "attr.financial.connections_v1.*",
    "attr.financial.accounts_v1.*",
    "attr.financial.holdings_v1.*",
    "attr.financial.securities_v1.*",
    "attr.financial.transactions_v1.*",
    "attr.financial.derived_v1.*",
    "attr.financial.linked_accounts.*",
    "attr.financial.linked_accounts.bank_accounts",
  ])("keeps %s private", (scope) => {
    expect(isPrivatePkmExportScope(scope)).toBe(true);
  });

  it.each([
    "attr.wallet.summary.*",
    "attr.wallet.secrets.*",
    "attr.financial.profile.*",
    "attr.financial.portfolio.*",
    "attr.financial.summary.*",
    "attr.identity.name",
    "attr.wallet.summary.*",
    "attr.wallet.secrets.*",
  ])("leaves %s exportable", (scope) => {
    expect(isPrivatePkmExportScope(scope)).toBe(false);
  });
});
