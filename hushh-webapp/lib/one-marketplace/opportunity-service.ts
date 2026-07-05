import { apiJson } from "@/lib/services/api-client";

/**
 * A durable Information Marketplace opportunity signal (migration 077).
 *
 * Unlike every other nudge in the app (Gmail, Location), which is derived fresh
 * on load and forgotten on reload, a signal is a real server record with a
 * persisted lifecycle: snooze ("remind me later" → reappears next day), dismiss,
 * or mark published — and that state survives reloads and days.
 */
export interface OpportunitySignal {
  id: string;
  userId?: string;
  kind: "expiry" | "intent";
  domain: string;
  scopeHandle?: string | null;
  title: string;
  body?: string | null;
  eventDate?: string | null;
  suggestedPriceCents?: number;
  currency?: string;
  source: "derived" | "authored";
  status: "active" | "snoozed" | "published" | "dismissed" | "expired";
  snoozedUntil?: string | null;
  dedupeKey?: string;
  showCount?: number;
  /** Publish-CTA targeting data persisted by the server (topLevelScopePath, etc.). */
  metadata?: {
    topLevelScopePath?: string | null;
    scopeHandle?: string | null;
    label?: string | null;
    domainTitle?: string | null;
    [key: string]: unknown;
  };
  createdAt?: string;
  updatedAt?: string;
}

function jsonAuthHeaders(vaultOwnerToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${vaultOwnerToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Client for durable opportunity signals — the proactive Information Marketplace
 * flashcards surfaced on Agent One. Owner-scoped: every call is gated on the
 * vault-owner token (no Firebase id-token). The lifecycle mutations mirror the
 * server routes at /api/one/marketplace/opportunities.
 */
export class OneOpportunityService {
  /**
   * Signals due to show now (active, or snoozed with the snooze elapsed). The
   * server also derives fresh `intent` signals and expires past-dated ones on
   * this read, so the caller just gets the current, honest set.
   */
  static async listDue(params: {
    vaultOwnerToken: string;
  }): Promise<OpportunitySignal[]> {
    const res = await apiJson<{ opportunities: OpportunitySignal[] }>(
      "/api/one/marketplace/opportunities",
      { headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
    return res.opportunities ?? [];
  }

  /** Remind me later: hide the signal until the given day count (default tomorrow). */
  static async snooze(params: {
    vaultOwnerToken: string;
    signalId: string;
    untilDays?: number;
  }): Promise<void> {
    await apiJson(
      `/api/one/marketplace/opportunities/${encodeURIComponent(params.signalId)}/snooze`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ untilDays: params.untilDays ?? 1 }),
      },
    );
  }

  static async dismiss(params: {
    vaultOwnerToken: string;
    signalId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/marketplace/opportunities/${encodeURIComponent(params.signalId)}/dismiss`,
      { method: "POST", headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
  }

  /**
   * Record that the owner published the slice this signal pointed at. Consent-first:
   * this only transitions the signal so it stops resurfacing — the actual publish
   * runs through the normal owner-driven posture flow (applySlicePosture) first.
   */
  static async markPublished(params: {
    vaultOwnerToken: string;
    signalId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/marketplace/opportunities/${encodeURIComponent(params.signalId)}/publish`,
      { method: "POST", headers: jsonAuthHeaders(params.vaultOwnerToken) },
    );
  }

  /**
   * Author a signal directly (source="authored"). Used to seed a "save a memory"
   * opportunity and, later, for client-derived dated `expiry` signals.
   */
  static async author(params: {
    vaultOwnerToken: string;
    kind: "expiry" | "intent";
    domain: string;
    title: string;
    dedupeKey: string;
    scopeHandle?: string | null;
    body?: string | null;
    eventDate?: string | null;
    suggestedPriceCents?: number;
    currency?: string;
    metadata?: Record<string, unknown>;
  }): Promise<OpportunitySignal> {
    const res = await apiJson<{ opportunity: OpportunitySignal }>(
      "/api/one/marketplace/opportunities",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          kind: params.kind,
          domain: params.domain,
          title: params.title,
          dedupeKey: params.dedupeKey,
          scopeHandle: params.scopeHandle ?? null,
          body: params.body ?? null,
          eventDate: params.eventDate ?? null,
          suggestedPriceCents: params.suggestedPriceCents ?? 0,
          currency: params.currency ?? "USD",
          metadata: params.metadata ?? {},
        }),
      },
    );
    return res.opportunity;
  }
}
