"use client";

import {
  HushhContacts,
  type HushhContactRecord,
  type HushhContactsReadResult,
} from "@/lib/capacitor";
import {
  normalizeContactPhone,
  resolveContactPhoneRegion,
} from "@/lib/contacts/phone-normalization";

/**
 * The backend caps `phone_lookups` at 1000 entries and rejects the whole
 * request past that, so the cap is enforced here rather than discovered as a
 * 422. Mobile numbers are kept first because accounts are SMS-verified, so a
 * landline can never be the thing that matched.
 */
const MAX_PHONE_LOOKUPS = 1000;

export type MarketplaceContactLookup = {
  hash: string;
  last4: string;
};

export type MarketplaceLocalContactLookup = MarketplaceContactLookup & {
  displayName?: string | null;
};

export type MarketplaceContactLookupResult = {
  lookups: MarketplaceLocalContactLookup[];
  totalContacts: number;
  sourcePlatform: HushhContactsReadResult["sourcePlatform"];
  /** Region used to interpret national-format numbers, for diagnostics. */
  region: string | null;
  /** True when only a user-selected subset of the contact book was readable. */
  limited: boolean;
  /** True when the contact read or the lookup cap dropped part of the book. */
  truncated: boolean;
};

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
  /**
   * The signed-in user's own verified phone number. Used only to infer which
   * region bare national contact numbers belong to; never hashed or sent.
   */
  accountPhoneNumber?: string | null;
  signal?: AbortSignal;
}): Promise<MarketplaceContactLookupResult> {
  const result = await HushhContacts.readContacts({
    limit: options?.limit ?? 500,
  });
  options?.signal?.throwIfAborted();

  const region = resolveContactPhoneRegion({
    deviceRegion: result.defaultRegion,
    accountPhoneNumber: options?.accountPhoneNumber,
  });

  // Normalize and dedupe before hashing. Hashing is the expensive step, so it
  // must never run twice for the same number — a contact book routinely holds
  // the same person under home/mobile/work entries.
  const seen = new Set<string>();
  const candidates: Array<{
    e164: string;
    last4: string;
    isMobile: boolean;
    displayName: string | null;
  }> = [];

  for (const contact of result.contacts) {
    const displayName = contactDisplayName(contact);
    for (const phoneNumber of contact.phoneNumbers || []) {
      const normalized = normalizeContactPhone(phoneNumber, region);
      if (!normalized || seen.has(normalized.e164)) continue;
      seen.add(normalized.e164);
      candidates.push({ ...normalized, displayName });
    }
  }

  // Stable priority: mobile lines first, original contact order preserved
  // within each group so truncation stays predictable across runs.
  const prioritized = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      if (left.candidate.isMobile !== right.candidate.isMobile) {
        return left.candidate.isMobile ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.candidate);

  const capped = prioritized.slice(0, MAX_PHONE_LOOKUPS);
  options?.signal?.throwIfAborted();

  // Hash in parallel. WebCrypto digests are dispatched to native code, so
  // awaiting them one at a time serialised ~1000 round trips through the
  // bridge for no reason.
  const hashes = await Promise.all(
    capped.map((candidate) => sha256Hex(candidate.e164)),
  );
  options?.signal?.throwIfAborted();

  return {
    lookups: capped.map((candidate, index) => ({
      hash: hashes[index]!,
      last4: candidate.last4,
      displayName: candidate.displayName,
    })),
    totalContacts: result.contacts.length,
    sourcePlatform: result.sourcePlatform,
    region: region ?? null,
    limited: Boolean(result.limited),
    truncated:
      Boolean(result.truncated) || prioritized.length > MAX_PHONE_LOOKUPS,
  };
}
