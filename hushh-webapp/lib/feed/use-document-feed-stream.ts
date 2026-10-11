"use client";

import { useEffect } from "react";
import type { User } from "firebase/auth";
import { Capacitor } from "@capacitor/core";

import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";
import { openDocumentFeedStream } from "@/lib/services/document-feed-transport";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

const MAX_FRAME_REMAINDER = 16_384;
const MAX_RECONNECT_DELAY_MS = 30_000;
const TOKEN_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 15_000;
const QUIET_TIMEOUT_MS = 45_000;
const SLOW_RETRY_MS = 5 * 60_000;
const PERMANENT_STATUSES = new Set([400, 403, 404, 410]);
const REFRESH_SETTLE_MS = 1_000;
const REFRESH_MAX_WAIT_MS = 5_000;

type FeedUser = Pick<User, "uid" | "getIdToken">;
type Change = { requestId?: string; general?: boolean; consent?: boolean };
type SharedStream = { subscribers: number; user: FeedUser; stop: () => void };
const sharedStreams = new Map<string, SharedStream>();

/** One owner-scoped connection, shared by the app lifetime and legacy page readers. */
export function useDocumentFeedStream(user: FeedUser | null): void {
  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    let shared = sharedStreams.get(user.uid);
    if (!shared) {
      shared = { subscribers: 0, user, stop: () => {} };
      sharedStreams.set(user.uid, shared);
      shared.stop = startDocumentFeedStream(shared);
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
}

/** Every awaited boundary settles, including SDK token calls that ignore AbortSignal. */
function bounded<T>(promise: Promise<T>, timeout: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("feed_stream_aborted")); };
    const timer = setTimeout(() => controller.abort(), timeout);
    const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); };
    if (controller.signal.aborted) { abort(); return; }
    controller.signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

function startDocumentFeedStream(shared: SharedStream): () => void {
  const uid = shared.user.uid;
  const owner = snapshotValidatedAuthSessionOwner();
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let attempts = 0;
  let forceTokenRefresh = false;
  let authBlocked = false;
  let healthy = false;
  let appActive = true;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastWakeAt = Number.NEGATIVE_INFINITY;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let burstStartedAt = 0;
  let burst: Change = {};
  const currentOwner = () => !stopped && (!owner || isValidatedAuthSessionOwnerCurrent(owner));
  const visible = () => appActive && document.visibilityState !== "hidden";
  const emit = (change: Change) => {
    if (!currentOwner() || !visible()) return;
    CacheSyncService.onFeedChanged(uid);
    if (change.general) dispatchFeedStateChanged("arrived");
    if (change.consent) {
      CacheSyncService.onConsentMutated(uid);
      dispatchConsentStateChanged({
        source: "sse_document_feed",
        requestId: change.requestId ? `document_share_request:${change.requestId}` : undefined,
        reconcile: true,
      });
    }
  };
  // The trailing read sees commits that arrived after the first read started.
  const refresh = (change: Change) => {
    const now = Date.now();
    if (settleTimer === null) {
      burstStartedAt = now;
      burst = change;
      emit(change);
    } else {
      clearTimeout(settleTimer);
      burst = { general: burst.general || change.general, consent: burst.consent || change.consent,
        requestId: burst.requestId === change.requestId ? change.requestId : undefined };
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      emit(burst);
    }, Math.max(0, Math.min(REFRESH_SETTLE_MS, burstStartedAt + REFRESH_MAX_WAIT_MS - now)));
  };
  const cancelRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; };

  const connect = async () => {
    if (!currentOwner() || !visible() || active) return;
    const controller = new AbortController();
    active = controller;
    lastAttemptAt = Date.now();
    let connectedAt: number | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let retry = true;
    const current = () => currentOwner() && active === controller && !controller.signal.aborted;
    try {
      const idToken = await bounded(shared.user.getIdToken(forceTokenRefresh), TOKEN_TIMEOUT_MS, controller);
      if (!current()) return;
      if (!idToken) { authBlocked = true; retry = false; return; }
      const pending = openDocumentFeedStream(uid, idToken, controller.signal);
      // A transport may ignore cancellation; its eventual body still must close.
      void pending.then((response) => { if (!current()) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await bounded(pending, HEADERS_TIMEOUT_MS, controller);
      if (!current()) return;
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401) {
          if (forceTokenRefresh) { authBlocked = true; retry = false; return; }
          forceTokenRefresh = true;
        } else if (PERMANENT_STATUSES.has(response.status)) {
          authBlocked = true;
          retry = false;
          return;
        }
        throw new Error("feed_stream_unavailable");
      }
      connectedAt = Date.now();
      forceTokenRefresh = false;
      authBlocked = false;
      healthy = true;
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let remainder = "";
      while (current()) {
        const { done, value } = await bounded(reader.read(), QUIET_TIMEOUT_MS, controller);
        if (!current() || done) break;
        const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), remainder);
        remainder = parsed.remainder;
        if (remainder.length > MAX_FRAME_REMAINDER) throw new Error("feed_stream_frame_too_large");
        for (const frame of parsed.events) {
          if (frame.event === "feed_reset") {
            refresh({ general: true, consent: true });
          } else if (frame.event === "feed_changed" || frame.event === "heartbeat") {
            try {
              const payload: unknown = JSON.parse(frame.data);
              if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
              const body = payload as Record<string, unknown>;
              if (frame.event === "heartbeat") {
                healthy = body.live !== false;
              } else if (body.request_id === undefined) {
                refresh({ general: true });
              } else if (typeof body.request_id === "string" && DOCUMENT_REQUEST_UUID.test(body.request_id)) {
                refresh({ consent: true, requestId: body.request_id });
              }
            } catch {
              // Malformed metadata never selects a request; polling remains available.
            }
          }
        }
      }
    } catch {
      // All failures use the same bounded recovery below; credentials are never logged.
    } finally {
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* A broken native reader may still be cancelling. */ }
      }
      if (active === controller) active = null;
    }
    healthy = false;
    if (!retry || !currentOwner() || !visible() || active) return;
    if (connectedAt !== null && Date.now() - connectedAt >= MAX_RECONNECT_DELAY_MS) attempts = 0;
    attempts += 1;
    const delay = attempts >= 8 ? SLOW_RETRY_MS
      : Math.min(1_000 * 2 ** Math.min(attempts - 1, 5), MAX_RECONNECT_DELAY_MS);
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay * (0.8 + Math.random() * 0.4));
  };

  const wake = () => {
    const now = Date.now();
    if (!currentOwner() || !visible() || now - lastWakeAt < 1_000) return;
    lastWakeAt = now;
    refresh({ general: true, consent: true });
    if (active && !active.signal.aborted) return;
    if (authBlocked && now - lastAttemptAt < 60_000) return;
    active = null;
    attempts = 0;
    cancelRetry();
    void connect();
  };
  const visibility = () => {
    if (visible()) { wake(); return; }
    cancelRetry();
    active?.abort();
    healthy = false;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", visibility);
  let removeAppListener: (() => void) | null = null;
  if (Capacitor.isNativePlatform()) {
    void import("@capacitor/app")
      .then(({ App }) => App.addListener("appStateChange", ({ isActive }) => {
        appActive = isActive;
        visibility();
      }))
      .then((handle) => {
        if (stopped) { void handle.remove(); return; }
        removeAppListener = () => { void handle.remove(); };
      }).catch(() => {});
  }
  const stopFallback = registerPeriodicTask({ id: `feed-stream-repair:${uid}`, intervalMs: QUIET_TIMEOUT_MS,
    run: () => { if (!healthy) emit({ general: true, consent: true }); } });
  void connect();
  return () => {
    stopped = true;
    active?.abort();
    cancelRetry();
    if (settleTimer) clearTimeout(settleTimer);
    stopFallback();
    removeAppListener?.();
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", visibility);
  };
}
