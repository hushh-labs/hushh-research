/**
 * Kai portfolio normalizer (V2-only)
 *
 * Canonical PKM financial shape:
 * - financial.portfolio (FinancialPortfolioCanonicalV2)
 * - financial.analytics (FinancialAnalyticsV2)
 */

 
type AnyObj = Record<string, any>;

const CASH_EQUIVALENT_SYMBOLS = new Set(["CASH", "MMF", "SWEEP", "QACDS"]);

function parseMaybeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const text = String(value).trim();
  if (!text || ["n/a", "na", "null", "none", "--", "-"].includes(text.toLowerCase())) {
    return undefined;
  }
  const negative = text.startsWith("(") && text.endsWith(")");
  const sanitized = text.replace(/[,$\s]/g, "").replace(/%/g, "").replace(/[()]/g, "");
  const parsed = Number(negative ? `-${sanitized}` : sanitized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeHoldingSymbol(rawSymbol: unknown, name: string, assetType: string): string {
  const symbol = String(rawSymbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
  if (!symbol) return "";
  if (symbol.startsWith("HOLDING_")) return "";
  if (CASH_EQUIVALENT_SYMBOLS.has(symbol)) return "CASH";

  const nameLc = name.trim().toLowerCase();
  const assetTypeLc = assetType.trim().toLowerCase();
  if (
    nameLc.includes("cash") ||
    nameLc.includes("sweep") ||
    assetTypeLc.includes("cash") ||
    assetTypeLc.includes("sweep") ||
    assetTypeLc.includes("money market")
  ) {
    return "CASH";
  }
  return symbol;
}

function normalizeHoldings(holdings: AnyObj[] | undefined): AnyObj[] {
  if (!Array.isArray(holdings)) return [];

  return holdings
    .map((row) => {
      const name = String(row.name || row.description || "").trim();
      const assetType = String(row.asset_type || "").trim();
      const symbol = normalizeHoldingSymbol(row.symbol, name, assetType);
      const quantity = parseMaybeNumber(row.quantity) ?? 0;
      const price = parseMaybeNumber(row.price ?? row.price_per_unit) ?? 0;
      const marketValue = parseMaybeNumber(row.market_value) ?? 0;
      const costBasis = parseMaybeNumber(row.cost_basis);
      const unrealized = parseMaybeNumber(row.unrealized_gain_loss);
      let unrealizedPct = parseMaybeNumber(row.unrealized_gain_loss_pct);

      if (unrealizedPct === undefined && unrealized !== undefined) {
        const basis =
          costBasis !== undefined && Math.abs(costBasis) > 1e-6
            ? costBasis
            : marketValue - unrealized;
        if (Math.abs(basis) > 1e-6) {
          unrealizedPct = (unrealized / basis) * 100;
        }
      }

      return {
        ...row,
        symbol,
        name: name || "Unknown",
        quantity,
        price,
        market_value: marketValue,
        cost_basis: costBasis,
        unrealized_gain_loss: unrealized,
        unrealized_gain_loss_pct: unrealizedPct,
        asset_type: assetType || row.asset_type,
      };
    })
    .filter((row) => Boolean(String(row.symbol || "").trim()));
}

/**
 * Normalize a V2 financial blob/canonical payload for dashboard/review consumers.
 *
 * Accepted inputs:
 * - financial domain object ({ portfolio, analytics, ... })
 * - canonical portfolio object ({ account_info, holdings, ... })
 */
export function normalizeStoredPortfolio(raw: AnyObj): AnyObj {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const domainRoot = raw as AnyObj;
  const canonical =
    domainRoot.portfolio &&
    typeof domainRoot.portfolio === "object" &&
    !Array.isArray(domainRoot.portfolio)
      ? (domainRoot.portfolio as AnyObj)
      : domainRoot;

  if (!Array.isArray(canonical.holdings)) {
    return canonical;
  }

  const accountInfo =
    canonical.account_info && typeof canonical.account_info === "object"
      ? {
          ...(canonical.account_info as AnyObj),
          holder_name:
            (canonical.account_info as AnyObj).holder_name ??
            (canonical.account_info as AnyObj).account_holder,
          brokerage:
            (canonical.account_info as AnyObj).brokerage ??
            (canonical.account_info as AnyObj).brokerage_name,
        }
      : undefined;
  const accountSummary =
    canonical.account_summary && typeof canonical.account_summary === "object"
      ? { ...(canonical.account_summary as AnyObj) }
      : undefined;

  const holdings = normalizeHoldings(canonical.holdings as AnyObj[]);
  const totalValue =
    parseMaybeNumber(canonical.total_value) ??
    parseMaybeNumber(accountSummary?.ending_value) ??
    holdings.reduce((sum, row) => sum + (parseMaybeNumber(row.market_value) ?? 0), 0);

  const cashBalance =
    parseMaybeNumber(canonical.cash_balance) ?? parseMaybeNumber(accountSummary?.cash_balance);

  const analyticsV2 =
    domainRoot.analytics &&
    typeof domainRoot.analytics === "object" &&
    !Array.isArray(domainRoot.analytics)
      ? (domainRoot.analytics as AnyObj)
      : canonical.analytics_v2;

  return {
    ...canonical,
    account_info: accountInfo,
    account_summary: accountSummary,
    holdings,
    total_value: totalValue,
    cash_balance: cashBalance,
    quality_report_v2:
      canonical.quality_report_v2 &&
      typeof canonical.quality_report_v2 === "object" &&
      !Array.isArray(canonical.quality_report_v2)
        ? canonical.quality_report_v2
        : undefined,
    analytics_v2:
      analyticsV2 && typeof analyticsV2 === "object" && !Array.isArray(analyticsV2)
        ? analyticsV2
        : undefined,
  };
}
