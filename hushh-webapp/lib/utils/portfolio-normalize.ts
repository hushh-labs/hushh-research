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

function mergeHoldingsBySymbol(rows: AnyObj[]): AnyObj[] {
  const grouped = new Map<string, AnyObj>();
  for (const row of rows) {
    const symbol = String(row.symbol || "")
      .trim()
      .toUpperCase();
    if (!symbol) continue;

    const existing = grouped.get(symbol);
    if (!existing) {
      grouped.set(symbol, {
        ...row,
        symbol,
        lots_count: Number.isFinite(Number(row.lots_count)) ? Number(row.lots_count) : 1,
      });
      continue;
    }

    const nextLotsCount = (Number(existing.lots_count) || 1) + (Number(row.lots_count) || 1);
    const sumField = (field: string) => {
      const current = parseMaybeNumber(existing[field]);
      const incoming = parseMaybeNumber(row[field]);
      if (current === undefined && incoming === undefined) return undefined;
      return (current ?? 0) + (incoming ?? 0);
    };

    const quantity = sumField("quantity");
    const marketValue = sumField("market_value");
    const costBasis = sumField("cost_basis");
    const unrealized = sumField("unrealized_gain_loss");

    existing.quantity = quantity ?? existing.quantity ?? 0;
    existing.market_value = marketValue ?? existing.market_value ?? 0;
    existing.cost_basis = costBasis;
    existing.unrealized_gain_loss = unrealized;
    existing.lots_count = nextLotsCount;

    if ((!String(existing.name || "").trim() || String(existing.name).trim() === "Unknown") && String(row.name || "").trim()) {
      existing.name = String(row.name).trim();
    }
    if (!String(existing.asset_type || "").trim() && String(row.asset_type || "").trim()) {
      existing.asset_type = row.asset_type;
    }
    if (!String(existing.sector || "").trim() && String(row.sector || "").trim()) {
      existing.sector = row.sector;
    }
    if (!String(existing.industry || "").trim() && String(row.industry || "").trim()) {
      existing.industry = row.industry;
    }
    if (!existing.symbol_cusip && row.symbol_cusip) {
      existing.symbol_cusip = row.symbol_cusip;
    }
    for (const boolField of [
      "is_cash_equivalent",
      "is_investable",
      "analyze_eligible",
      "debate_eligible",
      "optimize_eligible",
    ]) {
      existing[boolField] = Boolean(existing[boolField]) || Boolean(row[boolField]);
    }

    const estIncomeCurrent = parseMaybeNumber(existing.estimated_annual_income);
    const estIncomeIncoming = parseMaybeNumber(row.estimated_annual_income);
    if (estIncomeCurrent !== undefined || estIncomeIncoming !== undefined) {
      existing.estimated_annual_income = (estIncomeCurrent ?? 0) + (estIncomeIncoming ?? 0);
    }
  }

  const consolidated = Array.from(grouped.values());
  for (const row of consolidated) {
    const quantity = parseMaybeNumber(row.quantity) ?? 0;
    const marketValue = parseMaybeNumber(row.market_value) ?? 0;
    if (Math.abs(quantity) > 1e-9) {
      row.price = marketValue / quantity;
      row.price_per_unit = row.price;
    }
    const costBasis = parseMaybeNumber(row.cost_basis);
    const unrealized = parseMaybeNumber(row.unrealized_gain_loss);
    if (costBasis !== undefined && Math.abs(costBasis) > 1e-6 && unrealized !== undefined) {
      row.unrealized_gain_loss_pct = (unrealized / costBasis) * 100;
    }
    const estimatedAnnualIncome = parseMaybeNumber(row.estimated_annual_income);
    if (estimatedAnnualIncome !== undefined && Math.abs(marketValue) > 1e-6) {
      row.est_yield = (estimatedAnnualIncome / marketValue) * 100;
    }
  }
  return consolidated;
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
      const estimatedAnnualIncome = parseMaybeNumber(
        row.estimated_annual_income ?? row.est_annual_income
      );
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
        estimated_annual_income: estimatedAnnualIncome,
        est_annual_income: estimatedAnnualIncome,
        asset_type: assetType || row.asset_type,
      };
    })
    .filter((row) => Boolean(String(row.symbol || "").trim()));
}

export function consolidateHoldingsBySymbol(holdings: AnyObj[] | undefined): AnyObj[] {
  return mergeHoldingsBySymbol(normalizeHoldings(holdings));
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

  const holdings = consolidateHoldingsBySymbol(canonical.holdings as AnyObj[]);
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
