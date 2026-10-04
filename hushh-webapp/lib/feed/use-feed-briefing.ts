"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  useCalendarConnectionStatus,
} from "@/lib/calendar/use-calendar-connection-status";
import {
  useCalendarUpcomingEvents,
  type RedactedCalendarEvent,
} from "@/lib/calendar/use-calendar-upcoming-events";
import { useGmailNudges } from "@/lib/gmail/use-gmail-nudges";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  GmailInformationRequestsService,
} from "@/lib/services/gmail-information-requests-service";
import { useVault } from "@/lib/vault/vault-context";

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
  const [pendingKyc, setPendingKyc] = useState<FeedKycBriefing | null>(null);

  useEffect(() => {
    if (!userId || !vaultOwnerToken || !gmailConnected) {
      setPendingKyc(null);
      return;
    }

    let current = true;
    void (async () => {
      try {
        const firebaseIdToken = await idTokenProvider();
        if (!firebaseIdToken) return;
        const result = await GmailInformationRequestsService.list({
          firebaseIdToken,
          vaultOwnerToken,
          limit: 1,
        });
        const latest = result.workflows.find(
          (workflow) => workflow.status === "detected",
        );
        if (!current) return;
        setPendingKyc(
          latest
            ? {
                count: Math.max(result.total_count, 1),
                workflowId: latest.workflow_id,
                receivedAt: latest.received_at,
                createdAt: latest.created_at ?? null,
              }
            : null,
        );
      } catch {
        // A private briefing failure must not replace Feed's durable activity
        // with an error state. The Gmail workspace remains available to retry.
        if (current) setPendingKyc(null);
      }
    })();

    return () => {
      current = false;
    };
  }, [gmailConnected, idTokenProvider, userId, vaultOwnerToken]);

  return {
    upcomingEvents: upcoming.events,
    pendingKyc,
    needsReplyCount: gmailNudges.nudges.filter(
      (nudge) => nudge.type === "needs_reply",
    ).length,
  };
}
