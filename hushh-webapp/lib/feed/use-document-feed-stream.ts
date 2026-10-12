"use client";

import { useEffect } from "react";
import type { User } from "firebase/auth";
import { Capacitor } from "@capacitor/core";

import { useAuth } from "@/hooks/use-auth";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  createDocumentFeedStreamManager,
  type DocumentFeedStreamManager,
} from "@/lib/feed/document-feed-stream-manager";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";
import { setPayoutStreamState } from "@/lib/payouts/payout-live-store";
import {
  createDocumentFeedTransport,
  createFeedStreamCoordinator,
  observeIdTokenChanges,
  type DocumentFeedPlatform,
} from "@/lib/services/document-feed-transport";

type FeedUser = Pick<User, "uid" | "getIdToken">;
type SharedStream = {
  subscribers: number;
  user: FeedUser;
  manager: DocumentFeedStreamManager;
  stop: () => void;
};
const sharedStreams = new Map<string, SharedStream>();

/** Feed and Profile share one authenticated stream; frames are invalidation hints. */
export function useDocumentFeedStream(user: FeedUser | null): void {
  const { sessionVerificationRequired } = useAuth();

  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    let shared = sharedStreams.get(user.uid);
    if (!shared) {
      shared = openSharedStream(user);
      sharedStreams.set(user.uid, shared);
    }
    shared.user = user;
    shared.subscribers += 1;
    const entry = shared;
    return () => {
      entry.subscribers -= 1;
      if (entry.subscribers > 0) return;
      entry.stop();
      if (sharedStreams.get(user.uid) === entry) sharedStreams.delete(user.uid);
    };
  }, [user]);

  // A verified session after a failed check is one auth recovery signal.
  useEffect(() => {
    if (!user) return;
    sharedStreams.get(user.uid)?.manager.sessionVerification(Boolean(sessionVerificationRequired));
  }, [user, sessionVerificationRequired]);
}

function openSharedStream(user: FeedUser): SharedStream {
  const uid = user.uid;
  const platform: DocumentFeedPlatform = Capacitor.isNativePlatform() ? "native" : "web";
  let stopTokenWatch: (() => void) | null = null;
  const shared = { subscribers: 0, user } as SharedStream;
  const manager = createDocumentFeedStreamManager({
    uid,
    transport: createDocumentFeedTransport(platform),
    coordinator: createFeedStreamCoordinator(uid, platform),
    getToken: (forceRefresh) => shared.user.getIdToken(forceRefresh),
    dispatchFeed: ({ requestId }) => {
      CacheSyncService.onConsentMutated(uid);
      // All Feed surfaces listen to this one signal and perform a forced
      // authenticated reread. Consent Center also repairs its current view.
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
        stopTokenWatch ??= observeIdTokenChanges(uid, () => manager.tokenChanged());
      } else if (phase !== "auth_blocked" && stopTokenWatch) {
        stopTokenWatch();
        stopTokenWatch = null;
      }
    },
  });
  const detachLifecycle = attachLifecycle(manager, platform);
  shared.manager = manager;
  shared.stop = () => {
    detachLifecycle();
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
  const onVisibility = () => manager.visibility(document.visibilityState === "visible");
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
