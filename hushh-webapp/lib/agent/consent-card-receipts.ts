/**
 * Compact owner-scoped resolution receipts & live dynamic context projection
 * for incoming consent cards rendered inline in Main Chat.
 *
 * Security boundary:
 * - Stores non-secret metadata only (request/bundle ids, requester display name,
 *   human labels, duration hours, decision status, optional coin amount).
 * - Never stores vault keys, tokens, decrypted PKM values, or emails.
 * - Strictly scoped per owner user id, capped at 20 recent items with 24h TTL.
 */

import {
  consentInformationLabel,
  formatConsentDuration,
} from "@/lib/consent/consent-owner-copy";
import type { SpecialistPendingConsentRequestItem } from "@/components/agent/specialist-directive-card";
import {
  getPendingConsentRequestPayload,
  type AgentMessage,
} from "@/components/agent/workspace/agent-message-transforms";

export type VisibleIncomingConsentCardSummary = {
  requester_label: string;
  labels: string[];
  status: "pending" | "approved" | "denied" | "expired";
  reason: string;
  duration_label: string;
  price_coins: number;
  commerce_status: string;
};

export type ResolvedConsentCardReceipt = {
  item: SpecialistPendingConsentRequestItem;
  decidedAtMs: number;
};

const STORAGE_PREFIX = "hussh:one:consent_card_receipts:v1:";
const MAX_RECEIPTS = 20;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VISIBLE_CARDS = 5;

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerId}`;
}

function readCoins(metadata: Record<string, unknown> | null | undefined): number {
  if (!metadata) return 0;
  const bundleCoins = metadata.bundle_price_coins;
  if (typeof bundleCoins === "number" && Number.isFinite(bundleCoins) && bundleCoins > 0) {
    return Math.round(bundleCoins);
  }
  const reqCoins = metadata.request_price_coins;
  if (typeof reqCoins === "number" && Number.isFinite(reqCoins) && reqCoins > 0) {
    return Math.round(reqCoins);
  }
  return 0;
}

function cardLabels(item: SpecialistPendingConsentRequestItem): string[] {
  const bundled = (item.bundledScopes || [])
    .map((scope) => consentInformationLabel({ label: scope.label }))
    .filter(Boolean);
  if (bundled.length > 0) return bundled.slice(0, 6);
  const fallback = consentInformationLabel({
    scope: item.scope,
    label: item.scopeDescription,
  });
  return fallback ? [fallback] : [];
}

function durationLabelFor(hours?: number | string | null): string {
  if (hours == null || hours === "") return "";
  const numeric = typeof hours === "number" ? hours : Number(hours);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return formatConsentDuration(Math.round(numeric)) ?? "";
}

/**
 * Project currently mounted incoming consent cards in Main Chat into the bounded
 * non-secret payload forwarded inside `screenContext.visible_incoming_consent_cards`.
 */
export function serializeVisibleIncomingConsentCards(
  messages: readonly AgentMessage[],
): VisibleIncomingConsentCardSummary[] {
  const summaries: VisibleIncomingConsentCardSummary[] = [];
  const seen = new Set<string>();
  for (let idx = messages.length - 1; idx >= 0 && summaries.length < MAX_VISIBLE_CARDS; idx -= 1) {
    const msg = messages[idx];
    const payload = msg?.specialistDirective
      ? getPendingConsentRequestPayload(msg.specialistDirective)
      : null;
    const item = payload?.item;
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    const requester = String(item.requesterLabel || "").trim();
    const labels = cardLabels(item);
    if (!requester || labels.length === 0) continue;
    const rawStatus = String(item.status || "pending").toLowerCase();
    const status =
      rawStatus === "approved" || rawStatus === "denied" || rawStatus === "expired"
        ? rawStatus
        : "pending";
    const metadata = item.metadata ?? null;
    summaries.push({
      requester_label: requester.slice(0, 80),
      labels,
      status,
      reason: String(item.reason || "").trim().slice(0, 180),
      duration_label: durationLabelFor(item.expiryHours),
      price_coins: readCoins(metadata),
      commerce_status:
        typeof metadata?.commerce_status === "string"
          ? metadata.commerce_status.trim().toLowerCase().slice(0, 32)
          : "",
    });
  }
  return summaries.reverse();
}

function sanitizeReceiptItem(
  item: SpecialistPendingConsentRequestItem,
  status: "approved" | "denied",
  overrideHours?: number,
): SpecialistPendingConsentRequestItem {
  const metadata = item.metadata ?? null;
  const safeMetadata: Record<string, unknown> | null = metadata
    ? {
        ...(metadata.commercial_required === true ? { commercial_required: true } : {}),
        ...(metadata.upfront_price_reviewed === true ? { upfront_price_reviewed: true } : {}),
        ...(typeof metadata.request_price_coins === "number"
          ? { request_price_coins: metadata.request_price_coins }
          : {}),
        ...(typeof metadata.bundle_price_coins === "number"
          ? { bundle_price_coins: metadata.bundle_price_coins }
          : {}),
        ...(typeof metadata.commerce_status === "string"
          ? { commerce_status: status === "approved" ? "active" : "refunded" }
          : {}),
        ...(typeof metadata.requester_actor_type === "string"
          ? { requester_actor_type: metadata.requester_actor_type }
          : {}),
      }
    : null;
  return {
    id: item.id,
    requesterLabel: item.requesterLabel,
    requesterImageUrl: item.requesterImageUrl ?? null,
    scope: item.scope,
    scopeDescription: item.scopeDescription ?? null,
    requestedAt: item.requestedAt ?? null,
    expiryHours: overrideHours ?? item.expiryHours ?? null,
    reason: item.reason ?? null,
    status,
    metadata: safeMetadata,
    bundleId: item.bundleId ?? null,
    bundleLabel: item.bundleLabel ?? null,
    bundleScopeCount: item.bundleScopeCount ?? null,
    bundledRequestIds: item.bundledRequestIds ? [...item.bundledRequestIds] : [item.id],
    bundledScopes: item.bundledScopes ? item.bundledScopes.slice(0, 12) : undefined,
  };
}

export function readResolvedConsentCardReceipts(
  ownerId: string,
  nowMs = Date.now(),
): ResolvedConsentCardReceipt[] {
  if (!ownerId || typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(storageKey(ownerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ResolvedConsentCardReceipt => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        const item = record.item as Record<string, unknown> | undefined;
        const decidedAtMs = Number(record.decidedAtMs || 0);
        return Boolean(
          item &&
            typeof item.id === "string" &&
            item.id.trim() &&
            (item.status === "approved" || item.status === "denied") &&
            Number.isFinite(decidedAtMs) &&
            nowMs - decidedAtMs <= RECEIPT_TTL_MS,
        );
      })
      .slice(-MAX_RECEIPTS);
  } catch {
    return [];
  }
}

export function saveResolvedConsentCardReceipt(
  ownerId: string,
  item: SpecialistPendingConsentRequestItem,
  status: "approved" | "denied",
  overrideHours?: number,
): void {
  if (!ownerId || !item?.id || typeof window === "undefined") return;
  try {
    const nowMs = Date.now();
    const existing = readResolvedConsentCardReceipts(ownerId, nowMs).filter(
      (entry) =>
        entry.item.id !== item.id &&
        (!item.bundleId || entry.item.bundleId !== item.bundleId),
    );
    const next: ResolvedConsentCardReceipt[] = [
      ...existing,
      {
        item: sanitizeReceiptItem(item, status, overrideHours),
        decidedAtMs: nowMs,
      },
    ].slice(-MAX_RECEIPTS);
    window.sessionStorage.setItem(storageKey(ownerId), JSON.stringify(next));
  } catch {
    // Storage quota or private browsing must never block a consent decision.
  }
}

export function removeResolvedConsentCardReceipt(ownerId: string, requestId: string): void {
  if (!ownerId || !requestId || typeof window === "undefined") return;
  try {
    const existing = readResolvedConsentCardReceipts(ownerId).filter(
      (entry) =>
        entry.item.id !== requestId &&
        !(entry.item.bundledRequestIds || []).includes(requestId),
    );
    window.sessionStorage.setItem(storageKey(ownerId), JSON.stringify(existing));
  } catch {
    // Ignore storage failures.
  }
}
