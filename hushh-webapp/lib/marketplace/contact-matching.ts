"use client";

import {
  HushhContacts,
  type HushhContactRecord,
} from "@/lib/capacitor";

export type MarketplaceContactLookup = {
  hash: string;
  last4: string;
};

export type MarketplaceLocalContactLookup = MarketplaceContactLookup & {
  displayName?: string | null;
};

function normalizePhoneForContactHash(value: string): string | null {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function contactDisplayName(contact: HushhContactRecord): string | null {
  const value = String(contact.displayName || "").trim();
  return value || null;
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure hashing is unavailable in this web view.");
  }
  const encoded = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildMarketplaceContactLookups(options?: {
  limit?: number;
}): Promise<{
  lookups: MarketplaceLocalContactLookup[];
  totalContacts: number;
  sourcePlatform: "web" | "ios" | "android" | "native";
}> {
  const result = await HushhContacts.readContacts({ limit: options?.limit ?? 500 });
  const seen = new Set<string>();
  const lookups: MarketplaceLocalContactLookup[] = [];

  for (const contact of result.contacts) {
    for (const phoneNumber of contact.phoneNumbers || []) {
      const normalized = normalizePhoneForContactHash(phoneNumber);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const digits = normalized.replace(/\D/g, "");
      lookups.push({
        hash: await sha256Hex(normalized),
        last4: digits.slice(-4),
        displayName: contactDisplayName(contact),
      });
    }
  }

  return {
    lookups,
    totalContacts: result.contacts.length,
    sourcePlatform: result.sourcePlatform,
  };
}
