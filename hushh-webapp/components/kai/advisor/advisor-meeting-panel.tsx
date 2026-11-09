"use client";

import { useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { calendarTimeZone } from "@/lib/calendar/calendar-time-zone";
import { bookingInstant } from "@/lib/calendar/calendar-booking-time";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { AdvisorDatePicker, AdvisorDurationPicker, AdvisorTimePicker, AdvisorTimeZonePicker } from "./advisor-meeting-pickers";
import { AdvisorCalendarConnection, useAdvisorCalendar } from "./advisor-calendar-connection";
import styles from "./advisor-review.module.css";

type Run = (work: () => Promise<unknown>) => Promise<void>;
export function AdvisorMeetingPanel({
  review,
  context,
  busy,
  run,
}: {
  review: AdvisorReview;
  context: FinanceShareContext;
  busy: boolean;
  run: Run;
}) {
  const [date, setDate] = useState("");
  const [hour, setHour] = useState("");
  const [minute, setMinute] = useState("");
  const time = hour && minute ? `${hour}:${minute}` : "";
  const [duration, setDuration] = useState("30");
  const [zone, setZone] = useState(
    () => calendarTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const meeting = review.meeting;
  const advisor = context.userId === review.advisorUserId;
  const calendar = useAdvisorCalendar(context);
  const act = (action: string) =>
    run(() =>
      AdvisorReviewService.meeting(
        context,
        review.id,
        action,
        meeting?.proposalId,
      ),
    );
  const choose = () =>
    run(async () => {
      const startAt = bookingInstant(date, time, zone);
      await AdvisorReviewService.time(context, review.id, {
        startAt,
        endAt: new Date(
          Date.parse(startAt) + Number(duration) * 60000,
        ).toISOString(),
        timeZone: zone,
      });
    });
  const safeJoin = (() => {
    try {
      const url = new URL(meeting?.joinUrl || "");
      return url.protocol === "https:" && url.hostname === "meet.google.com"
        ? url.href
        : null;
    } catch {
      return null;
    }
  })();
  return (
    <section className={styles.card}>
      <h3 className="ui-text-section-label">Your introduction</h3>
      <p className="ui-text-helper-text">
        Agree on a time together. The advisor then reviews and confirms it in
        Google Calendar.
      </p>
      {meeting?.startAt ? (
        <div className={styles.notice}>
          <strong>
            {new Date(meeting.startAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </strong>
          <p className="ui-text-caption">
            Your time zone · {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
          <p className="ui-text-caption">
            Chosen zone:{" "}
            {new Date(meeting.startAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: meeting.timeZone,
            })}{" "}
            · {meeting.timeZone}
          </p>
          <p>{meeting.status.replaceAll("_", " ")}</p>
        </div>
      ) : null}
      {meeting?.status === "proposed" &&
      meeting.proposedBy !== context.userId ? (
        <ShellActionSurface
          variant="pill"
          className={styles.primary}
          disabled={busy}
          onClick={() => void act("agree")}
        >
          Agree to this time
        </ShellActionSurface>
      ) : null}
      {advisor &&
      ["agreed", "review_ready", "retryable"].includes(
        meeting?.status || "",
      ) ? (
        <div className={styles.actions}>
          {meeting?.status === "review_ready" ? (
            <>
              <p className="ui-text-helper-text">
                Invitation to {meeting.invitationEmail}. Google Meet will be
                created. Nothing is booked yet.
              </p>
              <ShellActionSurface
                variant="pill"
                className={styles.primary}
                disabled={busy}
                onClick={() => void act("confirm")}
              >
                Confirm meeting
              </ShellActionSurface>
            </>
          ) : (
            <ShellActionSurface
              variant="pill"
              className={styles.primary}
              disabled={busy}
              onClick={() => void act("prepare")}
            >
              Review Calendar booking
            </ShellActionSurface>
          )}
        </div>
      ) : null}
      {meeting?.status === "unknown" || meeting?.status === "booking" ? (
        <p role="status">
          The booking result is not confirmed. Check Google Calendar before
          trying to book again.
        </p>
      ) : null}
      {meeting?.status === "confirmed" ? (
        <div className={styles.actions}>
          {safeJoin ? (
            <a
              href={safeJoin}
              target="_blank"
              rel="noreferrer"
              className="ui-text-button-label"
            >
              Join Google Meet
            </a>
          ) : (
            <p>
              The calendar invitation will show the join link when Google has
              created it.
            </p>
          )}
          {advisor ? (
            <>
              <ShellActionSurface
                variant="pill"
                disabled={busy}
                onClick={() => void act("cancel")}
              >
                Cancel meeting
              </ShellActionSurface>
              <ShellActionSurface
                variant="pill"
                disabled={
                  busy ||
                  !meeting.endAt ||
                  Date.parse(meeting.endAt) > Date.now()
                }
                onClick={() => void act("complete")}
              >
                Introduction complete
              </ShellActionSurface>
            </>
          ) : null}
        </div>
      ) : null}
      {!["booking", "unknown", "retryable", "confirmed", "completed"].includes(
        meeting?.status || "",
      ) ? (
        <form
          className={styles.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void choose();
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className={styles.field}><span className="ui-text-form-label">Date</span><AdvisorDatePicker value={date} zone={zone} onChange={setDate} disabled={busy} /></div>
            <div className={styles.field}><span className="ui-text-form-label">Time · 24h</span><AdvisorTimePicker hour={hour} minute={minute} onHour={setHour} onMinute={setMinute} disabled={busy} /></div>
          </div>
          <div className={styles.field}><span className="ui-text-form-label">Duration</span><AdvisorDurationPicker value={duration} onChange={setDuration} disabled={busy} /></div>
          <div className={styles.field}><span className="ui-text-form-label">Time zone</span><AdvisorTimeZonePicker value={zone} date={date} time={time} onChange={setZone} disabled={busy} /></div>
          <div className={styles.actions}>
            <ShellActionSurface
              variant="pill"
              type="submit"
              disabled={busy || !date || !time}
            >
              Propose a time
            </ShellActionSurface>
          </div>
        </form>
      ) : null}
      {advisor &&
      ["booking", "unknown", "retryable", "confirmed"].includes(
        meeting?.status || "",
      ) ? (
        <div className={styles.actions}>
          <ShellActionSurface
            variant="pill"
            disabled={busy}
            onClick={() => void act("check")}
          >
            Check Calendar status
          </ShellActionSurface>
        </div>
      ) : null}
      <AdvisorCalendarConnection calendar={calendar} advisor={advisor} />
    </section>
  );
}
