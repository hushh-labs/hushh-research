"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { MapPin, ShieldCheck, TrendingUp, UserRound } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
} from "@/lib/services/cache-service";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
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
} from "@/lib/consent/consent-events";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";
import {
  ConnectionsService,
  type ConnectionRequest,
} from "@/lib/services/connections-service";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/** Subset of SettingsRow's icon-well tones (that type is not exported). */
export type FeedIconTone =
  | "accent"
  | "blue"
  | "purple"
  | "green"
  | "orange"
  | "red"
  | "gray";

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
}

export interface UseFeedActionablesResult {
  actionables: FeedActionable[];
  count: number;
  loading: boolean;
}

function toTimestamp(value?: string | number | null): number {
  if (value == null) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function consentSummary(entry: ConsentCenterEntry): string {
  if (entry.kind === "connection_request") return "Wants to connect with you.";
  if (entry.kind === "invite") return "Invitation waiting for your approval.";
  return (
    entry.additional_access_summary ||
    entry.scope_description ||
    entry.reason ||
    entry.scope ||
    "A new consent request needs your review."
  );
}

export function useFeedActionables(): UseFeedActionablesResult {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const userId = user?.uid ?? null;
  const cache = useMemo(() => CacheService.getInstance(), []);

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
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to review consents");
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        mode: "consents",
        force: consentTick > 0,
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
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to review consents");
      return ConsentCenterService.listEntries({
        idToken,
        userId: user.uid,
        mode: "consents",
        surface: "pending",
        page: 1,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: consentTick > 0,
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
      if (!vaultOwnerToken) throw new Error("Unlock to review location requests");
      const state = await OneLocationService.getState(vaultOwnerToken);
      if (userId) OneLocationStateResource.write(userId, state);
      return state;
    },
  });

  // ── Incoming connection requests ──
  const connectionsResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONNECTIONS_INCOMING(userId)
      : "connections_incoming_guest",
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
        cache.set(CACHE_KEYS.CONNECTIONS_INCOMING(userId), requests, CACHE_TTL.SHORT);
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
  const locationRefresh = locationResource.refresh;
  const connectionRequests = connectionsResource.data;
  const connectionsRefresh = connectionsResource.refresh;
  const consentItems = consentListResource.data?.items;

  const actionables = useMemo<FeedActionable[]>(() => {
    if (!userId) return [];
    const items: FeedActionable[] = [];

    // Consent — Review deep-link (approve needs the BYOK export ceremony that
    // lives in the consent manager, so the feed routes there rather than
    // one-tap approving; mirrors the prior consent inbox).
    if ((pendingConsentCount ?? 0) > 0) {
      for (const entry of consentItems ?? []) {
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
          // No reliable arrival time on a consent entry (only a future
          // expiry), so treat pending consents as current rather than mixing
          // future expiry into the descending recency sort.
          sortAt: Date.now(),
        });
      }
    }

    // Location access requests — inline Approve (1h) / Deny.
    const pendingLocation = (locationRequests ?? []).filter(
      (request: OneLocationAccessRequest) => request.status === "pending",
    );
    for (const request of pendingLocation) {
      const label = request.requesterDisplayName?.trim() || "Someone";
      items.push({
        id: `location:${request.id}`,
        icon: MapPin,
        iconTone: "blue",
        title: label,
        description: request.message?.trim() || "Wants to see your location.",
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
              await locationRefresh({ force: true });
            },
          },
          {
            key: "approve",
            label: "Approve",
            tone: "primary",
            disabled: !vaultOwnerToken,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.approveRequest({
                vaultOwnerToken,
                requestId: request.id,
                durationHours: 1,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              await locationRefresh({ force: true });
            },
          },
        ],
        sortAt: toTimestamp(request.requestedAt) || Date.now(),
      });
    }

    // Connection requests — inline Confirm / Decline.
    const pendingConnections = (connectionRequests ?? []).filter(
      (request: ConnectionRequest) => request.status === "pending",
    );
    for (const request of pendingConnections) {
      const label = request.counterpartDisplayName?.trim() || "Someone";
      items.push({
        id: `connection:${request.id}`,
        icon: UserRound,
        iconTone: "green",
        title: label,
        description: request.message?.trim() || "Wants to connect with you.",
        actions: [
          {
            key: "decline",
            label: "Decline",
            tone: "ghost",
            disabled: !userId,
            confirm: true,
            run: async () => {
              const idToken = await user?.getIdToken();
              if (!idToken) return;
              await ConnectionsService.reject({ idToken, requestId: request.id });
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
              await ConnectionsService.accept({ idToken, requestId: request.id });
              await connectionsRefresh({ force: true });
            },
          },
        ],
        sortAt: Date.now(),
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
        sortAt: toTimestamp(task.updatedAt || task.startedAt) || Date.now(),
      });
    }

    // Running background tasks (portfolio import, Plaid refresh) — Open + Cancel.
    const appTasks = appTaskState.tasks.filter(
      (task: AppBackgroundTask) =>
        task.userId === userId &&
        !task.dismissedAt &&
        isAppBackgroundTaskVisible(task) &&
        task.status === "running",
    );
    for (const task of appTasks) {
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
      items.push({
        id: `task:${task.taskId}`,
        icon: TrendingUp,
        iconTone: "gray",
        spinning: true,
        title: task.title,
        description: task.description || "Working in the background…",
        actions,
        sortAt: toTimestamp(task.updatedAt || task.startedAt) || Date.now(),
      });
    }

    return items.sort((a, b) => b.sortAt - a.sortAt);
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
    locationRequests,
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

  return { actionables, count: actionables.length, loading };
}
