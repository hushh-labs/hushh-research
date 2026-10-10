"use client";

import { useEffect } from "react";
import type { User } from "firebase/auth";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

const MAX_FRAME_REMAINDER = 16_384;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PERMANENT_STATUSES = new Set([400, 403, 404, 410]);

/** One stream per open Feed. The frame is a doorbell, never request state. */
export function useDocumentFeedStream(user: Pick<User, "uid" | "getIdToken"> | null): void {
  useEffect(() => {
    if (!user || typeof window === "undefined") return;

    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let forceTokenRefresh = false;
    const controller = new AbortController();
    const refresh = (requestId?: string) => {
      CacheSyncService.onConsentMutated(user.uid);
      // All Feed surfaces listen to this one signal and perform a forced
      // authenticated reread. Consent Center also repairs its current view.
      dispatchConsentStateChanged({
        source: "sse_document_feed",
        requestId: requestId ? `document_share_request:${requestId}` : undefined,
        reconcile: true,
      });
    };

    const connect = async () => {
      let connectedAt: number | null = null;
      try {
        const idToken = await user.getIdToken(forceTokenRefresh);
        if (stopped) return;
        const response = await ApiService.apiFetchStream(
          `/api/consent/document-feed/${encodeURIComponent(user.uid)}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${idToken}` },
            signal: controller.signal,
            cache: "no-store",
          },
        );
        if (!response.ok || !response.body) {
          if (response.status === 401) {
            // A token can expire between opening Feed and the handshake.
            // Retry once with a fresh Firebase token, then leave recovery to
            // focus/poll/FCM instead of making an authentication request storm.
            if (forceTokenRefresh) return;
            forceTokenRefresh = true;
            throw new Error("document_feed_token_expired");
          }
          if (PERMANENT_STATUSES.has(response.status)) return;
          throw new Error("document_feed_stream_unavailable");
        }
        connectedAt = Date.now();
        forceTokenRefresh = false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let remainder = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), remainder);
          remainder = parsed.remainder;
          if (remainder.length > MAX_FRAME_REMAINDER) {
            throw new Error("document_feed_frame_too_large");
          }
          for (const frame of parsed.events) {
            if (frame.event === "feed_reset") {
              refresh();
            } else if (frame.event === "feed_changed") {
              try {
                const payload = JSON.parse(frame.data) as { request_id?: unknown };
                const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
                if (DOCUMENT_REQUEST_UUID.test(requestId)) refresh(requestId);
              } catch {
                // Invalid stream metadata cannot select a request or suppress
                // the periodic, focus and push recovery paths.
              }
            }
          }
        }
        if (stopped) return;
        throw new Error("document_feed_stream_closed");
      } catch {
        if (stopped || controller.signal.aborted) return;
      }
      if (connectedAt !== null && Date.now() - connectedAt >= MAX_RECONNECT_DELAY_MS) {
        attempts = 0;
      }
      attempts += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, Math.min(1_000 * 2 ** Math.min(attempts - 1, 5), MAX_RECONNECT_DELAY_MS));
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [user]);
}
