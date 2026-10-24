"use client";

import { useRef, type MouseEvent } from "react";
import Image from "next/image";
import { CalendarDays, ChevronRight, MapPin, MoreHorizontal } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { isCalendarEventEnded } from "@/lib/calendar/calendar-event-status";
import type { CalendarEventSummary } from "@/lib/services/google-calendar-service";
import styles from "./calendar-schedule.module.css";

export { GoogleCalendarMark } from "./google-calendar-mark";
export { styles as calendarScheduleStyles };

export const MAIN_TABS = [
  { value: "schedule", label: "Schedule", href: "/one/calendar" },
  { value: "invitations", label: "Invitations", href: "/one/calendar" },
  { value: "insights", label: "Insights", href: "/one/calendar" },
];
export const SCHEDULE_TABS = [{ value: "today", label: "Today" }, { value: "free", label: "Free time" }];

export function CalendarProviderIcon({ className }: { className?: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 28 28" className={[styles.providerIcon, className].filter(Boolean).join(" ")}>
    <rect x="3" y="5" width="22" height="21" rx="3" fill="currentColor" />
    <path d="M8 3.5v4M20 3.5v4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M6 10.5h16v12H6z" fill="white" />
    <g fill="currentColor"><rect x="8" y="13" width="2.7" height="2.7" rx=".5" /><rect x="13" y="13" width="2.7" height="2.7" rx=".5" /><rect x="18" y="13" width="2.7" height="2.7" rx=".5" /><rect x="8" y="18" width="2.7" height="2.7" rx=".5" /><rect x="13" y="18" width="2.7" height="2.7" rx=".5" /></g>
  </svg>;
}

export function CalendarAvailabilityArt({ className }: { className?: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 56 56" className={[styles.availabilityArt, className].filter(Boolean).join(" ")}>
    <rect x="4" y="7" width="13" height="15" rx="2" fill="#d9e8f9" /><rect x="20" y="7" width="13" height="15" rx="2" fill="#c6dffa" /><rect x="36" y="7" width="13" height="15" rx="2" fill="#91beff" />
    <rect x="4" y="25" width="13" height="15" rx="2" fill="#75b9ff" /><rect x="20" y="25" width="13" height="15" rx="2" fill="#278eff" /><rect x="36" y="25" width="13" height="15" rx="2" fill="#0574f9" />
    <rect x="4" y="43" width="13" height="6" rx="1.5" fill="#e0ecf8" /><rect x="20" y="43" width="13" height="6" rx="1.5" fill="#d4e8fd" /><rect x="36" y="43" width="13" height="6" rx="1.5" fill="#e0ecf8" />
  </svg>;
}

export function CalendarHelperIcon({ className }: { className?: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 40 46" className={[styles.helperIcon, className].filter(Boolean).join(" ")}>
    <g stroke="#ffac00" strokeWidth="1.7" strokeLinecap="round"><path d="M20 1v4M7.5 6.5l2.8 2.8M1.5 19H6M34 19h4.5M30 9l3-3M4.5 30l3-2M32.5 28l3 2" /></g>
    <path d="M32.5 19.5c0 6.7-5 9.1-7.7 13.4h-9.6c-2.7-4.3-7.7-6.7-7.7-13.4a12.5 12.5 0 0 1 25 0" fill="#ffb000" />
    <circle cx="20" cy="18.4" r="7.1" fill="white" /><path d="M16 33h8v6.5h-8z" fill="#adb7c4" /><path d="M16.2 35.5h7.6M16.2 38h7.6" stroke="#7f8b9a" strokeWidth="1.3" /><path d="M17.1 39.8h5.8l-1.5 2.4h-2.8z" fill="#7b8493" />
  </svg>;
}

export function calendarDate(now: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function shiftCalendarDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function calendarDayLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}
export function calendarProviderDayUrl(date: string, email?: string | null) {
  const [year, month, day] = date.split("-").map(Number);
  const url = new URL(`https://calendar.google.com/calendar/u/0/r/day/${year}/${month}/${day}`);
  if (email) url.searchParams.set("authuser", email);
  return url.href;
}
export function timeLabel(value: string, zone: string) {
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
export function timeRangeLabel(start: string, end: string, zone: string) {
  const offsets = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "shortOffset" });
  const offset = (value: string) => offsets.formatToParts(new Date(value)).find(part => part.type === "timeZoneName")?.value;
  if (offset(start) !== offset(end)) {
    const clocks = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" });
    return `${clocks.format(new Date(start))} – ${clocks.format(new Date(end))}`;
  }
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).formatRange(new Date(start), new Date(end));
}
// Availability alone needs to distinguish the exclusive end of a civil day.
// Keep event labels and booking handoff formatting unchanged.
export function availabilityTimeRangeLabel(start: string, end: string, zone: string, selectedDate: string) {
  const endParts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(end));
  if (calendarDate(Date.parse(end), zone) === shiftCalendarDate(selectedDate, 1) && endParts === "00:00:00") {
    const offsets = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "shortOffset" });
    const offset = (value: string) => offsets.formatToParts(new Date(value)).find(part => part.type === "timeZoneName")?.value;
    if (offset(start) !== offset(end)) {
      const clock = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" });
      return `${clock.format(new Date(start))} – Midnight (next day) ${offset(end)}`;
    }
    return `${timeLabel(start, zone)} – Midnight (next day)`;
  }
  return timeRangeLabel(start, end, zone);
}
export function railTimeLabel(value: string, zone: string) {
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).formatToParts(new Date(value)).filter(part => part.type !== "dayPeriod").map(part => part.value).join("").trim();
}
export function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return hours ? `${hours} hr${remainder ? ` ${remainder} min` : ""}` : `${minutes} min`;
}
export function eventTime(event: CalendarEventSummary, zone: string) {
  const start = event.start?.dateTime, end = event.end?.dateTime;
  if (!start || !end) return "All day";
  return `${timeRangeLabel(start, end, zone)} · ${durationLabel(Math.round((Date.parse(end) - Date.parse(start)) / 60000))}`;
}
export function meetingProvider(event: CalendarEventSummary) {
  const link = safeMeetingUrl(event.conference_url);
  if (!link) return null;
  const host = new URL(link).hostname;
  if (host === "meet.google.com") return "Google Meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoomgov.us" || host.endsWith(".zoomgov.us")) return "Zoom Meeting";
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host === "teams.cloud.microsoft") return "Microsoft Teams";
  return event.conference_name || host;
}

export function CalendarMeetingIcon({ provider }: { provider: string }) {
  if (provider === "Google Meet") return <Image aria-hidden="true" alt="" src="/one-calendar/providers/google-meet-reference.png" width={20} height={19} unoptimized className={styles.meetingIcon} />;
  if (provider === "Microsoft Teams") return <Image aria-hidden="true" alt="" src="/one-calendar/providers/microsoft-teams-reference.png" width={20} height={21} unoptimized className={styles.meetingIcon} />;
  if (provider === "Zoom Meeting") return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className={styles.meetingIcon}><circle fill="#0784ff" cx="12" cy="12" r="11.5" /><rect fill="white" x="4.5" y="8.1" width="10.1" height="7.7" rx="1.4" /><path fill="white" d="m15.9 9.8 3.7-2v8.4l-3.7-2z" /></svg>;
  return <CalendarDays aria-hidden className={styles.meetingIcon} />;
}

export function calendarResponse(event: CalendarEventSummary, accountEmail?: string | null) {
  return event.attendees?.find(attendee => accountEmail
    ? attendee.email?.toLowerCase() === accountEmail.toLowerCase()
    : attendee.self)?.response_status;
}

export function CalendarTimelineRow({ event, accountEmail, zone, active, ongoing, now, onOpen }: {
  event: CalendarEventSummary; accountEmail?: string | null; zone: string; active: boolean; ongoing: boolean; now: number;
  onOpen: (event: CalendarEventSummary, trigger: HTMLButtonElement) => void;
}) {
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const join = safeMeetingUrl(event.conference_url), provider = meetingProvider(event);
  const open = (click: MouseEvent<HTMLButtonElement>) => onOpen(event, click.currentTarget);
  const starts = event.start?.dateTime, ends = event.end?.dateTime;
  const ended = isCalendarEventEnded(event, now, zone);
  const minutes = starts ? Math.ceil((Date.parse(starts) - now) / 60000) : 0;
  const providerColor = event.event_color || event.calendar_color;
  const color = /^#[0-9a-f]{6}$/i.test(providerColor || "") ? providerColor! : "var(--app-accent)";
  const detailsId = `${event.calendar_id}:${event.id}`;
  return <li data-calendar-event={detailsId} data-highlighted={active || undefined} data-ended={ended || undefined} className={[styles.row, active && styles.highlighted].filter(Boolean).join(" ")}>
    <div data-current={ongoing || undefined} className={[styles.timeColumn, active && styles.activeTime].filter(Boolean).join(" ")}>
      {active ? <span>{ongoing ? "Happening now" : minutes < 60 ? `In ${minutes} min` : "Up next"}</span> : starts && ends ? <><span>{railTimeLabel(starts, zone)}</span><span>{railTimeLabel(ends, zone)}</span></> : <span>All day</span>}
    </div>
    <span aria-hidden="true" className={styles.stripe} style={{ backgroundColor: ended ? "var(--app-secondary-label)" : color }} />
    <div className={styles.eventCopy}>
      <button ref={detailsTrigger} type="button" className={styles.detailsButton} onClick={open}>
        <span className={styles.eventTitle} title={event.title}>{event.title}</span>
        <span className={styles.eventTime}>{eventTime(event, zone)}</span>
      </button>
      {provider || event.location ? <span className={styles.eventSource}>{provider ? <CalendarMeetingIcon provider={provider} /> : <MapPin aria-hidden weight="fill" className={styles.meetingIcon} />}<span className={styles.sourceLabel} title={provider || event.location || undefined}>{provider || event.location}</span></span> : event.calendar_name ? <span className={styles.eventSource}><span className={styles.sourceLabel} title={event.calendar_name}>{event.calendar_name}</span></span> : null}
      {provider && event.location && event.location !== join ? <span className={styles.eventSource}><MapPin aria-hidden weight="fill" className={styles.meetingIcon} /><span className={styles.sourceLabel} title={event.location}>{event.location}</span></span> : null}
      {ended ? <span className={styles.endedLabel}>Ended</span> : null}
      {calendarResponse(event, accountEmail) === "declined" ? <span className={styles.declined}>Declined</span> : null}
    </div>
    <div className={styles.rowActions}>
      {join && !ended ? <a aria-label={`Join meeting: ${event.title}`} href={join} target="_blank" rel="noopener noreferrer" className={styles.joinButton}>Join</a> : null}
      <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={styles.overflowButton} aria-label={`More options: ${event.title}`}><MoreHorizontal aria-hidden /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => { if (detailsTrigger.current) onOpen(event, detailsTrigger.current); }}>View details</DropdownMenuItem>
        {safeMeetingUrl(event.html_link) ? <DropdownMenuItem asChild><a href={safeMeetingUrl(event.html_link)!} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a></DropdownMenuItem> : null}
      </DropdownMenuContent></DropdownMenu>
    </div>
  </li>;
}

export function CalendarProviderShortcut({ date, email, availability = false }: { date: string; email?: string | null; availability?: boolean }) {
  return <SurfaceCard className={styles.providerCard}><a className={[styles.providerShortcut, availability && styles.providerShortcutFree].filter(Boolean).join(" ")} href={calendarProviderDayUrl(date, email)} target="_blank" rel="noopener noreferrer">
    <span aria-hidden className={styles.providerIconTile}><CalendarProviderIcon /></span>
    <span className={styles.providerCopy}><span className={styles.providerTitle}>{availability ? "View full availability" : "View more events"}</span><span className={styles.providerSubtitle}>{availability ? "See more slots in Google Calendar" : "See your full day in Google Calendar"}</span></span>
    <ChevronRight aria-hidden className={styles.providerChevron} />
  </a></SurfaceCard>;
}
