// hushh-webapp/lib/services/slice-pricing-service.ts
/**
 * Slice pricing service (Phase 1: suggested price display only).
 *
 * Calls the server-authoritative pricing endpoint so the browser never computes
 * or fabricates a price. Sends only public slice metadata plus a demo audience
 * band — no ciphertext, no protected PKM content.
 *
 * IMPORTANT: goes through ApiService.apiFetch() (never direct fetch("/api/...")),
 * consistent with the rest of the PKM services.
 */

import { ApiService } from "./api-service";

export type PricingCategory =
  | "identifiers"
  | "quasi_identifiers"
  | "demographics_lifestyle"
  | "private_financial";
export type PricingPower = "mass" | "mid" | "affluent" | "hnw" | "uhnw";
export type PricingMood = "passive" | "affinity" | "in_market" | "hot";
export type PricingExclusivity = "shared" | "limited" | "exclusive";
export type PricingGeography = "us" | "non_us";

export interface SlicePricingInput {
  category?: PricingCategory;
  attributeCount: number;
  power?: PricingPower;
  mood?: PricingMood;
  weeksStale?: number;
  exclusivity?: PricingExclusivity;
  geography?: PricingGeography;
}

export interface SlicePriceBreakdown {
  suggestedPriceCents: number;
  currency: string;
  floorCents: number;
  breakdown: Record<string, unknown>;
}

export class SlicePricingError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message || `Failed to compute suggested price (${status})`);
    this.name = "SlicePricingError";
    this.status = status;
  }
}

/**
 * Mirror of the backend `category_from_sensitivity` mapping so the demo band
 * pricing lines up with what the server would derive from the same slice.
 */
export function categoryFromSensitivity(
  sensitivityTier?: string | null,
  scopeKind?: string | null
): PricingCategory {
  const tier = (sensitivityTier || "").trim().toLowerCase();
  const kind = (scopeKind || "").trim().toLowerCase();
  if (tier === "restricted" || kind.includes("financial") || kind.includes("secret")) {
    return "private_financial";
  }
  return "demographics_lifestyle";
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format((Number.isFinite(cents) ? cents : 0) / 100);
}

export class SlicePricingService {
  private static readonly ENDPOINT = "/api/pkm/slice-price";

  static async getSuggestedPrice(
    input: SlicePricingInput,
    vaultOwnerToken?: string
  ): Promise<SlicePriceBreakdown> {
    const response = await ApiService.apiFetch(this.ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(vaultOwnerToken ? { Authorization: `Bearer ${vaultOwnerToken}` } : {}),
      },
      body: JSON.stringify({
        category: input.category ?? "demographics_lifestyle",
        attribute_count: Math.max(0, Math.trunc(input.attributeCount || 0)),
        power: input.power ?? "mass",
        mood: input.mood ?? "passive",
        weeks_stale: Math.max(0, Math.trunc(input.weeksStale ?? 0)),
        exclusivity: input.exclusivity ?? "shared",
        geography: input.geography ?? "us",
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SlicePricingError(response.status, detail || undefined);
    }

    const data = (await response.json()) as {
      suggested_price_cents: number;
      currency: string;
      floor_cents: number;
      breakdown: Record<string, unknown>;
    };

    return {
      suggestedPriceCents: data.suggested_price_cents,
      currency: data.currency,
      floorCents: data.floor_cents,
      breakdown: data.breakdown ?? {},
    };
  }
}
