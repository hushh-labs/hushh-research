"use client";

import { MapPin } from "@/components/icons";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import type { CalendarInvitation } from "@/lib/services/google-calendar-service";
import { CalendarMeetingIcon, eventTime } from "./calendar-schedule-presentation";
import styles from "./calendar-invitations.module.css";

export function invitationDescription(value?: string | null) {
  // Provider HTML is untrusted. Render text only; never mount its DOM or links.
  return (value || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/p\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}

export function InvitationDate({ event, zone }: { event: CalendarInvitation; zone: string }) {
  const value = event.start?.dateTime || (event.start?.date ? `${event.start.date}T12:00:00Z` : "");
  const date = new Date(value);
  const timeZone = event.start?.date ? "UTC" : zone;
  if (!Number.isFinite(date.getTime())) return null;
  return <span className={styles.dateBlock} aria-label={date.toLocaleDateString(undefined, { timeZone, dateStyle: "full" })}>
    <span>{date.toLocaleDateString("en", { timeZone, month: "short" }).toUpperCase()}</span>
    <strong>{date.toLocaleDateString("en", { timeZone, day: "numeric" })}</strong>
    <small>{date.toLocaleDateString("en", { timeZone, weekday: "short" })}</small>
  </span>;
}

export function InvitationAvatar({ name, index = 0 }: { name: string; index?: number }) {
  return <span aria-hidden className={styles.avatar} data-tone={index % 4}>{name.trim().slice(0, 1).toUpperCase() || "?"}</span>;
}

export function CalendarInvitationDetail({ event, zone }: { event: CalendarInvitation; zone: string }) {
  const organizer = event.organizer?.displayName || event.organizer?.email || "Organizer";
  const join = safeMeetingUrl(event.conference_url);
  const provider = event.conference_name || (join ? new URL(join).hostname : "");
  return <article className={styles.detailCard} aria-label={`Invitation details: ${event.title}`}>
    <div className={styles.detailHeading}>
      <InvitationDate event={event} zone={zone} />
      <div className={styles.copy}><h2>{event.title}</h2><p className={styles.muted}>{eventTime(event, zone)}</p>
        <p className={styles.timeZone}>{zone}</p>
        {join ? <div className={styles.meeting}><CalendarMeetingIcon provider={provider} /><span>{provider}</span><a href={join} target="_blank" rel="noopener noreferrer">Join meeting</a></div> : null}
      </div>
    </div>
    <div className={styles.detailSection}><p className={styles.sectionLabel}>Organiser</p><div className={styles.person}><InvitationAvatar name={organizer} /><div className={styles.copy}><p>{organizer}</p>{event.organizer?.displayName ? <p className={styles.muted}>{event.organizer.email}</p> : null}</div></div>
      {event.description ? <><p className={`${styles.sectionLabel} ${styles.descriptionLabel}`}>Description</p><p className={styles.description}>{invitationDescription(event.description)}</p></> : null}
      {event.location ? <p className={styles.location}><MapPin aria-hidden className="size-4 shrink-0" />{event.location}</p> : null}
    </div>
    <div className={styles.detailSection}><p className={styles.sectionLabel}>Attendees ({event.attendees?.length || 0})</p><ul className={styles.attendees}>{event.attendees?.map((attendee, index) => <li key={`${attendee.email}:${index}`} title={attendee.email || undefined}>
      <InvitationAvatar name={attendee.display_name || attendee.email || "?"} index={index} /><span>{attendee.self ? "You" : attendee.display_name || attendee.email}</span><small>{attendee.response_status === "needsAction" ? "Awaiting reply" : attendee.response_status}</small>
    </li>)}</ul></div>
  </article>;
}
