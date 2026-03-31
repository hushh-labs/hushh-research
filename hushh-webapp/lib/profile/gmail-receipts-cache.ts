"use client";

import type { ReceiptListItem, ReceiptListResponse } from "@/lib/services/gmail-receipts-service";
import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";

const STORAGE_KEY = "kai_gmail_receipts_cache_v1";
const CACHE_VERSION = 1;
const RECEIPTS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedReceiptEntry extends ReceiptListResponse {
  fetched_at: number;
}

interface PersistedReceiptCache {
  version: number;
  entries: Record<string, CachedReceiptEntry>;
}

const receiptCache = new Map<string, CachedReceiptEntry>();
let hydrated = false;

function normalizeUserId(userId: string | null | undefined): string {
  return String(userId || "").trim();
}

function receiptCacheKey(item: ReceiptListItem): string {
  return String(item.id || item.gmail_message_id || "").trim();
}

function hydrateCache(): void {
  if (hydrated) return;
  hydrated = true;

  const raw = getSessionItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedReceiptCache>;
    if (parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
      return;
    }

    for (const [userId, value] of Object.entries(parsed.entries)) {
      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId || !value || typeof value !== "object") continue;
      receiptCache.set(normalizedUserId, {
        items: Array.isArray(value.items) ? value.items : [],
        page: Number.isFinite(value.page) ? Math.max(1, Number(value.page)) : 1,
        per_page: Number.isFinite(value.per_page) ? Math.max(1, Number(value.per_page)) : 20,
        total: Number.isFinite(value.total) ? Math.max(0, Number(value.total)) : 0,
        has_more: Boolean(value.has_more),
        fetched_at:
          Number.isFinite(value.fetched_at) && Number(value.fetched_at) > 0
            ? Number(value.fetched_at)
            : 0,
      });
    }
  } catch {
    // Ignore malformed cache and continue with empty in-memory state.
  }
}

function persistCache(): void {
  setSessionItem(
    STORAGE_KEY,
    JSON.stringify({
      version: CACHE_VERSION,
      entries: Object.fromEntries(receiptCache.entries()),
    } satisfies PersistedReceiptCache)
  );
}

export function mergeCachedReceiptItems(params: {
  existing: ReceiptListItem[];
  incoming: ReceiptListItem[];
  mode: "replace" | "prepend_refresh" | "append";
}): ReceiptListItem[] {
  const seen = new Set<string>();
  const ordered =
    params.mode === "append"
      ? [...params.existing, ...params.incoming]
      : params.mode === "prepend_refresh"
        ? [...params.incoming, ...params.existing]
        : [...params.incoming];

  const merged: ReceiptListItem[] = [];
  for (const item of ordered) {
    const key = receiptCacheKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function getCachedGmailReceipts(
  userId: string | null | undefined
): CachedReceiptEntry | null {
  hydrateCache();
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;
  return receiptCache.get(normalizedUserId) || null;
}

export function isCachedGmailReceiptsFresh(
  userId: string | null | undefined,
  ttlMs = RECEIPTS_CACHE_TTL_MS
): boolean {
  const cached = getCachedGmailReceipts(userId);
  if (!cached?.fetched_at) return false;
  return Date.now() - cached.fetched_at <= ttlMs;
}

export function primeCachedGmailReceipts(params: {
  userId: string;
  response: ReceiptListResponse;
  fetchedAt?: number;
}): void {
  hydrateCache();
  const normalizedUserId = normalizeUserId(params.userId);
  if (!normalizedUserId) return;

  receiptCache.set(normalizedUserId, {
    ...params.response,
    fetched_at:
      typeof params.fetchedAt === "number" && Number.isFinite(params.fetchedAt)
        ? params.fetchedAt
        : Date.now(),
  });
  persistCache();
}

export function clearCachedGmailReceipts(userId: string | null | undefined): void {
  hydrateCache();
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return;
  receiptCache.delete(normalizedUserId);
  persistCache();
}
