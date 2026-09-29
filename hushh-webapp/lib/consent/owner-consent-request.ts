/**
 * One owner-facing request, however many rows the server stored for it.
 *
 * The backend writes one consent event per piece of information, correctly: a
 * grant and a revocation are per-item security decisions. But a person who
 * asked for three things asked ONE question, and the Feed showed it as three
 * rows ("Someone requested Preferences." three times). This module folds the
 * Consent Center's pending entries into the question the owner actually
 * answers, and keeps every member entry so the decision still acts on each
 * item's own authority.
 *
 * Pure on purpose: the Feed, the decision sheet and the tests all read the same
 * projection, and nothing here touches the network or the vault.
 */

import type { PendingConsent } from "@/lib/consent/use-consent-actions";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { isDriveSharingEntry } from "@/lib/consent/drive-query-consent";
import { isEmailHelperConsent } from "@/lib/consent/email-helper-consent";
import {
  isCircleMemberInviteConsent,
  isLocationConsent,
} from "@/lib/consent/location-consent";
import { isMarketplaceConsent } from "@/lib/consent/marketplace-consent";
import {
  consentEntryInformationLabel,
  consentInformationLabel,
  consentRequestHeadline,
  parseConsentInstant,
  requesterShortName,
} from "@/lib/consent/consent-owner-copy";

export type OwnerConsentRequest = {
  /** `bundle:<id>` for a grouped ask, `request:<id>` for a single one. */
  key: string;
  bundleId: string | null;
  requesterLabel: string;
  requesterShortName: string;
  requesterPhotoUrl: string | null;
  isPerson: boolean;
  /** Human names of what is still waiting, one per member, de-duplicated. */
  labels: string[];
  headline: string;
  reason: string | null;
  requestedAt: number | null;
  decideBy: number | null;
  durationHours: number | null;
  /** The pending entries a decision acts on, each with its own request id. */
  members: ConsentCenterEntry[];
  /**
   * False while a grouped ask is still arriving. Nothing may be decided
   * inline until every part of it is here: allowing half a question and
   * labelling the whole of it allowed would misstate what was shared.
   */
  complete: boolean;
  detailsHref: string;
};

function metadataOf(entry: ConsentCenterEntry): Record<string, unknown> {
  return entry.metadata && typeof entry.metadata === "object"
    ? (entry.metadata as Record<string, unknown>)
    : {};
}

function bundleIdOf(entry: ConsentCenterEntry): string | null {
  const direct = String(entry.bundle_id || "").trim();
  if (direct) return direct;
  const fromMetadata = metadataOf(entry).bundle_id;
  return typeof fromMetadata === "string" && fromMetadata.trim()
    ? fromMetadata.trim()
    : null;
}

/**
 * Whether the Feed may decide this entry inline through the shared generic
 * approve path. Location, Mail, marketplace, Drive and connection requests
 * each have their own ceremony and keep routing to it.
 */
export function isInlineDecidableConsentEntry(
  entry: ConsentCenterEntry,
): boolean {
  if (entry.kind !== "incoming_request") return false;
  if (!entry.scope) return false;
  const next = String(entry.allowed_next_action || "").trim();
  if (next ? next !== "review_request" : entry.status !== "pending") {
    return false;
  }
  if (isDriveSharingEntry(entry)) return false;
  if (isLocationConsent(entry.metadata, entry.scope)) return false;
  if (isCircleMemberInviteConsent(entry.metadata)) return false;
  if (isEmailHelperConsent(entry.metadata)) return false;
  if (isMarketplaceConsent(entry.metadata, entry.scope)) return false;
  return true;
}

/**
 * Whether a pending-list entry belongs in the owner's decision queue at all
 * (as opposed to outgoing asks, connection requests, or someone else's lane).
 */
export function isOwnerConsentQueueEntry(entry: ConsentCenterEntry): boolean {
  if (entry.bundle_items && entry.bundle_items.length > 0) return true;
  return isInlineDecidableConsentEntry(entry);
}

function durationHoursOf(entry: ConsentCenterEntry): number | null {
  const metadata = metadataOf(entry);
  const raw = metadata.expiry_hours ?? metadata.requested_duration_hours;
  const hours = Number(raw);
  if (Number.isFinite(hours) && hours > 0) return hours;
  const days = Number(metadata.duration_days);
  return Number.isFinite(days) && days > 0 ? days * 24 : null;
}

function earliest(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.min(...present) : null;
}

function buildRequest(
  key: string,
  bundleId: string | null,
  head: ConsentCenterEntry,
  members: ConsentCenterEntry[],
  complete: boolean,
  fallbackLabels: string[],
): OwnerConsentRequest {
  const requesterLabel = resolveConsentRequesterLabel({
    counterpartLabel: head.counterpart_label,
    counterpartEmail: head.counterpart_email,
    counterpartSecondaryLabel: head.counterpart_secondary_label,
    counterpartId: head.counterpart_id,
  });
  const isPerson = head.counterpart_type === "person";
  const shortName = requesterShortName(requesterLabel, isPerson);
  const labels = Array.from(
    new Set(
      members.length
        ? members.map((member) =>
            consentEntryInformationLabel(member),
          )
        : fallbackLabels,
    ),
  );
  const reasonSource =
    head.reason ||
    members.find((member) => member.reason)?.reason ||
    metadataOf(head).reason;
  const reason =
    typeof reasonSource === "string" && reasonSource.trim()
      ? reasonSource.trim()
      : null;
  const timed = members.length ? members : [head];
  const firstRequestId =
    members[0]?.request_id || members[0]?.id || head.request_id || undefined;
  return {
    key,
    bundleId,
    requesterLabel,
    requesterShortName: shortName,
    requesterPhotoUrl: head.counterpart_image_url || null,
    isPerson,
    labels,
    headline: consentRequestHeadline({
      requesterShortName: shortName,
      labels,
    }),
    reason,
    requestedAt: earliest(
      timed.map((entry) => parseConsentInstant(entry.issued_at)),
    ),
    decideBy: earliest(
      timed.map((entry) =>
        parseConsentInstant(entry.approval_timeout_at ?? entry.expires_at),
      ),
    ),
    durationHours: durationHoursOf(members[0] ?? head),
    members,
    complete: complete && members.length > 0,
    detailsHref: buildConsentCenterHref("pending", {
      requestId: firstRequestId,
      bundleId: bundleId || undefined,
      from: "/one/feed",
    }),
  };
}

/**
 * Fold pending entries into one request per ask.
 *
 * - A server bundle group (`bundle_items`) is one request; its members are the
 *   items still pending.
 * - Ungrouped entries that carry the same `bundle_id` (the server falls back to
 *   individual rows when a bundle's correlation record is missing) are folded
 *   together here.
 * - Everything else stays one request per entry.
 *
 * Order follows the input, which the server already sorts newest first.
 */
export function groupPendingConsentRequests(
  entries: ConsentCenterEntry[],
): OwnerConsentRequest[] {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      bundleId: string | null;
      head: ConsentCenterEntry;
      members: ConsentCenterEntry[];
      complete: boolean;
      fallbackLabels: string[];
    }
  >();

  const upsert = (
    key: string,
    bundleId: string | null,
    head: ConsentCenterEntry,
    members: ConsentCenterEntry[],
    complete: boolean,
    fallbackLabels: string[] = [],
  ) => {
    const existing = groups.get(key);
    if (!existing) {
      order.push(key);
      groups.set(key, { bundleId, head, members, complete, fallbackLabels });
      return;
    }
    const seen = new Set(
      existing.members.map((member) => member.request_id || member.id),
    );
    for (const member of members) {
      const id = member.request_id || member.id;
      if (!seen.has(id)) {
        seen.add(id);
        existing.members.push(member);
      }
    }
    existing.complete = existing.complete && complete;
    existing.fallbackLabels.push(...fallbackLabels);
  };

  for (const entry of entries) {
    if (entry.bundle_items && entry.bundle_items.length > 0) {
      const bundleId = bundleIdOf(entry) || entry.id;
      const members = entry.bundle_items
        .filter((item) => item.status === "pending" && item.entry)
        .map((item) => item.entry!)
        .filter(isInlineDecidableConsentEntry);
      upsert(
        `bundle:${bundleId}`,
        bundleId,
        entry,
        members,
        Boolean(entry.bundle_complete),
        entry.bundle_items
          .filter((item) => item.status === "pending")
          .map((item) => consentInformationLabel({ label: item.label })),
      );
      continue;
    }
    if (!isInlineDecidableConsentEntry(entry)) continue;
    const bundleId = bundleIdOf(entry);
    const requestId = entry.request_id || entry.id;
    upsert(
      bundleId ? `bundle:${bundleId}` : `request:${requestId}`,
      bundleId,
      entry,
      [entry],
      true,
    );
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    return buildRequest(
      key,
      group.bundleId,
      group.head,
      group.members,
      group.complete,
      group.fallbackLabels,
    );
  });
}

/**
 * The shape the shared approve path takes. Every surface converts through this
 * one function, so a request decided from the Feed, the sheet or chat carries
 * the same time, duration and wrapping metadata.
 */
export function consentEntryToPendingConsent(
  entry: ConsentCenterEntry,
  durationHours?: number,
): PendingConsent {
  const requestedAt = parseConsentInstant(entry.issued_at) ?? Date.now();
  const approvalTimeoutAt =
    parseConsentInstant(entry.approval_timeout_at ?? entry.expires_at) ??
    undefined;
  return {
    id: entry.request_id || entry.id,
    developer: resolveConsentRequesterLabel({
      counterpartLabel: entry.counterpart_label,
      counterpartEmail: entry.counterpart_email,
      counterpartSecondaryLabel: entry.counterpart_secondary_label,
      counterpartId: entry.counterpart_id,
    }),
    developerImageUrl: entry.counterpart_image_url || undefined,
    developerWebsiteUrl: entry.counterpart_website_url || undefined,
    scope: entry.scope || "",
    scopeDescription: entry.scope_description || undefined,
    requestedAt,
    approvalTimeoutAt,
    reason: entry.reason || undefined,
    requestUrl: entry.request_url || undefined,
    isScopeUpgrade: Boolean(entry.is_scope_upgrade),
    existingGrantedScopes: entry.existing_granted_scopes || undefined,
    additionalAccessSummary: entry.additional_access_summary || undefined,
    bundleId: bundleIdOf(entry) || undefined,
    durationHours,
    metadata: entry.metadata || undefined,
  };
}

/** Grants written within this window for one person read as one request. */
export const ACTIVE_REQUEST_WINDOW_MS = 2 * 60 * 1000;

export type ActiveConsentRow =
  | { kind: "single"; entry: ConsentCenterEntry }
  | {
      kind: "request";
      /** `bundle:<id>`, or `window:<counterpart>:<first grant ms>` without one. */
      key: string;
      bundleId: string | null;
      /** "Food preferences and Dietary constraints" (the server's), else "Food preferences and 1 more". */
      label: string;
      /** Every field's own grant: each one stays separately revocable. */
      members: ConsentCenterEntry[];
    };

/** A person's information grant; location, Drive, Mail and marketplace keep their own rows. */
function isPersonGrant(entry: ConsentCenterEntry): boolean {
  if (entry.counterpart_type !== "person" || !entry.scope || !entry.counterpart_id) return false;
  if (isDriveSharingEntry(entry)) return false;
  if (isLocationConsent(entry.metadata, entry.scope)) return false;
  if (isCircleMemberInviteConsent(entry.metadata)) return false;
  if (isEmailHelperConsent(entry.metadata)) return false;
  return !isMarketplaceConsent(entry.metadata, entry.scope);
}

function requestLabel(members: ConsentCenterEntry[]): string {
  const fromServer = members.map((member) => String(member.bundle_label || "").trim()).find(Boolean);
  if (fromServer) return fromServer;
  const labels = [...new Set(members.map((member) =>
    consentEntryInformationLabel(member)))];
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels[0]} and ${labels.length - 1} more`;
}

/**
 * Fold the Active list into one row per request.
 *
 * The server keeps one grant per field, correctly: each is its own revocable
 * decision. But the owner allowed one request, and the Active tab showed one
 * row per field ("Food preferences kind", "Health dietary constraints
 * observations"). Entries sharing a `bundle_id` become one row named by the
 * server's `bundle_label`. Without a bundle id, a person's grants written
 * within ACTIVE_REQUEST_WINDOW_MS of each other are the same request. Order
 * follows the input; a group that ends with one member stays a plain row.
 */
export function groupActiveConsentEntries(entries: ConsentCenterEntry[]): ActiveConsentRow[] {
  const order: string[] = [];
  const groups = new Map<string, { bundleId: string | null; members: ConsentCenterEntry[] }>();
  const windows: Array<{ key: string; counterpart: string; anchorMs: number }> = [];
  entries.forEach((entry, index) => {
    if (!isPersonGrant(entry)) {
      const key = `single:${index}`;
      order.push(key);
      groups.set(key, { bundleId: null, members: [entry] });
      return;
    }
    const bundleId = bundleIdOf(entry);
    let key: string;
    if (bundleId) {
      key = `bundle:${bundleId}`;
    } else {
      const counterpart = String(entry.counterpart_id);
      const grantedMs = parseConsentInstant(entry.issued_at);
      const window = grantedMs === null ? undefined : windows.find((candidate) =>
        candidate.counterpart === counterpart && Math.abs(candidate.anchorMs - grantedMs) <= ACTIVE_REQUEST_WINDOW_MS);
      if (window) key = window.key;
      else if (grantedMs === null) key = `single:${index}`;
      else {
        key = `window:${counterpart}:${grantedMs}`;
        windows.push({ key, counterpart, anchorMs: grantedMs });
      }
    }
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(entry);
      return;
    }
    order.push(key);
    groups.set(key, { bundleId, members: [entry] });
  });
  return order.map((key) => {
    const group = groups.get(key)!;
    if (group.members.length === 1) return { kind: "single" as const, entry: group.members[0]! };
    return {
      kind: "request" as const,
      key,
      bundleId: group.bundleId,
      label: requestLabel(group.members),
      members: group.members,
    };
  });
}
