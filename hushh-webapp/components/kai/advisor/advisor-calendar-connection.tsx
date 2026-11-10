"use client";

import Link from "next/link";
import { useEffect } from "react";
import { calendarAccountStatus } from "@/lib/calendar/calendar-account-status";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import styles from "./advisor-review.module.css";

export function useAdvisorCalendar(context: FinanceShareContext) {
  const calendar = useCalendarConnectionStatus({ userId: context.userId, idTokenProvider: context.getIdToken });
  const { refresh } = calendar;
  useEffect(() => {
    const onReturn = () => { if (!document.hidden && context.isCurrent()) refresh(); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [context, refresh]);

  return calendar;
}

function calendarConnection(calendar: ReturnType<typeof useAdvisorCalendar>) {
  const status = calendar.status;
  const primary = status ? calendarAccountStatus(status) : null;
  const connected = (account: typeof primary) => account?.connected === true && account.status === "connected";
  const secondary = status?.accounts?.find(connected);
  const account = connected(primary) ? primary : secondary;
  const calendarReady = connected(primary) && primary?.access_level === "manage";
  const needsReauth = primary?.status === "needs_reauth" || status?.status === "needs_reauth";
  const calendarLabel = account?.google_email || (account ? "Calendar connected" : null);
  return { account, calendarReady, needsReauth, calendarLabel };
}

export function advisorCalendarReady(calendar: ReturnType<typeof useAdvisorCalendar>) {
  return calendarConnection(calendar).calendarReady;
}

export function AdvisorCalendarConnection({ calendar, advisor }: {
  calendar: ReturnType<typeof useAdvisorCalendar>;
  advisor: boolean;
}) {
  const { account, calendarReady, needsReauth, calendarLabel } = calendarConnection(calendar);
  const { refresh } = calendar;
  return (
    <div className={styles.calendarRow}>
      {calendarLabel ? (
        <span className={styles.calendarBadge} title={calendarLabel}>{calendarLabel}<span aria-hidden /></span>
      ) : <span className="ui-text-section-label">Google Calendar</span>}
      {calendar.error ? (
        <button type="button" className={styles.quietAction} onClick={refresh}>Retry Calendar status</button>
      ) : calendar.loaded ? (
        <Link href="/one/calendar" className="ui-text-compact-button-label">
          {account ? "Manage Calendar" : needsReauth ? "Reconnect Calendar" : "Connect Calendar"}
        </Link>
      ) : <span role="status" className="ui-text-helper-text">Checking connection…</span>}
      {calendar.loaded && !calendar.error && advisor && !calendarReady
        ? <span className="ui-text-helper-text w-full">{account ? "Allow scheduling on your primary Calendar." : "Connect Calendar to book meetings."}</span>
        : calendar.loaded && !calendar.error && !advisor && !account
          ? <span className="ui-text-helper-text w-full">Optional for email invitations.</span> : null}
    </div>
  );
}
