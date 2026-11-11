"use client";

import { CheckCircle, MapPin } from "@/components/icons";
import { admittedPortraitSource } from "@/lib/profile/provider-avatar";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { CalendarJoinLink } from "./calendar-join-link";
import type { CalendarInvitation } from "@/lib/services/google-calendar-service";
import type { CalendarHusshPeople, CalendarHusshPerson } from "@/lib/calendar/calendar-hussh-people";
import { CalendarMeetingIcon, eventTime } from "./calendar-schedule-presentation";
import { CalendarPersonAvatar } from "./calendar-person-avatar";
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

export type InvitationPeople = CalendarHusshPeople;

export function invitationPerson(people: InvitationPeople, email?: string | null) {
  return people.get(email?.trim().toLowerCase() || "");
}

/** A matched person shows the name Connect shows; the provider label and address are fallbacks. */
export function invitationPersonName(person: CalendarHusshPerson | undefined, ...fallbacks: Array<string | null | undefined>) {
  return person?.displayName?.trim() || fallbacks.map(value => value?.trim()).find(Boolean) || "";
}

export function InvitationAvatar({ name, email, photoUrl, userId }: { name: string; email?: string | null; photoUrl?: string | null; userId?: string | null }) {
  const identity = (email?.trim().toLowerCase() || name.trim().toLowerCase());
  const tone = [...identity].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 4;
  const cleanPhoto = photoUrl?.trim() || "";
  const safePhoto = admittedPortraitSource(cleanPhoto) ? cleanPhoto : null;
  return <CalendarPersonAvatar userId={userId} name={name} photoUrl={safePhoto} className={styles.avatar} fallbackClassName={styles.avatarFallback} tone={tone} source="hussh" />;
}

function guestStatus(status?: string | null) {
  if (status === "accepted") return "Accepted";
  if (status === "declined") return "Declined";
  if (status === "tentative") return "Maybe";
  if (status === "needsAction") return "Awaiting reply";
  return "Response unavailable";
}

export function CalendarInvitationDetail({ event, zone, people = new Map(), profileUserIds, workspaceLayout = false, accountEmail }: { event: CalendarInvitation; zone: string; people?: InvitationPeople; profileUserIds?: ReadonlySet<string>; workspaceLayout?: boolean; accountEmail?: string | null }) {
  const profileId = (person?: CalendarHusshPerson) => person && profileUserIds?.has(person.userId) ? person.userId : undefined;
  const organizerEmail = event.organizer?.email?.trim().toLowerCase();
  const organizerPerson = invitationPerson(people, event.organizer?.email);
  const organizerName = invitationPersonName(organizerPerson, event.organizer?.displayName, event.organizer?.email) || "Organizer";
  const guests = [...(event.attendees || [])];
  const syntheticOrganizer = (organizerEmail || event.organizer?.displayName) && !guests.some(person => organizerEmail && person.email?.trim().toLowerCase() === organizerEmail)
    ? { email: event.organizer?.email, display_name: event.organizer?.displayName, response_status: null }
    : null;
  if (syntheticOrganizer) guests.unshift(syntheticOrganizer);
  const isOrganizer = (person: typeof guests[number]) => person === syntheticOrganizer || Boolean(organizerEmail && person.email?.trim().toLowerCase() === organizerEmail);
  const rank = (person: typeof guests[number]) => isOrganizer(person) ? 0 : person.response_status === "accepted" ? 1 : 2;
  guests.sort((left, right) => rank(left) - rank(right));
  const counts = {
    yes: guests.filter(person => person.response_status === "accepted").length,
    awaiting: guests.filter(person => guestStatus(person.response_status) === "Awaiting reply").length,
    declined: guests.filter(person => person.response_status === "declined").length,
    maybe: guests.filter(person => person.response_status === "tentative").length,
    unknown: guests.filter(person => guestStatus(person.response_status) === "Response unavailable").length,
  };
  const responseSummary = Object.entries(counts).filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join(", ");
  const join = safeMeetingUrl(event.conference_url);
  const provider = event.conference_name || (join ? new URL(join).hostname : "");
  return <article className={styles.detailCard} aria-label={`Invitation details: ${event.title}`}>
    <div className={styles.detailHeading}>
      <InvitationDate event={event} zone={zone} />
      <div className={styles.copy}><h2>{event.title}</h2><p className={styles.muted}>{eventTime(event, zone)}</p>
        {join ? <div className={styles.meeting}><CalendarMeetingIcon provider={provider} /><span>{provider}</span><CalendarJoinLink url={join} accountEmail={event.account_email || accountEmail} /></div> : null}
      </div>
    </div>
    {workspaceLayout ? <>
    {event.description || event.location ? <div className={styles.detailSection}>
      {event.description ? <><p className={styles.sectionLabel}>Description</p><p className={styles.description}>{invitationDescription(event.description)}</p></> : null}
      {event.location ? <p className={styles.location}><MapPin aria-hidden className="size-4 shrink-0" />{event.location}</p> : null}
    </div> : null}
    <div className={styles.detailSection}><p className={styles.sectionLabel}>Guests ({guests.length})</p>
      {responseSummary ? <p className={styles.attendeeSummary}>{responseSummary}</p> : null}
      <ul className={styles.guestList} aria-label="Guests">{guests.map((attendee, index) => {
        const person = invitationPerson(people, attendee.email);
        const organizer = isOrganizer(attendee);
        const name = attendee.self ? "You" : invitationPersonName(person, organizer ? event.organizer?.displayName : null, attendee.display_name, attendee.email) || "Guest";
        const photo = person?.photoUrl;
        return <li key={`${attendee.email || "guest"}:${index}`} title={attendee.email || undefined}>
          <span className={styles.guestAvatar} data-guest-avatar>
            <InvitationAvatar userId={attendee.self ? undefined : profileId(person)} name={name} email={attendee.email} photoUrl={photo} />
            {attendee.response_status === "accepted" ? <CheckCircle aria-hidden="true" weight="fill" data-accepted-indicator className={styles.guestAccepted} /> : null}
          </span>
          <span className={styles.guestCopy}><span>{name}</span>{photo ? <span className="sr-only">HUSSH profile photo</span> : null}{organizer && attendee.email && name !== attendee.email ? <small>{attendee.email}</small> : null}<small>{organizer ? `Organiser · ${guestStatus(attendee.response_status)}` : guestStatus(attendee.response_status)}</small></span>
        </li>;
      })}</ul>
    </div></> : <>
    <div className={styles.detailSection}><p className={styles.sectionLabel}>Organiser</p><div className={styles.person}><InvitationAvatar userId={profileId(organizerPerson)} name={organizerName} email={event.organizer?.email} photoUrl={organizerPerson?.photoUrl} /><div className={styles.copy}><p>{organizerName}</p>{organizerName !== event.organizer?.email ? <p className={styles.muted}>{event.organizer?.email}</p> : null}</div></div>
      {event.description ? <><p className={`${styles.sectionLabel} ${styles.descriptionLabel}`}>Description</p><p className={styles.description}>{invitationDescription(event.description)}</p></> : null}
      {event.location ? <p className={styles.location}><MapPin aria-hidden className="size-4 shrink-0" />{event.location}</p> : null}
    </div>
    <div className={styles.detailSection}><p className={styles.sectionLabel}>Attendees ({event.attendees?.length || 0})</p><ul className={styles.attendees}>{event.attendees?.map((attendee, index) => <li key={`${attendee.email}:${index}`} title={attendee.email || undefined}>
      <InvitationAvatar userId={attendee.self ? undefined : profileId(invitationPerson(people, attendee.email))} name={invitationPersonName(invitationPerson(people, attendee.email), attendee.display_name, attendee.email) || "?"} email={attendee.email} photoUrl={invitationPerson(people, attendee.email)?.photoUrl} /><span>{attendee.self ? "You" : invitationPersonName(invitationPerson(people, attendee.email), attendee.display_name, attendee.email)}</span><small>{attendee.response_status === "needsAction" ? "Awaiting reply" : attendee.response_status}</small>
    </li>)}</ul></div></>}
  </article>;
}
