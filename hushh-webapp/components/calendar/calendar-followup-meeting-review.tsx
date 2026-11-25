"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { dueText } from "@/lib/calendar/calendar-followup-presentation";
import { CalendarSelect } from "./calendar-select";
import presentation from "./calendar-presentation.module.css";
import type { FollowupRequest } from "@/lib/services/calendar-followups-service";

export function MeetingReview({ request, zone, busy, onReview }: {
  request: FollowupRequest; zone: string; busy: boolean;
  onReview: (request: FollowupRequest, startAt: string, endAt: string, timeZone: string) => void;
}) {
  const local = request.proposed_at ? bookingLocalFields(request.proposed_at, request.time_zone || zone) : null;
  const [date, setDate] = useState(local?.date || request.proposed_date || "");
  const [time, setTime] = useState(local?.time || "");
  const [duration, setDuration] = useState<"" | "15" | "30" | "60">(request.ambiguities.includes("duration") ? "" : "30");
  const [timeZone, setTimeZone] = useState(request.ambiguities.includes("time_zone") ? "" : request.time_zone || zone);
  const [error, setError] = useState("");
  if (request.state === "cancelled" || request.state === "dismissed" || request.booking_state === "booked") return null;
  return <>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <label>Date<Input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <label>Time<Input type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <label>Duration<CalendarSelect value={duration} onChange={event => setDuration(event.target.value as typeof duration)}><option value="">Choose</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">60 min</option></CalendarSelect></label>
      <label>Time zone<CalendarSelect value={timeZone} onChange={event => setTimeZone(event.target.value)}><option value="">Choose</option><option value={zone}>{zone}</option>{request.time_zone && request.time_zone !== zone ? <option value={request.time_zone}>{request.time_zone}</option> : null}{zone !== "UTC" && request.time_zone !== "UTC" ? <option value="UTC">UTC</option> : null}</CalendarSelect></label>
    </div>
    {error ? <p role="alert" className={`${presentation.support} text-destructive`}>{error}</p> : null}
    <Button size="compact" disabled={busy} onClick={() => {
      if (!date || !time || !duration || !timeZone) { setError("Choose the meeting date, time, duration and time zone first."); return; }
      try {
        const startAt = bookingInstant(date, time, timeZone);
        if (Date.parse(startAt) <= Date.now()) { setError("Choose a future meeting time."); return; }
        onReview(request, startAt, new Date(Date.parse(startAt) + Number(duration) * 60_000).toISOString(), timeZone);
      } catch { setError("Choose a valid meeting time."); }
    }}>Schedule</Button>
  </>;
}

/** Where a request stands against the Calendar, in the owner's words. */
export function meetingStatus(request: FollowupRequest, zone: string): string {
  if (request.booking_state === "booked") return "On your Calendar";
  if (request.state === "cancelled" || request.state === "dismissed") return "Not on your Calendar";
  const linked = request.linked_event;
  if (linked) return `Already on your Calendar: ${linked[1]}`;
  return `Meeting proposed · ${dueText(request, zone)} · Not on your Calendar yet`;
}
