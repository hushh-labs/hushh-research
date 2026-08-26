"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";

import { ApiService } from "@/lib/services/api-service";

/**
 * The Referrals tab's live connection.
 *
 * A referral changes state from something the OTHER person did -- they finished
 * setup, they opened an agent, their credited minutes crossed the bar. The
 * referrer is touching nothing while any of that happens, so asking on a timer
 * is the wrong shape: the screen is wrong for however long the timer has left
 * to run, every single time.
 *
 * The server pushes instead. What arrives is a doorbell, never data: the caller
 * re-reads the authenticated summary, which is the one place that decides what
 * a referrer may see. That is deliberate -- a stream carrying the numbers would
 * be a second, quieter place where that decision lives.
 *
 * `connected` is returned so the caller can stop polling while the stream is up
 * and start again the moment it drops. The fallback is the point: a stream that
 * cannot open (an old browser, a proxy that eats it, a network that forbids
 * long connections) must cost freshness, never the screen.
 */
export function useReferralStream(
  user: User | null | undefined,
  onChange: () => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  // Held in a ref so a re-render with a new callback identity does not tear
  // down and rebuild the connection.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const controller = new AbortController();

    const scheduleReconnect = () => {
      if (cancelled) return;
      // Backs off to a minute. A backend that is down does not get hammered by
      // every open tab, and a person watching the screen still reconnects
      // quickly on the first drop.
      const delay = Math.min(1000 * 2 ** attempt, 60_000);
      attempt += 1;
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (cancelled) return;
      try {
        const idToken = await user.getIdToken();
        const response = await ApiService.apiFetchStream("/api/one/referrals/events", {
          method: "GET",
          headers: { Authorization: `Bearer ${idToken}`, Accept: "text/event-stream" },
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok || !response.body) throw new Error("stream_unavailable");
        if (cancelled) return;

        attempt = 0;
        setConnected(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Read frames rather than lines: an SSE event is terminated by a blank
        // line, and a chunk can split one anywhere.
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;

          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.includes("event: referral_changed")) {
              onChangeRef.current();
            }
            boundary = buffer.indexOf("\n\n");
          }
        }

        if (!cancelled) {
          setConnected(false);
          scheduleReconnect();
        }
      } catch {
        if (!cancelled) {
          setConnected(false);
          scheduleReconnect();
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      setConnected(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [user]);

  return { connected };
}
