"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  useCalendarConnectionStatus,
} from "@/lib/calendar/use-calendar-connection-status";
import {
  useCalendarUpcomingEvents,
  type RedactedCalendarEvent,
} from "@/lib/calendar/use-calendar-upcoming-events";
import { useGmailNudges } from "@/lib/gmail/use-gmail-nudges";
import { FEED_STATE_CHANGED_EVENT, feedStateChangeReason } from "@/lib/feed/feed-events";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  GmailInformationRequestsService,
} from "@/lib/services/gmail-information-requests-service";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export type FeedKycBriefing = {
  count: number;
  workflowId: string;
  receivedAt: string | null;
  createdAt: string | null;
};

export type UseFeedBriefingResult = {
  upcomingEvents: RedactedCalendarEvent[];
  pendingKyc: FeedKycBriefing | null;
  needsReplyCount: number;
};

/**
 * Current, owner-scoped briefing data for Feed. Unlike historical Feed rows,
 * every result here is read after vault unlock and remains in component memory.
 * This hook deliberately does not call an agent: Calendar, Gmail nudges, and
 * KYC workflows are already authoritative deterministic read models.
 */
export function useFeedBriefing(): UseFeedBriefingResult {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const userId = user?.uid ?? null;
  const epoch = snapshotVaultSessionEpoch();
  const scope = useMemo(() => Symbol(`feed-briefing:${Boolean(userId)}:${Boolean(vaultOwnerToken)}:${epoch}`), [userId, vaultOwnerToken, epoch]);
  const idTokenProvider = useCallback(
    () => user?.getIdToken() ?? Promise.resolve(""),
    [user],
  );

  const calendar = useCalendarConnectionStatus({
    userId,
    idTokenProvider: user ? idTokenProvider : null,
  });
  const upcoming = useCalendarUpcomingEvents({
    userId,
    vaultOwnerToken,
    isConnected: calendar.connected,
    windowHours: 24,
  });
  const gmail = useGmailConnectorStatus({
    userId,
    idTokenProvider: user ? idTokenProvider : null,
    routeHref: "/one/feed",
  });
  const gmailConnected =
    gmail.status?.connected === true && gmail.status.needs_reauth !== true;
  const gmailNudges = useGmailNudges({
    userId,
    vaultOwnerToken,
    isConnected: gmailConnected,
    idTokenProvider: user ? idTokenProvider : null,
    limit: 10,
  });
  const [kyc, setKyc] = useState<{ scope: symbol; value: FeedKycBriefing | null }>({ scope, value: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshers = useRef({ calendar: upcoming.refresh, gmail: gmailNudges.refresh });
  useEffect(() => { refreshers.current = { calendar: upcoming.refresh, gmail: gmailNudges.refresh }; });
  const scheduleRefresh = useRef<(() => void) | null>(null);
  const taskId = `feed-briefing:${useId()}`;

  // General activity can affect the briefing. Document-only consent frames and
  // unread-watermark changes do not. Coalesce bursts and bound provider reads;
  // foreground + a slow visible-page fallback repair missed remote hints.
  useEffect(() => {
    if (!userId || !vaultOwnerToken) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    const schedule = () => {
      if (timer || document.visibilityState === "hidden" || !isVaultSessionEpochCurrent(epoch)) return;
      timer = setTimeout(() => {
        timer = null;
        if (document.visibilityState === "hidden" || !isVaultSessionEpochCurrent(epoch)) return;
        lastRefreshAt = Date.now();
        if (calendar.connected) refreshers.current.calendar();
        if (gmailConnected) refreshers.current.gmail();
        setRefreshKey((value) => value + 1);
      }, Math.max(500, lastRefreshAt + 15_000 - Date.now()));
    };
    const onFeed = (event: Event) => { if (feedStateChangeReason(event) !== "read") schedule(); };
    scheduleRefresh.current = schedule;
    window.addEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      scheduleRefresh.current = null;
      if (timer) clearTimeout(timer);
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [scope, userId, vaultOwnerToken, epoch, calendar.connected, gmailConnected]);
  usePeriodicTask(taskId, 120_000, () => scheduleRefresh.current?.(), { enabled: Boolean(userId && vaultOwnerToken) });

  useEffect(() => {
    if (!userId || !vaultOwnerToken || !gmailConnected) {
      setKyc({ scope, value: null });
      return;
    }

    let current = true;
    void (async () => {
      try {
        const firebaseIdToken = await idTokenProvider();
        if (!firebaseIdToken || !current || !isVaultSessionEpochCurrent(epoch)) return;
        const result = await GmailInformationRequestsService.list({
          firebaseIdToken,
          vaultOwnerToken,
          limit: 1,
        });
        const latest = result.workflows.find(
          (workflow) => workflow.status === "detected",
        );
        if (!current || !isVaultSessionEpochCurrent(epoch)) return;
        setKyc({ scope, value: latest
            ? {
                count: Math.max(result.total_count, 1),
                workflowId: latest.workflow_id,
                receivedAt: latest.received_at,
                createdAt: latest.created_at ?? null,
              }
            : null });
      } catch {
        // A private briefing failure must not replace Feed's durable activity
        // with an error state. The Gmail workspace remains available to retry.
        if (current && isVaultSessionEpochCurrent(epoch)) setKyc({ scope, value: null });
      }
    })();

    return () => {
      current = false;
    };
  }, [gmailConnected, idTokenProvider, userId, vaultOwnerToken, scope, epoch, refreshKey]);

  return {
    upcomingEvents: upcoming.events,
    pendingKyc: kyc.scope === scope && vaultOwnerToken ? kyc.value : null,
    needsReplyCount: gmailNudges.nudges.filter(
      (nudge) => nudge.type === "needs_reply",
    ).length,
  };
}
