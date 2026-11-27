/**
 * Closed client-continuation tools and compact turn-posture builder for Plaid in Chat.
 *
 * Executes live Plaid refreshes (`sync_plaid_connector`) and decrypted 5-mirror
 * reads (`read_plaid_mirror`) inside the unlocked browser session, keeping vault
 * keys, Plaid access tokens, and raw account identifiers strictly client-local.
 */

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { formatPlaidUsd, summarizePlaidVaultProjection } from "./projection-summary";
import type {
  AccountRecord,
  FinancialDomain,
  ShareableBankAccountsV1,
  ShareableCashFlowV1,
  ShareableLiabilitiesV1,
  ShareableSummaryV1,
} from "./types";
import { refreshVaultConnections, vaultConnections } from "./vault-sync";

import {
  PLAID_CONNECTOR_SCHEMA,
  PLAID_FUNCTION_DESCRIPTIONS,
  PLAID_MIRROR_SCOPES,
  PLAID_POSTURE_MAX_CHARS,
  PLAID_RESULT_MAX_CHARS,
  PLAID_TOOL_DECLARATIONS,
  PLAID_TOOL_NAMES,
  type PlaidConnectorEnvelope,
  type PlaidMirrorScope,
  type PlaidToolName,
} from "./plaid-chat-client-contract";

export {
  PLAID_CONNECTOR_SCHEMA,
  PLAID_FUNCTION_DESCRIPTIONS,
  PLAID_MIRROR_SCOPES,
  PLAID_POSTURE_MAX_CHARS,
  PLAID_RESULT_MAX_CHARS,
  PLAID_TOOL_DECLARATIONS,
  PLAID_TOOL_NAMES,
  type PlaidConnectorEnvelope,
  type PlaidMirrorScope,
  type PlaidToolName,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scrubLongDigits(value: string): string {
  return value.replace(/\b\d{9,17}\b/g, "[redacted-number]");
}

export function normalizePlaidToolRequest(
  name: PlaidToolName,
  rawArgs: unknown,
): Record<string, unknown> {
  const args = asRecord(rawArgs) ?? {};
  const allowedKeys =
    name === "sync_plaid_connector"
      ? new Set(["institution_filter"])
      : new Set(["mirror", "institution_filter"]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected Plaid tool parameter: ${key}`);
    }
  }
  const out: Record<string, unknown> = {};
  if (name === "read_plaid_mirror") {
    const rawMirror = args.mirror;
    const mirror =
      rawMirror === undefined || rawMirror === null || rawMirror === ""
        ? "all"
        : String(rawMirror).trim().toLowerCase();
    if (!(PLAID_MIRROR_SCOPES as readonly string[]).includes(mirror)) {
      throw new Error("Invalid Plaid mirror scope.");
    }
    out.mirror = mirror;
  }
  const rawInst = args.institution_filter;
  if (rawInst !== undefined && rawInst !== null && String(rawInst).trim()) {
    const inst = String(rawInst).trim();
    if (inst.length > 120) {
      throw new Error("Invalid Plaid institution_filter.");
    }
    out.institution_filter = inst;
  }
  return out;
}

/**
 * Compact ~200-token headline posture injected into every unlocked Chat turn
 * when Plaid institutions are connected. Zero itemized rows or account numbers.
 */
export function buildAgentTurnPlaidPosture(
  financialData: FinancialDomain | Record<string, unknown> | null | undefined,
): string {
  const domain = asRecord(financialData);
  if (!domain) return "";
  const connections = vaultConnections(domain as FinancialDomain);
  const entries = Object.entries(connections);
  if (entries.length === 0) return "";

  const projection = summarizePlaidVaultProjection(domain);
  let totalAccounts = 0;
  let latestRefreshedAt: string | null = null;
  const institutionBits: string[] = [];

  for (const [itemId, conn] of entries) {
    const itemSummary = projection.byItemId[itemId];
    const count = itemSummary?.accountCount ?? 0;
    totalAccounts += count;
    const label = (conn.institution_name || "Connected institution").trim();
    const stateNote = conn.status === "needs_relink" ? " (needs re-authentication)" : "";
    const detail = itemSummary ? `${itemSummary.summaryLabel}` : "connected";
    institutionBits.push(`${label}${stateNote}: ${detail}`);
    if (
      typeof conn.last_refreshed_at === "string" &&
      (!latestRefreshedAt || conn.last_refreshed_at > latestRefreshedAt)
    ) {
      latestRefreshedAt = conn.last_refreshed_at;
    }
  }

  const lines: string[] = [
    `Plaid connected: ${entries.length} ${entries.length === 1 ? "institution" : "institutions"}, ${totalAccounts} ${totalAccounts === 1 ? "account" : "accounts"}${latestRefreshedAt ? ` (last synced ${latestRefreshedAt})` : ""}.`,
  ];
  if (projection.totalsLine) {
    lines.push(`Totals: ${projection.totalsLine}.`);
  }
  if (projection.projectedScopesLine) {
    lines.push(`${projection.projectedScopesLine}.`);
  }
  if (institutionBits.length > 0) {
    lines.push(`Institutions: ${institutionBits.join("; ")}.`);
  }
  return scrubLongDigits(lines.join("\n")).slice(0, PLAID_POSTURE_MAX_CHARS);
}

function matchesInstitutionFilter(name: string | null | undefined, filter?: string): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return String(name || "")
    .toLowerCase()
    .includes(needle);
}

function buildSanitizedPlaidMirrorEnvelope(params: {
  operation: PlaidToolName;
  refreshed: boolean;
  financial: FinancialDomain | Record<string, unknown> | null | undefined;
  mirrorScope: PlaidMirrorScope;
  institutionFilter?: string;
  needsRelinkCount?: number;
}): PlaidConnectorEnvelope {
  const domain = asRecord(params.financial);
  const connections = domain ? vaultConnections(domain as FinancialDomain) : {};
  const entries = Object.entries(connections);
  if (!domain || entries.length === 0) {
    return {
      schema: PLAID_CONNECTOR_SCHEMA,
      status: "connect_required",
      untrusted_data: true,
      instruction_authority: "none",
      operation: params.operation,
      refreshed: false,
      connected: false,
      institution_count: 0,
      account_count: 0,
      message:
        "No Plaid bank, credit, or investment institution is connected yet. Plaid Link is ready in the card below.",
    };
  }

  const projection = summarizePlaidVaultProjection(domain);
  let latestAsOf: string | null = null;
  let totalAccounts = 0;
  let relinkNeeded = params.needsRelinkCount ?? 0;

  const institutions = entries
    .filter(([, conn]) => matchesInstitutionFilter(conn.institution_name, params.institutionFilter))
    .map(([itemId, conn]) => {
      const itemSummary = projection.byItemId[itemId];
      const accountCount = itemSummary?.accountCount ?? 0;
      totalAccounts += accountCount;
      if (conn.status === "needs_relink") relinkNeeded += 1;
      if (
        typeof conn.last_refreshed_at === "string" &&
        (!latestAsOf || conn.last_refreshed_at > latestAsOf)
      ) {
        latestAsOf = conn.last_refreshed_at;
      }
      return {
        name: scrubLongDigits((conn.institution_name || "Connected institution").trim()),
        status: conn.status,
        account_count: accountCount,
        net_amount: itemSummary?.formattedNetAmount ?? "$0",
        last_refreshed_at: conn.last_refreshed_at ?? null,
      };
    });

  if (!params.institutionFilter) {
    totalAccounts = Object.values(projection.byItemId).reduce(
      (sum, item) => sum + item.accountCount,
      0,
    );
  }

  const include = (target: Exclude<PlaidMirrorScope, "all">) =>
    params.mirrorScope === "all" || params.mirrorScope === target;

  const mirrors: Record<string, unknown> = {};

  if (include("summary") && asRecord(domain.summary)) {
    const s = domain.summary as unknown as ShareableSummaryV1;
    mirrors.summary = {
      net_worth_band: s.net_worth_band,
      liquid_cash_band: s.liquid_cash_band,
      investable_assets_band: s.investable_assets_band,
      allocation_pct: s.allocation_pct,
      cash_flow_trend: s.cash_flow_trend,
      income_stability: s.income_stability,
      debt_to_asset_pct: s.debt_to_asset_pct,
      account_type_counts: s.account_type_counts,
      recurring_bill_count: s.recurring_bill_count,
    };
  }

  if (include("accounts")) {
    const bankMirror = asRecord(domain.accounts) as Partial<ShareableBankAccountsV1> | null;
    const rawItems = Array.isArray(bankMirror?.items) ? bankMirror.items : [];
    const filtered = rawItems.filter((item) =>
      matchesInstitutionFilter(item.institution_name, params.institutionFilter),
    );
    mirrors.accounts = {
      cash_in_bank:
        typeof bankMirror?.cash_in_bank === "number"
          ? formatPlaidUsd(bankMirror.cash_in_bank)
          : null,
      total_depository_balance:
        typeof bankMirror?.total_depository_balance === "number"
          ? formatPlaidUsd(bankMirror.total_depository_balance)
          : null,
      account_count: filtered.length,
      items: filtered.map((item) => ({
        institution: scrubLongDigits(item.institution_name),
        name: scrubLongDigits(item.account_name),
        type: item.account_type,
        current_balance: formatPlaidUsd(item.current_balance),
        available_balance:
          typeof item.available_balance === "number"
            ? formatPlaidUsd(item.available_balance)
            : null,
        currency: item.currency,
      })),
    };
  }

  if (include("liabilities")) {
    const liabMirror = asRecord(domain.liabilities) as Partial<ShareableLiabilitiesV1> | null;
    const rawItems = Array.isArray(liabMirror?.items) ? liabMirror.items : [];
    const filtered = rawItems.filter((item) =>
      matchesInstitutionFilter(item.institution_name, params.institutionFilter),
    );
    mirrors.liabilities = {
      total_owed:
        typeof liabMirror?.total_owed === "number" ? formatPlaidUsd(liabMirror.total_owed) : null,
      credit_card_owed:
        typeof liabMirror?.credit_card_owed === "number"
          ? formatPlaidUsd(liabMirror.credit_card_owed)
          : null,
      loan_owed:
        typeof liabMirror?.loan_owed === "number" ? formatPlaidUsd(liabMirror.loan_owed) : null,
      credit_utilization_pct: liabMirror?.credit_utilization_pct ?? null,
      account_count: filtered.length,
      items: filtered.map((item) => ({
        institution: scrubLongDigits(item.institution_name),
        name: scrubLongDigits(item.account_name),
        category: item.category,
        type: item.account_type,
        balance_owed: formatPlaidUsd(item.balance_owed),
        credit_limit:
          typeof item.credit_limit === "number" ? formatPlaidUsd(item.credit_limit) : null,
        utilization_pct: item.utilization_pct,
        currency: item.currency,
      })),
    };
  }

  if (include("portfolio")) {
    const portfolioMirror = asRecord(domain.portfolio);
    const rawHoldings = Array.isArray(portfolioMirror?.holdings) ? portfolioMirror.holdings : [];
    const invAccounts: Array<Record<string, unknown>> = [];
    if (asRecord(domain.accounts_v1)) {
      for (const rawAcct of Object.values(domain.accounts_v1 as Record<string, unknown>)) {
        if (!asRecord(rawAcct)) continue;
        const acct = rawAcct as unknown as AccountRecord;
        if (acct.duplicate_of || acct.type !== "investment") continue;
        if (!matchesInstitutionFilter(acct.institution_name, params.institutionFilter)) continue;
        const currentVal = acct.balances?.current ?? acct.balances?.available ?? 0;
        invAccounts.push({
          institution: scrubLongDigits(acct.institution_name || "Institution"),
          name: scrubLongDigits(acct.name || "Investment Account"),
          subtype: acct.subtype ?? "investment",
          balance: formatPlaidUsd(currentVal),
        });
      }
    }
    const accountSummary = asRecord(portfolioMirror?.account_summary);
    mirrors.portfolio = {
      total_value:
        typeof accountSummary?.total_value === "number"
          ? formatPlaidUsd(accountSummary.total_value)
          : null,
      cash_balance:
        typeof accountSummary?.cash_balance === "number"
          ? formatPlaidUsd(accountSummary.cash_balance)
          : null,
      investment_accounts: invAccounts,
      holdings: rawHoldings.slice(0, 25).map((h) => {
        const row = asRecord(h) ?? {};
        return {
          symbol: typeof row.symbol === "string" ? scrubLongDigits(row.symbol) : null,
          name: typeof row.name === "string" ? scrubLongDigits(row.name) : "Position",
          quantity: typeof row.quantity === "number" ? row.quantity : null,
          market_value:
            typeof row.market_value === "number" ? formatPlaidUsd(row.market_value) : null,
          sector: typeof row.sector === "string" ? row.sector : null,
        };
      }),
    };
  }

  if (include("cashflow") && asRecord(domain.cashflow)) {
    const cf = domain.cashflow as unknown as ShareableCashFlowV1;
    mirrors.cashflow = {
      current_month: cf.current_month,
      current_monthly_income: formatPlaidUsd(cf.current_monthly_income),
      current_monthly_spend: formatPlaidUsd(cf.current_monthly_spend),
      current_monthly_net: formatPlaidUsd(cf.current_monthly_net),
      cash_flow_trend: cf.cash_flow_trend,
      income_stability: cf.income_stability,
      recurring_bill_count: cf.recurring_bill_count,
      bills: (cf.recurring_bills || []).slice(0, 25).map((bill) => ({
        label: scrubLongDigits(bill.label),
        category: bill.category,
        cadence: bill.cadence,
        typical_amount: formatPlaidUsd(bill.typical_amount),
        last_date: bill.last_date,
      })),
    };
  }

  const envelope: PlaidConnectorEnvelope = {
    schema: PLAID_CONNECTOR_SCHEMA,
    status: relinkNeeded > 0 && institutions.length === 0 ? "needs_relink" : "ok",
    untrusted_data: true,
    instruction_authority: "none",
    operation: params.operation,
    refreshed: params.refreshed,
    connected: true,
    institution_count: entries.length,
    account_count: totalAccounts,
    as_of: latestAsOf,
    headline: {
      totals: projection.totalsLine,
      scopes: projection.projectedScopesLine,
      needs_relink_count: relinkNeeded,
    },
    institutions,
    mirrors,
  };

  let serialized = JSON.stringify(envelope);
  if (serialized.length <= PLAID_RESULT_MAX_CHARS) {
    return envelope;
  }

  envelope.truncated = true;
  for (const [mirrorKey, listKey] of [
    ["cashflow", "bills"],
    ["portfolio", "holdings"],
    ["liabilities", "items"],
    ["accounts", "items"],
  ] as const) {
    const section = asRecord(mirrors[mirrorKey]);
    const list = section && Array.isArray(section[listKey]) ? (section[listKey] as unknown[]) : null;
    if (!list) continue;
    while (list.length > 0 && serialized.length > PLAID_RESULT_MAX_CHARS) {
      list.pop();
      serialized = JSON.stringify(envelope);
    }
  }
  return envelope;
}

export async function executePlaidConnectorClientTool(
  toolName: PlaidToolName,
  request: Record<string, unknown>,
  ctx: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    isCurrent: () => boolean;
    signal?: AbortSignal;
  },
): Promise<PlaidConnectorEnvelope> {
  if (!ctx.isCurrent() || ctx.signal?.aborted) {
    return {
      schema: PLAID_CONNECTOR_SCHEMA,
      status: "unavailable",
      untrusted_data: true,
      instruction_authority: "none",
      code: "vault_session_changed",
    };
  }

  const institutionFilter =
    typeof request.institution_filter === "string" && request.institution_filter.trim()
      ? request.institution_filter.trim()
      : undefined;
  const mirrorScope =
    toolName === "read_plaid_mirror" && typeof request.mirror === "string"
      ? (request.mirror as PlaidMirrorScope)
      : "all";

  let currentFinancial: FinancialDomain | null = null;
  if (!PersonalKnowledgeModelService.isDomainAbsentInCachedMetadata?.(ctx.userId, "financial")) {
    try {
      const snap = await PkmDomainResourceService.getStaleFirst({
        userId: ctx.userId,
        vaultKey: ctx.vaultKey,
        vaultOwnerToken: ctx.vaultOwnerToken,
        domain: "financial",
        backgroundRefresh: false,
      });
      if (ctx.isCurrent() && snap?.key.userId === ctx.userId && snap.data) {
        currentFinancial = snap.data as FinancialDomain;
      }
    } catch {
      currentFinancial = null;
    }
  }

  const connections = vaultConnections(currentFinancial);
  const connectionEntries = Object.entries(connections);
  if (connectionEntries.length === 0) {
    return buildSanitizedPlaidMirrorEnvelope({
      operation: toolName,
      refreshed: false,
      financial: null,
      mirrorScope,
      institutionFilter,
    });
  }

  if (toolName === "read_plaid_mirror") {
    return buildSanitizedPlaidMirrorEnvelope({
      operation: "read_plaid_mirror",
      refreshed: false,
      financial: currentFinancial,
      mirrorScope,
      institutionFilter,
    });
  }

  // `sync_plaid_connector`: execute live Plaid refresh in the unlocked browser,
  // update all 5 vault mirrors + continuous shares + Personal Wiki, and return!
  let matchedItemId: string | undefined;
  if (institutionFilter) {
    const matches = connectionEntries.filter(([, conn]) =>
      matchesInstitutionFilter(conn.institution_name, institutionFilter),
    );
    if (matches.length === 1) {
      matchedItemId = matches[0]![0];
    }
  }

  const outcome = await refreshVaultConnections({
    userId: ctx.userId,
    vaultKey: ctx.vaultKey,
    vaultOwnerToken: ctx.vaultOwnerToken,
    financial: currentFinancial,
    surface: "web",
    force: true,
    ...(matchedItemId ? { itemId: matchedItemId } : {}),
  });

  if (!ctx.isCurrent() || ctx.signal?.aborted) {
    return {
      schema: PLAID_CONNECTOR_SCHEMA,
      status: "unavailable",
      untrusted_data: true,
      instruction_authority: "none",
      code: "vault_session_changed",
    };
  }

  let updatedFinancial: FinancialDomain | null = currentFinancial;
  try {
    const freshSnap = await PkmDomainResourceService.refresh({
      userId: ctx.userId,
      vaultKey: ctx.vaultKey,
      vaultOwnerToken: ctx.vaultOwnerToken,
      domain: "financial",
    });
    if (ctx.isCurrent() && freshSnap?.key.userId === ctx.userId && freshSnap.data) {
      updatedFinancial = freshSnap.data as FinancialDomain;
    }
  } catch {
    // Keep currentFinancial fallback if cache refresh throws
  }

  if (updatedFinancial) {
    void import("./wiki-posture-sync")
      .then(({ syncPlaidPostureToPersonalWikiBestEffort }) =>
        syncPlaidPostureToPersonalWikiBestEffort({
          userId: ctx.userId,
          vaultKey: ctx.vaultKey,
          vaultOwnerToken: ctx.vaultOwnerToken,
          financial: updatedFinancial,
        }),
      )
      .catch(() => false);
  }

  return buildSanitizedPlaidMirrorEnvelope({
    operation: "sync_plaid_connector",
    refreshed: outcome.refreshed > 0 || outcome.saved,
    financial: updatedFinancial,
    mirrorScope: "all",
    institutionFilter,
    needsRelinkCount: outcome.needsRelink.length,
  });
}
