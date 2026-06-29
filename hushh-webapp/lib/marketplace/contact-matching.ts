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

export type MarketplaceEmailContactLookup = {
  hash: string;
};

type MarketplaceLocalEmailContactLookup = MarketplaceEmailContactLookup & {
  displayName?: string | null;
  domain?: string | null;
};

function normalizePhoneForContactHash(value: string): string | null {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function normalizeEmailForContactHash(value: string): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return null;
  const [localPart, domain, ...rest] = normalized.split("@");
  if (!localPart || !domain || rest.length > 0) return null;
  return `${localPart}@${domain}`;
}

function emailDomain(value: string): string | null {
  return value.split("@")[1] || null;
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
  phoneLookups: MarketplaceLocalContactLookup[];
  emailLookups: MarketplaceLocalEmailContactLookup[];
  totalContacts: number;
  sourcePlatform: "web" | "ios" | "android" | "native";
}> {
  const result = await HushhContacts.readContacts({ limit: options?.limit ?? 500 });
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  const phoneLookups: MarketplaceLocalContactLookup[] = [];
  const emailLookups: MarketplaceLocalEmailContactLookup[] = [];

  for (const contact of result.contacts) {
    for (const phoneNumber of contact.phoneNumbers || []) {
      const normalized = normalizePhoneForContactHash(phoneNumber);
      if (!normalized || seenPhones.has(normalized)) continue;
      seenPhones.add(normalized);
      const digits = normalized.replace(/\D/g, "");
      phoneLookups.push({
        hash: await sha256Hex(normalized),
        last4: digits.slice(-4),
        displayName: contactDisplayName(contact),
      });
    }

    for (const emailAddress of contact.emailAddresses || []) {
      const normalized = normalizeEmailForContactHash(emailAddress);
      if (!normalized || seenEmails.has(normalized)) continue;
      seenEmails.add(normalized);
      emailLookups.push({
        hash: await sha256Hex(normalized),
        displayName: contactDisplayName(contact),
        domain: emailDomain(normalized),
      });
    }
  }

  return {
    lookups: phoneLookups,
    phoneLookups,
    emailLookups,
    totalContacts: result.contacts.length,
    sourcePlatform: result.sourcePlatform,
  };
}

export async function buildMarketplaceContactLookupsFromQuery(query: string): Promise<{
  phoneLookups: MarketplaceContactLookup[];
  emailLookups: MarketplaceEmailContactLookup[];
}> {
  const normalizedEmail = normalizeEmailForContactHash(query);
  if (normalizedEmail) {
    return {
      phoneLookups: [],
      emailLookups: [{ hash: await sha256Hex(normalizedEmail) }],
    };
  }

  const queryDigits = String(query || "").replace(/\D/g, "");
  if (queryDigits.length < 7) {
    return { phoneLookups: [], emailLookups: [] };
  }
  const normalizedPhone = normalizePhoneForContactHash(query);
  if (normalizedPhone) {
    const digits = normalizedPhone.replace(/\D/g, "");
    return {
      phoneLookups: [
        {
          hash: await sha256Hex(normalizedPhone),
          last4: digits.slice(-4),
        },
      ],
      emailLookups: [],
    };
  }

  return { phoneLookups: [], emailLookups: [] };
}
