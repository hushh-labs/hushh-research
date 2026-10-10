import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import { apiJson } from "@/lib/services/api-client";

export type DriveRequestPricing = {
  /** Disabled means the owner must choose a price for each request. */
  enabled: boolean;
  amountCents: number;
  version: number;
};

export type DriveRequestQuote = {
  amountCents: number | null;
  version: number;
  paymentRequired: boolean;
  priceReady: boolean;
  payoutReady: boolean;
  paymentsReady: boolean;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Drive pricing response");
  }
  return value as Record<string, unknown>;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Invalid Drive pricing response");
  }
  return value as number;
}

function amount(value: unknown): number {
  if (!isValidDocumentRequestPriceCents(value)) {
    throw new Error("Invalid Drive pricing response");
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid Drive pricing response");
  return value;
}

const headers = (vaultOwnerToken: string) => ({
  Authorization: `Bearer ${vaultOwnerToken}`,
});

export class DriveRequestPricingService {
  static async owner(vaultOwnerToken: string): Promise<DriveRequestPricing> {
    if (!vaultOwnerToken) throw new Error("Unlock your vault to view Drive pricing");
    const value = record(await apiJson<unknown>("/api/connectors/google_drive/sharing/pricing", {
      headers: headers(vaultOwnerToken),
      cache: "no-store",
    }));
    return {
      enabled: boolean(value.enabled),
      amountCents: amount(value.amountCents),
      version: version(value.version),
    };
  }

  static async save(
    vaultOwnerToken: string,
    input: { enabled: boolean; amountCents: number; expectedVersion: number },
  ): Promise<DriveRequestPricing> {
    if (!vaultOwnerToken) throw new Error("Unlock your vault to change Drive pricing");
    if (typeof input.enabled !== "boolean" ||
        !isValidDocumentRequestPriceCents(input.amountCents)) {
      throw new Error("Choose a whole-dollar price from $1 to $500");
    }
    version(input.expectedVersion);
    const value = record(await apiJson<unknown>("/api/connectors/google_drive/sharing/pricing", {
      method: "PUT",
      headers: { ...headers(vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }));
    return {
      enabled: boolean(value.enabled),
      amountCents: amount(value.amountCents),
      version: version(value.version),
    };
  }

  static async quote(vaultOwnerToken: string, ownerPersonRef: string): Promise<DriveRequestQuote> {
    if (!vaultOwnerToken) throw new Error("Unlock your vault to view the quote");
    if (!DOCUMENT_REQUEST_UUID.test(ownerPersonRef)) throw new Error("Invalid owner reference");
    const value = record(await apiJson<unknown>(
      `/api/connectors/google_drive/sharing/quote?ownerPersonRef=${encodeURIComponent(ownerPersonRef)}`,
      { headers: headers(vaultOwnerToken), cache: "no-store" },
    ));
    const quotedAmount = value.amountCents === null ? null : amount(value.amountCents);
    const priceReady = boolean(value.priceReady);
    if (priceReady !== (quotedAmount !== null)) {
      throw new Error("Invalid Drive pricing response");
    }
    return {
      amountCents: quotedAmount,
      version: version(value.version),
      paymentRequired: boolean(value.paymentRequired),
      priceReady,
      payoutReady: boolean(value.payoutReady),
      paymentsReady: boolean(value.paymentsReady),
    };
  }
}
