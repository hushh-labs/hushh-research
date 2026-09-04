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
 * The backend accepts at most 1000 entries per contact-sync request. The local
 * pipeline keeps the whole readable book; the sync orchestrator chunks it at
 * this boundary so later contacts are never mislabeled as unmatched.
 */
export const CONTACT_SYNC_BATCH_SIZE = 1000;
/** Hard privacy/performance ceiling: at most five mutation requests per sync. */
export const CONTACT_SYNC_MAX_LOOKUPS = 5000;
const CONTACT_HASH_CHUNK_SIZE = 250;

export type MarketplaceContactLookup = {
  /** Opaque, invocation-local correlation id. Never derived from phone data. */
  lookupId: string;
  hash: string;
  last4: string;
};

export type MarketplaceLocalContact = {
  /** Local-only source key. It must never be sent to the API or analytics. */
  contactKey: string;
  /** Kept only until matched rows are assembled; unmatched names are discarded. */
  displayName: string | null;
  lookupIds: string[];
  /** False when at least one usable number was beyond the per-sync lookup cap. */
  coverageComplete: boolean;
};

export type MarketplaceContactLookupResult = {
  lookups: MarketplaceContactLookup[];
  /** Local-only correlation table used for exact contact-level classification. */
  contacts: MarketplaceLocalContact[];
  totalContacts: number;
  readContactCount: number;
  unreadContactCount: number;
  uncheckableContactCount: number;
  excludedSelfContactCount: number;
  lookupLimitExceeded: boolean;
  lookupLimitedContactCount: number;
  sourcePlatform: HushhContactsReadResult["sourcePlatform"];
  /** Region used to interpret national-format numbers, for diagnostics. */
  region: string | null;
  /** True when only a user-selected subset of the contact book was readable. */
  limited: boolean;
  /** True when the contact source reports that part of the book was not read. */
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

/**
 * Where a batch of contacts comes from.
 *
 * The device address book is the default and stays the default. This exists so
 * a second source — Google Contacts, read in the browser — can feed the same
 * normalize/dedupe/hash pipeline instead of growing a parallel one. Everything
 * that keeps a raw phone number off our servers lives below this line, and
 * there has to be exactly one copy of it.
 *
 * Deliberately a function returning the whole `HushhContactsReadResult` rather
 * than a bare array of records: the pipeline reads `defaultRegion`,
 * `sourcePlatform`, `limited` and `truncated` off the result, and every one of
 * those is a judgement only the source is qualified to make.
 */
export type MarketplaceContactSource = (options: {
  limit: number;
}) => Promise<HushhContactsReadResult>;

export async function buildMarketplaceContactLookups(options?: {
  limit?: number;
  /**
   * The signed-in user's own verified phone number. Used only to infer which
   * region bare national contact numbers belong to; never hashed or sent.
   */
  accountPhoneNumber?: string | null;
  /**
   * Reads the latest verified account phone after the contact source returns.
   * AuthContext can finish hydrating while an OS/Google picker is open; callers
   * that provide this resolver avoid freezing the earlier null value.
   */
  resolveAccountPhoneNumber?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  signal?: AbortSignal;
  /** Defaults to the device address book through the Capacitor plugin. */
  source?: MarketplaceContactSource;
}): Promise<MarketplaceContactLookupResult> {
  // The default forwards exactly `{ limit }` and nothing else — the existing
  // test asserts that call shape as an exact object match, and it is the right
  // assertion: a source has no business receiving the account phone number or
  // the abort signal, both of which stay on this side of the seam.
  const read: MarketplaceContactSource =
    options?.source ?? ((forwarded) => HushhContacts.readContacts(forwarded));
  const result = await read({
    limit: options?.limit ?? 500,
  });
  options?.signal?.throwIfAborted();

  const accountPhoneNumber = options?.resolveAccountPhoneNumber
    ? await options.resolveAccountPhoneNumber()
    : options?.accountPhoneNumber;

  const region = resolveContactPhoneRegion({
    deviceRegion: result.defaultRegion,
    // Android is the only source whose region comes from the number plan; see
    // `resolveContactPhoneRegion` for why iOS cannot supply one and why
    // ranking a locale above the account's own number silently loses matches.
    deviceRegionFromNumberPlan: result.sourcePlatform === "android",
    accountPhoneNumber,
  });

  // Normalize once per unique number, while retaining which local contact rows
  // referenced it. The correlation table never leaves this process.
  const candidatesByNumber = new Map<
    string,
    {
      e164: string;
      last4: string;
      isMobile: boolean;
      firstSeenIndex: number;
    }
  >();
  const contactNumbers = new Map<string, Set<string>>();
  const selfOnlyContactKeys = new Set<string>();
  const accountPhoneE164 = accountPhoneNumber
    ? (normalizeContactPhone(accountPhoneNumber, region)?.e164 ?? null)
    : null;
  const localContacts = result.contacts.map((contact, index) => ({
    contactKey: `${String(contact.id || "contact")}:${index + 1}`,
    displayName: contactDisplayName(contact),
  }));

  for (const [contactIndex, contact] of result.contacts.entries()) {
    const contactKey = localContacts[contactIndex]!.contactKey;
    const normalizedNumbers = new Set<string>();
    let excludedOwnNumber = false;
    for (const phoneNumber of contact.phoneNumbers || []) {
      const normalized = normalizeContactPhone(phoneNumber, region);
      if (!normalized) continue;
      if (accountPhoneE164 && normalized.e164 === accountPhoneE164) {
        excludedOwnNumber = true;
        continue;
      }
      normalizedNumbers.add(normalized.e164);
      if (!candidatesByNumber.has(normalized.e164)) {
        candidatesByNumber.set(normalized.e164, {
          ...normalized,
          firstSeenIndex: candidatesByNumber.size,
        });
      }
    }
    contactNumbers.set(contactKey, normalizedNumbers);
    if (excludedOwnNumber && normalizedNumbers.size === 0) {
      selfOnlyContactKeys.add(contactKey);
    }
  }

  // Stable priority: mobile lines first, original contact order preserved
  // within each group so truncation stays predictable across runs.
  const prioritized = Array.from(candidatesByNumber.values())
    .map((candidate) => ({ candidate, index: candidate.firstSeenIndex }))
    .sort((left, right) => {
      if (left.candidate.isMobile !== right.candidate.isMobile) {
        return left.candidate.isMobile ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.candidate);

  options?.signal?.throwIfAborted();

  // Cap before hashing. Raw overflow values stay inside this function and are
  // never returned, persisted, logged, analysed, or sent to the API.
  const selectedCandidates = prioritized.slice(0, CONTACT_SYNC_MAX_LOOKUPS);
  const selectedNumbers = new Set(
    selectedCandidates.map((candidate) => candidate.e164),
  );
  const hashes: string[] = [];
  // WebCrypto work is bounded so a 5k address book does not enqueue thousands
  // of native bridge operations at once.
  for (
    let index = 0;
    index < selectedCandidates.length;
    index += CONTACT_HASH_CHUNK_SIZE
  ) {
    options?.signal?.throwIfAborted();
    hashes.push(
      ...(await Promise.all(
        selectedCandidates
          .slice(index, index + CONTACT_HASH_CHUNK_SIZE)
          .map((candidate) => sha256Hex(candidate.e164)),
      )),
    );
  }
  options?.signal?.throwIfAborted();

  const lookupIdByNumber = new Map<string, string>();
  const lookups = selectedCandidates.map((candidate, index) => {
    const lookupId = `lookup_${index + 1}`;
    lookupIdByNumber.set(candidate.e164, lookupId);
    return {
      lookupId,
      hash: hashes[index]!,
      last4: candidate.last4,
    };
  });
  const contacts = localContacts.map((contact) => {
    const normalizedNumbers = Array.from(
      contactNumbers.get(contact.contactKey) ?? [],
    );
    return {
      ...contact,
      lookupIds: normalizedNumbers
        .map((number) => lookupIdByNumber.get(number))
        .filter((lookupId): lookupId is string => Boolean(lookupId)),
      coverageComplete: normalizedNumbers.every((number) =>
        selectedNumbers.has(number),
      ),
    };
  });
  const totalAvailable = Math.max(
    result.contacts.length,
    Number(result.totalAvailable) || 0,
  );

  return {
    lookups,
    contacts,
    totalContacts: totalAvailable,
    readContactCount: result.contacts.length,
    unreadContactCount: Math.max(0, totalAvailable - result.contacts.length),
    uncheckableContactCount: contacts.filter(
      (contact) =>
        contact.lookupIds.length === 0 &&
        contact.coverageComplete &&
        !selfOnlyContactKeys.has(contact.contactKey),
    ).length,
    excludedSelfContactCount: selfOnlyContactKeys.size,
    lookupLimitExceeded: prioritized.length > CONTACT_SYNC_MAX_LOOKUPS,
    lookupLimitedContactCount: contacts.filter(
      (contact) => !contact.coverageComplete,
    ).length,
    sourcePlatform: result.sourcePlatform,
    region: region ?? null,
    limited: Boolean(result.limited),
    truncated: Boolean(result.truncated),
  };
}
