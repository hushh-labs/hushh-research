"use client";

import { Capacitor } from "@capacitor/core";
import { Volume2, VolumeX } from "@/components/icons";
import { useEffect, useRef, useState } from "react";

import { isFeedIdAtOrBefore, latestFeedId } from "@/lib/feed/feed-pagination";
import { playFeedChime, prepareFeedChime } from "@/lib/feed/feed-chime";
import { FCM_MESSAGE_EVENT } from "@/lib/notifications/fcm-service";
import { Button } from "@/lib/morphy-ux/button";
import type { FeedItem } from "@/lib/services/feed-service";

const PUSH_CONFIRM_WINDOW_MS = 15_000;
const SOUND_BURST_WINDOW_MS = 10_000;

function preferenceKey(userId: string): string {
  return `hushh:feed-sound-enabled:${userId}`;
}

function savedPreference(userId: string): boolean {
  try {
    return window.localStorage.getItem(preferenceKey(userId)) === "1";
  } catch {
    return false;
  }
}

function isSilentPush(data: Record<string, string>): boolean {
  const presentation = String(data.notification_presentation ?? "").trim().toLowerCase();
  if (presentation === "silent") return true;
  if (presentation === "alert") return false;
  // Match the service worker for legacy consent bookkeeping doorbells.
  const type = String(data.type ?? "").trim().toLowerCase();
  return type === "consent_opened" || type === "consent_resolved";
}

/**
 * A Feed cue is presentation only. A push may wake the page, but only a newer
 * authenticated Feed row can sound it; initial load, polls and optimistic
 * local actions never do. Browser/OS banners remain independent, so a Mac may
 * also play its notification sound for the same confirmed Drive event.
 */
export function FeedSoundControl({
  userId,
  firstPageItems,
}: {
  userId: string;
  firstPageItems: FeedItem[] | null;
}) {
  // The client effect restores this device preference after hydration.
  // Reading localStorage during the render would make server and client markup differ.
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const observedIdRef = useRef<string | null>(null);
  const hasBaselineRef = useRef(false);
  const pendingPushUntilRef = useRef<number | null>(null);
  const lastSoundAtRef = useRef<number | null>(null);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    const saved = savedPreference(userId);
    setEnabled(saved);
    setReady(false);
    observedIdRef.current = null;
    hasBaselineRef.current = false;
    pendingPushUntilRef.current = null;
    lastSoundAtRef.current = null;
    if (!saved || isNative) return;
    // A previously enabled device may be allowed to resume after a reload.
    // If the browser requires a new gesture, the control says so explicitly.
    let active = true;
    void prepareFeedChime().then((isReady) => {
      if (active) setReady(isReady);
    });
    return () => {
      active = false;
    };
  }, [isNative, userId]);

  useEffect(() => {
    if (!enabled || !ready || isNative) return;
    const onPush = (event: Event) => {
      if (document.visibilityState !== "visible") return;
      const detail = (event as CustomEvent<{ data?: Record<string, string>; notification?: { data?: Record<string, string> } }>).detail;
      const data = detail?.data ?? detail?.notification?.data;
      if (!data?.type || (data.user_id && data.user_id !== userId)) return;
      if (isSilentPush(data)) return;
      pendingPushUntilRef.current = Date.now() + PUSH_CONFIRM_WINDOW_MS;
    };
    window.addEventListener(FCM_MESSAGE_EVENT, onPush);
    return () => window.removeEventListener(FCM_MESSAGE_EVENT, onPush);
  }, [enabled, ready, isNative, userId]);

  useEffect(() => {
    if (!firstPageItems) return;
    const newestId = latestFeedId(firstPageItems);
    if (!hasBaselineRef.current) {
      hasBaselineRef.current = true;
      observedIdRef.current = newestId;
      return;
    }
    if (!newestId || (observedIdRef.current && isFeedIdAtOrBefore(newestId, observedIdRef.current))) return;
    observedIdRef.current = newestId;
    const now = Date.now();
    const pendingUntil = pendingPushUntilRef.current;
    pendingPushUntilRef.current = null;
    if (!enabled || !ready || isNative || document.visibilityState !== "visible") return;
    if (pendingUntil === null || now > pendingUntil) return;
    if (lastSoundAtRef.current !== null && now - lastSoundAtRef.current < SOUND_BURST_WINDOW_MS) return;
    lastSoundAtRef.current = now;
    playFeedChime();
  }, [enabled, firstPageItems, isNative, ready]);

  if (isNative) return null;

  const activate = (preview: boolean) => {
    void prepareFeedChime().then((isReady) => {
      setReady(isReady);
      if (isReady && preview) playFeedChime();
    });
  };

  const toggle = () => {
    if (enabled) {
      setEnabled(false);
      setReady(false);
      pendingPushUntilRef.current = null;
      try {
        window.localStorage.removeItem(preferenceKey(userId));
      } catch {
        // Device storage may be unavailable; this session still turns off.
      }
      return;
    }
    setEnabled(true);
    try {
      window.localStorage.setItem(preferenceKey(userId), "1");
    } catch {
      // Sound can still work during this session without device storage.
    }
    activate(true); // the enabling tap previews the cue
  };

  const label = enabled ? "Feed sound on" : "Feed sound off";

  return (
    <div className="mb-3 flex flex-col items-end gap-0.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {enabled && !ready ? (
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="compact"
            onClick={() => activate(true)}
            className="min-h-11 px-2 text-[12px] text-[color:var(--app-accent)]"
          >
            Tap to activate
          </Button>
        ) : null}
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="compact"
          aria-label={label}
          aria-pressed={enabled}
          onClick={toggle}
          className="min-h-11 gap-2 rounded-full px-3 text-[12px] text-[color:var(--app-secondary-label)]"
        >
          {enabled ? <Volume2 className="mr-2 h-4 w-4 shrink-0" aria-hidden /> : <VolumeX className="mr-2 h-4 w-4 shrink-0" aria-hidden />}
          <span>{label}</span>
        </Button>
      </div>
      {enabled ? (
        <p className="px-2 text-right text-[11px] text-[color:var(--app-secondary-label)]">
          Plays while Feed is open. Mac alerts may sound too.
        </p>
      ) : null}
    </div>
  );
}
