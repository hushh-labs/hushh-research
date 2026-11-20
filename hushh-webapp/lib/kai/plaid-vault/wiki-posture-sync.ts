/**
 * Syncs sanitized Plaid Vault financial posture into the owner's Personal Wiki.
 *
 * Works identically across Private Pod (`ownerPodRequest("files/wiki/migrate")`)
 * and Shared Wiki (`SharedWikiLibrary` + `SharedWikiKnowledgeWriter`), updating
 * the cited financial page and refreshing `hot.md` without storing credentials,
 * Plaid access tokens, item secrets, or account/routing numbers.
 */

import { ensureActiveSharedWiki, peekActiveSharedWiki } from "@/lib/files/wiki/active-shared-wiki";
import { sha256Hex, type WikiClaim, type WikiSourceRef } from "@/lib/files/wiki/contracts";
import { SharedWikiKnowledgeWriter } from "@/lib/files/wiki/writer";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { summarizePlaidVaultProjection, formatPlaidUsd } from "./projection-summary";
import type { AccountRecord, FinancialDomain } from "./types";
import { vaultConnections } from "./vault-sync";

const PLAID_WIKI_SOURCE_LOCATOR = "plaid://vault/connected-financial-accounts";
const PLAID_WIKI_PAGE_TITLE = "Connected Financial Accounts";
const POD_WIKI_MIGRATE_TIMEOUT_MS = 6_000;

interface PlaidWikiMirrorSpec {
  slug: string;
  title: string;
  tldr: string;
  bullets: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function accountBalanceNumber(account: AccountRecord): number | null {
  const current = account.balances?.current;
  if (typeof current === "number" && Number.isFinite(current)) return current;
  const available = account.balances?.available;
  return typeof available === "number" && Number.isFinite(available) ? available : null;
}

function accountAvailableNumber(account: AccountRecord): number | null {
  const available = account.balances?.available;
  return typeof available === "number" && Number.isFinite(available) ? available : null;
}

export function buildPlaidWikiPostureSummary(financial: FinancialDomain | Record<string, unknown> | null | undefined): {
  markdown: string;
  tldr: string;
  statusAsOf: string;
  claims: Array<{ statement: string }>;
} | null {
  const domainRecord = asRecord(financial);
  if (!domainRecord) return null;

  const connections = vaultConnections(domainRecord as FinancialDomain);
  const connectionEntries = Object.entries(connections);
  if (connectionEntries.length === 0) return null;

  const projection = summarizePlaidVaultProjection(domainRecord);
  const accountsByItem = new Map<string, AccountRecord[]>();
  const rawAccounts = asRecord(domainRecord.accounts_v1);
  if (rawAccounts) {
    for (const rawAccount of Object.values(rawAccounts)) {
      if (!asRecord(rawAccount)) continue;
      const account = rawAccount as unknown as AccountRecord;
      if (account.duplicate_of || !account.item_id) continue;
      const list = accountsByItem.get(account.item_id) ?? [];
      list.push(account);
      accountsByItem.set(account.item_id, list);
    }
  }

  let latestIso = new Date().toISOString();
  for (const [, conn] of connectionEntries) {
    const candidate = conn.last_refreshed_at;
    if (typeof candidate === "string" && /^\d{4}-\d{2}-\d{2}/.test(candidate)) {
      latestIso = candidate;
      break;
    }
  }
  const statusAsOf = latestIso.slice(0, 10);

  const bullets: string[] = [];
  for (const [itemId, conn] of connectionEntries) {
    const bankName = (conn.institution_name || "Connected institution").trim();
    const itemAccounts = accountsByItem.get(itemId) ?? [];
    if (itemAccounts.length === 0) {
      bullets.push(
        `${bankName}: connected via Plaid (${conn.status === "needs_relink" ? "reconnect needed" : "active"}).`,
      );
      continue;
    }
    for (const account of itemAccounts) {
      const label = (account.name || "Account").trim();
      const mask = account.mask ? ` (••••${account.mask})` : "";
      const kind = [account.subtype, account.type].filter(Boolean)[0] ?? "account";
      const balance = accountBalanceNumber(account);
      const available = accountAvailableNumber(account);
      const currency = (account.balances?.iso_currency_code || "USD").toUpperCase();
      const balParts: string[] = [];
      if (balance !== null) balParts.push(`${formatPlaidUsd(balance)} ${currency} current`);
      if (available !== null && available !== balance) {
        balParts.push(`${formatPlaidUsd(available)} available`);
      }
      const balanceText = balParts.length > 0 ? `: ${balParts.join(", ")}` : "";
      bullets.push(`${bankName} — ${label}${mask} [${kind}]${balanceText}.`);
    }
  }

  if (projection.totalsLine) {
    bullets.push(`Financial posture: ${projection.totalsLine}.`);
  }
  if (projection.projectedScopesLine) {
    bullets.push(`${projection.projectedScopesLine}.`);
  }

  const tldr = projection.totalsLine
    ? `${connectionEntries.length} ${connectionEntries.length === 1 ? "institution" : "institutions"} linked via Plaid (${projection.totalsLine}).`
    : `${connectionEntries.length} ${connectionEntries.length === 1 ? "institution" : "institutions"} linked via Plaid.`;

  const markdown = [
    `# ${PLAID_WIKI_PAGE_TITLE}`,
    ...bullets.map((line) => `- ${line}`),
  ].join("\n");

  return {
    markdown,
    tldr,
    statusAsOf,
    claims: bullets.map((statement) => ({ statement })),
  };
}

export function buildPlaidWikiMirrorPages(
  financial: FinancialDomain | Record<string, unknown> | null | undefined,
): PlaidWikiMirrorSpec[] {
  const domainRecord = asRecord(financial);
  if (!domainRecord) return [];
  const pages: PlaidWikiMirrorSpec[] = [];
  const projection = summarizePlaidVaultProjection(domainRecord);

  const summary = asRecord(domainRecord.summary);
  if (summary && summary.schema === "plaid-summary-v1") {
    const summaryBullets = [
      `Net worth band: ${String(summary.net_worth_band || "unknown")}; liquid cash band: ${String(summary.liquid_cash_band || "unknown")}; investable band: ${String(summary.investable_assets_band || "unknown")}.`,
      `Coverage: ${String(summary.institution_count ?? 0)} institution(s), ${String(summary.account_count ?? 0)} account(s), cash-flow trend ${String(summary.cash_flow_trend || "flat")}, income stability ${String(summary.income_stability || "unknown")}.`,
    ];
    pages.push({
      slug: "financial_summary",
      title: "Financial Summary",
      tldr: `Financial posture (${String(summary.net_worth_band || "current")}) across ${String(summary.institution_count ?? 0)} institution(s).`,
      bullets: summaryBullets,
    });
  }

  const accounts = asRecord(domainRecord.accounts);
  if (accounts && accounts.schema === "plaid-accounts-v1") {
    const items = Array.isArray(accounts.items) ? accounts.items : [];
    const bullets = items.map((rawItem) => {
      const item = asRecord(rawItem) ?? {};
      const bal = typeof item.current_balance === "number" ? formatPlaidUsd(item.current_balance) : "n/a";
      const avail =
        typeof item.available_balance === "number" && item.available_balance !== item.current_balance
          ? `, ${formatPlaidUsd(item.available_balance)} available`
          : "";
      return `${String(item.institution_name || "Bank")} — ${String(item.account_name || "Account")} [${String(item.account_type || "Account")}]: ${bal} current${avail}.`;
    });
    if (typeof accounts.total_depository_balance === "number") {
      bullets.push(`Total depository balance: ${formatPlaidUsd(accounts.total_depository_balance)} (liquid cash ${formatPlaidUsd(Number(accounts.cash_in_bank ?? 0))}).`);
    }
    if (bullets.length > 0) {
      pages.push({
        slug: "bank_accounts",
        title: "Bank Accounts",
        tldr: `${String(accounts.account_count ?? items.length)} depository account(s) totaling ${formatPlaidUsd(Number(accounts.total_depository_balance ?? 0))}.`,
        bullets,
      });
    }
  }

  const liabilities = asRecord(domainRecord.liabilities);
  if (liabilities && liabilities.schema === "plaid-liabilities-v1") {
    const items = Array.isArray(liabilities.items) ? liabilities.items : [];
    const bullets = items.map((rawItem) => {
      const item = asRecord(rawItem) ?? {};
      const owed = typeof item.balance_owed === "number" ? formatPlaidUsd(item.balance_owed) : "n/a";
      const util =
        typeof item.utilization_pct === "number" && typeof item.credit_limit === "number"
          ? ` (limit ${formatPlaidUsd(item.credit_limit)}, ${item.utilization_pct}% used)`
          : "";
      return `${String(item.institution_name || "Lender")} — ${String(item.account_name || "Liability")} [${String(item.account_type || item.category || "Liability")}]: ${owed} owed${util}.`;
    });
    if (typeof liabilities.total_owed === "number") {
      bullets.push(`Total liabilities: ${formatPlaidUsd(liabilities.total_owed)} (cards ${formatPlaidUsd(Number(liabilities.credit_card_owed ?? 0))}, loans ${formatPlaidUsd(Number(liabilities.loan_owed ?? 0))}).`);
    }
    if (bullets.length > 0) {
      pages.push({
        slug: "credit_and_loans",
        title: "Credit & Loans",
        tldr: `${String(liabilities.account_count ?? items.length)} liability account(s) totaling ${formatPlaidUsd(Number(liabilities.total_owed ?? 0))} owed.`,
        bullets,
      });
    }
  }

  const portfolio = asRecord(domainRecord.portfolio);
  const holdings = Array.isArray(portfolio?.holdings) ? portfolio.holdings : [];
  if (portfolio && holdings.length > 0) {
    const totalVal =
      typeof portfolio.total_value === "number"
        ? portfolio.total_value
        : Number(asRecord(portfolio.account_summary)?.ending_value ?? 0);
    const cashVal =
      typeof portfolio.cash_balance === "number"
        ? portfolio.cash_balance
        : Number(asRecord(portfolio.account_summary)?.cash_balance ?? 0);
    const bullets = holdings.slice(0, 25).map((rawHolding) => {
      const h = asRecord(rawHolding) ?? {};
      const inst = String(h.institution_name || "Brokerage");
      const sym = String(h.symbol || h.name || "Position");
      const val = typeof h.market_value === "number" ? formatPlaidUsd(h.market_value) : "n/a";
      const qty = typeof h.quantity === "number" ? `${h.quantity} units` : "";
      return `${inst} — ${sym}${qty ? ` (${qty})` : ""}: ${val}.`;
    });
    bullets.push(`Portfolio total: ${formatPlaidUsd(totalVal)} (cash ${formatPlaidUsd(cashVal)} across ${holdings.length} holding(s)).`);
    pages.push({
      slug: "investment_portfolio",
      title: "Investment Portfolio",
      tldr: `${holdings.length} holding(s) totaling ${formatPlaidUsd(totalVal)}.`,
      bullets,
    });
  } else if (projection.projectedScopesLine?.includes("Investment Portfolio")) {
    pages.push({
      slug: "investment_portfolio",
      title: "Investment Portfolio",
      tldr: "Synced investment portfolio posture.",
      bullets: [projection.projectedScopesLine],
    });
  }

  const cashflow = asRecord(domainRecord.cashflow);
  if (cashflow && cashflow.schema === "plaid-cashflow-v1") {
    const bills = Array.isArray(cashflow.recurring_bills) ? cashflow.recurring_bills : [];
    const bullets = [
      `Current posture (${String(cashflow.current_month || "current")}): monthly income ${formatPlaidUsd(Number(cashflow.current_monthly_income ?? 0))}, monthly spend ${formatPlaidUsd(Number(cashflow.current_monthly_spend ?? 0))}, net ${formatPlaidUsd(Number(cashflow.current_monthly_net ?? 0))}; trend ${String(cashflow.cash_flow_trend || "flat")}.`,
      ...bills.map((rawBill) => {
        const b = asRecord(rawBill) ?? {};
        return `Recurring bill — ${String(b.label || "Bill")} [${String(b.cadence || "monthly")}]: ${formatPlaidUsd(Number(b.typical_amount ?? 0))} (last ${String(b.last_date || "")}).`;
      }),
    ];
    pages.push({
      slug: "cashflow_and_recurring_bills",
      title: "Cash Flow & Recurring Bills",
      tldr: `${bills.length} active recurring bill(s); monthly trend ${String(cashflow.cash_flow_trend || "flat")}.`,
      bullets,
    });
  }

  return pages;
}

async function upsertSharedWikiPage(input: {
  wiki: NonNullable<ReturnType<typeof ensureActiveSharedWiki>>;
  pageKey: string;
  idempotencyKey: string;
  title: string;
  tldr: string;
  statusAsOf: string;
  bullets: string[];
  sourceId: string;
  observedAt: string;
}): Promise<void> {
  const pageId = `wpg_${(await sha256Hex(input.pageKey)).slice(0, 16)}`;
  const claims: WikiClaim[] = await Promise.all(
    input.bullets.map(async (statement, index) => ({
      claim_id: `wcl_${(await sha256Hex(`${pageId}:${index}:${statement}`)).slice(0, 16)}`,
      statement,
      status: "active",
      confidence: 1,
      source_ids: [input.sourceId],
      observed_at: input.observedAt,
    })),
  );
  const existing = await input.wiki.readPage(pageId).catch(() => null);
  const body = input.bullets.map((line) => `- ${line}`).join("\n");
  if (existing) {
    await input.wiki.editPage(pageId, {
      expected_revision: existing.revision,
      idempotency_key: input.idempotencyKey,
      title: input.title,
      folder: "financial",
      tldr: input.tldr,
      status_as_of: input.statusAsOf,
      body,
      claims,
      source_ids: [input.sourceId],
    });
    return;
  }
  await input.wiki.createPage({
    page_id: pageId,
    idempotency_key: input.idempotencyKey,
    title: input.title,
    folder: "financial",
    tldr: input.tldr,
    status_as_of: input.statusAsOf,
    body,
    claims,
    source_ids: [input.sourceId],
  });
}

export async function syncPlaidPostureToPersonalWiki(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  financial?: FinancialDomain | Record<string, unknown> | null;
}): Promise<boolean> {
  const cachedFinancial = CacheService.getInstance().get<Record<string, unknown>>(
    CACHE_KEYS.DOMAIN_DATA(input.userId, "financial"),
  );
  const financialPayload = input.financial ?? cachedFinancial;
  const summary = buildPlaidWikiPostureSummary(financialPayload);
  if (!summary) return false;
  const mirrorPages = buildPlaidWikiMirrorPages(financialPayload);
  const fullMarkdown = [
    summary.markdown,
    ...mirrorPages.map((page) => `## ${page.title}\n${page.bullets.map((line) => `- ${line}`).join("\n")}`),
  ].join("\n\n");

  const isPrivatePod = await ownerContentIsPrivate().catch(() => false);
  if (isPrivatePod) {
    try {
      const response = await ApiService.ownerPodRequest(
        "files/wiki/migrate",
        {
          method: "POST",
          signal: AbortSignal.timeout(POD_WIKI_MIGRATE_TIMEOUT_MS),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "compile_and_verify",
            v1_markdown: fullMarkdown,
            chat_key_verified: true,
            request_id: crypto.randomUUID(),
          }),
        },
        false,
      );
      if (response.ok) return true;
    } catch {
      // Pod files disabled (`503 FILES_NOT_ENABLED`) or transient timeout: fall
      // through to the owner-encrypted Personal Wiki library so Wiki & hot.md
      // stay current without blocking Chat or leaking plaintext server-side.
    }
  }

  const wiki =
    peekActiveSharedWiki() ??
    ensureActiveSharedWiki({
      userId: input.userId,
      vaultKey: input.vaultKey,
      vaultOwnerToken: input.vaultOwnerToken,
    });
  if (!wiki) return false;

  const observedAt = new Date().toISOString();
  const contentSha = await sha256Hex(fullMarkdown);
  const sourceId = `wsr_${(await sha256Hex(`plaid:sync:${contentSha}:${observedAt}`)).slice(0, 16)}`;
  const source: WikiSourceRef = {
    source_id: sourceId,
    kind: "pkm_record",
    locator: PLAID_WIKI_SOURCE_LOCATOR,
    content_sha256: contentSha,
    observed_at: observedAt,
  };
  await wiki.registerSource(source, `plaid-src:${contentSha.slice(0, 24)}:${Date.now()}`);

  const idempotencyBase = `plaid-wiki:${contentSha.slice(0, 24)}:${Date.now()}`;
  await upsertSharedWikiPage({
    wiki,
    pageKey: "plaid:connected_financial_accounts:v1",
    idempotencyKey: `${idempotencyBase}:overview`,
    title: PLAID_WIKI_PAGE_TITLE,
    tldr: summary.tldr,
    statusAsOf: summary.statusAsOf,
    bullets: summary.claims.map((claim) => claim.statement),
    sourceId,
    observedAt,
  });

  for (const page of mirrorPages) {
    await upsertSharedWikiPage({
      wiki,
      pageKey: `plaid:mirror:${page.slug}:v1`,
      idempotencyKey: `${idempotencyBase}:${page.slug}`,
      title: page.title,
      tldr: page.tldr,
      statusAsOf: summary.statusAsOf,
      bullets: page.bullets,
      sourceId,
      observedAt,
    });
  }

  await new SharedWikiKnowledgeWriter(wiki).refreshHotDigest();
  return true;
}

export async function syncPlaidPostureToPersonalWikiBestEffort(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  financial: FinancialDomain | Record<string, unknown> | null | undefined;
}): Promise<boolean> {
  try {
    return await syncPlaidPostureToPersonalWiki(input);
  } catch {
    return false;
  }
}
