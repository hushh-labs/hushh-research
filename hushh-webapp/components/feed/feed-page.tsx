"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { User } from "firebase/auth";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";

import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { Button as StockButton } from "@/components/ui/button";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler, type LocalOnboardingActionHandler, type LocalActionPreparer } from "@/lib/agent/local-onboarding-actions";
import { ConnectionsService } from "@/lib/services/connections-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { FeedRow } from "@/components/feed/feed-row";
import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { FeedPushPrompt } from "@/components/feed/feed-push-prompt";
import {
  SettingsGroup,
  SettingsPresentationProvider,
} from "@/components/app-ui/settings-ui";
import { useFeedActionables } from "@/lib/feed/use-feed-actionables";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { listKaiActionsForSurface } from "@/lib/voice/kai-action-gateway";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { isFeedItemHidden } from "@/lib/feed/feed-visibility";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import {
  FeedService,
  type FeedItem,
  type FeedListResponse,
} from "@/lib/services/feed-service";
import { daysSinceToday } from "@/lib/feed/feed-timestamp";
import {
  appendFeedPage,
  createFeedPaginationState,
  isFeedIdAtOrBefore,
  latestFeedId,
  reconcileFeedFirstPage,
} from "@/lib/feed/feed-pagination";

function dayLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const diffDays = daysSinceToday(date);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function groupItemsByDay(
  items: FeedItem[],
): Array<{ label: string; items: FeedItem[] }> {
  const groups: Array<{ label: string; items: FeedItem[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.created_at);
    const current = groups[groups.length - 1];
    if (current && current.label === label) current.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/**
 * What voice can do while someone is standing on the Feed.
 *
 * Derived from the generated action gateway rather than hand-listed, the same
 * way Location's surfaces do it -- a new Feed action becomes reachable the
 * moment it is added to the contract, with no second list to remember.
 *
 * This screen published nothing at all until now, which mattered more here
 * than almost anywhere else: connect.accept_request and connect.reject_request
 * name `one_feed` as their home, so the one screen where "accept request"
 * is the obvious thing to say was the one screen that never offered it. Both
 * execute backend-direct, so they always *ran* if the model went looking --
 * they were simply never suggested.
 */
const FEED_VOICE_ACTIONS = listKaiActionsForSurface({ screen: "one_feed" })
  .filter(
    (action) =>
      action.execution_target.status === "wired" &&
      (action.execution_target.path === "local_handler" ||
        action.execution_target.path === "route" ||
        action.execution_target.path === "control") &&
      action.execution_policy !== "manual_only",
  )
  .map((action) => ({
    id: action.action_id,
    actionId: action.action_id,
    label: action.label,
    // First sentence only: contract `meaning` is multi-sentence prose written
    // for the model's semantic assessment, not a short one-liner.
    purpose: action.meaning.split(/(?<=[.!?])\s/)[0] || action.meaning,
  }));

export function FeedPage() {
  const { user, loading: authLoading } = useAuth();

  const prepareConnectionRequest = (accept: boolean): LocalActionPreparer => async (slots, chosenResourceId) => {
    if (!user || authLoading) return { status: "blocked", gate: "permission", summary: "Sign in to review requests." };
    const person = typeof slots.person === "string" ? slots.person.trim() : "";
    const selected = Object.prototype.hasOwnProperty.call(slots, "requestId") ? slots.requestId : chosenResourceId;
    if (!person || (selected !== undefined && (typeof selected !== "string" || !selected.trim() || selected.length > 256))) {
      return { status: "blocked", gate: "input", summary: "Choose one request again." };
    }
    try {
      const idToken = await user.getIdToken();
      const incoming = await ConnectionsService.listRequests({ idToken, direction: "incoming" });
      const matches = incoming.filter((request) =>
        (selected === undefined || request.id === selected) &&
        request.counterpartDisplayName?.trim().toLocaleLowerCase() === person.toLocaleLowerCase());
      if (matches.length !== 1) return { status: "blocked", gate: "input", summary: "Choose one current request in your Feed." };
      const request = matches[0]!;
      if (accept && request.scopes?.length) return { status: "blocked", gate: "navigation", route: "/one/feed", waitForUser: true, summary: "Review the requested information in your Feed before accepting." };
      return { status: "ready", binding: { owner: user.uid, requestId: request.id, person: request.counterpartDisplayName, decision: accept ? "accept" : "reject", scopes: request.scopes ?? [] }, summary: `${accept ? "Accept" : "Decline"} ${request.counterpartDisplayName}'s connection request?` };
    } catch {
      return { status: "blocked", gate: "permission", summary: "Requests could not be checked. Try again." };
    }
  };

  const decideConnectionRequest = (accept: boolean): LocalOnboardingActionHandler => async (slots, context) => {
    if (context?.preparedBinding) slots = { ...slots, ...context.preparedBinding };
    if (!user || authLoading) return { status: "blocked", summary: "Sign in to review requests." };
    if (!context?.directiveId && !context?.humanConfirmationToken) {
      return { status: "blocked", summary: "Confirm this action in the app first." };
    }
    const person = typeof slots.person === "string" ? slots.person.trim() : "";
    const hasRequestId = Object.prototype.hasOwnProperty.call(slots, "requestId");
    const requestId = typeof slots.requestId === "string" ? slots.requestId.trim() : "";
    if (!person || (hasRequestId && (!requestId || requestId.length > 256))) {
      return { status: "blocked", summary: "Choose the request again." };
    }
    try {
      const idToken = await user.getIdToken();
      const incoming = await ConnectionsService.listRequests({ idToken, direction: "incoming" });
      // IDs select only from this owner's current incoming requests. A stale ID
      // or mismatched label never falls back to a same-name request.
      const matches = incoming.filter((request) =>
        (!hasRequestId || request.id === requestId) &&
        request.counterpartDisplayName?.trim().toLocaleLowerCase() === person.toLocaleLowerCase());
      if (matches.length !== 1) return { status: "blocked", summary: "Choose one current request in your Feed." };
      if (context.signal?.aborted) return { status: "blocked", summary: "The action was cancelled." };
      const request = matches[0]!;
      // Scope-bearing accepts still require the existing scope-review UI; the
      // API rejects an accept without those selections rather than guessing.
      if (accept) await ConnectionsService.accept({ idToken, requestId: request.id });
      else await ConnectionsService.reject({ idToken, requestId: request.id });
      if (accept) CacheSyncService.onConnectionGraphMutated(user.uid);
      else CacheSyncService.onConnectionCapabilityMutated(user.uid);
      return { status: "succeeded", summary: `${accept ? "Accepted" : "Declined"} ${request.counterpartDisplayName}'s connection request.` };
    } catch {
      return { status: "failed", summary: "The request could not be updated. Review it in your Feed." };
    }
  };
  useLocalOnboardingActionHandler("connect.accept_request", decideConnectionRequest(true), { prepare: prepareConnectionRequest(true) });
  useLocalOnboardingActionHandler("connect.reject_request", decideConnectionRequest(false), { prepare: prepareConnectionRequest(false) });

  // Every account owns an independent Feed session. Remounting on uid changes
  // scopes pagination, clear/read watermarks, actionables, and pending requests
  // together, so no state or late response from one account can reach another.
  return (
    <FeedPageSession
      key={user?.uid ?? "signed-out"}
      user={user}
      authLoading={authLoading}
    />
  );
}

function FeedPageSession({
  user,
  authLoading,
}: {
  user: User | null;
  authLoading: boolean;
}) {
  const router = useRouter();
  const [pagination, setPagination] = useState(createFeedPaginationState);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // The newest item id this visit has already reported as read. A live refresh
  // brings genuinely new rows in while the page is open, and those must clear
  // the tab badge too — a boolean latch marked read exactly once and then let
  // the badge count up over a list the user was looking straight at.
  const markedReadUpToRef = useRef<string | null>(null);
  // Ids that arrived unread at any point during this visit.
  //
  // The Feed marks itself read on open but deliberately keeps those rows styled
  // unread until the next visit (see the mark-read effect below). Now that the
  // list actually re-fetches, the server would return those same rows as read
  // and the accent tint would drain out from under the reader mid-scroll.
  // Remembering them preserves the intended behaviour through a live refresh.
  const visitUnreadIdsRef = useRef<Set<string>>(new Set());
  // Durable clear. There is no backend feed-delete endpoint yet, so "Clear"
  // (a) marks everything read (which the server persists) and (b) records a
  // per-user "cleared through this id" watermark in localStorage. Feed ids are
  // append-only and are also the backend read/pagination authority, so a new row
  // can never be hidden because its server timestamp tied or moved backwards.
  // Remove the old timestamp key on sight. It cannot be losslessly translated
  // to an id: a row appended later may carry an equal/older timestamp. Showing
  // old history once is safer than silently losing a genuinely new alert.
  const clearedIdStorageKey = user?.uid
    ? `hushh:feed-cleared-through-id:${user.uid}`
    : null;
  const legacyClearedStorageKey = user?.uid
    ? `hushh:feed-cleared-at:${user.uid}`
    : null;

  // The persisted watermark is read in the state initialiser. This session
  // component is remounted per account (`key={user?.uid}`) after auth has
  // resolved on the client, so there is no server-rendered list to mismatch;
  // reading it in an effect instead forced every visit to paint the skeleton
  // first and the warm cached list one commit later (two full layouts per
  // tab switch). Storage can be disabled; that falls back to no clear.
  const readPersistedWatermark = () => {
    if (!clearedIdStorageKey || typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(clearedIdStorageKey);
    } catch {
      return null;
    }
  };
  const [clearedThroughId, setClearedThroughId] = useState<string | null>(
    readPersistedWatermark,
  );
  const [clearWatermarkHydrated, setClearWatermarkHydrated] = useState(
    () => !clearedIdStorageKey || typeof window !== "undefined",
  );
  const [clearing, setClearing] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);

  // Retire the legacy timestamp key on sight (it cannot be translated to an
  // id); a storage failure here changes nothing the initialiser decided.
  useEffect(() => {
    if (!clearedIdStorageKey || !legacyClearedStorageKey) {
      setClearWatermarkHydrated(true);
      return;
    }
    try {
      window.localStorage.removeItem(legacyClearedStorageKey);
    } catch {
      // Storage can be disabled; nothing to retire.
    }
    setClearWatermarkHydrated(true);
  }, [clearedIdStorageKey, legacyClearedStorageKey]);

  useEffect(() => {
    if (!clearArmed) return;
    const timeout = window.setTimeout(() => setClearArmed(false), 5_000);
    return () => window.clearTimeout(timeout);
  }, [clearArmed]);

  const {
    actionables,
    loading: actionablesLoading,
    error: actionablesError,
    retry: retryActionables,
    hasClearableSmsEmergencies,
    clearSmsEmergencies,
  } = useFeedActionables();

  // Counts only -- never who, and never what any item says. The Feed is a list
  // of other people's names and activity; the only thing voice needs from it is
  // whether there is anything waiting, which is what makes "accept their
  // request" a sensible thing to offer here at all.
  // `connection:` is the id prefix use-feed-actionables gives an incoming
  // connection request; FeedActionable is a presentation shape and carries no
  // kind of its own, so the prefix is the only thing that distinguishes one.
  const pendingConnectionRequestCount = actionables.filter((entry) =>
    entry.id.startsWith("connection:"),
  ).length;

  usePublishVoiceSurfaceMetadata(
    user && !authLoading
      ? {
          screenId: "one_feed",
          title: "Feed",
          purpose:
            "Shows recent activity and anything waiting on you, including connection requests you can accept or decline.",
          spokenSubject: "Feed",
          actions: FEED_VOICE_ACTIONS,
          availableActions: FEED_VOICE_ACTIONS.map((action) => action.label),
          busyOperations: actionablesLoading ? ["feed_actionables_load"] : [],
          screenMetadata: {
            pending_connection_request_count: pendingConnectionRequestCount,
            actionable_count: actionables.length,
            data_state: actionablesLoading ? "loading" : "loaded",
          },
        }
      : null,
  );

  const {
    data,
    loading,
    error: resourceError,
    refresh,
  } = useStaleResource<FeedListResponse>({
    cacheKey: user?.uid
      ? CACHE_KEYS.FEED_LIST(user.uid)
      : "feed_list_signed_out",
    enabled: Boolean(user?.uid),
    resourceLabel: "feed_list",
    retainOnInvalidate: true,
    // `force` must reach FeedService: it keeps its own short-TTL cache in front
    // of the request, so dropping the flag here made a forced refresh return the
    // same page it already had and the list looked live without being live.
    load: async (options) => {
      const idToken = await user!.getIdToken();
      return FeedService.list({
        idToken,
        userId: user!.uid,
        limit: 20,
        force: options?.force,
      });
    },
  });

  // Keep the open list live. `force` is required: without it a cache entry that
  // is still inside its TTL short-circuits the load, which is exactly how the
  // Feed could sit open showing activity that had already been answered.
  useFeedLiveRefresh(
    useCallback(() => {
      void refresh({ force: true });
    }, [refresh]),
    Boolean(user?.uid),
  );

  useEffect(() => {
    if (!data) return;
    setPagination((current) => reconcileFeedFirstPage(current, data));
  }, [data]);

  const latestIdRef = useRef<string | null>(null);

  useEffect(() => {
    latestIdRef.current = latestFeedId(data?.items ?? []);
  }, [data]);

  const markSeen = useCallback(() => {
    const latestId = latestIdRef.current;
    if (!user?.uid || !latestId || markedReadUpToRef.current === latestId)
      return;
    markedReadUpToRef.current = latestId;
    CacheSyncService.onFeedReadStarted(user.uid, latestId);
    dispatchFeedStateChanged("read");

    void (async () => {
      try {
        const idToken = await user.getIdToken();
        await FeedService.markRead({ idToken, upToId: latestId });
        CacheSyncService.onFeedReadSettled(user.uid);
        // Recount after success so a row that arrived above the posted
        // watermark remains unread instead of being swallowed by optimistic 0.
        dispatchFeedStateChanged("read");
      } catch (error) {
        markedReadUpToRef.current = null;
        CacheSyncService.onFeedReadFailed(user.uid);
        dispatchFeedStateChanged("read");
        console.warn("[FeedPage] Failed to mark notifications read:", error);
      }
    })();
  }, [user]);

  // Mark the current watermark when the Feed is visible, and again for a truly
  // newer live row. Keep the hidden/unmount calls as a final settlement path
  // for platforms that suspend network work while the page is active.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        markSeen();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      markSeen();
    };
  }, [markSeen]);

  // Record every row that has been unread this visit, before the mark-read above
  // takes effect on the server. Covers paged-in rows too, which arrive unread on
  // their own request.
  useEffect(() => {
    for (const item of [
      ...(data?.items ?? []),
      ...pagination.additionalItems,
    ]) {
      if (!item.read) visitUnreadIdsRef.current.add(item.id);
    }
  }, [data, pagination.additionalItems]);

  useEffect(() => {
    if (data?.items[0]?.id) markSeen();
  }, [data?.items, markSeen]);

  // A poll that returns the same rows must not hand FeedRow new objects: the
  // rows are memoised on their item, so a row whose id, read flag and time
  // are unchanged keeps its previous object and skips its render.
  const previousItemsRef = useRef<Map<string, FeedItem>>(new Map());
  const items = useMemo(() => {
    // useStaleResource can synchronously expose a warm first page. Do not let
    // that cached history render for one frame before the device-local clear
    // watermark has been read.
    if (!clearWatermarkHydrated) return [];
    // The cached first page can revalidate and shift after "load more" has
    // appended later pages; de-dupe by id so a boundary item never renders
    // twice (duplicate React keys) if it reappears across the seam.
    const seen = new Set<string>();
    const merged: FeedItem[] = [];
    // Drop anything at or below the persisted append-only id watermark.
    for (const item of [
      ...(data?.items ?? []),
      ...pagination.additionalItems,
    ]) {
      if (isFeedItemHidden(item, isLocalCrmBuildEnabled())) continue;
      if (seen.has(item.id)) continue;
      if (clearedThroughId && isFeedIdAtOrBefore(item.id, clearedThroughId)) {
        continue;
      }
      seen.add(item.id);
      const previous = previousItemsRef.current.get(item.id);
      merged.push(
        previous &&
          previous.read === item.read &&
          previous.created_at === item.created_at &&
          previous.event_type === item.event_type &&
          previous.actor_label === item.actor_label
          ? previous
          : item,
      );
    }
    previousItemsRef.current = new Map(merged.map((item) => [item.id, item]));
    return merged;
  }, [
    data,
    pagination.additionalItems,
    clearedThroughId,
    clearWatermarkHydrated,
  ]);

  const retryFeed = useCallback(async () => {
    await Promise.all([refresh({ force: true }), retryActionables()]);
  }, [refresh, retryActionables]);

  const loadMore = useCallback(async () => {
    const requestedCursor = pagination.nextCursor;
    if (!user || !requestedCursor || loadingMore) return;
    setLoadMoreError(null);
    setLoadingMore(true);
    try {
      const idToken = await user.getIdToken();
      const response = await FeedService.list({
        idToken,
        cursor: requestedCursor,
        limit: 20,
      });
      setPagination((current) =>
        appendFeedPage(current, response, requestedCursor),
      );
    } catch {
      setLoadMoreError("Couldn't load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [user, pagination.nextCursor, loadingMore]);

  const openItem = useCallback(
    (item: FeedItem) => {
      const href = presentFeedItem(item).href;
      if (href) router.push(href);
    },
    [router],
  );

  const handleClearAll = useCallback(async () => {
    if (!user || clearing) return;
    setClearArmed(false);
    setClearing(true);
    try {
      if (items.length > 0) {
        // Persist what the backend supports today: mark everything read so
        // the unread badge is cleared durably. Hiding history is a per-device,
        // per-user watermark until a real feed-delete endpoint exists.
        const idToken = await user.getIdToken();
        const latestId = latestFeedId(items);
        if (!latestId) throw new Error("Feed contains no valid row id");
        CacheSyncService.onFeedReadStarted(user.uid, latestId);
        try {
          await FeedService.markRead({ idToken, upToId: latestId });
          CacheSyncService.onFeedReadSettled(user.uid);
        } catch (error) {
          CacheSyncService.onFeedReadFailed(user.uid);
          dispatchFeedStateChanged("read");
          throw error;
        }
        dispatchFeedStateChanged("read");
        markedReadUpToRef.current = latestId;
        setPagination(createFeedPaginationState());
        setClearedThroughId(latestId);
        if (clearedIdStorageKey && legacyClearedStorageKey) {
          try {
            window.localStorage.setItem(clearedIdStorageKey, latestId);
            window.localStorage.removeItem(legacyClearedStorageKey);
          } catch {
            // Storage disabled: clear still applies for this session.
          }
        }
      }
      // Revoked/expired SOS cards have nothing left to act on. Dismiss them
      // only after the durable read mutation succeeds, so a backend failure is
      // a true no-op instead of reporting failure after partially clearing UI.
      if (hasClearableSmsEmergencies) clearSmsEmergencies();
      toast.success("Feed cleared on this device");
    } catch {
      toast.error("Couldn't clear your feed.");
    } finally {
      setClearing(false);
    }
  }, [
    user,
    clearing,
    items,
    clearedIdStorageKey,
    legacyClearedStorageKey,
    hasClearableSmsEmergencies,
    clearSmsEmergencies,
  ]);

  // Present strictly newest-first by wall-clock time, then club into day
  // sections. The backend paginates by row id (append-only), which normally
  // equals created_at order; sorting here keeps the feed correct even when it
  // doesn't, so a day never appears split across the list.
  const dayGroups = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return groupItemsByDay(sorted);
  }, [items]);
  // A live SOS share gets its own "Live" section, pinned above "Needs you",
  // so a safety alert is never mistaken for a routine pending item. Revoked or
  // expired SOS rows fall straight into the regular "Needs you" list.
  const liveActionables = actionables.filter(
    (item) => item.emphasis === "emergency",
  );
  const regularActionables = actionables.filter(
    (item) => item.emphasis !== "emergency",
  );
  const hasLiveActionables = liveActionables.length > 0;
  const hasRegularActionables = regularActionables.length > 0;
  const hasActionables = hasLiveActionables || hasRegularActionables;
  // Once cleared this session, the loaded history rows are hidden even though
  // `items` still holds them (no backend delete yet), so the empty state shows.
  const hasHistory = items.length > 0;
  const contentLoading =
    !clearWatermarkHydrated || loading || actionablesLoading;
  const hasRefreshError = Boolean(resourceError || actionablesError);
  const showEmpty =
    !contentLoading && !hasActionables && !hasHistory && !hasRefreshError;
  const showColdError =
    !contentLoading && !hasActionables && !hasHistory && hasRefreshError;
  const showStaleWarning = hasRefreshError && (hasActionables || hasHistory);
  // The Clear affordance only makes sense when there is dismissable history
  // showing. Actionables ("Needs you") are otherwise deliberately NOT
  // cleared — they're pending tasks the user must still act on — except a
  // revoked SOS card, which has nothing left to act on and is the one
  // actionable type Clear also removes.
  const canClear = hasHistory || hasClearableSmsEmergencies;
  const beaconDataState = contentLoading
    ? "loading"
    : showColdError
      ? "error"
      : hasActionables || hasHistory
        ? "loaded"
        : "empty-valid";

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-[calc(var(--app-screen-footer-pad)+16px)]"
    >
      <NativeTestBeacon
        routeId="/one/feed"
        marker="native-route-feed"
        authState={
          authLoading ? "pending" : user ? "authenticated" : "anonymous"
        }
        dataState={beaconDataState}
        errorCode={showColdError ? "FEED_LOAD_FAILED" : null}
        errorMessage={showColdError ? "Feed activity could not load." : null}
      />
      <div className="w-full">
        {/* No in-body header: the shared top bar owns the single Feed title. */}
        <SettingsPresentationProvider density="compact">
          <AppPageContentRegion>
            <FeedPushPrompt />
            {hasLiveActionables ? (
              <section aria-label="Live">
                <SectionLabel>Live</SectionLabel>
                <SettingsGroup
                  separatorInset
                  testId="feed-live-group"
                  shellClassName="!bg-accent/[0.04] shadow-none ring-1 ring-inset ring-accent/10"
                >
                  {liveActionables.map((item) => (
                    <FeedActionableRow key={item.id} item={item} />
                  ))}
                </SettingsGroup>
              </section>
            ) : null}

          {hasRegularActionables ? (
            <section aria-label="Needs you">
              <SectionLabel>Needs you</SectionLabel>
              <div className="divide-y divide-[color:var(--foundation-hairline)]">
                {regularActionables.map((item) => (
                  <FeedActionableRow key={item.id} item={item} />
                ))}
              </div>
            </section>
          ) : null}

            {contentLoading && !hasHistory && !hasActionables ? (
              <FeedRowsSkeleton />
            ) : null}

            {showColdError ? (
              <div
                role="alert"
                className="flex min-h-[100px] flex-col items-center justify-center gap-2.5 rounded-[16px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-6 text-center"
              >
                <p className="text-[17px] font-semibold leading-[22px] text-[color:var(--app-label)]">
                  Activity unavailable
                </p>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="compact"
                  onClick={() => void retryFeed()}
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {showStaleWarning ? (
              <div
                role="status"
                className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.04] px-3 py-2 text-xs text-muted-foreground"
              >
                <span>
                  Showing saved activity. Some updates couldn't refresh.
                </span>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="compact"
                  onClick={() => void retryFeed()}
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {showEmpty ? (
              <div
                role="status"
                className="flex min-h-[100px] flex-col items-center justify-center gap-1 rounded-[16px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-6 text-center"
              >
                <p className="text-[17px] font-semibold leading-[22px] text-[color:var(--app-label)]">
                  No activity yet
                </p>
                <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
                  Your recent activity will appear here.
                </p>
              </div>
            ) : null}

            {canClear ? (
              <div className="flex w-full justify-end pt-3" aria-live="polite">
                <StockButton
                  type="button"
                  variant="secondary"
                  size="compact"
                  onClick={() => {
                    if (!clearArmed) {
                      setClearArmed(true);
                      return;
                    }
                    void handleClearAll();
                  }}
                  disabled={clearing}
                  aria-label={
                    clearArmed
                      ? "Confirm clear feed notifications on this device"
                      : "Clear feed notifications on this device"
                  }
                  className="w-auto max-w-full whitespace-nowrap bg-destructive/10 px-4 text-destructive hover:bg-destructive/15"
                >
                  {clearing
                    ? "Clearing…"
                    : clearArmed
                      ? "Confirm clear"
                      : "Clear on this device"}
                </StockButton>
              </div>
            ) : null}

            {hasHistory
              ? dayGroups.map((group) => (
                  <section key={group.label} aria-label={group.label}>
                    <SectionLabel>{group.label}</SectionLabel>
                    <SettingsGroup separatorInset>
                      {group.items.map((item) => (
                        <FeedRow
                          key={item.id}
                          item={item}
                          unread={
                            !item.read || visitUnreadIdsRef.current.has(item.id)
                          }
                          onOpen={openItem}
                        />
                      ))}
                    </SettingsGroup>
                  </section>
                ))
              : null}

            {hasHistory && pagination.nextCursor ? (
              <div className="flex flex-col items-center gap-1 py-3">
                {loadMoreError ? (
                  <p role="alert" className="text-xs text-muted-foreground">
                    {loadMoreError} Try again.
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="compact"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore
                    ? "Loading…"
                    : loadMoreError
                      ? "Retry"
                      : "Load more"}
                </Button>
              </div>
            ) : null}
          </AppPageContentRegion>
        </SettingsPresentationProvider>
      </div>
    </AppPageShell>
  );
}

/** Day / section divider that follows the shared readable label scale. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <AppSectionLabel
      as="h2"
      compact
      className="px-1 pb-1.5 pt-5 text-[color:var(--app-section-label)]"
    >
      {children}
    </AppSectionLabel>
  );
}

function FeedRowsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading feed"
      className="overflow-hidden rounded-[16px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-none"
    >
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="grid min-h-[60px] grid-cols-[36px_minmax(0,1fr)_48px] items-center gap-x-3 border-b border-[color:var(--app-separator)] px-4 py-2.5 last:border-b-0"
        >
          <span className="h-9 w-9 rounded-full bg-foreground/[0.07]" />
          <span className="space-y-2">
            <span className="block h-3.5 w-2/3 rounded-full bg-foreground/[0.07]" />
            <span className="block h-3 w-5/6 rounded-full bg-foreground/[0.055]" />
          </span>
          <span className="h-3 w-12 rounded-full bg-foreground/[0.055]" />
        </div>
      ))}
    </div>
  );
}
