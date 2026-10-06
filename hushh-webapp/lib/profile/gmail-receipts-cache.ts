"use client";

import type {
  GmailLiveReceiptScanCoverage,
  ReceiptListItem,
  ReceiptListResponse,
} from "@/lib/services/gmail-receipts-service";

const RECEIPTS_CACHE_TTL_MS = 5 * 60 * 1000;
// The backend signs each continuation for two hours from the pass's first
// page. Resume well inside that window; an older pass restarts at page one.
const RECEIPT_SCAN_RESUME_WINDOW_MS = 100 * 60 * 1000;

interface CachedReceiptEntry extends ReceiptListResponse {
  next_cursor?: string | null;
  fetched_at: number;
  receipt_scan_reached_limit: boolean;
  /** When this scan pass requested page one (its continuation window). */
  scan_started_at?: number;
  /**
   * Rows from the previous completed pass that this unfinished pass has not
   * re-read yet. They stay visible until the pass completes.
   */
  previous_items?: ReceiptListItem[];
}

// Live Gmail receipt DTOs are owner-scoped, vault-gated information. Keep the
// warm cache in process memory only. In particular, do not hydrate the retired
// sessionStorage receipt cache: it contains legacy rows whose identities cannot
// be resolved by the authoritative live detail endpoint.
const receiptCache = new Map<string, CachedReceiptEntry>();

function normalizeUserId(userId: string | null | undefined): string {
  return String(userId || "").trim();
}

function normalizeAccountKey(accountKey: string | null | undefined): string {
  return (
    String(accountKey || "legacy")
      .trim()
      .toLowerCase() || "legacy"
  );
}

function ownerAccountKey(
  userId: string | null | undefined,
  accountKey?: string | null,
): string {
  const owner = normalizeUserId(userId);
  return owner ? `${owner}\u0000${normalizeAccountKey(accountKey)}` : "";
}

function receiptCacheKey(item: ReceiptListItem): string {
  // The backend source handle is the authoritative account-bound identity.
  // Compatibility fields remain only for hydrating older read-only entries.
  return String(
    item.source_id ||
      item.gmail_message_id ||
      item.receipt_key ||
      item.id ||
      "",
  ).trim();
}

function isAuthoritativeLiveReceipt(item: ReceiptListItem): boolean {
  return (
    item.source_kind === "gmail_live" &&
    Boolean(String(item.source_id || "").trim())
  );
}

export function mergeCachedReceiptItems(params: {
  existing: ReceiptListItem[];
  incoming: ReceiptListItem[];
  mode: "replace" | "prepend_refresh" | "append";
}): ReceiptListItem[] {
  const seen = new Set<string>();
  const incomingByKey = new Map(
    params.incoming
      .filter(isAuthoritativeLiveReceipt)
      .map((item) => [receiptCacheKey(item), item] as const),
  );
  const ordered =
    params.mode === "append"
      ? [
          ...params.existing.map((item) =>
            incomingByKey.get(receiptCacheKey(item)) || item,
          ),
          ...params.incoming,
        ]
      : params.mode === "prepend_refresh"
        ? [...params.incoming, ...params.existing]
        : [...params.incoming];

  const merged: ReceiptListItem[] = [];
  for (const item of ordered) {
    if (!isAuthoritativeLiveReceipt(item)) continue;
    const key = receiptCacheKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function getCachedGmailReceipts(
  userId: string | null | undefined,
  accountKey?: string | null,
): CachedReceiptEntry | null {
  const cacheKey = ownerAccountKey(userId, accountKey);
  if (!cacheKey) return null;
  return receiptCache.get(cacheKey) || null;
}

export function isCachedGmailReceiptsFresh(
  userId: string | null | undefined,
  accountKey?: string | null,
  ttlMs = RECEIPTS_CACHE_TTL_MS,
): boolean {
  const cached = getCachedGmailReceipts(userId, accountKey);
  if (!cached?.fetched_at) return false;
  return Date.now() - cached.fetched_at <= ttlMs;
}

export function primeCachedGmailReceipts(params: {
  userId: string;
  accountKey?: string | null;
  response: ReceiptListResponse & {
    coverage?: GmailLiveReceiptScanCoverage;
    next_cursor?: string | null;
  };
  fetchedAt?: number;
  scanStartedAt?: number;
  previousItems?: readonly ReceiptListItem[] | null;
}): void {
  const cacheKey = ownerAccountKey(params.userId, params.accountKey);
  if (!cacheKey) return;

  const items = params.response.items.filter(isAuthoritativeLiveReceipt);
  const previousItems = params.previousItems?.filter(isAuthoritativeLiveReceipt);

  receiptCache.set(cacheKey, {
    ...params.response,
    items,
    total: items.length,
    has_more:
      items.length === params.response.items.length && params.response.has_more,
    receipt_scan_reached_limit:
      params.response.coverage?.reached_limit === true,
    fetched_at:
      typeof params.fetchedAt === "number" && Number.isFinite(params.fetchedAt)
        ? params.fetchedAt
        : Date.now(),
    ...(typeof params.scanStartedAt === "number" &&
    Number.isFinite(params.scanStartedAt)
      ? { scan_started_at: params.scanStartedAt }
      : {}),
    ...(previousItems?.length ? { previous_items: previousItems } : {}),
  });
}

/** Rows to show for a cached pass: re-read rows first, then unconfirmed ones. */
export function cachedGmailReceiptDisplayItems(
  cached: CachedReceiptEntry,
): ReceiptListItem[] {
  return cached.previous_items?.length
    ? mergeCachedReceiptItems({
        existing: cached.previous_items,
        incoming: cached.items,
        mode: "prepend_refresh",
      })
    : cached.items;
}

/** Whether an unfinished cached pass can continue from its signed cursor. */
export function isCachedGmailReceiptScanResumable(
  cached: CachedReceiptEntry | null,
  now = Date.now(),
): cached is CachedReceiptEntry & { next_cursor: string; scan_started_at: number } {
  return Boolean(
    cached &&
      cached.has_more &&
      cached.next_cursor &&
      typeof cached.scan_started_at === "number" &&
      now - cached.scan_started_at >= 0 &&
      now - cached.scan_started_at < RECEIPT_SCAN_RESUME_WINDOW_MS,
  );
}

export function upsertCachedGmailReceipt(params: {
  userId: string;
  accountKey?: string | null;
  item: ReceiptListItem;
}): void {
  const cacheKey = ownerAccountKey(params.userId, params.accountKey);
  const cached = cacheKey ? receiptCache.get(cacheKey) : null;
  if (!cached || !isAuthoritativeLiveReceipt(params.item)) return;
  const sourceKey = receiptCacheKey(params.item);
  if (!cached.items.some((item) => receiptCacheKey(item) === sourceKey)) return;
  receiptCache.set(cacheKey, {
    ...cached,
    items: mergeCachedReceiptItems({
      existing: cached.items,
      incoming: [params.item],
      mode: "append",
    }),
  });
}

export function clearCachedGmailReceipts(
  userId: string | null | undefined,
): void {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return;
  for (const key of receiptCache.keys()) {
    if (
      key === normalizedUserId ||
      key.startsWith(`${normalizedUserId}\u0000`)
    ) {
      receiptCache.delete(key);
    }
  }
}
