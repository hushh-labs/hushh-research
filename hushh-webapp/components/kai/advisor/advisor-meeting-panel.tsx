"use client";

import Link from "next/link";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { bookingInstant } from "@/lib/calendar/calendar-booking-time";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
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
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("30");
  const [zone, setZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const meeting = review.meeting;
  const advisor = context.userId === review.advisorUserId;
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
          <div className={styles.row}>
            <label className={styles.field}>
              Date
              <Input
                required
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              Time
              <Input
                required
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              Duration
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </label>
          </div>
          <label className={styles.field}>
            Time zone
            <Input
              required
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Asia/Kolkata"
            />
          </label>
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
      <div className={styles.notice}>
        <p className="ui-text-helper-text">
          {advisor
            ? "You need a connected Google Calendar with scheduling permission. Connecting or reconnecting keeps this request saved."
            : "You can receive an email invitation and join without connecting Calendar. Connect it if you want this meeting in your calendar."}
        </p>
        <Link href="/one/calendar" className="ui-text-button-label">
          Connect or manage Calendar
        </Link>
      </div>
    </section>
  );
}
