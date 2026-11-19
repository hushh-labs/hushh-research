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

  const isPrivatePod = await ownerContentIsPrivate().catch(() => false);
  if (isPrivatePod) {
    const response = await ApiService.ownerPodRequest(
      "files/wiki/migrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "compile_and_verify",
          v1_markdown: summary.markdown,
          chat_key_verified: true,
          request_id: crypto.randomUUID(),
        }),
      },
      false,
    );
    return response.ok;
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
  const contentSha = await sha256Hex(summary.markdown);
  const pageId = `wpg_${(await sha256Hex("plaid:connected_financial_accounts:v1")).slice(0, 16)}`;
  const sourceId = `wsr_${(await sha256Hex(`plaid:sync:${contentSha}:${observedAt}`)).slice(0, 16)}`;
  const source: WikiSourceRef = {
    source_id: sourceId,
    kind: "pkm_record",
    locator: PLAID_WIKI_SOURCE_LOCATOR,
    content_sha256: contentSha,
    observed_at: observedAt,
  };
  await wiki.registerSource(source, `plaid-src:${contentSha.slice(0, 24)}:${Date.now()}`);

  const claims: WikiClaim[] = await Promise.all(
    summary.claims.map(async (item, index) => ({
      claim_id: `wcl_${(await sha256Hex(`${pageId}:${index}:${item.statement}`)).slice(0, 16)}`,
      statement: item.statement,
      status: "active",
      confidence: 1,
      source_ids: [sourceId],
      observed_at: observedAt,
    })),
  );

  const existing = await wiki.readPage(pageId).catch(() => null);
  const idempotencyKey = `plaid-wiki:${contentSha.slice(0, 24)}:${Date.now()}`;
  const body = summary.claims.map((c) => `- ${c.statement}`).join("\n");

  if (existing) {
    await wiki.editPage(pageId, {
      expected_revision: existing.revision,
      idempotency_key: idempotencyKey,
      title: PLAID_WIKI_PAGE_TITLE,
      folder: "financial",
      tldr: summary.tldr,
      status_as_of: summary.statusAsOf,
      body,
      claims,
      source_ids: [sourceId],
    });
  } else {
    await wiki.createPage({
      page_id: pageId,
      idempotency_key: idempotencyKey,
      title: PLAID_WIKI_PAGE_TITLE,
      folder: "financial",
      tldr: summary.tldr,
      status_as_of: summary.statusAsOf,
      body,
      claims,
      source_ids: [sourceId],
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
