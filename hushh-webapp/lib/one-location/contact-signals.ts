"use client";

import { HushhContacts, type HushhContactsPermissionState } from "@/lib/capacitor";
import { buildMarketplaceContactLookups } from "@/lib/marketplace/contact-matching";
import {
  RiaService,
  type MarketplaceContactMatch,
} from "@/lib/services/ria-service";

/**
 * Why the sync could not produce matches. The caller used to infer this by
 * substring-matching the thrown message ("denied", "web view", …), which broke
 * silently whenever a platform reworded its error. The plugin already knows the
 * real permission state, so it is read directly and carried as a typed value.
 */
export type OneLocationContactSyncFailure =
  | "denied"
  | "restricted"
  | "unavailable"
  | "error";

export class OneLocationContactSyncError extends Error {
  readonly failure: OneLocationContactSyncFailure;

  constructor(failure: OneLocationContactSyncFailure, message: string) {
    super(message);
    this.name = "OneLocationContactSyncError";
    this.failure = failure;
  }
}

export type OneLocationContactSignalResult = {
  matches: MarketplaceContactMatch[];
  matchedUserIds: string[];
  totalContacts: number;
  inviteCandidateCount: number;
  sourcePlatform: "web" | "ios" | "android" | "native";
  /** Region used to read national-format contact numbers, for diagnostics. */
  region: string | null;
  /**
   * True when only part of the contact book was readable — iOS limited access
   * or the web contact picker. An empty result is then inconclusive, not proof
   * that nobody matched.
   */
  limited: boolean;
  /** True when the contact book was larger than the read or lookup caps. */
  truncated: boolean;
};

const PERMISSION_FAILURES: Partial<
  Record<HushhContactsPermissionState["state"], OneLocationContactSyncFailure>
> = {
  denied: "denied",
  restricted: "restricted",
  unavailable: "unavailable",
};

const PERMISSION_MESSAGES: Record<OneLocationContactSyncFailure, string> = {
  denied:
    "Contact access is turned off for Hussh. Turn it on in Settings to find people you already know.",
  restricted: "Contact access is restricted on this device.",
  unavailable: "Contact sync is available in the iOS and Android app.",
  error: "Could not sync contacts.",
};

async function assertContactsReadable(): Promise<void> {
  let permission: HushhContactsPermissionState;
  try {
    permission = await HushhContacts.getPermissionState();
  } catch {
    // A plugin that cannot report state at all is not installed on this
    // surface; treat it the same as an unavailable platform.
    throw new OneLocationContactSyncError(
      "unavailable",
      PERMISSION_MESSAGES.unavailable,
    );
  }

  const failure = PERMISSION_FAILURES[permission.state];
  if (failure) {
    throw new OneLocationContactSyncError(failure, PERMISSION_MESSAGES[failure]);
  }
}

export async function syncOneLocationContactSignals({
  idToken,
  accountPhoneNumber,
  contactLimit = 5000,
  matchLimit = 100,
  signal,
}: {
  idToken: string;
  /**
   * The signed-in user's own verified phone number. Used only to infer the
   * region for bare national contact numbers; never hashed or transmitted.
   */
  accountPhoneNumber?: string | null;
  contactLimit?: number;
  matchLimit?: number;
  signal?: AbortSignal;
}): Promise<OneLocationContactSignalResult> {
  await assertContactsReadable();

  const lookupResult = await buildMarketplaceContactLookups({
    limit: contactLimit,
    accountPhoneNumber,
    signal,
  });

  if (lookupResult.lookups.length === 0) {
    return {
      matches: [],
      matchedUserIds: [],
      totalContacts: lookupResult.totalContacts,
      inviteCandidateCount: lookupResult.totalContacts,
      sourcePlatform: lookupResult.sourcePlatform,
      region: lookupResult.region,
      limited: lookupResult.limited,
      truncated: lookupResult.truncated,
    };
  }

  const matches = await RiaService.matchMarketplaceContacts(idToken, {
    phone_lookups: lookupResult.lookups.map(({ hash, last4 }) => ({
      hash,
      last4,
    })),
    limit: matchLimit,
    // One Location matches the whole One network, not just the Connect deck.
    // Under the marketplace scope an ordinary user matches nobody, because
    // marketplace profiles are off by default.
    scope: "one_network",
  });
  const privacySafeMatches = matches.map((match) => {
    const safeMatch = { ...match };
    delete safeMatch.phone_last4;
    return safeMatch as MarketplaceContactMatch;
  });
  const matchedUserIds = Array.from(
    new Set(
      privacySafeMatches
        .map((match) => String(match.user_id || "").trim())
        .filter(Boolean),
    ),
  );

  return {
    matches: privacySafeMatches,
    matchedUserIds,
    totalContacts: lookupResult.totalContacts,
    inviteCandidateCount: Math.max(
      0,
      lookupResult.totalContacts - matchedUserIds.length,
    ),
    sourcePlatform: lookupResult.sourcePlatform,
    region: lookupResult.region,
    limited: lookupResult.limited,
    truncated: lookupResult.truncated,
  };
}

/** Open the OS settings page so a denied user can restore contact access. */
export async function openContactPermissionSettings(): Promise<boolean> {
  try {
    const result = await HushhContacts.openAppSettings();
    return Boolean(result?.opened);
  } catch {
    return false;
  }
}
