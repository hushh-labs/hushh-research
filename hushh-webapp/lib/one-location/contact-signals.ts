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

/**
 * How a completed sync should be reported, and what the user can do about it.
 *
 * Kept pure and separate from the toast so the wording is testable. It exists
 * because a partial read was being reported as if it were a whole one: the web
 * Contact Picker and iOS limited access both return only a hand-picked subset,
 * yet a match count phrased as "3 people added" reads as though the entire
 * address book was searched.
 */
export type ContactSyncRemedy =
  /** Re-run the picker so more contacts can be included (web). */
  | "pick_more"
  /** Open OS settings to widen contact access (iOS limited access). */
  | "open_settings"
  /**
   * Some contacts are not on Hushh. Offer to invite them.
   *
   * Only ever returned where the remedy would otherwise be null. A partial
   * read owns that slot with the remedy that widens it, and widening is the
   * better next step than inviting out of a list the person has not finished
   * choosing from.
   */
  | "invite"
  | null;

export type ContactSyncOutcome = {
  title: string;
  description?: string;
  remedy: ContactSyncRemedy;
};

function peopleLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function contactsLabel(count: number): string {
  return count === 1 ? "1 contact" : `${count} contacts`;
}

export function describeContactSyncOutcome(
  result: Pick<
    OneLocationContactSignalResult,
    | "matchedUserIds"
    | "totalContacts"
    | "sourcePlatform"
    | "limited"
    | "truncated"
    | "inviteCandidateCount"
  >,
): ContactSyncOutcome {
  const matched = result.matchedUserIds.length;
  // The other half of the answer. `inviteCandidateCount` has been computed on
  // every sync since this file shipped and read by nothing except an analytics
  // dimension — so the product learned "forty of your contacts are not here
  // yet", recorded it, and told the person nothing.
  const inviteCandidates = Math.max(0, result.inviteCandidateCount ?? 0);

  // The picker grants per-invocation and has no settings page to open, so
  // offering "Settings" there sends the user somewhere that cannot help —
  // openAppSettings resolves false on web. Re-running the picker is the only
  // real remedy. iOS limited access is the opposite: the subset is sticky
  // until it is widened in Settings.
  const remedy: ContactSyncRemedy = !result.limited
    ? null
    : result.sourcePlatform === "web"
      ? "pick_more"
      : "open_settings";

  if (result.limited) {
    const scanned = contactsLabel(result.totalContacts);
    return {
      title: matched
        ? `${matched} of the ${scanned} you shared ${matched === 1 ? "is" : "are"} on Hushh`
        : `None of the ${scanned} you shared are on Hushh yet`,
      description:
        remedy === "pick_more"
          ? "Only the contacts you picked were checked, not your whole address book."
          : "Only the contacts you shared with Hushh were checked.",
      remedy,
    };
  }

  if (!matched) {
    return {
      title: "No One users matched from this contact scan.",
      description: inviteCandidates
        ? `${contactsLabel(inviteCandidates)} could be invited.`
        : undefined,
      // `invite` only ever appears where `remedy` would have been null. A
      // partial read already owns that slot with the remedy that widens it,
      // and widening the read is the better next step than inviting from a
      // list the person has not finished picking.
      remedy: inviteCandidates ? "invite" : null,
    };
  }

  return {
    title: `${peopleLabel(matched)} added as a contact signal.`,
    // A truncated read is still a partial answer, just for a different reason:
    // the book was larger than the caps rather than deliberately narrowed.
    description: result.truncated
      ? "Your address book was larger than the sync limit, so some contacts were not checked."
      : inviteCandidates
        ? `${contactsLabel(inviteCandidates)} are not on Hushh yet.`
        : undefined,
    remedy: inviteCandidates ? "invite" : null,
  };
}
