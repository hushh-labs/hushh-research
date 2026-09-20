"use client";

/**
 * `/one/location?view=now` for the voice-first Location area, plus the three
 * focused lists it summarises (`?action=active-shares`, `shared-with-me`,
 * `needs-review`).
 *
 * Data: the server state through `OneLocationStateResource` (memory-only
 * presentation snapshot + de-duplicated loads) and the persisted sharing
 * posture through `useLocationSharingState`. Voice never writes UI state
 * directly: a `tool.result` that carries persisted state invalidates the
 * resource and the screen refetches, so what is on screen is always what the
 * server just said.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  Hand,
  LifeBuoy,
  Loader2,
  MapPinned,
  Navigation,
  Settings2,
  UserRoundCheck,
} from "@/components/icons";

import {
  LocationStatusCard,
  type LocationStatusFacts,
} from "@/components/location/location-status-card";
import {
  QuickActionCard,
  QuickActionsSection,
} from "@/components/one-location/redesign/quick-actions";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  useLocationSharingState,
  type LocationSharingStateView,
} from "@/lib/location/sharing-state";
import {
  LOCATION_VOICE_SCREEN_IDS,
  hrefForLocationAction,
  hrefForLocationView,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  CARD_SURFACE,
  MUTED_TEXT,
  SUBCARD_SURFACE,
} from "@/lib/morphy-ux/tokens/surfaces";
import {
  AvatarBubble,
  EmptyState,
  QuickPathRow,
  StatusPill,
  TaskFlowHeader,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ROUTES } from "@/lib/navigation/routes";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { OneLocationService } from "@/lib/one-location/service";
import {
  describeShareRemaining,
  parseTimestamp,
} from "@/lib/one-location/share-countdown";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
  OneLocationState,
} from "@/lib/one-location/types";
import {
  NOT_SUCCESS_STATUSES,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

/* ------------------------------------------------------------------ */
/* Voice reconciliation                                               */
/* ------------------------------------------------------------------ */

/** `ui_refresh` keys (tool catalog) that mean the Location state changed. */
const STATE_REFRESH_KEYS = new Set([
  "location_home",
  "location_people",
  "location_active_shares",
  "location_shared_with_me",
  "location_needs_review",
  "location_links",
  "location_circles",
  "location_sos",
  "location_emergency_contacts",
  "connections",
]);

/** `ui_refresh` keys that mean the persisted sharing posture changed. */
const SETTINGS_REFRESH_KEYS = new Set([
  "location_state",
  "location_settings",
  "location_map",
  "location_setup",
]);

/** Read tools whose successful result carries persisted state worth reconciling. */
const STATE_READ_TOOLS = new Set([
  "get_location_status",
  "list_people",
  "list_shares",
  "list_requests",
  "list_circles",
  "list_links",
  "get_save_my_soul_status",
]);
const SETTINGS_READ_TOOLS = new Set([
  "get_location_status",
  "get_location_settings",
  "get_location_setup_state",
]);

export function isVoiceToolSuccess(
  result: ToolResultPublic | null | undefined,
): boolean {
  if (!result || typeof result.status !== "string") return false;
  return !NOT_SUCCESS_STATUSES.has(result.status);
}

function refreshKeys(result: ToolResultPublic | null | undefined): string[] {
  return Array.isArray(result?.ui_refresh)
    ? result.ui_refresh.filter((key): key is string => typeof key === "string")
    : [];
}

export type LocationVoiceReconcileHandlers = {
  /** The server state (shares, requests, people) may have changed. */
  onLocationState?: () => void;
  /** The persisted sharing posture (on/off, precision, presence) may have changed. */
  onSettings?: () => void;
};

/**
 * Subscribe a Location screen to the voice session and refetch whatever a
 * successful tool result says it touched. Success is decided from the result
 * status (never transcript text); a rejected or pending result refreshes
 * nothing.
 */
export function useLocationVoiceReconcile(
  handlers: LocationVoiceReconcileHandlers,
): void {
  // `useVoiceToolEffects` reads its handlers through a ref, so inline closures
  // over the latest `handlers` are safe here without a second ref.
  useVoiceToolEffects({
    onToolResult: (tool, result) =>
      reconcileVoiceResult(tool, result, handlers),
    onPendingResolved: (_id, status, result) => {
      if (status !== "executed") return;
      reconcileVoiceResult(null, result, handlers);
    },
  });
}

/** Pure: decide which handlers a successful result should wake. Exported for tests. */
export function reconcileVoiceResult(
  tool: string | null,
  result: ToolResultPublic | null,
  handlers: LocationVoiceReconcileHandlers,
): { state: boolean; settings: boolean } {
  if (!isVoiceToolSuccess(result)) return { state: false, settings: false };
  const keys = refreshKeys(result);
  // A resolved confirmation arrives without its tool name; when it also
  // names nothing to refresh, refetch both rather than miss a change.
  const unnamed = tool === null && keys.length === 0;
  const state =
    unnamed ||
    keys.some((key) => STATE_REFRESH_KEYS.has(key)) ||
    (tool !== null && STATE_READ_TOOLS.has(tool));
  const settings =
    unnamed ||
    keys.some((key) => SETTINGS_REFRESH_KEYS.has(key)) ||
    (tool !== null && SETTINGS_READ_TOOLS.has(tool));
  if (state) handlers.onLocationState?.();
  if (settings) handlers.onSettings?.();
  return { state, settings };
}

/* ------------------------------------------------------------------ */
/* Workspace state                                                    */
/* ------------------------------------------------------------------ */

export type LocationWorkspaceStatus = "idle" | "loading" | "ready" | "error";

export type LocationWorkspace = {
  userId: string | null;
  vaultOwnerToken: string | null;
  state: OneLocationState | null;
  status: LocationWorkspaceStatus;
  error: string | null;
  /** Commit an acknowledged mutation immediately and fence older reads. */
  commitState: (next: OneLocationState) => string | null;
  /** Refetch; `invalidate` fences off any in-flight pre-mutation load first. */
  refresh: (options?: { invalidate?: boolean }) => Promise<void>;
};

/**
 * The Location server state for the signed-in owner.
 *
 * Reads the memory-only presentation snapshot first so a same-session
 * re-entry paints immediately, then loads through the resource so concurrent
 * screens share one request. Subscribed to voice reconciliation.
 */
export function useLocationWorkspaceState(): LocationWorkspace {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [state, setState] = useState<OneLocationState | null>(() =>
    userId ? OneLocationStateResource.readPresentation(userId) : null,
  );
  const [status, setStatus] = useState<LocationWorkspaceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const refreshRevisionRef = useRef(0);
  const localCommitEventIdsRef = useRef(new Set<string>());
  const foregroundTaskRef = useRef<Promise<void> | null>(null);
  const foregroundQueuedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (options?: { invalidate?: boolean }) => {
      if (!userId || !vaultOwnerToken) return;
      const revision = ++refreshRevisionRef.current;
      if (options?.invalidate) OneLocationStateResource.invalidate(userId);
      setStatus((current) => (current === "ready" ? "ready" : "loading"));
      try {
        const next = await OneLocationStateResource.load(userId, () =>
          OneLocationService.getState(vaultOwnerToken),
        );
        if (!mountedRef.current || refreshRevisionRef.current !== revision) return;
        setState(next);
        setError(null);
        setStatus("ready");
      } catch (caught) {
        if (!mountedRef.current || refreshRevisionRef.current !== revision) return;
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "Location could not be loaded.",
        );
        setStatus("error");
      }
    },
    [userId, vaultOwnerToken],
  );

  const commitState = useCallback(
    (next: OneLocationState) => {
      if (!userId || !mountedRef.current) return null;
      const eventId = `location_workspace:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;
      localCommitEventIdsRef.current.add(eventId);
      ++refreshRevisionRef.current;
      OneLocationStateResource.invalidate(userId);
      OneLocationStateResource.write(userId, next);
      setState(next);
      setError(null);
      setStatus("ready");
      return eventId;
    },
    [userId],
  );

  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    const snapshot = OneLocationStateResource.readPresentation(userId);
    if (snapshot) {
      setState(snapshot);
      setStatus("ready");
    }
    void refresh();
  }, [refresh, userId, vaultOwnerToken]);

  useLocationVoiceReconcile({
    onLocationState: () => void refresh({ invalidate: true }),
  });

  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    return subscribeToOneLocationStateChanges((detail) => {
      if (detail.userId !== userId || !detail.domains.includes("workspace")) {
        return;
      }
      if (
        detail.eventId &&
        localCommitEventIdsRef.current.delete(detail.eventId)
      ) {
        return;
      }
      void refresh({ invalidate: true });
    });
  }, [refresh, userId, vaultOwnerToken]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    const reconcile = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) return;
      if (foregroundTaskRef.current) {
        foregroundQueuedRef.current = true;
        return;
      }
      const run = async () => {
        do {
          foregroundQueuedRef.current = false;
          await refresh({ invalidate: true });
        } while (foregroundQueuedRef.current);
      };
      const task = run().finally(() => {
        if (foregroundTaskRef.current === task) foregroundTaskRef.current = null;
      });
      foregroundTaskRef.current = task;
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => {
      if (appInteractionCoordinator.getLifecycleSnapshot().state === "active") {
        reconcile();
      }
    });
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      removeLifecycle();
    };
  }, [refresh, userId, vaultOwnerToken]);

  return useMemo(
    () => ({ userId, vaultOwnerToken, state, status, error, commitState, refresh }),
    [commitState, error, refresh, state, status, userId, vaultOwnerToken],
  );
}

/* ------------------------------------------------------------------ */
/* Selectors                                                          */
/* ------------------------------------------------------------------ */

export function selectActiveOwnerGrants(
  state: OneLocationState | null,
): OneLocationGrant[] {
  return (state?.ownerGrants ?? []).filter(
    (grant) => grant.status === "active",
  );
}

export function selectActiveReceivedGrants(
  state: OneLocationState | null,
): OneLocationGrant[] {
  return (state?.receivedGrants ?? []).filter(
    (grant) => grant.status === "active",
  );
}

export function selectPendingIncomingRequests(
  state: OneLocationState | null,
  userId: string | null,
): OneLocationAccessRequest[] {
  if (!userId) return [];
  return (state?.requests ?? []).filter(
    (request) => request.status === "pending" && request.ownerUserId === userId,
  );
}

export function selectPendingOutgoingRequests(
  state: OneLocationState | null,
  userId: string | null,
): OneLocationAccessRequest[] {
  if (!userId) return [];
  return (state?.requests ?? []).filter(
    (request) =>
      request.status === "pending" && request.requesterUserId === userId,
  );
}

export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

function grantRemainingLabel(grant: OneLocationGrant, nowMs: number): string {
  if (grant.durationMode === "until_stopped" || !grant.expiresAt)
    return "Until stopped";
  const endsAt = parseTimestamp(grant.expiresAt);
  if (endsAt === null) return "Active";
  return describeShareRemaining(endsAt - nowMs);
}

function shareKindLabel(kind: OneLocationGrant["shareKind"]): string | null {
  switch (kind) {
    case "sos":
      return "Save My Soul";
    case "check_in":
      return "Check-In";
    case "drive_to":
      return "Drive";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sharing facts adapter                                              */
/* ------------------------------------------------------------------ */

/** The three facts the card renders, from the composed sharing view. */
export function toStatusFacts(
  snapshot: LocationSharingStateView,
): LocationStatusFacts {
  return {
    sharingState:
      snapshot.sharingState === "on" || snapshot.sharingState === "off"
        ? snapshot.sharingState
        : "unset",
    osPermission: snapshot.os,
    precision: snapshot.precision === "approximate" ? "approximate" : "precise",
  };
}

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

function PersonSummaryRow({
  name,
  photoUrl,
  detail,
  pill,
  pillTone = "neutral",
  action,
  testId,
}: {
  name: string;
  photoUrl?: string | null;
  detail?: string | null;
  pill?: string | null;
  pillTone?: "ready" | "pending" | "live" | "neutral";
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        SUBCARD_SURFACE,
        "flex min-h-[58px] items-center gap-3 px-3.5 py-2.5",
      )}
      data-testid={testId}
    >
      <AvatarBubble
        initials={personInitials(name)}
        imageUrl={photoUrl}
        size={36}
      />
      <div className="min-w-0 flex-1">
        <p className="ui-text-row-label truncate">{name}</p>
        {detail ? <p className={cn(MUTED_TEXT, "truncate")}>{detail}</p> : null}
      </div>
      {pill ? (
        <StatusPill tone={pillTone} className="shrink-0">
          {pill}
        </StatusPill>
      ) : null}
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function useNowMs(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ */
/* Home                                                               */
/* ------------------------------------------------------------------ */

const HOME_VOICE_ACTIONS = deriveLocationVoiceActions("one_location");

export function LocationHome() {
  const router = useRouter();
  const workspace = useLocationWorkspaceState();
  const sharing = useLocationSharingState();
  const nowMs = useNowMs();

  const facts = useMemo(() => toStatusFacts(sharing), [sharing]);
  const sharingLoading = sharing.resolving;
  const setupRequired = !sharingLoading && facts.sharingState === "unset";

  const refreshSharing = sharing.refresh;
  useLocationVoiceReconcile({
    onSettings: () => void refreshSharing(),
  });

  const activeShares = useMemo(
    () => selectActiveOwnerGrants(workspace.state),
    [workspace.state],
  );
  const sharedWithMe = useMemo(
    () => selectActiveReceivedGrants(workspace.state),
    [workspace.state],
  );
  const needsReview = useMemo(
    () => selectPendingIncomingRequests(workspace.state, workspace.userId),
    [workspace.state, workspace.userId],
  );

  usePublishVoiceSurfaceMetadata(
    useMemo(
      () => ({
        screenId: LOCATION_VOICE_SCREEN_IDS.home,
        title: "Location",
        purpose:
          "Your location sharing status, who can see you, and who is sharing with you.",
        spokenSubject: "Location",
        activeTab: "now",
        actions: HOME_VOICE_ACTIONS,
        availableActions: HOME_VOICE_ACTIONS.map((action) => action.label),
        screenState: {
          sharing_state: facts.sharingState,
          os_permission: facts.osPermission,
          precision: facts.precision,
          active_shares: activeShares.length,
          shared_with_me: sharedWithMe.length,
          needs_review: needsReview.length,
          setup_required: setupRequired,
        },
      }),
      [
        activeShares.length,
        facts,
        needsReview.length,
        setupRequired,
        sharedWithMe.length,
      ],
    ),
  );

  const go = useCallback(
    (href: string) => {
      router.push(href, { scroll: false });
    },
    [router],
  );

  return (
    <div className="space-y-6" data-testid="location-home">
      {setupRequired ? (
        <section
          className={cn(CARD_SURFACE, "space-y-3 p-5")}
          data-testid="location-home-setup-card"
        >
          <p className="ui-text-headline">Set up Location</p>
          <p className={MUTED_TEXT}>
            Sharing with people isn't set up yet. Setup records your consent,
            asks your device for permission, and chooses how precise you want to
            be.
          </p>
          <Button asChild className="min-h-11 w-full sm:w-auto">
            <Link href={ROUTES.ONE_SETUP_LOCATION}>Set up Location</Link>
          </Button>
        </section>
      ) : (
        <LocationStatusCard facts={facts} loading={sharingLoading} />
      )}

      <QuickActionsSection
        title="Quick actions"
        columns={3}
        testId="location-home-quick-actions"
      >
        <QuickActionCard
          icon={<Navigation />}
          title="Share"
          subtitle="Your location"
          tone="blue"
          controlId="location_home_share"
          onClick={() => go(hrefForLocationAction("share"))}
        />
        <QuickActionCard
          icon={<Hand />}
          title="Ask"
          subtitle="For theirs"
          tone="violet"
          controlId="location_home_ask"
          onClick={() => go(hrefForLocationAction("ask"))}
        />
        <QuickActionCard
          icon={<MapPinned />}
          title="Check-In"
          subtitle="Say where you are"
          tone="green"
          controlId="location_home_check_in"
          onClick={() => go(hrefForLocationAction("check-in"))}
        />
        <QuickActionCard
          icon={<LifeBuoy />}
          title="Save My Soul"
          subtitle="Emergency"
          tone="red"
          controlId="location_home_sos"
          onClick={() => go(hrefForLocationAction("sos"))}
        />
        <QuickActionCard
          icon={<Settings2 />}
          title="Settings"
          subtitle="Precision, map, approvals"
          tone="slate"
          controlId="location_home_settings"
          onClick={() => go(hrefForLocationAction("settings"))}
        />
      </QuickActionsSection>

      {workspace.status === "error" && !workspace.state ? (
        <EmptyState
          title="Location couldn't load"
          description={workspace.error ?? undefined}
          action={
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void workspace.refresh({ invalidate: true })}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <section className="space-y-2" data-testid="location-home-summaries">
          <QuickPathRow
            icon={<Navigation className="h-4 w-4" />}
            title="Active shares"
            description={
              workspace.state
                ? activeShares.length
                  ? `${activeShares.length} ${activeShares.length === 1 ? "person" : "people"} can see you`
                  : "No one can see your location right now"
                : "Loading"
            }
            badge={
              activeShares.length ? String(activeShares.length) : undefined
            }
            onClick={() => go(hrefForLocationAction("active-shares"))}
          />
          <QuickPathRow
            icon={<UserRoundCheck className="h-4 w-4" />}
            title="Shared with me"
            description={
              workspace.state
                ? sharedWithMe.length
                  ? `${sharedWithMe.length} ${sharedWithMe.length === 1 ? "person is" : "people are"} sharing with you`
                  : "No one is sharing with you right now"
                : "Loading"
            }
            badge={
              sharedWithMe.length ? String(sharedWithMe.length) : undefined
            }
            onClick={() => go(hrefForLocationAction("shared-with-me"))}
          />
          <QuickPathRow
            icon={<Clock3 className="h-4 w-4" />}
            title="Needs review"
            description={
              workspace.state
                ? needsReview.length
                  ? `${needsReview.length} ${needsReview.length === 1 ? "request is" : "requests are"} waiting for you`
                  : "Nothing is waiting for you"
                : "Loading"
            }
            badge={needsReview.length ? String(needsReview.length) : undefined}
            onClick={() => go(hrefForLocationAction("needs-review"))}
          />
        </section>
      )}

      {activeShares.length ? (
        <section
          className="space-y-2"
          data-testid="location-home-active-share-preview"
        >
          <p className="ui-text-section-label px-1">Sharing now</p>
          {activeShares.slice(0, 3).map((grant) => (
            <PersonSummaryRow
              key={grant.id}
              name={grant.recipientDisplayName || "Someone"}
              photoUrl={grant.recipientPhotoUrl}
              detail={grantRemainingLabel(grant, nowMs)}
              pill={shareKindLabel(grant.shareKind) ?? "Live"}
              pillTone="live"
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Focused lists                                                      */
/* ------------------------------------------------------------------ */

function FocusedListShell({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="space-y-5" data-testid={testId}>
      <TaskFlowHeader
        eyebrow="Location"
        title={title}
        description={description}
      />
      {children}
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="flex items-center gap-2 px-1 py-4 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className={MUTED_TEXT}>Loading</span>
    </div>
  );
}

export function LocationActiveSharesScreen() {
  const workspace = useLocationWorkspaceState();
  const nowMs = useNowMs();
  const [stopping, setStopping] = useState<string | null>(null);
  const shares = useMemo(
    () => selectActiveOwnerGrants(workspace.state),
    [workspace.state],
  );

  const stopShare = useCallback(
    async (grant: OneLocationGrant) => {
      if (!workspace.vaultOwnerToken || !workspace.userId) return;
      setStopping(grant.id);
      try {
        const next = await OneLocationService.revokeGrant({
          vaultOwnerToken: workspace.vaultOwnerToken,
          grantId: grant.id,
        });
        OneLocationStateResource.mergeOwnerGrant(workspace.userId, next);
        await workspace.refresh({ invalidate: true });
        morphyToast.success(
          `Stopped sharing with ${grant.recipientDisplayName || "them"}.`,
        );
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "The share could not be stopped.",
        );
      } finally {
        setStopping(null);
      }
    },
    [workspace],
  );

  return (
    <FocusedListShell
      title="Active shares"
      description="People who can see your location right now."
      testId="location-active-shares"
    >
      {!workspace.state && workspace.status !== "error" ? (
        <LoadingRows />
      ) : shares.length ? (
        <div className="space-y-2">
          {shares.map((grant) => (
            <PersonSummaryRow
              key={grant.id}
              name={grant.recipientDisplayName || "Someone"}
              photoUrl={grant.recipientPhotoUrl}
              detail={grantRemainingLabel(grant, nowMs)}
              pill={shareKindLabel(grant.shareKind)}
              pillTone="live"
              testId="location-active-share-row"
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  disabled={stopping === grant.id}
                  onClick={() => void stopShare(grant)}
                  aria-label={`Stop sharing with ${grant.recipientDisplayName || "this person"}`}
                >
                  {stopping === grant.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Stop"
                  )}
                </Button>
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No one can see you right now"
          description="Start a share and it shows up here with the time left."
          action={
            <Button asChild className="min-h-11">
              <Link href={hrefForLocationAction("share")}>
                Share your location
              </Link>
            </Button>
          }
        />
      )}
    </FocusedListShell>
  );
}

export function LocationSharedWithMeScreen() {
  const workspace = useLocationWorkspaceState();
  const nowMs = useNowMs();
  const shares = useMemo(
    () => selectActiveReceivedGrants(workspace.state),
    [workspace.state],
  );

  return (
    <FocusedListShell
      title="Shared with me"
      description="People sharing their location with you."
      testId="location-shared-with-me"
    >
      {!workspace.state && workspace.status !== "error" ? (
        <LoadingRows />
      ) : shares.length ? (
        <div className="space-y-2">
          {shares.map((grant) => (
            <PersonSummaryRow
              key={grant.id}
              name={grant.ownerDisplayName || "Someone"}
              photoUrl={grant.ownerPhotoUrl}
              detail={grantRemainingLabel(grant, nowMs)}
              pill={shareKindLabel(grant.shareKind)}
              pillTone="live"
              testId="location-shared-with-me-row"
              action={
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                >
                  <Link href={ROUTES.ONE_LOCATION_MAP}>Map</Link>
                </Button>
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No one is sharing with you"
          description="Ask someone you're connected with and their share appears here once they approve."
          action={
            <Button asChild className="min-h-11">
              <Link href={hrefForLocationView("people")}>See your people</Link>
            </Button>
          }
        />
      )}
    </FocusedListShell>
  );
}

export function LocationNeedsReviewScreen() {
  const workspace = useLocationWorkspaceState();
  const [deciding, setDeciding] = useState<string | null>(null);
  const requests = useMemo(
    () => selectPendingIncomingRequests(workspace.state, workspace.userId),
    [workspace.state, workspace.userId],
  );

  const decide = useCallback(
    async (request: OneLocationAccessRequest, approve: boolean) => {
      if (!workspace.vaultOwnerToken || !workspace.userId) return;
      setDeciding(request.id);
      try {
        if (approve) {
          const approved = await OneLocationService.approveRequest({
            vaultOwnerToken: workspace.vaultOwnerToken,
            requestId: request.id,
            approvalMode: "manual",
          });
          OneLocationStateResource.mergeRequestStatus(
            workspace.userId,
            approved.request,
          );
          morphyToast.success(
            `${request.requesterDisplayName || "They"} can see your location now.`,
          );
        } else {
          const denied = await OneLocationService.denyRequest({
            vaultOwnerToken: workspace.vaultOwnerToken,
            requestId: request.id,
          });
          OneLocationStateResource.mergeRequestStatus(workspace.userId, denied);
          morphyToast.success("Request declined.");
        }
        await workspace.refresh({ invalidate: true });
      } catch (error) {
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "That didn't go through.",
        );
      } finally {
        setDeciding(null);
      }
    },
    [workspace],
  );

  return (
    <FocusedListShell
      title="Needs review"
      description="Requests to see your location that are waiting for your answer."
      testId="location-needs-review"
    >
      {!workspace.state && workspace.status !== "error" ? (
        <LoadingRows />
      ) : requests.length ? (
        <div className="space-y-2">
          {requests.map((request) => (
            <PersonSummaryRow
              key={request.id}
              name={request.requesterDisplayName || "Someone"}
              photoUrl={request.requesterPhotoUrl}
              detail={
                request.requestedDurationHours
                  ? `Asked for ${request.requestedDurationHours} ${request.requestedDurationHours === 1 ? "hour" : "hours"}${request.message ? ` · ${request.message}` : ""}`
                  : request.message || "Wants to see your location"
              }
              testId="location-needs-review-row"
              action={
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={deciding === request.id}
                    onClick={() => void decide(request, false)}
                  >
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11"
                    disabled={deciding === request.id}
                    onClick={() => void decide(request, true)}
                  >
                    {deciding === request.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Approve"
                    )}
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="Nothing is waiting for you"
          description="When someone asks to see your location, the request shows up here."
        />
      )}
    </FocusedListShell>
  );
}
