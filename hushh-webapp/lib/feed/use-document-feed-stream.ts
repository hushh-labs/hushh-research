"use client";

import { useEffect } from "react";
import type { User } from "firebase/auth";
import { Capacitor } from "@capacitor/core";

import { useAuth } from "@/hooks/use-auth";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  createDocumentFeedStreamManager,
  type DocumentFeedStreamManager,
} from "@/lib/feed/document-feed-stream-manager";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";
import { setPayoutStreamState } from "@/lib/payouts/payout-live-store";
import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";
import {
  createDocumentFeedTransport,
  createFeedStreamCoordinator,
  observeIdTokenChanges,
  type DocumentFeedPlatform,
} from "@/lib/services/document-feed-transport";

/** While no healthy stream covers this tab, the Feed is repaired on this clock. */
const REPAIR_INTERVAL_MS = 45_000;

type FeedUser = Pick<User, "uid" | "getIdToken">;
type SharedStream = {
  subscribers: number;
  user: FeedUser;
  manager: DocumentFeedStreamManager;
  stop: () => void;
};
const sharedStreams = new Map<string, SharedStream>();

/**
 * One owner-scoped connection per tab, opened by the app-level
 * AuthenticatedFeedStream; Feed and Profile calls join it, never open another.
 * Across tabs, one leader streams and relays (document-feed-transport.ts).
 * Frames are invalidation hints.
 */
export function useDocumentFeedStream(user: FeedUser | null): void {
  const { userId, sessionVerificationRequired } = useAuth();

  useEffect(() => {
    if (!user || !userId || typeof window === "undefined") return;
    let shared = sharedStreams.get(userId);
    if (!shared) {
      shared = openSharedStream(user, userId);
      sharedStreams.set(userId, shared);
    }
    shared.user = user;
    shared.subscribers += 1;
    const entry = shared;
    return () => {
      entry.subscribers -= 1;
      if (entry.subscribers > 0) return;
      entry.stop();
      if (sharedStreams.get(userId) === entry) sharedStreams.delete(userId);
    };
  }, [user, userId]);

  // A verified session after a failed check is one auth recovery signal.
  useEffect(() => {
    if (!user || !userId) return;
    sharedStreams.get(userId)?.manager.sessionVerification(Boolean(sessionVerificationRequired));
  }, [user, userId, sessionVerificationRequired]);
}

function openSharedStream(user: FeedUser, ownerId: string): SharedStream {
  const uid = ownerId; // Owner-scoped stream, channel and caches; the ID-token watch uses user.uid.
  const platform: DocumentFeedPlatform = Capacitor.isNativePlatform() ? "native" : "web";
  // Fence: once another account (or a new sign-in) owns this tab, nothing
  // from this stream reaches its caches or event buses.
  const owner = snapshotValidatedAuthSessionOwner();
  const isCurrent = () => !owner || isValidatedAuthSessionOwnerCurrent(owner);
  let stopTokenWatch: (() => void) | null = null;
  const shared = { subscribers: 0, user } as SharedStream;
  const manager = createDocumentFeedStreamManager({
    uid,
    transport: createDocumentFeedTransport(platform),
    coordinator: createFeedStreamCoordinator(uid, platform),
    getToken: (forceRefresh) => shared.user.getIdToken(forceRefresh),
    isCurrent,
    isVisible: () => document.visibilityState !== "hidden",
    dispatchFeed: ({ general, consent, requestId, historyMutated }) => {
      // Server activity invalidates both Feed projections and fences older reads.
      if (historyMutated) CacheSyncService.onFeedHistoryMutated(uid);
      else CacheSyncService.onFeedChanged(uid);
      if (general) dispatchFeedStateChanged("arrived");
      if (!consent) return;
      // Feed surfaces listen to this one signal and perform a forced
      // authenticated reread. Consent Center also repairs its current view.
      CacheSyncService.onConsentMutated(uid);
      dispatchConsentStateChanged({
        source: "sse_document_feed",
        requestId: requestId ? `document_share_request:${requestId}` : undefined,
        reconcile: true,
      });
    },
    dispatchPayout: (detail) => dispatchPayoutStateChanged(detail),
    onStreamState: (state) => setPayoutStreamState(state),
    onPhase: (phase) => {
      // A new web ID token is a recovery signal; watch only while blocked.
      if (phase === "auth_blocked" && platform === "web") {
        stopTokenWatch ??= observeIdTokenChanges(user.uid, () => manager.tokenChanged());
      } else if (phase !== "auth_blocked" && stopTokenWatch) {
        stopTokenWatch();
        stopTokenWatch = null;
      }
    },
  });
  const detachLifecycle = attachLifecycle(manager, platform);
  const stopRepair = registerPeriodicTask({
    id: `feed-stream-repair:${uid}`,
    intervalMs: REPAIR_INTERVAL_MS,
    run: () => manager.repairIfUncovered(),
  });
  shared.manager = manager;
  shared.stop = () => {
    detachLifecycle();
    stopRepair();
    manager.stop();
    stopTokenWatch?.();
    stopTokenWatch = null;
  };
  manager.start();
  return shared;
}

function attachLifecycle(manager: DocumentFeedStreamManager, platform: DocumentFeedPlatform): () => void {
  const onOnline = () => manager.online();
  const onFocus = () => manager.focus();
  // Hidden aborts the stream (freeing its server slot); visible repairs and reconnects.
  const onVisibility = () => manager.visibility(document.visibilityState !== "hidden");
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  let detached = false;
  let removeAppListener: (() => void) | null = null;
  if (platform === "native") {
    // Background cancels the native request (frees its backend slot); resume reconnects.
    void import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("appStateChange", ({ isActive }) => manager.appActive(isActive)),
      )
      .then((handle) => {
        if (detached) {
          void handle.remove();
          return;
        }
        removeAppListener = () => void handle.remove();
      })
      .catch(() => undefined);
  }
  return () => {
    detached = true;
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    removeAppListener?.();
  };
}
