"use client";

import { useState } from "react";
import { ShellActionSurface, SHELL_PILL_TRIGGER_CLASSNAME } from "@/components/app-ui/shell-action-surface";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZone, calendarTimeZoneOffset } from "@/lib/calendar/calendar-time-zone";
import type { AdvisorMeeting, AdvisorReview } from "@/lib/advisor-review/contract";
import { AdvisorReviewError, AdvisorReviewService } from "@/lib/advisor-review/service";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { cn } from "@/lib/utils";
import { AdvisorDatePicker, AdvisorDurationPicker, AdvisorTimePicker, AdvisorTimeZonePicker } from "./advisor-meeting-pickers";
import { AdvisorCalendarConnection, advisorCalendarReady, useAdvisorCalendar } from "./advisor-calendar-connection";
import styles from "./advisor-review.module.css";

type Run = (work: () => Promise<unknown>) => Promise<void>;
type MeetingAction = Parameters<typeof AdvisorReviewService.meeting>[2];

const statuses: Record<AdvisorMeeting["status"], string> = {
  proposed: "Proposed", agreed: "Time accepted", review_ready: "Ready to confirm",
  booking: "Waiting for Google Calendar", retryable: "Booking can be retried",
  confirmed: "Confirmed", completed: "Introduction complete", cancelled: "Cancelled",
  missing: "No longer on Calendar", unknown: "Booking status unclear",
};

function meetingTime(meeting: AdvisorMeeting, zone: string) {
  return new Date(meeting.startAt!).toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short", timeZone: zone,
  });
}

function joinHref(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && url.hostname === "meet.google.com" ? url.href : null;
  } catch {
    return null;
  }
}

export function AdvisorMeetingPanel({ review, context, busy, run }: {
  review: AdvisorReview; context: FinanceShareContext; busy: boolean; run: Run;
}) {
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("");
  const [minute, setMinute] = useState("");
  const [duration, setDuration] = useState("30");
  const [deviceZone] = useState(() => calendarTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [zone, setZone] = useState(deviceZone);
  const [editId, setEditId] = useState<string>();
  const [check, setCheck] = useState<{ id: string | undefined; label: string }>();
  const [confirmCancel, setConfirmCancel] = useState<string>();
  const meeting = review.meeting;
  const advisor = context.userId === review.advisorUserId;
  const time = hour && minute ? `${hour}:${minute}` : "";
  const calendar = useAdvisorCalendar(context);
  const calendarReady = advisorCalendarReady(calendar);
  const past = review.pastMeetings ?? [];
  const introduction = past.find((entry) => ["confirmed", "completed"].includes(entry.status)) ?? meeting;
  const now = Date.parse(review.serverNow);
  const finished = meeting?.endAt ? Date.parse(meeting.endAt) <= now : false;
  const canComplete = advisor && introduction?.status === "confirmed" && introduction.endAt && Date.parse(introduction.endAt) <= now;
  const confirmed = meeting?.status === "confirmed";
  const canFollowUp = confirmed && finished || meeting?.status === "completed";
  const canSuggest = Boolean(meeting?.id) && (canFollowUp || ["proposed", "agreed", "review_ready"].includes(meeting?.status ?? ""));
  const editing = Boolean(meeting?.id && editId === meeting.id && canSuggest);
  const showForm = !meeting || editing || meeting.status === "missing" || meeting.status === "cancelled";
  const automatic = advisor && calendarReady;
  const autoOffer = !advisor && meeting?.automaticApprovalExpiresAt &&
    Date.parse(meeting.automaticApprovalExpiresAt) > now;

  const act = (action: MeetingAction, target = meeting) => run(async () => {
    await AdvisorReviewService.meeting(context, review.id, action, target?.proposalId, target?.id);
    if (action === "agree" && advisor && target?.proposedBy !== context.userId) {
      await AdvisorReviewService.meeting(context, review.id, "prepare", undefined, target?.id);
    }
  });
  const checkCalendar = () => run(async () => {
    setCheck({ id: meeting?.id, label: "Checking Calendar…" });
    try {
      const result = await AdvisorReviewService.meeting(context, review.id, "check", meeting?.proposalId, meeting?.id);
      if (context.isCurrent()) setCheck({
        id: meeting?.id,
        label: result.status === "confirmed" ? "Checked just now" : statuses[result.status],
      });
    } catch (error) {
      const label = error instanceof AdvisorReviewError ? error.message : "Couldn’t check Calendar. Try again.";
      if (context.isCurrent()) setCheck({ id: meeting?.id, label });
    }
  });
  const choose = () => run(async () => {
    const startAt = bookingInstant(date, time, zone);
    await AdvisorReviewService.time(context, review.id, {
      startAt,
      endAt: new Date(Date.parse(startAt) + Number(duration) * 60_000).toISOString(),
      timeZone: zone,
      expectedMeetingId: meeting?.id ?? null,
    }, automatic);
    if (context.isCurrent()) setEditId(undefined);
  });
  const openForm = () => {
    if (!meeting?.id) return;
    if (!canFollowUp && meeting.startAt && meeting.endAt) {
      const selectedZone = calendarTimeZone(meeting.timeZone);
      const fields = bookingLocalFields(meeting.startAt, selectedZone);
      setDate(fields.date);
      setHour(fields.time.slice(0, 2));
      setMinute(fields.time.slice(3));
      setZone(selectedZone);
      setDuration(String((Date.parse(meeting.endAt) - Date.parse(meeting.startAt)) / 60_000));
    } else {
      setDate("");
      setHour("");
      setMinute("");
    }
    setEditId(meeting.id);
  };
  const safeJoin = confirmed && !finished ? joinHref(meeting?.joinUrl) : null;
  const meetingZone = calendarTimeZone(meeting?.timeZone ?? deviceZone);
  const durationLabel = meeting?.startAt && meeting.endAt
    ? `${(Date.parse(meeting.endAt) - Date.parse(meeting.startAt)) / 60_000} min` : null;
  const showCheck = advisor && ["booking", "unknown", "retryable", "confirmed"].includes(meeting?.status ?? "");

  return (
    <section className={cn(styles.card, "space-y-3")}>
      <h3 className="ui-text-section-label">{past.some((entry) => entry.status === "confirmed" || entry.status === "completed") ? "Your meetings" : "Your introduction"}</h3>
      {meeting?.startAt ? (
        <div className={styles.notice}>
          <div className={styles.row}>
            <strong className="text-foreground">{meetingTime(meeting, meetingZone)}</strong>
            <span className="ui-text-helper-text">{confirmed && finished ? "Meeting ended" : statuses[meeting.status]}</span>
          </div>
          <p className="ui-text-helper-text">{durationLabel} · {meetingZone.split("/").at(-1)?.replaceAll("_", " ")} · {calendarTimeZoneOffset(meetingZone, meeting.startAt)}</p>
          {deviceZone !== meetingZone ? <p className="ui-text-helper-text">Your time · {meetingTime(meeting, deviceZone)}</p> : null}
          {advisor && meeting.status === "review_ready" && meeting.invitationEmail
            ? <p className="ui-text-helper-text break-all">Invite to {meeting.invitationEmail}</p> : null}
        </div>
      ) : null}
      {meeting?.status === "proposed" && meeting.proposedBy !== context.userId && !editing ? (
        <div className={styles.row}>
          <ShellActionSurface variant="pill" className={styles.primary} disabled={busy} onClick={() => void act(autoOffer ? "accept_booking" : "agree")}>
            {autoOffer ? "Accept & book" : "Accept time"}
          </ShellActionSurface>
        </div>
      ) : null}
      {advisor && !editing && ["agreed", "review_ready", "retryable"].includes(meeting?.status ?? "") ? (
        <ShellActionSurface variant="pill" className={styles.primary} disabled={busy}
          onClick={() => void act(meeting?.status === "review_ready" ? "confirm" : "prepare")}>
          {meeting?.status === "review_ready" ? "Confirm meeting" : "Review Calendar booking"}
        </ShellActionSurface>
      ) : null}
      {safeJoin || showCheck ? (
        <div className="flex flex-wrap items-center gap-2">
          {safeJoin ? <a href={safeJoin} target="_blank" rel="noreferrer"
            className={cn(SHELL_PILL_TRIGGER_CLASSNAME, styles.primary, "ui-text-compact-button-label inline-flex min-h-11 items-center px-4")}>Join Google Meet</a> : null}
          {showCheck ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ShellActionSurface variant="pill" aria-label="More meeting actions" disabled={busy}>More</ShellActionSurface>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="rounded-[var(--app-card-radius-compact)]" align="start">
                <DropdownMenuItem onSelect={() => void checkCalendar()}>Check Calendar status</DropdownMenuItem>
                {confirmed && !finished && meeting?.id ? <DropdownMenuItem variant="destructive" onSelect={() => setConfirmCancel(meeting.id)}>Cancel meeting</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {check && check.id === meeting?.id ? <p role="status" className="ui-text-helper-text">{check.label}</p> : null}
      {canComplete ? <ShellActionSurface variant="pill" disabled={busy} onClick={() => void act("complete", introduction)}>Mark introduction complete</ShellActionSurface> : null}
      {canSuggest && !editing ? <ShellActionSurface variant="pill" disabled={busy} onClick={openForm}>
        {canFollowUp ? "Schedule another meeting" : "Suggest a different time"}
      </ShellActionSurface> : null}
      {showForm ? (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void choose(); }}>
          <div className="grid grid-cols-2 gap-2">
            <div className={styles.field}><span className="ui-text-form-label">Date</span><AdvisorDatePicker value={date} zone={zone} onChange={setDate} disabled={busy} /></div>
            <div className={styles.field}><span className="ui-text-form-label">Time · 24h</span><AdvisorTimePicker hour={hour} minute={minute} onHour={setHour} onMinute={setMinute} disabled={busy} /></div>
          </div>
          <div className={styles.field}><span className="ui-text-form-label">Duration</span><AdvisorDurationPicker value={duration} onChange={setDuration} disabled={busy} /></div>
          <div className={styles.field}><span className="ui-text-form-label">Time zone</span><AdvisorTimeZonePicker value={zone} date={date} time={time} onChange={setZone} disabled={busy} /></div>
          {automatic ? <p className="ui-text-helper-text">If the client accepts this exact time within 24 hours, Calendar sends the invite.</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            {editing ? <ShellActionSurface variant="pill" onClick={() => setEditId(undefined)} disabled={busy}>Back</ShellActionSurface> : null}
            <ShellActionSurface variant="pill" type="submit" className={styles.primary} disabled={busy || !date || !time}>
              {automatic ? "Propose & allow booking" : "Propose a time"}
            </ShellActionSurface>
          </div>
        </form>
      ) : null}
      {past.length ? <details className="ui-text-helper-text">
        <summary>Past meetings · {past.length}</summary>
        <ul>{[...past].reverse().map((entry) => <li key={entry.id}>
          {entry.startAt ? `${meetingTime(entry, calendarTimeZone(entry.timeZone))} · ` : ""}{statuses[entry.status]}
        </li>)}</ul>
      </details> : null}
      <AdvisorCalendarConnection calendar={calendar} advisor={advisor} />
      <AlertDialog open={Boolean(confirmCancel && confirmCancel === meeting?.id)} onOpenChange={(open) => { if (!open) setConfirmCancel(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel meeting?</AlertDialogTitle>
            <AlertDialogDescription>Google Calendar will notify the invitee.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep meeting</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void act("cancel")}>Cancel meeting</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
