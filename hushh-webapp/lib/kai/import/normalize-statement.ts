import type { PortfolioData } from "@/components/kai/views/portfolio-review-view";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";

export function parseMaybeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const text = String(value).trim();
  if (
    !text ||
    ["n/a", "na", "null", "none", "--", "-"].includes(text.toLowerCase())
  ) {
    return undefined;
  }

  const negative = text.startsWith("(") && text.endsWith(")");
  const sanitized = text
    .replace(/[,$\s]/g, "")
    .replace(/%/g, "")
    .replace(/[()]/g, "");
  const maybe = Number(negative ? `-${sanitized}` : sanitized);
  return Number.isFinite(maybe) ? maybe : undefined;
}

function parseNumberOrZero(value: unknown): number {
  return parseMaybeNumber(value) ?? 0;
}

function compactRecord<T extends Record<string, unknown>>(
  value: T | undefined,
): T | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(([, entryValue]) => {
    if (entryValue === undefined || entryValue === null) return false;
    if (typeof entryValue === "string" && entryValue.trim().length === 0)
      return false;
    return true;
  });
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as T;
}

const TRADE_ACTION_SYMBOLS = new Set([
  "BUY",
  "SELL",
  "REINVEST",
  "DIVIDEND",
  "INTEREST",
  "TRANSFER",
  "WITHDRAWAL",
  "DEPOSIT",
]);

const CASH_EQUIVALENT_SYMBOLS = new Set(["CASH", "MMF", "SWEEP", "QACDS"]);

export function normalizeTickerSymbol(
  value: unknown,
  opts?: { name?: string; assetType?: string },
): string {
  if (value === null || value === undefined) return "";
  const normalized = String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
  if (!normalized || normalized.startsWith("HOLDING_")) return "";
  if (TRADE_ACTION_SYMBOLS.has(normalized)) return "";
  if (CASH_EQUIVALENT_SYMBOLS.has(normalized)) return "CASH";
  const nameLc = String(opts?.name || "")
    .trim()
    .toLowerCase();
  const assetTypeLc = String(opts?.assetType || "")
    .trim()
    .toLowerCase();
  if (
    nameLc.includes("cash") ||
    nameLc.includes("sweep") ||
    assetTypeLc.includes("cash") ||
    assetTypeLc.includes("sweep") ||
    assetTypeLc.includes("money market")
  ) {
    return "CASH";
  }
  return normalized;
}

export function normalizePortfolioData(
  backendData: Record<string, unknown>,
): PortfolioData {
  const normalized = normalizeStoredPortfolio(
    backendData as Record<string, unknown>,
    { preserveEntries: true },
  ) as PortfolioData;
  const rawHoldings = Array.isArray(normalized.holdings)
    ? normalized.holdings
    : [];
  const canonicalHoldings = rawHoldings
    .map((h) => ({
      ...h,
      symbol: normalizeTickerSymbol(h.symbol, {
        name: h.name,
        assetType: h.asset_type,
      }),
      quantity: parseNumberOrZero(h.quantity),
      price: parseNumberOrZero(h.price),
      market_value: parseNumberOrZero(h.market_value),
      cost_basis: parseMaybeNumber(h.cost_basis),
      unrealized_gain_loss: parseMaybeNumber(h.unrealized_gain_loss),
      unrealized_gain_loss_pct: parseMaybeNumber(h.unrealized_gain_loss_pct),
    }))
    .filter((h) => Boolean((h.symbol || "").trim()));

  const accountSummary = normalized.account_summary || {};
  const totalValue =
    parseMaybeNumber(normalized.total_value) ??
    parseMaybeNumber(accountSummary.ending_value) ??
    canonicalHoldings.reduce((sum, h) => sum + (h.market_value || 0), 0);
  const cashBalance =
    parseMaybeNumber(normalized.cash_balance) ??
    parseMaybeNumber(accountSummary.cash_balance);

  const result: PortfolioData = {
    ...normalized,
    account_info:
      normalized.account_info && typeof normalized.account_info === "object"
        ? ({
            ...(normalized.account_info as Record<string, unknown>),
            holder_name:
              (normalized.account_info as Record<string, unknown>)
                .holder_name ??
              (normalized.account_info as Record<string, unknown>)
                .account_holder,
            brokerage:
              (normalized.account_info as Record<string, unknown>).brokerage ??
              (normalized.account_info as Record<string, unknown>)
                .brokerage_name,
          } as PortfolioData["account_info"])
        : normalized.account_info,
    holdings: canonicalHoldings,
    quality_report_v2: compactRecord(
      normalized.quality_report_v2 &&
        typeof normalized.quality_report_v2 === "object"
        ? ({
            ...(normalized.quality_report_v2 as Record<string, unknown>),
          } as Record<string, unknown>)
        : undefined,
    ),
    cash_balance: cashBalance,
    total_value: totalValue,
    parse_fallback: normalized.parse_fallback === true,
  };

  return result;
}
