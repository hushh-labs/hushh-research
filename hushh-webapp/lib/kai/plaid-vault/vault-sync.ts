"use client";

/**
 * Wires the zero-knowledge Plaid flow into the app.
 *
 * The person's Plaid access token and every record Plaid returns live in their
 * encrypted financial memory (founder decision 2026-09-23). The server only
 * relays Plaid calls through `/api/kai/plaid/vault` and keeps nothing. This
 * module:
 *
 * - connects a bank: vault link token -> Plaid Link -> exchange -> first
 *   snapshot, sealed into memory in one owner-confirmed write;
 * - refreshes on unlock: each sealed connection whose last refresh is older
 *   than the freshness window is re-read and saved under the
 *   `owner_connected_source_sync` receipt (never claimed as a review);
 * - disconnects: Plaid first, then the connection and its records;
 * - adapts memory into the server-shaped status the finance screens render.
 */

import type { PlaidAccountSummary, PlaidItemSummary, PlaidPortfolioStatusResponse } from "@/lib/kai/brokerage/portfolio-sources";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { resolvePlaidLinkPlatform } from "@/lib/capacitor/plaid-link";
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import { resolvePlaidRedirectUri } from "@/lib/kai/brokerage/plaid-redirect-uri";
import {
  buildFinancialDomainSummary,
  getActiveStatementSnapshotId,
  setActivePlaidSource,
  setActiveStatementSnapshot,
} from "@/lib/kai/brokerage/financial-sources";
import {
  applyConnectionLink,
  applySnapshot,
  recomputeDerived,
  removeConnection,
  toPortfolioData,
} from "@/lib/kai/plaid-vault/projection";
import type {
  ConnectionRecord,
  FinancialDomain,
  PlaidVaultSnapshot,
} from "@/lib/kai/plaid-vault/types";
import { isUnavailable } from "@/lib/kai/plaid-vault/types";
import {
  createVaultLinkToken,
  exchangeVaultPublicToken,
  fetchVaultSnapshot,
  removeVaultItem,
} from "@/lib/kai/plaid-vault/vault-client";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** A connection refreshed more recently than this is not re-read on unlock. */
export const VAULT_REFRESH_FRESHNESS_MS = 15 * 60 * 1000;
/** `/snapshot` pages transactions itself; the device follows `has_more` this many times. */
const MAX_SNAPSHOT_FOLLOW_UPS = 5;

type AnyRecord = Record<string, unknown>;

/**
 * Every vault write builds the complete financial domain from the latest
 * memory, so it replaces the domain. Without this the store's default merge
 * picks the first `entities` map it finds and silently drops everything else
 * (seen on the iPhone proof 2026-09-23: the write returned 200 and the sealed
 * connection, accounts and summary were gone).
 */
const VAULT_REPLACE_FINANCIAL = {
  merge_mode: "replace_domain",
  target_domain: "financial",
} as const;

export type VaultSurface = "web" | "ios" | "android";

/** One launch only: XCTest supplies this through NSArgumentDomain, never persisted by product code. */
export const PLAID_SANDBOX_PROOF_PREFERENCE_KEY = "hushh_plaid_sandbox_proof";

export function isPlaidSandboxProofBuild(): boolean {
  return process.env.NEXT_PUBLIC_PLAID_SANDBOX_PROOF === "true";
}

async function plaidSandboxProofRequestedForLaunch(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await Preferences.get({ key: PLAID_SANDBOX_PROOF_PREFERENCE_KEY })).value === "1";
  } catch {
    return false;
  }
}

/**
 * A proof Link token can exist only when the immutable WebView build and the
 * single native test launch both opt in. A UAT bundle with the launch flag—or
 * a local proof bundle opened normally—fails before any backend request.
 */
export async function requirePlaidSandboxProofMarker(): Promise<boolean> {
  const builtForProof = isPlaidSandboxProofBuild();
  const requestedForLaunch = await plaidSandboxProofRequestedForLaunch();
  if (builtForProof !== requestedForLaunch) {
    throw new Error("Plaid sandbox proof requires the matching local build and native launch marker.");
  }
  return builtForProof;
}

export function vaultConnections(financial: AnyRecord | null | undefined): Record<string, ConnectionRecord> {
  const raw = (financial as FinancialDomain | null | undefined)?.connections_v1;
  return raw && typeof raw === "object" ? raw : {};
}

export function hasVaultConnections(financial: AnyRecord | null | undefined): boolean {
  return Object.keys(vaultConnections(financial)).length > 0;
}

function surfaceFor(platform: string): VaultSurface {
  return platform === "ios" || platform === "android" ? platform : "web";
}

/**
 * Read every transactions page for one connection. Each page is a delta on
 * the previous cursor, so the pages are applied in order by the caller.
 */
async function readSnapshotPages(params: {
  vaultOwnerToken: string;
  accessToken: string;
  cursor: string | null;
}): Promise<PlaidVaultSnapshot[]> {
  const pages: PlaidVaultSnapshot[] = [];
  let cursor = params.cursor;
  for (let attempt = 0; attempt <= MAX_SNAPSHOT_FOLLOW_UPS; attempt += 1) {
    const snapshot = await fetchVaultSnapshot({
      vaultOwnerToken: params.vaultOwnerToken,
      accessToken: params.accessToken,
      transactionsCursor: cursor,
    });
    pages.push(snapshot);
    if (snapshot.item?.error) break;
    const transactions = snapshot.transactions;
    if (isUnavailable(transactions)) break;
    const hasMore = (transactions as { has_more?: boolean }).has_more === true;
    if (!hasMore || !transactions.next_cursor || transactions.next_cursor === cursor) break;
    cursor = transactions.next_cursor;
  }
  return pages;
}

function applyPages(
  financial: AnyRecord,
  itemId: string,
  pages: PlaidVaultSnapshot[],
  now: string,
): FinancialDomain {
  let next = financial as FinancialDomain;
  for (const page of pages) next = applySnapshot(next, itemId, page, now);
  return next;
}

/** The finance screens show the linked source once a bank is connected. */
/**
 * Keeps the readable portfolio in step with the vault on every vault save:
 * the retired `sources.plaid` copy is dropped, and when Plaid is the active
 * source `portfolio` and `analytics` are rebuilt from the sealed holdings
 * (analysis, disclosures and ticker lookups read them).
 */
function withVaultPortfolio(financial: FinancialDomain, now: string, activate = false): FinancialDomain {
  const sources = { ...((financial.sources as AnyRecord | undefined) ?? {}) };
  delete sources.plaid;
  const base = { ...financial, sources } as FinancialDomain;
  if (!activate && sources.active_source !== "plaid") return base;
  const active = setActivePlaidSource(base, now) as FinancialDomain | null;
  if (active) return active;
  if (activate) return { ...base, sources: { ...sources, active_source: "plaid" } } as FinancialDomain;
  // Plaid was active and no sealed holdings remain (the last bank was
  // disconnected): fall back to the saved statement, or to nothing.
  const snapshotId = getActiveStatementSnapshotId(base);
  const statement = snapshotId
    ? (setActiveStatementSnapshot(base, snapshotId, now) as FinancialDomain | null)
    : null;
  if (statement) return statement;
  const cleared = { ...base, sources: { ...sources, active_source: "statement" } } as FinancialDomain;
  delete (cleared as AnyRecord).portfolio;
  delete (cleared as AnyRecord).analytics;
  return cleared;
}

export type VaultConnectResult =
  | { status: "connected"; itemId: string; institutionName: string | null }
  | { status: "exited" }
  | { status: "blocked"; reason: string };

/** A vault link token for this platform (Android only when native Link opens it). */
export async function createVaultLink(params: {
  vaultOwnerToken: string;
  /** Update mode: repair the Item this sealed token belongs to. */
  accessToken?: string;
}): Promise<{ linkToken: string; platform: VaultSurface }> {
  const platform = await resolvePlaidLinkPlatform();
  const sandboxProof = await requirePlaidSandboxProofMarker();
  const link = await createVaultLinkToken({
    vaultOwnerToken: params.vaultOwnerToken,
    request: {
      platform,
      redirect_uri: platform === "android" ? null : resolvePlaidRedirectUri(),
      ...(sandboxProof ? { sandbox_proof: true } : {}),
      ...(params.accessToken ? { access_token: params.accessToken } : {}),
    },
  });
  return { linkToken: link.link_token, platform: surfaceFor(platform) };
}

export type SealedVaultConnection = {
  itemId: string;
  institutionName: string | null;
  financial: FinancialDomain;
  status: PlaidPortfolioStatusResponse | null;
};

/**
 * Exchange a Plaid public token and seal the resulting connection, with its
 * first snapshot, into the person's financial memory in one owner-confirmed
 * write (the person tapped Connect). The token goes from Plaid through the
 * relay to this device and into the encrypted write; it is stored nowhere
 * else. If the write fails the connection is disconnected at Plaid, so no live
 * connection is left that nobody holds.
 */
export async function sealVaultPlaidConnection(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  publicToken: string;
  surface: VaultSurface;
}): Promise<SealedVaultConnection> {
  const { userId, vaultKey, vaultOwnerToken } = params;
  const exchanged = await exchangeVaultPublicToken({ vaultOwnerToken, publicToken: params.publicToken });
  let pages: PlaidVaultSnapshot[];
  try {
    pages = await readSnapshotPages({ vaultOwnerToken, accessToken: exchanged.access_token, cursor: null });
  } catch (error) {
    await removeVaultItem({ vaultOwnerToken, accessToken: exchanged.access_token }).catch(() => undefined);
    throw error;
  }
  const now = new Date().toISOString();
  let saved: FinancialDomain | null = null;
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId,
    domain: "financial",
    vaultKey,
    vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: params.surface,
      source: "plaid_vault_connect",
    },
    build: (context) => {
      const linked = applyConnectionLink(
        context.currentDomainData,
        {
          item_id: exchanged.item_id,
          access_token: exchanged.access_token,
          institution: exchanged.institution,
          products: exchanged.consented_products?.length
            ? exchanged.consented_products
            : exchanged.products,
        },
        now,
      );
      const domainData = withVaultPortfolio(applyPages(linked, exchanged.item_id, pages, now), now, true);
      saved = domainData;
      return {
        domainData,
        summary: buildFinancialDomainSummary(domainData),
        mergeDecision: VAULT_REPLACE_FINANCIAL,
      };
    },
  });
  if (!result.success || !saved) {
    await removeVaultItem({ vaultOwnerToken, accessToken: exchanged.access_token }).catch(() => undefined);
    throw new Error(result.message || "Could not save the bank connection.");
  }
  const financial = saved as FinancialDomain;
  return {
    itemId: exchanged.item_id,
    institutionName: exchanged.institution?.name ?? null,
    financial,
    status: buildVaultPlaidStatus(financial, userId),
  };
}

/** Open Plaid Link with a vault link token; resolves the public token, or null on exit. */
export async function openVaultPlaidLink(linkToken: string): Promise<string | null> {
  const Plaid = await loadPlaidLink();
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: (token: string) => {
        if (settled) return;
        settled = true;
        handler.destroy?.();
        resolve(token);
      },
      onExit: (error: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        handler.destroy?.();
        if (error && typeof error === "object" && typeof error.error_message === "string") {
          reject(new Error(error.error_message));
          return;
        }
        resolve(null);
      },
    });
    handler.open();
  });
}

/** Connect a bank end to end (link, open, seal). */
export async function connectVaultPlaid(params: {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
}): Promise<VaultConnectResult> {
  const { userId, vaultKey, vaultOwnerToken } = params;
  if (!vaultKey || !vaultOwnerToken) {
    return { status: "blocked", reason: "Unlock your vault to connect a bank." };
  }
  const { linkToken, platform } = await createVaultLink({ vaultOwnerToken });
  const publicToken = await openVaultPlaidLink(linkToken);
  if (!publicToken) return { status: "exited" };
  const sealed = await sealVaultPlaidConnection({
    userId,
    vaultKey,
    vaultOwnerToken,
    publicToken,
    surface: platform,
  });
  return { status: "connected", itemId: sealed.itemId, institutionName: sealed.institutionName };
}

export type VaultRelinkResult =
  | { status: "repaired"; refreshed: number }
  | { status: "exited" }
  | { status: "blocked"; reason: string };

/**
 * Repairs a sealed connection that needs the person to log in again (Plaid
 * update mode). The access token does not change, so nothing new is sealed;
 * a forced refresh then reads the Item and clears its "needs relink" state.
 */
export async function relinkVaultPlaid(params: {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  itemId: string;
}): Promise<VaultRelinkResult> {
  const { userId, vaultKey, vaultOwnerToken, itemId } = params;
  if (!vaultKey || !vaultOwnerToken) {
    return { status: "blocked", reason: "Unlock your vault to reconnect this bank." };
  }
  const financial = await loadFinancialForVault({ userId, vaultKey, vaultOwnerToken });
  const connection = vaultConnections(financial)[itemId];
  if (!connection?.access_token) {
    return { status: "blocked", reason: "That connection is no longer in your vault." };
  }
  const { linkToken } = await createVaultLink({
    vaultOwnerToken,
    accessToken: connection.access_token,
  });
  const publicToken = await openVaultPlaidLink(linkToken);
  if (!publicToken) return { status: "exited" };
  const outcome = await refreshVaultConnections({
    userId,
    vaultKey,
    vaultOwnerToken,
    financial,
    force: true,
  });
  return { status: "repaired", refreshed: outcome.refreshed };
}

export type VaultRefreshOutcome = {
  refreshed: number;
  needsRelink: string[];
  failed: number;
  saved: boolean;
};

function isStale(connection: ConnectionRecord, nowMs: number): boolean {
  if (!connection.last_refreshed_at) return true;
  const last = Date.parse(connection.last_refreshed_at);
  return !Number.isFinite(last) || nowMs - last >= VAULT_REFRESH_FRESHNESS_MS;
}

/**
 * Refresh sealed connections. Called on unlock and when the person asks.
 * Reads Plaid first (outside the write), then applies everything to the
 * latest memory inside one write so a concurrent save is never overwritten.
 */
type VaultRefreshParams = {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  financial: AnyRecord | null | undefined;
  surface?: VaultSurface;
  force?: boolean;
};

// One background refresh per person and vault session at a time. Unlock warming and the Kai
// finance loader both ask for one; overlapping runs would read the same pages
// twice and save twice. A forced (person-initiated) refresh always runs.
const refreshInFlight = new Map<string, Promise<VaultRefreshOutcome>>();

export function refreshVaultConnections(params: VaultRefreshParams): Promise<VaultRefreshOutcome> {
  const vaultEpoch = snapshotVaultSessionEpoch();
  if (params.force === true) return runVaultRefresh(params, vaultEpoch);
  const key = `${params.userId}:${vaultEpoch}`;
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const run = runVaultRefresh(params, vaultEpoch).finally(() => {
    if (refreshInFlight.get(key) === run) refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, run);
  return run;
}

async function runVaultRefresh(params: VaultRefreshParams, vaultEpoch: number): Promise<VaultRefreshOutcome> {
  const outcome: VaultRefreshOutcome = { refreshed: 0, needsRelink: [], failed: 0, saved: false };
  const { userId, vaultKey, vaultOwnerToken } = params;
  if (!vaultKey || !vaultOwnerToken || !isVaultSessionEpochCurrent(vaultEpoch)) return outcome;
  const nowMs = Date.now();
  const due = Object.entries(vaultConnections(params.financial)).filter(
    ([, connection]) => params.force === true || isStale(connection, nowMs),
  );
  if (due.length === 0) return outcome;

  const read: Array<{ itemId: string; pages: PlaidVaultSnapshot[] }> = [];
  for (const [itemId, connection] of due) {
    if (!isVaultSessionEpochCurrent(vaultEpoch)) return outcome;
    try {
      const pages = await readSnapshotPages({
        vaultOwnerToken,
        accessToken: connection.access_token,
        cursor: connection.transactions_cursor,
      });
      if (!isVaultSessionEpochCurrent(vaultEpoch)) return outcome;
      read.push({ itemId, pages });
      if (pages.some((page) => page.item?.error)) outcome.needsRelink.push(itemId);
    } catch {
      outcome.failed += 1;
    }
  }
  if (read.length === 0 || !isVaultSessionEpochCurrent(vaultEpoch)) return outcome;

  const now = new Date().toISOString();
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId,
    domain: "financial",
    vaultKey,
    vaultOwnerToken,
    beforeEffect: async () => {
      if (!isVaultSessionEpochCurrent(vaultEpoch)) {
        throw new DOMException("The vault session changed.", "AbortError");
      }
    },
    confirmation: {
      authorizationMode: "owner_connected_source_sync",
      surface: params.surface ?? "web",
      source: "plaid_vault_refresh",
      connectedSourceProvider: "plaid",
    },
    build: (context) => {
      let domainData = context.currentDomainData as FinancialDomain;
      for (const { itemId, pages } of read) {
        if (!vaultConnections(domainData)[itemId]) continue; // disconnected meanwhile
        domainData = applyPages(domainData, itemId, pages, now);
      }
      domainData = withVaultPortfolio(recomputeDerived(domainData, now), now);
      return {
        domainData,
        summary: buildFinancialDomainSummary(domainData),
        mergeDecision: VAULT_REPLACE_FINANCIAL,
      };
    },
  });
  outcome.refreshed = result.success ? read.length : 0;
  outcome.saved = result.success;
  return outcome;
}

/**
 * Disconnect a bank the person chose to remove: tell Plaid first, then drop
 * the connection and every record it produced, and recompute the facts.
 */
export async function disconnectVaultPlaid(params: {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  itemId: string;
  financial: AnyRecord | null | undefined;
  surface?: VaultSurface;
}): Promise<boolean> {
  const { userId, vaultKey, vaultOwnerToken, itemId } = params;
  if (!vaultKey || !vaultOwnerToken) return false;
  const connection = vaultConnections(params.financial)[itemId];
  if (connection) {
    await removeVaultItem({ vaultOwnerToken, accessToken: connection.access_token });
  }
  const now = new Date().toISOString();
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId,
    domain: "financial",
    vaultKey,
    vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: params.surface ?? "web",
      source: "plaid_vault_disconnect",
    },
    build: (context) => {
      const domainData = withVaultPortfolio(removeConnection(context.currentDomainData, itemId, now), now);
      return {
        domainData,
        summary: buildFinancialDomainSummary(domainData),
        mergeDecision: VAULT_REPLACE_FINANCIAL,
      };
    },
  });
  return result.success;
}

/**
 * The server-shaped status the finance screens already render, built from
 * memory. No token, cursor or raw transaction leaves this function.
 */
export function buildVaultPlaidStatus(
  financial: AnyRecord | null | undefined,
  userId: string,
): PlaidPortfolioStatusResponse | null {
  const connections = vaultConnections(financial);
  const itemIds = Object.keys(connections);
  if (itemIds.length === 0) return null;
  const memory = financial as FinancialDomain;
  const accounts = Object.values(memory.accounts_v1 ?? {});
  const portfolio = toPortfolioData(memory);
  const lastRefreshed = itemIds
    .map((id) => connections[id]?.last_refreshed_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop() ?? null;

  const items: PlaidItemSummary[] = itemIds.map((itemId) => {
    const connection = connections[itemId]!;
    const itemAccounts: PlaidAccountSummary[] = accounts
      .filter((account) => account.item_id === itemId)
      .map((account) => ({
        account_id: account.account_id,
        persistent_account_id: account.persistent_account_id,
        name: account.name,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype,
        balances: {
          available: account.balances?.available ?? null,
          current: account.balances?.current ?? null,
          iso_currency_code: account.balances?.iso_currency_code ?? null,
          limit: account.balances?.limit ?? null,
        },
        institution_id: connection.institution_id,
        institution_name: connection.institution_name,
        item_id: itemId,
      }));
    return {
      item_id: itemId,
      institution_id: connection.institution_id,
      institution_name: connection.institution_name,
      status: connection.status === "needs_relink" ? "needs_relink" : "active",
      sync_status: connection.status === "needs_relink" ? "action_required" : "idle",
      last_synced_at: connection.last_refreshed_at,
      accounts: itemAccounts,
    };
  });

  return {
    configured: true,
    custody: "vault",
    user_id: userId,
    source_preference: "plaid",
    items,
    aggregate: {
      item_count: items.length,
      account_count: accounts.length,
      holdings_count: portfolio?.holdings?.length ?? 0,
      institution_names: [
        ...new Set(items.map((item) => item.institution_name).filter((name): name is string => Boolean(name))),
      ],
      last_synced_at: lastRefreshed,
      sync_status: items.some((item) => item.status === "needs_relink") ? "action_required" : "idle",
      portfolio_data: portfolio,
    },
  };
}

/** The person's current financial memory, read for a vault operation. */
export async function loadFinancialForVault(params: {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
}): Promise<AnyRecord | null> {
  if (!params.vaultKey || !params.vaultOwnerToken) return null;
  const prepared = await PkmDomainResourceService.prepareDomainWriteContext({
    userId: params.userId,
    domain: "financial",
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
  });
  return (prepared.domainData as AnyRecord | null) ?? null;
}

/** Disconnect every sealed connection (the person deleted their Plaid data). */
export async function disconnectAllVaultPlaid(params: {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  surface?: VaultSurface;
}): Promise<{ disconnected: number; failed: number }> {
  const financial = await loadFinancialForVault(params);
  let disconnected = 0;
  let failed = 0;
  for (const itemId of Object.keys(vaultConnections(financial))) {
    try {
      const ok = await disconnectVaultPlaid({ ...params, itemId, financial });
      if (ok) disconnected += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { disconnected, failed };
}
