import tables from "./nws-score-tables.json";
import type { AccountRecord, ConnectionRecord, FinancialDomain, LinkedNetWorthScore } from "./types";

function scoreFromTable(amount: number): number {
  const [first, ...rest] = tables.US;
  let [low, start] = first!;
  if (amount <= low!) return start!;

  for (const [high, end] of rest) {
    if (amount <= high!) {
      return Math.round(start! + ((amount - low!) / (high! - low!)) * (end! - start!));
    }
    low = high;
    start = end;
  }
  return start!;
}

function unavailable(reason: NonNullable<LinkedNetWorthScore["unavailable_reason"]>): LinkedNetWorthScore {
  return { linked_net_worth_usd: null, country_on_file: null, score: null, unavailable_reason: reason };
}

/** Uses canonical linked accounts. Legacy Finance totals have different balance fallback rules. */
export function scoreLinkedNetWorth(
  accounts: readonly AccountRecord[],
  connections: ReadonlyMap<string, ConnectionRecord>,
): LinkedNetWorthScore {
  for (const connection of connections.values()) {
    if (connection.status !== "active" || !connection.last_refreshed_at) {
      return unavailable("connection_unavailable");
    }
  }

  const eligible = accounts.filter((account) => account.holder_category !== "business");
  if (eligible.length === 0) return unavailable("no_eligible_accounts");

  let total = 0;
  const countries = new Set<string | null>();
  for (const account of eligible) {
    const connection = connections.get(account.item_id);
    if (!connection) return unavailable("connection_unavailable");
    const { current, iso_currency_code: currency } = account.balances;
    if (typeof current !== "number" || !Number.isFinite(current)) return unavailable("balance_unavailable");
    if (currency !== "USD") return unavailable("unsupported_account_or_currency");

    if (account.type === "depository" || account.type === "investment" || account.type === "brokerage") {
      total += current;
    } else if (account.type === "credit" || account.type === "loan") {
      total -= current;
    } else {
      return unavailable("unsupported_account_or_currency");
    }
    countries.add(connection.country_on_file ?? null);
  }

  const amount = Math.sign(total) * Math.round(Math.abs(total) * 100) / 100;
  const country = countries.size === 1 ? countries.values().next().value ?? null : null;
  const score = country === "US" ? scoreFromTable(amount) : null;
  return {
    linked_net_worth_usd: amount === 0 ? 0 : amount,
    country_on_file: country,
    score,
    unavailable_reason: score === null ? "country_unavailable" : null,
  };
}

/** Selects the NWS from a Finance snapshot already decrypted for its owner. */
export function selectLinkedNetWorthScore(financial: Record<string, unknown> | null): LinkedNetWorthScore | null {
  return (financial as FinancialDomain | null)?.derived_v1?.nws?.value ?? null;
}
