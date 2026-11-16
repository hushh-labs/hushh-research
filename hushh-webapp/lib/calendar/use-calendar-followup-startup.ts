"use client";

import { getAuthSessionGeneration, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useEffect, useRef } from "react";
import { CalendarFollowupsService } from "@/lib/services/calendar-followups-service";
import { initializeFollowupMonitor } from "./calendar-followup-sync";
import { calendarTimeZone } from "./calendar-time-zone";

/** Start at the connected Calendar workspace, before Insights is opened. */
export function useCalendarFollowupStartup(options: {
  userId: string; accountIds: string[]; connectionRevision: number;
  getIdToken: () => Promise<string>;
}) {
  const current = useRef(options);
  useEffect(() => { current.current = options; });
  const accountKey = JSON.stringify(options.accountIds);
  useEffect(() => {
    const controller = new AbortController();
    const generation = getAuthSessionGeneration();
    const alive = () => snapshotValidatedAuthSessionOwner()?.userId === options.userId && !controller.signal.aborted && getAuthSessionGeneration() === generation && current.current.userId === options.userId
      && current.current.connectionRevision === options.connectionRevision;
    const zone = calendarTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    void (async () => {
      for (const accountId of JSON.parse(accountKey) as string[]) {
        try {
          const idToken = await current.current.getIdToken();
          if (!alive()) return;
          const status = await CalendarFollowupsService.status(options.userId, accountId, idToken, controller.signal);
          if (!alive()) return;
          const initialized = await initializeFollowupMonitor(options.userId, accountId, status, zone, idToken, controller.signal);
          if (!alive()) return;
          if (initialized) {
            // The existing scheduled worker owns continuation after this bounded first step.
            void CalendarFollowupsService.scan(options.userId, accountId, idToken, {}, controller.signal).catch(() => undefined);
          }
        } catch {
          // Insights retains its recoverable state; a failed optional startup
          // must never interrupt the Calendar board or trigger another OAuth.
        }
      }
    })();
    return () => controller.abort();
  }, [options.userId, accountKey, options.connectionRevision]);
}
