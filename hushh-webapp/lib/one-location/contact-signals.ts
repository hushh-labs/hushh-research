"use client";

import {
  HushhContacts,
  type HushhContactsPermissionState,
} from "@/lib/capacitor";
import { isWeb } from "@/lib/capacitor/platform";
import {
  buildMarketplaceContactLookups,
  CONTACT_SYNC_BATCH_SIZE,
  CONTACT_SYNC_MAX_LOOKUPS,
  type MarketplaceContactSource,
} from "@/lib/marketplace/contact-matching";
import {
  ConnectionsService,
  ConnectionsServiceRequestError,
  type ContactSyncMatch,
  type ContactSyncMatchOutcome,
} from "@/lib/services/connections-service";

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
  /** Matched identities only. No hash, last-four, or unmatched row survives. */
  matches: ContactSyncMatch[];
  matchedUserIds: string[];
  totalContacts: number;
  readContactCount: number;
  checkedContactCount: number;
  matchedContactCount: number;
  unmatchedContactCount: number;
  uncheckableContactCount: number;
  excludedSelfContactCount: number;
  /** Readable contacts with at least one usable number beyond the 5k cap. */
  lookupLimitedContactCount: number;
  lookupLimitExceeded: boolean;
  /** Readable contacts in a dispatched batch whose response was not received. */
  unknownContactCount: number;
  /** A dispatched mutating request may have committed before its response was lost. */
  mutationOutcomeUnknown: boolean;
  uncheckedContactCount: number;
  /** Backward-compatible alias. Only fully checked, unmatched rows qualify. */
  inviteCandidateCount: number;
  autoConnectedCount: number;
  alreadyConnectedCount: number;
  requestRequiredCount: number;
  suppressedCount: number;
  completedBatchCount: number;
  totalBatchCount: number;
  partial: boolean;
  partialFailureMessage?: string;
  sourcePlatform: "web" | "ios" | "android" | "native" | "google";
  region: string | null;
  limited: boolean;
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
    "Contact access is turned off for Hushh. Turn it on in Settings to find people you already know.",
  restricted: "Contact access is restricted on this device.",
  unavailable: "Contact sync is available in the iOS and Android app.",
  error: "Could not sync contacts.",
};

async function assertContactsReadable(): Promise<void> {
  let permission: HushhContactsPermissionState;
  try {
    permission = await HushhContacts.getPermissionState();
  } catch {
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

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const OUTCOME_PRIORITY: Record<ContactSyncMatchOutcome, number> = {
  auto_connected: 4,
  already_connected: 3,
  request_required: 2,
  suppressed: 1,
};

function dedupeMatches(matches: ContactSyncMatch[]): ContactSyncMatch[] {
  const byUserId = new Map<string, ContactSyncMatch>();
  for (const match of matches) {
    const userId = String(match.userId || "").trim();
    if (!userId) continue;
    const previous = byUserId.get(userId);
    if (
      !previous ||
      OUTCOME_PRIORITY[match.outcome] > OUTCOME_PRIORITY[previous.outcome]
    ) {
      byUserId.set(userId, {
        ...match,
        userId,
        // When the same account is present under multiple local aliases, keep
        // the first deterministic non-empty identity already chosen.
        displayName: previous?.displayName || match.displayName,
      });
    } else if (!previous.displayName && match.displayName) {
      byUserId.set(userId, { ...previous, displayName: match.displayName });
    }
  }
  return Array.from(byUserId.values());
}

function shouldRetryContactSyncBatch(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof ConnectionsServiceRequestError) {
    return error.status >= 500;
  }
  // Fetch/network failures do not carry a response status. One replay with the
  // same opaque lookup ids is safe because the server mutation is idempotent.
  return true;
}

export async function syncOneLocationContactSignals({
  idToken,
  resolveIdToken,
  accountPhoneNumber,
  resolveAccountPhoneNumber,
  contactLimit = 5000,
  signal,
  source,
}: {
  /** Existing callers may provide an already-resolved Firebase token. */
  idToken?: string;
  /**
   * Defers token work until after the contact picker/source has returned.
   * Browser contact pickers require the original tap's transient activation,
   * so no network-backed auth or identity read may run before the source.
   */
  resolveIdToken?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  accountPhoneNumber?: string | null;
  resolveAccountPhoneNumber?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  contactLimit?: number;
  /** Retained at the call boundary for older callers; batching owns the cap. */
  matchLimit?: number;
  signal?: AbortSignal;
  source?: MarketplaceContactSource;
}): Promise<OneLocationContactSignalResult> {
  // The web Contact Picker requires transient user activation. Its own read
  // reports availability, so avoid any async bridge/auth work before select().
  if (!source && !isWeb()) await assertContactsReadable();

  const lookupResult = await buildMarketplaceContactLookups({
    limit: contactLimit,
    accountPhoneNumber,
    resolveAccountPhoneNumber,
    signal,
    ...(source ? { source } : {}),
  });
  // Besides supplying the region, the transaction-scoped resolver asserts the
  // initiating account still owns this contact read. Recheck immediately on
  // both sides of token resolution so no batch can cross an account switch.
  if (resolveAccountPhoneNumber) await resolveAccountPhoneNumber();
  const tokenValue =
    idToken ?? (resolveIdToken ? await resolveIdToken() : null);
  const resolvedIdToken = String(tokenValue ?? "").trim();
  if (resolveAccountPhoneNumber) await resolveAccountPhoneNumber();
  if (!resolvedIdToken) {
    throw new Error("Sign in before syncing contacts.");
  }
  const dispatchedLookups = lookupResult.lookups.slice(
    0,
    CONTACT_SYNC_MAX_LOOKUPS,
  );
  const dispatchedLookupIds = new Set(
    dispatchedLookups.map((lookup) => lookup.lookupId),
  );
  const batches = chunks(dispatchedLookups, CONTACT_SYNC_BATCH_SIZE);
  const completedLookupIds = new Set<string>();
  const matchedLookupIds = new Set<string>();
  const unknownLookupIds = new Set<string>();
  const localDisplayNameByLookupId = new Map<string, string>();
  for (const contact of lookupResult.contacts) {
    const displayName = String(contact.displayName || "").trim();
    if (!displayName) continue;
    for (const lookupId of contact.lookupIds) {
      if (!localDisplayNameByLookupId.has(lookupId)) {
        localDisplayNameByLookupId.set(lookupId, displayName);
      }
    }
  }
  const rawMatches: ContactSyncMatch[] = [];
  const localMatchedDisplayNameByUserId = new Map<string, string>();
  let completedBatchCount = 0;
  let mutationOutcomeUnknown = false;
  let partialFailureMessage: string | undefined;

  for (const batch of batches) {
    let response: Awaited<
      ReturnType<typeof ConnectionsService.syncContacts>
    > | null = null;
    let requestDispatched = false;
    let ambiguousDispatchedFailure = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        signal?.throwIfAborted();
        requestDispatched = true;
        response = await ConnectionsService.syncContacts({
          idToken: resolvedIdToken,
          lookups: batch,
          signal,
        });
        break;
      } catch (error) {
        lastError = error;
        if (shouldRetryContactSyncBatch(error)) {
          ambiguousDispatchedFailure = true;
          if (attempt === 0) continue;
        }
        break;
      }
    }

    if (!response) {
      if (!requestDispatched && completedBatchCount === 0) throw lastError;
      const explicitClientFailure =
        lastError instanceof ConnectionsServiceRequestError &&
        lastError.status >= 400 &&
        lastError.status < 500
          ? lastError
          : null;
      if (explicitClientFailure && !ambiguousDispatchedFailure) {
        if (completedBatchCount === 0) throw explicitClientFailure;
        partialFailureMessage = `${explicitClientFailure.message} Remaining contacts were not checked.`;
      } else if (requestDispatched) {
        mutationOutcomeUnknown = true;
        for (const lookup of batch) unknownLookupIds.add(lookup.lookupId);
        partialFailureMessage =
          "A sync request may have completed even though its response was lost. We refreshed your connections; run contact sync again to confirm these results.";
      } else {
        partialFailureMessage =
          "Sync paused before the next contact batch was checked.";
      }
      break;
    }

    const expectedLookupIds = new Set(batch.map((lookup) => lookup.lookupId));
    for (const lookup of batch) completedLookupIds.add(lookup.lookupId);
    for (const lookupId of response.indeterminateLookupIds ?? []) {
      if (expectedLookupIds.has(lookupId)) unknownLookupIds.add(lookupId);
    }
    for (const match of response.matches) {
      if (!expectedLookupIds.has(match.lookupId)) continue;
      matchedLookupIds.add(match.lookupId);
      const serverDisplayName = String(match.displayName || "").trim();
      const localDisplayName = localDisplayNameByLookupId.get(match.lookupId);
      if (
        !serverDisplayName &&
        localDisplayName &&
        !localMatchedDisplayNameByUserId.has(match.userId)
      ) {
        localMatchedDisplayNameByUserId.set(match.userId, localDisplayName);
      }
      rawMatches.push({
        ...match,
        displayName: serverDisplayName || null,
      });
    }
    completedBatchCount += 1;
  }

  let matchedContactCount = 0;
  let unmatchedContactCount = 0;
  let unknownContactCount = 0;
  let uncheckedReadableContactCount = 0;
  let lookupLimitedUncheckedContactCount = 0;
  for (const contact of lookupResult.contacts) {
    const coverageComplete =
      contact.coverageComplete !== false &&
      contact.lookupIds.every((lookupId) => dispatchedLookupIds.has(lookupId));
    if (contact.lookupIds.length === 0) {
      if (!coverageComplete) {
        uncheckedReadableContactCount += 1;
        lookupLimitedUncheckedContactCount += 1;
      }
      continue;
    }
    if (contact.lookupIds.some((lookupId) => matchedLookupIds.has(lookupId))) {
      matchedContactCount += 1;
      continue;
    }
    if (contact.lookupIds.some((lookupId) => unknownLookupIds.has(lookupId))) {
      unknownContactCount += 1;
      continue;
    }
    // A partially covered multi-number contact cannot truthfully be called
    // unmatched even when every selected number completed.
    if (!coverageComplete) {
      uncheckedReadableContactCount += 1;
      lookupLimitedUncheckedContactCount += 1;
      continue;
    }
    if (
      contact.lookupIds.every((lookupId) => completedLookupIds.has(lookupId))
    ) {
      unmatchedContactCount += 1;
    } else {
      uncheckedReadableContactCount += 1;
    }
  }

  const matches = dedupeMatches(rawMatches).map((match) => ({
    ...match,
    displayName:
      match.displayName ||
      localMatchedDisplayNameByUserId.get(match.userId) ||
      null,
  }));
  const outcomeCount = (outcome: ContactSyncMatchOutcome) =>
    matches.filter((match) => match.outcome === outcome).length;
  const unreadContactCount = lookupResult.unreadContactCount ?? 0;
  const uncheckedContactCount =
    uncheckedReadableContactCount + unreadContactCount;
  const partial = Boolean(
    partialFailureMessage ||
      lookupResult.limited ||
      lookupResult.truncated ||
      lookupResult.lookupLimitExceeded ||
      unknownContactCount ||
      uncheckedContactCount,
  );

  return {
    matches,
    matchedUserIds: matches.map((match) => match.userId),
    totalContacts: lookupResult.totalContacts,
    readContactCount: lookupResult.readContactCount,
    checkedContactCount: matchedContactCount + unmatchedContactCount,
    matchedContactCount,
    unmatchedContactCount,
    uncheckableContactCount: lookupResult.uncheckableContactCount,
    excludedSelfContactCount: lookupResult.excludedSelfContactCount ?? 0,
    lookupLimitedContactCount: lookupLimitedUncheckedContactCount,
    lookupLimitExceeded:
      lookupResult.lookupLimitExceeded ||
      lookupResult.lookups.length > CONTACT_SYNC_MAX_LOOKUPS,
    unknownContactCount,
    mutationOutcomeUnknown,
    uncheckedContactCount,
    inviteCandidateCount: unmatchedContactCount,
    autoConnectedCount: outcomeCount("auto_connected"),
    alreadyConnectedCount: outcomeCount("already_connected"),
    requestRequiredCount: outcomeCount("request_required"),
    suppressedCount: outcomeCount("suppressed"),
    completedBatchCount,
    totalBatchCount: batches.length,
    partial,
    partialFailureMessage,
    sourcePlatform: lookupResult.sourcePlatform,
    region: lookupResult.region,
    limited: lookupResult.limited,
    truncated: lookupResult.truncated,
  };
}

export async function openContactPermissionSettings(): Promise<boolean> {
  try {
    const result = await HushhContacts.openAppSettings();
    return Boolean(result?.opened);
  } catch {
    return false;
  }
}

export type ContactSyncRemedy =
  | "pick_more"
  | "open_settings"
  | "invite"
  | "sync_again"
  | null;

export type ContactSyncOutcome = {
  title: string;
  description?: string;
  remedy: ContactSyncRemedy;
};

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
    | "autoConnectedCount"
    | "alreadyConnectedCount"
    | "requestRequiredCount"
    | "uncheckableContactCount"
    | "unknownContactCount"
    | "mutationOutcomeUnknown"
    | "lookupLimitExceeded"
    | "lookupLimitedContactCount"
    | "uncheckedContactCount"
    | "partial"
    | "partialFailureMessage"
  >,
): ContactSyncOutcome {
  if (result.mutationOutcomeUnknown) {
    const details = [
      result.unknownContactCount
        ? `${contactsLabel(result.unknownContactCount)} need confirmation and are not counted as unmatched or inviteable.`
        : null,
      result.uncheckedContactCount
        ? `${contactsLabel(result.uncheckedContactCount)} were not checked yet.`
        : null,
    ].filter(Boolean);
    return {
      title: "Some contact results need confirmation",
      description: details.join(" ") || undefined,
      remedy: "sync_again",
    };
  }
  if (
    result.lookupLimitExceeded &&
    !result.mutationOutcomeUnknown &&
    !result.partialFailureMessage &&
    !result.limited &&
    !result.truncated &&
    result.unknownContactCount === 0 &&
    result.uncheckedContactCount === result.lookupLimitedContactCount
  ) {
    return {
      title: `${contactsLabel(result.matchedUserIds.length)} matched in this bounded sync`,
      description: result.lookupLimitedContactCount
        ? `${contactsLabel(result.lookupLimitedContactCount)} had additional phone numbers beyond the secure ${CONTACT_SYNC_MAX_LOOKUPS.toLocaleString()}-number sync limit and were left unchecked, not marked inviteable.`
        : `Additional phone numbers were outside the secure ${CONTACT_SYNC_MAX_LOOKUPS.toLocaleString()}-number sync limit. Every matched contact remains matched; none was reclassified as unchecked or inviteable.`,
      // Repeating the same deterministic capped sync cannot inspect overflow.
      remedy: null,
    };
  }
  if (result.partial) {
    const remedy = result.limited
      ? result.sourcePlatform === "web"
        ? "pick_more"
        : "open_settings"
      : "sync_again";
    return {
      title: `${contactsLabel(result.matchedUserIds.length)} matched in this partial sync`,
      description: result.uncheckedContactCount
        ? `${contactsLabel(result.uncheckedContactCount)} were not checked yet.`
        : "The contact source reported that this was not the full address book.",
      remedy,
    };
  }

  const connected = result.autoConnectedCount + result.alreadyConnectedCount;
  const title = connected
    ? `${contactsLabel(connected)} connected from your contacts`
    : result.matchedUserIds.length
      ? `${contactsLabel(result.matchedUserIds.length)} matched`
      : "No eligible contacts matched";
  const details = [
    result.matchedUserIds.length === 0
      ? "New matches require a verified phone and contact matching enabled. Existing connections may still appear."
      : null,
    result.requestRequiredCount
      ? result.requestRequiredCount === 1
        ? "1 contact needs a connection request."
        : `${result.requestRequiredCount} contacts need a connection request.`
      : null,
    result.inviteCandidateCount
      ? `${contactsLabel(result.inviteCandidateCount)} were checked and can be invited.`
      : null,
    result.uncheckableContactCount
      ? `${contactsLabel(result.uncheckableContactCount)} had no usable phone number.`
      : null,
  ].filter(Boolean);
  return {
    title,
    description: details.join(" ") || undefined,
    remedy: result.inviteCandidateCount ? "invite" : null,
  };
}
