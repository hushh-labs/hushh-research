"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  MapPin,
  ShieldCheck,
  Siren,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
} from "@/lib/services/cache-service";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import {
  locationApproveActionLabel,
  locationAskPromptLine,
} from "@/lib/one-location/duration-copy";
import {
  DebateRunManagerService,
  type DebateRunTask,
} from "@/lib/services/debate-run-manager";
import {
  AppBackgroundTaskService,
  type AppBackgroundTask,
  isAppBackgroundTaskVisible,
} from "@/lib/services/app-background-task-service";
import {
  CONSENT_CENTER_PAGE_SIZE,
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";
import {
  isLocationConsent,
  locationConsentSummary,
} from "@/lib/consent/location-consent";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationAccessRequest,
  OneLocationCircleMemberInvite,
  OneLocationGrant,
} from "@/lib/one-location/types";
import { buildOneLocationNotificationHref } from "@/lib/one-location/notifications";
import {
  ConnectionsService,
  type ConnectionRequest,
} from "@/lib/services/connections-service";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/** Subset of SettingsRow's icon-well tones (that type is not exported). */
export type FeedIconTone =
  "accent" | "blue" | "purple" | "green" | "orange" | "red" | "gray";

export type FeedActionTone = "primary" | "ghost" | "danger";

export interface FeedActionButton {
  key: string;
  label: string;
  tone: FeedActionTone;
  run: () => Promise<void> | void;
  disabled?: boolean;
  /** Irreversible action — the row requires a second confirming tap. */
  confirm?: boolean;
}

/**
 * A live, actionable item for the Feed's "Needs you" zone. Unlike the
 * historical `feed_events` log, these come straight from the domain's live
 * stores/services so the action is real and current (Instagram pins its
 * "follow requests" the same way, above the chronological activity).
 */
export interface FeedActionable {
  id: string;
  icon: LucideIcon;
  iconTone: FeedIconTone;
  /** Running work animates its leading glyph. */
  spinning?: boolean;
  title: string;
  description: string;
  /** Whole-row link (e.g. consent Review deep-link). */
  href?: string | null;
  /** Whole-row imperative action (e.g. resume a running debate). */
  onSelect?: () => void;
  chevron?: boolean;
  actions: FeedActionButton[];
  sortAt: number;
  /**
   * Real-world instant to render as the row's "Today - 3:45 PM" label.
   * Distinct from `sortAt` (which falls back to when the row was first seen so
   * ordering never breaks) — null/absent exactly when there is no real
   * timestamp to show the user (a consent entry with no `issued_at`, or any
   * connection request, whose payload carries no timestamp at all).
   * `FeedActionableRow` omits the label entirely rather than fabricating one.
   */
  displayTimestamp?: number | null;
  /**
   * High-priority visual treatment. "emergency" rows (an incoming SMS · Save My
   * Soul alert) render with prominent red styling and sort above everything else.
   */
  emphasis?: "emergency";
}

export interface UseFeedActionablesResult {
  actionables: FeedActionable[];
  count: number;
  loading: boolean;
  error: string | null;
  retry: () => Promise<void>;
  /** A revoked/expired SOS card is sitting in `actionables` with nothing left
   * to act on — only the Feed page's existing Clear button can remove it. */
  hasClearableSmsEmergencies: boolean;
  /** Dismisses every revoked/expired SOS card currently shown. Wired into the
   * Feed page's existing Clear button so it clears SOS notifications too. */
  clearSmsEmergencies: () => void;
}

function toTimestamp(value?: string | number | null): number {
  if (value == null) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Same idea as `toTimestamp` but yields `null` (not `0`) when there is no
 * source value or it doesn't parse — used for `displayTimestamp`, where the
 * absence of a real instant must suppress the row's time label rather than
 * silently rendering an epoch-zero date.
 */
function toDisplayTimestamp(value?: string | number | null): number | null {
  if (value == null) return null;
  const ts = toTimestamp(value);
  return ts > 0 ? ts : null;
}

function consentSummary(entry: ConsentCenterEntry): string {
  if (entry.kind === "invite") return "Invitation waiting for your approval.";
  if (isLocationConsent(entry.metadata, entry.scope)) {
    return locationConsentSummary(entry.metadata);
  }
  return (
    entry.additional_access_summary ||
    entry.scope_description ||
    entry.reason ||
    entry.scope ||
    "A new consent request needs your review."
  );
}

/**
 * A pending location access request is actionable in the viewer's "Needs you"
 * feed only when the viewer OWNS the request (their location is being asked for)
 * and did NOT send it themselves. `state.requests` carries BOTH directions, so
 * without this guard a user's own OUTGOING request leaks back onto their feed as
 * an incoming "wants to see your location" card labelled with their own name.
 * Mirrors the `pendingOwnerRequests` predicate in the Location page, plus an
 * explicit sender-≠-recipient check so a self-request never becomes actionable.
 */
export function isIncomingLocationRequestActionable(
  request: OneLocationAccessRequest,
  userId: string,
): boolean {
  return (
    request.status === "pending" &&
    request.ownerUserId === userId &&
    request.requesterUserId !== userId
  );
}

/**
 * A received share a contact started as an emergency SOS (SMS · Save My Soul)
 * that is still live. These surface as pinned, emergency-styled feed cards so a
 * safety alert is never buried under routine activity. The share point stays
 * end-to-end encrypted; only the emergency intent (`shareKind`) is read here.
 */
export function isActiveSmsEmergencyGrant(grant: OneLocationGrant): boolean {
  return grant.status === "active" && grant.shareKind === "sos";
}

/**
 * Any SOS grant a contact ever sent, live or revoked. Unlike
 * `isActiveSmsEmergencyGrant`, this keeps a revoked/expired SOS in the "Needs
 * you" feed as a historical alert instead of silently dropping it the instant
 * the sender cancels — a safety event must stay visible until the recipient
 * explicitly clears it.
 */
export function isSmsEmergencyGrant(grant: OneLocationGrant): boolean {
  return grant.shareKind === "sos";
}

const SMS_EMERGENCY_DISMISSED_STORAGE_PREFIX = "hushh:feed-sms-dismissed:";

function readDismissedSmsEmergencyIds(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(
      `${SMS_EMERGENCY_DISMISSED_STORAGE_PREFIX}${userId}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissedSmsEmergencyIds(userId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(
      `${SMS_EMERGENCY_DISMISSED_STORAGE_PREFIX}${userId}`,
      JSON.stringify([...ids]),
    );
  } catch {
    // Storage disabled — the dismiss still applies for this session via state.
  }
}

export function notifyFeedActionResolved(): void {
  dispatchConsentStateChanged({ source: "feed_actionable" });
  dispatchFeedStateChanged();
}

export function useFeedActionables(): UseFeedActionablesResult {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const userId = user?.uid ?? null;
  const [dismissedSmsEmergencyIds, setDismissedSmsEmergencyIds] = useState<
    Set<string>
  >(() => new Set());
  const cache = useMemo(() => CacheService.getInstance(), []);

  // Revoked/expired SOS cards stay in the feed as a historical alert until the
  // recipient explicitly clears them (see the Clear action below); the
  // per-user dismissal set persists to localStorage so it survives refreshes.
  useEffect(() => {
    if (!userId) {
      setDismissedSmsEmergencyIds(new Set());
      return;
    }
    setDismissedSmsEmergencyIds(readDismissedSmsEmergencyIds(userId));
  }, [userId]);

  // ── Debate + background-task live stores (in-memory, synchronous) ──
  const [debateState, setDebateState] = useState(() =>
    DebateRunManagerService.getState(),
  );
  const [appTaskState, setAppTaskState] = useState(() =>
    AppBackgroundTaskService.getState(),
  );
  useEffect(() => DebateRunManagerService.subscribe(setDebateState), []);
  useEffect(() => AppBackgroundTaskService.subscribe(setAppTaskState), []);

  // ── Consent pending (canonical one:consents lane, refetch on mutation) ──
  const [consentTick, setConsentTick] = useState(0);
  useEffect(() => {
    const bump = () => setConsentTick((value) => value + 1);
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, bump);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, bump);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, bump);
    };
  }, []);

  const consentSummaryResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "one:consents")
      : "consent_center_summary_guest",
    refreshKey: `one:consents:${consentTick}`,
    enabled: Boolean(userId),
    // `options.force` is honoured alongside the mutation tick: the consent
    // services keep their own caches, so a live refresh that dropped the flag
    // would re-read the same cached page it was trying to move past.
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to review consents");
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        mode: "consents",
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  const pendingConsentCount =
    consentSummaryResource.data?.counts.pending ?? null;

  const consentListResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_LIST(
          userId,
          "one:consents",
          "pending",
          "",
          1,
          CONSENT_CENTER_PAGE_SIZE,
        )
      : "consent_center_list_guest",
    refreshKey: `one:consents:${consentTick}:${pendingConsentCount ?? "?"}`,
    enabled: Boolean(userId) && (pendingConsentCount ?? 0) > 0,
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to review consents");
      return ConsentCenterService.listEntries({
        idToken,
        userId: user.uid,
        mode: "consents",
        surface: "pending",
        page: 1,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });

  // ── Location access requests (vault-gated read) ──
  // Shares the canonical ONE_LOCATION_STATE cache with the Location workspace,
  // so this loader write-throughs via OneLocationStateResource (which owns that
  // key) rather than leaving the shared snapshot stale; useStaleResource only
  // peeks the cache, so without the write the SWR warm-render never happens.
  const locationResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.ONE_LOCATION_STATE(userId)
      : "one_location_state_guest",
    enabled: Boolean(userId) && Boolean(vaultOwnerToken),
    load: async () => {
      if (!vaultOwnerToken)
        throw new Error("Unlock to review location requests");
      const state = await OneLocationService.getState(vaultOwnerToken);
      if (userId) OneLocationStateResource.write(userId, state);
      return state;
    },
  });

  // ── Incoming connection requests ──
  // Keyed on the same tick as the consent lanes: a connection request can be
  // answered from the Consent Center rather than here, and that surface only
  // announces itself through CONSENT_ACTION_COMPLETE_EVENT. Without the key
  // this resource never re-runs, so an accepted request stays on the feed as
  // though it were still waiting.
  const connectionsResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONNECTIONS_INCOMING(userId)
      : "connections_incoming_guest",
    refreshKey: `connections:${consentTick}`,
    enabled: Boolean(userId),
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!idToken) throw new Error("Sign in to review connections");
      const requests = await ConnectionsService.listRequests({
        idToken,
        direction: "incoming",
      });
      // Write-through so a revisit renders instantly (useStaleResource peeks
      // the cache but never populates it; the loader owns that here).
      if (userId) {
        cache.set(
          CACHE_KEYS.CONNECTIONS_INCOMING(userId),
          requests,
          CACHE_TTL.SHORT,
        );
      }
      return requests;
    },
  });

  const openAnalysis = useCallback(
    (runId: string) => {
      router.push(
        buildKaiMarketRoute("analysis", { focus: "active", run_id: runId }),
      );
    },
    [router],
  );

  // Pull stable slices out of the resource wrappers (which useStaleResource
  // returns fresh every render) so the memo below depends on the actual data
  // + the stable refresh callbacks, not the changing wrapper identity.
  const locationRequests = locationResource.data?.requests;
  const receivedGrants = locationResource.data?.receivedGrants;
  const circleMemberInvites = locationResource.data?.circleMemberInvites;
  const locationRefresh = locationResource.refresh;
  const connectionRequests = connectionsResource.data;
  const connectionsRefresh = connectionsResource.refresh;
  const consentItems = consentListResource.data?.items;
  const consentSummaryRefresh = consentSummaryResource.refresh;
  const consentListRefresh = consentListResource.refresh;

  // When a row genuinely has no arrival time, remember when it was first seen.
  //
  // These rows used to call `Date.now()` inline, inside the memo — so every
  // recompute minted a brand-new "now" and they jumped back above rows carrying
  // real timestamps. Harmless while the Feed only built its list once; with the
  // live refresh above, the order would reshuffle on every tick. A first-seen
  // stamp is stable across refreshes AND is the honest answer to "when did this
  // reach me", so arrival order between two untimed rows is preserved.
  const firstSeenAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    firstSeenAtRef.current = new Map();
  }, [userId]);
  const firstSeenAt = useCallback((id: string) => {
    const remembered = firstSeenAtRef.current.get(id);
    if (remembered !== undefined) return remembered;
    const now = Date.now();
    firstSeenAtRef.current.set(id, now);
    return now;
  }, []);

  // "Needs you" is the half of the Feed that is a to-do list, so a stale one is
  // worse than a stale history: it offers Approve on a request somebody already
  // answered elsewhere. Every source behind it re-checks on the same live signal
  // the list and the tab badge use.
  const refreshActionables = useCallback(async () => {
    await Promise.all([
      consentSummaryRefresh({ force: true }),
      consentListRefresh({ force: true }),
      locationRefresh({ force: true }),
      connectionsRefresh({ force: true }),
    ]);
  }, [
    connectionsRefresh,
    consentListRefresh,
    consentSummaryRefresh,
    locationRefresh,
  ]);

  useFeedLiveRefresh(
    useCallback(() => {
      void refreshActionables();
    }, [refreshActionables]),
    Boolean(userId),
  );

  // Revoked/expired SOS cards stay in the feed as a historical alert instead
  // of vanishing the moment the sender cancels — but there is nothing left to
  // act on, so only the Feed page's existing Clear button removes them (no
  // separate per-row control). The dismissal set persists to localStorage so
  // a clear survives refreshes.
  const clearableSmsEmergencyIds = useMemo(
    () =>
      (receivedGrants ?? [])
        .filter(
          (grant) =>
            isSmsEmergencyGrant(grant) &&
            !isActiveSmsEmergencyGrant(grant) &&
            !dismissedSmsEmergencyIds.has(grant.id),
        )
        .map((grant) => grant.id),
    [receivedGrants, dismissedSmsEmergencyIds],
  );

  const clearSmsEmergencies = useCallback(() => {
    if (!userId || clearableSmsEmergencyIds.length === 0) return;
    setDismissedSmsEmergencyIds((current) => {
      const next = new Set(current);
      for (const id of clearableSmsEmergencyIds) next.add(id);
      writeDismissedSmsEmergencyIds(userId, next);
      return next;
    });
  }, [userId, clearableSmsEmergencyIds]);

  const actionables = useMemo<FeedActionable[]>(() => {
    if (!userId) return [];
    const items: FeedActionable[] = [];

    // Consent — Review deep-link (approve needs the BYOK export ceremony that
    // lives in the consent manager, so the feed routes there rather than
    // one-tap approving; mirrors the prior consent inbox).
    if ((pendingConsentCount ?? 0) > 0) {
      for (const entry of consentItems ?? []) {
        // Incoming connection requests reach this lane too — the Consent
        // Center folds them into its `pending` surface from the very same
        // ConnectionsService the connections lane below reads. Rendering both
        // put one request in "Needs you" twice (a chevron-only consent row and
        // the real one). The connections lane owns them: it carries the inline
        // Confirm/Decline and the scoped Review route.
        if (entry.kind === "connection_request") continue;
        items.push({
          id: `consent:${entry.id}`,
          icon: ShieldCheck,
          iconTone: "accent",
          title: resolveConsentRequesterLabel({
            counterpartLabel: entry.counterpart_label,
            counterpartEmail: entry.counterpart_email,
            counterpartSecondaryLabel: entry.counterpart_secondary_label,
            counterpartId: entry.counterpart_id,
          }),
          description: consentSummary(entry),
          href: buildConsentCenterHref("pending", {
            requestId: entry.request_id || entry.id,
            from: "/one/feed",
          }),
          chevron: true,
          actions: [],
          // `issued_at` when the backend populated it — never the expiry, which
          // is in the future and would sort this above everything. Otherwise
          // when it was first seen, so it holds its place across refreshes.
          sortAt:
            toTimestamp(entry.issued_at) || firstSeenAt(`consent:${entry.id}`),
          // Real only when the backend happened to populate issued_at — never
          // fabricate a "just now" time label for this type.
          displayTimestamp: toDisplayTimestamp(entry.issued_at),
        });
      }
    }

    // SMS · Save My Soul emergency alerts — a share a contact started as an
    // SOS. Rendered as pinned, emergency-styled cards at the very top of the
    // feed so a safety alert is never buried under routine activity. A
    // revoked/expired SOS stays as a historical entry ("Revoked") rather than
    // vanishing the moment the sender cancels; the Feed page's existing Clear
    // button (via `clearSmsEmergencies` above) is what removes it — no
    // separate per-row control here.
    const smsEmergencies = (receivedGrants ?? []).filter(
      (grant) =>
        isSmsEmergencyGrant(grant) && !dismissedSmsEmergencyIds.has(grant.id),
    );
    for (const grant of smsEmergencies) {
      const label = grant.ownerDisplayName?.trim() || "A contact";
      const isRevoked = !isActiveSmsEmergencyGrant(grant);
      // A revoked/expired SOS sorts and displays by when it stopped
      // mattering, not when it was triggered — mirrors the
      // `revokedAt || updatedAt || expiresAt` "stopped" convention in
      // lib/one-location/activity.ts, extended with a createdAt fallback so
      // this is never 0/null.
      const resolvedAt = isRevoked
        ? toTimestamp(grant.revokedAt) ||
          toTimestamp(grant.updatedAt) ||
          toTimestamp(grant.expiresAt) ||
          toTimestamp(grant.createdAt)
        : toTimestamp(grant.createdAt);
      items.push({
        id: `sms-emergency:${grant.id}`,
        icon: Siren,
        iconTone: "red",
        // Only a still-live SOS gets the pinned "Live" emergency treatment.
        // A revoked/expired one renders as a plain "Needs you" row (see
        // feed-page.tsx) — Siren icon + red icon-well tint are all that's
        // left as the "this was an SOS" signal.
        emphasis: isRevoked ? undefined : "emergency",
        title: `${label} triggered an SOS`,
        description: isRevoked
          ? "Emergency SMS - Revoked"
          : "Emergency SMS - Sent.",
        href: buildOneLocationNotificationHref(grant.id),
        chevron: true,
        actions: [],
        sortAt: resolvedAt || firstSeenAt(`sms-emergency:${grant.id}`),
        displayTimestamp: resolvedAt || null,
      });
    }

    // Location access requests — inline Approve / Deny. Only requests the
    // viewer owns (and did not send) are actionable; outgoing requests must not
    // surface here as a self-addressed "wants to see your location" card.
    //
    // Approve grants exactly what was asked for. It used to send a flat
    // durationHours: 1, so answering a four-hour ask from here handed out one
    // hour -- and the card never said what had been asked, so the owner had no
    // way to notice.
    const pendingLocation = (locationRequests ?? []).filter(
      (request: OneLocationAccessRequest) =>
        isIncomingLocationRequestActionable(request, userId),
    );
    for (const request of pendingLocation) {
      const label = request.requesterDisplayName?.trim() || "Someone";
      items.push({
        id: `location:${request.id}`,
        icon: MapPin,
        iconTone: "blue",
        title: label,
        // Names the amount, and says when it is extra time on a live share.
        description:
          request.message?.trim() || locationAskPromptLine(request, Date.now()),
        actions: [
          {
            key: "deny",
            label: "Deny",
            tone: "ghost",
            disabled: !vaultOwnerToken,
            confirm: true,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.denyRequest({
                vaultOwnerToken,
                requestId: request.id,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
          {
            key: "approve",
            label: locationApproveActionLabel(request, Date.now()),
            tone: "primary",
            disabled: !vaultOwnerToken,
            run: async () => {
              if (!vaultOwnerToken) return;
              // No durationHours: omitting it means the server grants the
              // amount that was requested, falling back to an hour only when
              // the ask named none. Naming a number here is what silently
              // turned a four-hour ask into a one-hour grant.
              await OneLocationService.approveRequest({
                vaultOwnerToken,
                requestId: request.id,
                approvalMode: "manual",
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
        ],
        sortAt:
          toTimestamp(request.requestedAt) ||
          firstSeenAt(`location:${request.id}`),
        displayTimestamp: toDisplayTimestamp(request.requestedAt),
      });
    }

    // Circle invitations — inline Accept / Decline. The state read already
    // scopes these to incoming + pending, but re-filter so a widened server
    // response can never surface someone else's invite as actionable here.
    const pendingCircleInvites = (circleMemberInvites ?? []).filter(
      (invite: OneLocationCircleMemberInvite) =>
        invite.inviteeUserId === userId && invite.status === "pending",
    );
    for (const invite of pendingCircleInvites) {
      const label = invite.inviterDisplayName?.trim() || "Someone";
      const circleName = invite.circleName?.trim() || "a Circle";
      items.push({
        id: `circle-invite:${invite.id}`,
        icon: Users,
        iconTone: "blue",
        title: label,
        description: `Invited you to join ${circleName}.`,
        actions: [
          {
            key: "decline",
            label: "Decline",
            tone: "ghost",
            disabled: !vaultOwnerToken,
            confirm: true,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.declineNamedCircleMemberInvite({
                vaultOwnerToken,
                inviteId: invite.id,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
          {
            key: "accept",
            label: "Accept",
            tone: "primary",
            disabled: !vaultOwnerToken,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.acceptNamedCircleMemberInvite({
                vaultOwnerToken,
                inviteId: invite.id,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
        ],
        sortAt:
          toTimestamp(invite.createdAt) ||
          firstSeenAt(`circle-invite:${invite.id}`),
        displayTimestamp: toDisplayTimestamp(invite.createdAt),
      });
    }

    // Scoped connection requests require the Consent Center review surface.
    // A feed shortcut must never turn an omitted scope decision into a silent
    // decline (or, worse, an implied approval).
    const pendingConnections = (connectionRequests ?? []).filter(
      (request: ConnectionRequest) => request.status === "pending",
    );
    for (const request of pendingConnections) {
      const label = request.counterpartDisplayName?.trim() || "Someone";
      const requiresScopeReview = (request.scopes?.length ?? 0) > 0;
      const reviewHref = buildConsentCenterHref("pending", {
        requestId: request.id,
      });
      items.push({
        id: `connection:${request.id}`,
        icon: UserRound,
        iconTone: "green",
        title: label,
        description: request.message?.trim() || "Wants to connect with you.",
        href: requiresScopeReview ? reviewHref : null,
        actions: requiresScopeReview
          ? [
              {
                key: "review",
                label: "Review",
                tone: "primary",
                disabled: !userId,
                run: () => router.push(reviewHref),
              },
            ]
          : [
              {
                key: "decline",
                label: "Decline",
                tone: "ghost",
                disabled: !userId,
                confirm: true,
                run: async () => {
                  const idToken = await user?.getIdToken();
                  if (!idToken) return;
                  await ConnectionsService.reject({
                    idToken,
                    requestId: request.id,
                  });
                  CacheSyncService.onConnectionCapabilityMutated(userId);
                  notifyFeedActionResolved();
                  await connectionsRefresh({ force: true });
                },
              },
              {
                key: "confirm",
                label: "Confirm",
                tone: "primary",
                disabled: !userId,
                run: async () => {
                  const idToken = await user?.getIdToken();
                  if (!idToken) return;
                  await ConnectionsService.accept({
                    idToken,
                    requestId: request.id,
                  });
                  CacheSyncService.onConnectionCapabilityMutated(userId);
                  notifyFeedActionResolved();
                  await connectionsRefresh({ force: true });
                },
              },
            ],
        // ConnectionRequest (lib/services/connections-service.ts) carries no
        // timestamp field at all, so first-seen is the only honest ordering.
        sortAt: firstSeenAt(`connection:${request.id}`),
        // Still never fabricate a visible time label from it.
        displayTimestamp: null,
      });
    }

    // Running / failed Kai debates — Resume (reconnect the stream) + Cancel.
    const debateTasks = debateState.tasks.filter(
      (task: DebateRunTask) => task.userId === userId && !task.dismissedAt,
    );
    for (const task of debateTasks) {
      const running = task.status === "running";
      const failedSave =
        task.status !== "running" && task.persistenceState === "failed";
      if (!running && !failedSave) continue;
      const statusText = running
        ? task.streamState === "reconnecting"
          ? "Reconnecting…"
          : task.streamState === "paused"
            ? "Updates paused"
            : "Analyzing…"
        : task.persistenceError || "History save failed.";
      const actions: FeedActionButton[] = [];
      if (running) {
        actions.push({
          key: "cancel",
          label: "Cancel",
          tone: "danger",
          disabled: !vaultOwnerToken,
          confirm: true,
          run: async () => {
            if (!vaultOwnerToken) return;
            await DebateRunManagerService.cancelRun({
              runId: task.runId,
              userId: task.userId,
              vaultOwnerToken,
            });
          },
        });
      } else {
        actions.push({
          key: "retry",
          label: "Retry",
          tone: "primary",
          run: async () => {
            await DebateRunManagerService.retryTaskPersistence(task.runId);
          },
        });
        actions.push({
          key: "dismiss",
          label: "Dismiss",
          tone: "ghost",
          run: () => DebateRunManagerService.dismissTask(task.runId),
        });
      }
      items.push({
        id: `debate:${task.runId}`,
        icon: TrendingUp,
        iconTone: "accent",
        spinning: running,
        title: task.ticker || "Analysis",
        description: statusText,
        onSelect: running ? () => openAnalysis(task.runId) : undefined,
        chevron: running,
        actions,
        sortAt:
          toTimestamp(task.updatedAt || task.startedAt) ||
          firstSeenAt(`debate:${task.runId}`),
        displayTimestamp: toDisplayTimestamp(task.updatedAt || task.startedAt),
      });
    }

    // Running and failed background work stays actionable. A failed task must
    // not silently disappear from Feed: the owner route explains recovery,
    // while Dismiss lets the user acknowledge work they no longer need.
    const appTasks = appTaskState.tasks.filter(
      (task: AppBackgroundTask) =>
        task.userId === userId &&
        !task.dismissedAt &&
        isAppBackgroundTaskVisible(task) &&
        (task.status === "running" || task.status === "failed"),
    );
    for (const task of appTasks) {
      const running = task.status === "running";
      const actions: FeedActionButton[] = [];
      if (task.routeHref) {
        const href = task.routeHref;
        actions.push({
          key: "open",
          label: "Open",
          tone: "primary",
          run: () => router.push(href),
        });
      }
      if (!running) {
        actions.push({
          key: "dismiss",
          label: "Dismiss",
          tone: "ghost",
          run: () => {
            AppBackgroundTaskService.dismissTask(task.taskId);
            notifyFeedActionResolved();
          },
        });
      }
      items.push({
        id: `task:${task.taskId}`,
        icon: TrendingUp,
        iconTone: running ? "gray" : "orange",
        spinning: running,
        title: task.title,
        description: running
          ? task.description || "Working in the background…"
          : task.error ||
            task.description ||
            "This background task needs attention.",
        actions,
        sortAt:
          toTimestamp(task.updatedAt || task.startedAt) ||
          firstSeenAt(`task:${task.taskId}`),
        displayTimestamp: toDisplayTimestamp(task.updatedAt || task.startedAt),
      });
    }

    return items.sort((a, b) => {
      // Emergency SMS alerts pin to the very top, then the rest stays in
      // descending recency order.
      const aEmergency = a.emphasis === "emergency" ? 1 : 0;
      const bEmergency = b.emphasis === "emergency" ? 1 : 0;
      if (aEmergency !== bEmergency) return bEmergency - aEmergency;
      return b.sortAt - a.sortAt;
    });
    // Depend on the resources' `data` + stable `refresh` (not the wrapper
    // objects, which useStaleResource returns fresh every render) so this memo
    // only recomputes when the underlying data actually changes — otherwise a
    // streaming debate's frequent ticks would rebuild every row each render.
  }, [
    appTaskState.tasks,
    connectionRequests,
    connectionsRefresh,
    consentItems,
    debateState.tasks,
    dismissedSmsEmergencyIds,
    firstSeenAt,
    locationRequests,
    receivedGrants,
    circleMemberInvites,
    locationRefresh,
    openAnalysis,
    pendingConsentCount,
    router,
    user,
    userId,
    vaultOwnerToken,
  ]);

  const loading =
    consentSummaryResource.loading ||
    consentListResource.loading ||
    locationResource.loading ||
    connectionsResource.loading;
  const error = [
    consentSummaryResource.error,
    consentListResource.error,
    locationResource.error,
    connectionsResource.error,
  ].some(Boolean)
    ? "Some pending activity couldn't refresh."
    : null;

  return {
    actionables,
    count: actionables.length,
    loading,
    error,
    retry: refreshActionables,
    hasClearableSmsEmergencies: clearableSmsEmergencyIds.length > 0,
    clearSmsEmergencies,
  };
}
