import type { PortfolioData } from "@/components/kai/types/portfolio";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { overviewFacts } from "@/components/kai/views/portfolio-display-facts";
import { resolveFinancePortfolio } from "@/lib/kai/brokerage/resolve-portfolio-source";
import { groupHoldingPositions } from "@/lib/kai/holding-positions";
import { KaiFinancialResourceService, type KaiFinancialResource } from "@/lib/kai/kai-financial-resource";
import { sinceBought } from "@/lib/kai/portfolio-performance";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export const PORTFOLIO_CONTEXT_TOOL = "read_portfolio_context";
export const PORTFOLIO_CONTEXT_CONTRACT = 1;

export type PortfolioContextRequest = {
  section: "holdings" | "allocation" | "performance";
  source: "active" | "last_card";
  ticker?: string;
  detail?: "expanded";
};

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const MAX_CARD_REFERENCES = 16;
const REFERENCE_TTL_MS = 30 * 60 * 1000;
const MAX_LEGACY_POSITIONS = 40;
const MAX_EXPANDED_POSITIONS = 64;

export function parsePortfolioContextRequest(value: unknown): PortfolioContextRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { section, source, ticker, detail, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length || (source !== "active" && source !== "last_card")) return null;
  if (section !== "holdings" && section !== "allocation" && section !== "performance") return null;
  if ("ticker" in value && (section !== "holdings" || typeof ticker !== "string" || !TICKER.test(ticker))) return null;
  if ("detail" in value && detail !== "expanded") return null;
  return {
    section, source, ...(typeof ticker === "string" ? { ticker } : {}),
    ...(detail === "expanded" ? { detail } : {}),
  };
}

type PortfolioSource = {
  kind: "statement" | "plaid";
  snapshotId: string | null;
};

type CardReference = PortfolioSource & {
  epoch: number;
  observedAt: number;
  fingerprint: string;
};

// Only a source reference and digest stay in the active browser runtime.
const cardReferences = new Map<string, CardReference>();
const referenceKey = (owner: string, thread: string) => JSON.stringify([owner, thread]);

function activeSource(resource: KaiFinancialResource): PortfolioSource {
  return {
    kind: resource.activeSource,
    snapshotId: resource.activeSource === "statement" ? resource.activeStatementSnapshotId : null,
  };
}

function observationDate(resource: KaiFinancialResource, source: PortfolioSource, portfolio: PortfolioData) {
  const value = source.kind === "plaid"
    ? resource.plaidStatus?.aggregate?.last_synced_at
    : resource.statementSnapshots.find(snapshot => snapshot.id === source.snapshotId)?.statementPeriodEnd
      ?? portfolio.account_info?.statement_period_end;
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toISOString();
}

const knownNumber = (value: number | undefined | null) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const currencyCode = (value: unknown) => {
  const code = typeof value === "string" ? value.trim().toUpperCase() : null;
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
};

function portfolioChatView(resource: KaiFinancialResource, source: PortfolioSource, portfolio: PortfolioData) {
  const asOf = observationDate(resource, source, portfolio);
  const statementCurrency = source.kind === "statement" ? currencyCode(portfolio.account_info?.currency) : null;
  const positions = groupHoldingPositions(portfolio.holdings || [])
    .filter(position => !position.pending_delete)
    .map(position => {
      const symbol = position.symbol?.trim().toUpperCase() ?? "";
      const publicTicker = position.identifier_type === "ticker" ||
        (position.identifier_type === undefined && position.is_sec_common_equity_ticker === true);
      const ticker = publicTicker && TICKER.test(symbol) ? symbol : null;
      const name = (position.name || ticker || "Holding").replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, 100);
      const entries = position.entries.filter(entry => !("pending_delete" in entry && entry.pending_delete === true));
      const currencies = new Set(entries.map(entry =>
        currencyCode(entry.currency || entry.iso_currency_code) ?? statementCurrency));
      const valueUnavailable = entries.some(entry =>
        entry.market_value_unavailable || knownNumber(entry.market_value) === null);
      return { position, facts: {
        ticker, name: name || "Holding",
        currency: currencies.size === 1 ? currencies.values().next().value ?? null : null,
        market_value: valueUnavailable || currencies.size > 1 ? null : knownNumber(position.market_value),
      } };
    })
    .sort(({ facts: a }, { facts: b }) =>
      Number(a.currency === null) - Number(b.currency === null) ||
      (a.currency ?? "").localeCompare(b.currency ?? "") ||
      (a.currency && b.currency && a.market_value !== b.market_value
        ? (b.market_value ?? -Infinity) - (a.market_value ?? -Infinity)
        : 0));
  const currencies = new Set(positions.map(({ facts }) => facts.currency));
  const currency = currencies.size === 1 ? currencies.values().next().value ?? null : null;
  const model = mapPortfolioToDashboardViewModel(portfolio);
  const gain = sinceBought(model.canonicalModel.positions);
  const observedValue = positions.some(({ facts }) => facts.market_value !== null) ||
    knownNumber(portfolio.account_summary?.ending_value) !== null || model.hero.totalValue > 0;
  // Match the chart's saved allocation rows, including an authored allocation
  // mix supplied with the statement, and its portfolio-value denominator.
  const allocation = currency && model.quality.allocationReady &&
      model.allocation.length <= 6 && model.hero.totalValue > 0
    ? model.allocation.filter(row => Number.isFinite(row.value) && row.value > 0)
      .map(row => ({ ...row, percent: row.value / model.hero.totalValue * 100 }))
    : null;
  const { invested, cash } = overviewFacts(model, portfolio);
  return {
    as_of: asOf,
    date_kind: asOf ? (source.kind === "plaid" ? "last_synced" : "statement_end") : "unknown",
    currency,
    singleCurrency: currency !== null,
    positions,
    allocation,
    gain: currency ? gain : null,
    invested: currency ? invested : null,
    cash: currency ? cash : null,
    history: model.history,
    performance: {
      value: currency && observedValue ? knownNumber(model.hero.totalValue) : null,
      unrealized_gain: currency ? knownNumber(gain?.gain) : null,
      unrealized_percent: currency ? knownNumber(gain?.pct) : null,
      covered: currency ? gain?.covered ?? 0 : 0,
      eligible: currency ? gain?.eligible ?? 0 : 0,
      history_available: currency !== null && model.quality.historyReady && model.history.length >= 2,
    },
  };
}

export function activePortfolioChatView(resource: KaiFinancialResource) {
  return resource.activePortfolio
    ? portfolioChatView(resource, activeSource(resource), resource.activePortfolio)
    : null;
}

function portfolioFacts(resource: KaiFinancialResource, source: PortfolioSource, portfolio: PortfolioData) {
  const { as_of, date_kind, currency, positions, allocation, performance } =
    portfolioChatView(resource, source, portfolio);
  return {
    as_of, date_kind, currency,
    positions: positions.map(({ facts }) => facts),
    allocation: allocation?.map(({ name, percent }) => ({ bucket: name, percent })) ?? null,
    performance,
  };
}

async function fingerprint(facts: ReturnType<typeof portfolioFacts>) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(facts)));
  return new Uint8Array(hash).join(".");
}

export async function rememberPortfolioCard(
  thread: string,
  resource: KaiFinancialResource,
) {
  if (!resource.activePortfolio) return;
  const key = referenceKey(resource.userId, thread);
  const epoch = snapshotVaultSessionEpoch();
  const observedAt = Date.now();
  const source = activeSource(resource);
  const digest = await fingerprint(portfolioFacts(resource, source, resource.activePortfolio));
  if (!isVaultSessionEpochCurrent(epoch) || (cardReferences.get(key)?.observedAt ?? 0) > observedAt) return;
  cardReferences.delete(key);
  cardReferences.set(key, { ...source, epoch, observedAt, fingerprint: digest });
  if (cardReferences.size > MAX_CARD_REFERENCES) {
    const oldest = cardReferences.keys().next().value;
    if (oldest) cardReferences.delete(oldest);
  }
}

type UnavailableReason = "source_unavailable" | "card_unavailable" | "section_unavailable" | "portfolio_changed";
const unavailable = (reason: UnavailableReason) => ({ status: "unavailable", reason });

export async function readPortfolioContext(
  session: { userId: string; vaultKey: string; vaultOwnerToken: string; threadId: string },
  request: PortfolioContextRequest,
  isCurrent: () => boolean,
) {
  const reference = request.source === "last_card"
    ? cardReferences.get(referenceKey(session.userId, session.threadId)) : undefined;
  if (request.source === "last_card" && (!reference || !isVaultSessionEpochCurrent(reference.epoch) ||
      Date.now() - reference.observedAt >= REFERENCE_TTL_MS)) return unavailable("card_unavailable");

  const read = await KaiFinancialResourceService.readForAnswer(session, isCurrent);
  if (!read) return unavailable("portfolio_changed");
  const { resource } = read;
  const currentSource = activeSource(resource);
  const source = reference ?? currentSource;
  const useActive = source.kind === currentSource.kind && source.snapshotId === currentSource.snapshotId;
  const portfolio = useActive ? resource.activePortfolio :
    resource.financialDomain && resolveFinancePortfolio(resource.financialDomain, source);
  if (!portfolio) return unavailable(reference ? "card_unavailable" : "source_unavailable");

  const { positions, allocation, performance, ...metadata } = portfolioFacts(resource, source, portfolio);
  if (reference && (await fingerprint({ ...metadata, positions, allocation, performance })) !== reference.fingerprint) {
    return unavailable("card_unavailable");
  }
  if (!read.isCurrent()) return unavailable("portfolio_changed");

  const result = { status: "ok", source: source.kind, selection: request.source, ...metadata };
  if (request.section === "allocation") {
    return allocation?.length ? { ...result, allocation } : unavailable("section_unavailable");
  }
  if (request.section === "performance") {
    return performance.value !== null || performance.unrealized_gain !== null || performance.history_available
      ? { ...result, performance } : unavailable("section_unavailable");
  }
  const matched = request.ticker ? positions.filter(position => position.ticker === request.ticker) : positions;
  return {
    ...result,
    holdings: {
      positions: matched.slice(0, request.detail === "expanded" ? MAX_EXPANDED_POSITIONS : MAX_LEGACY_POSITIONS),
      total_count: positions.length,
      matched_count: matched.length,
      ...(request.detail === "expanded" ? {
        investment_rows: (portfolio.holdings ?? []).filter(
          row => !("pending_delete" in row && row.pending_delete === true),
        ).length,
        unique_tickers: positions.every(row => row.ticker !== null)
          ? new Set(positions.map(row => row.ticker)).size
          : null,
      } : {}),
    },
  };
}
