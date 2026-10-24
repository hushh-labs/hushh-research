"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { CalendarCompactAction } from "./calendar-compact-action";
import presentationStyles from "./calendar-presentation.module.css";
import { GoogleCalendarService, type CalendarOpening } from "@/lib/services/google-calendar-service";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";

declare global { interface Window { __oneCalendarReschedulingCapability?: string } }
type Options = { openings: CalendarOpening[]; time_zone: string; reply_to: string; event_link?: string };

/** No login, owner credentials, event reads or booking authority. */
export function CalendarReschedulingPage() {
  const capability = useRef("");
  const consumed = useRef(false);
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useLayoutEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    capability.current = window.__oneCalendarReschedulingCapability || window.location.hash.slice(1);
    delete window.__oneCalendarReschedulingCapability;
    // Before any request/telemetry or external link can read the fragment.
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
    setReady(true);
  }, []);
  const load = async () => {
    if (!capability.current) { setError("This rescheduling link is incomplete. Ask the sender for a new link."); setLoading(false); return; }
    setLoading(true); setError(""); setOptions(null);
    try { setOptions(await GoogleCalendarService.publicReschedulingOptions(capability.current)); }
    catch (error) { setError(error instanceof Error ? error.message : "Availability could not be checked."); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (ready) void load(); }, [ready]);
  const label = (slot: CalendarOpening) => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short", timeZone: options?.time_zone }).format(new Date(slot.start_at));
  const replyBody = (slot: CalendarOpening) => `I suggest ${label(slot)} (${options?.time_zone}), for ${Math.round((Date.parse(slot.end_at) - Date.parse(slot.start_at)) / 60000)} minutes. Please confirm whether this works; I can then update the invitation.${safeMeetingUrl(options?.event_link) ? `\n\nMeeting: ${safeMeetingUrl(options?.event_link)}` : ""}`;
  return <AppPageShell width="reading" fitContent className="py-8">
    <div className="space-y-[var(--page-header-section-gap)]" data-calendar-presentation>
      <PageHeader title="Find another time" description="Choose an offered time and reply to the sender. The organizer updates the invitation." />
      <SurfaceCard className="space-y-4 p-5 shadow-none">
        {loading ? <p role="status" className={presentationStyles.status}>Checking offered times…</p> : error ? <div role="alert" className="space-y-3"><p className={presentationStyles.status}>Availability could not be checked.</p><p className={`${presentationStyles.support} text-muted-foreground`}>{error}</p><CalendarCompactAction onClick={() => void load()}>Try again</CalendarCompactAction></div> : options ? <>
          <p className={`${presentationStyles.support} text-muted-foreground`}>Time zone: {options.time_zone}</p>
          {options.openings.length ? <ul className="space-y-3">{options.openings.map(slot => <li key={slot.start_at}><a className={`${presentationStyles.publicOffer} flex min-h-11 items-center rounded-[var(--app-radius-sm)] border p-3 text-[color:var(--app-accent)] focus-visible:ring-2`} href={`mailto:${encodeURIComponent(options.reply_to)}?subject=${encodeURIComponent("Another meeting time")}&body=${encodeURIComponent(replyBody(slot))}`}>Suggest {label(slot)}</a></li>)}</ul> : <p className={presentationStyles.support}>The offered times are no longer available. Reply to the sender to request new options.</p>}
          <p className={`${presentationStyles.support} text-muted-foreground`}>These times were checked just now and aren't reserved. Selecting a time opens your email app; the meeting changes only when the organizer updates it.</p>
          {safeMeetingUrl(options.event_link) ? <a className={presentationStyles.sourceLink} href={safeMeetingUrl(options.event_link)!} target="_blank" rel="noopener noreferrer">Open this meeting in Google Calendar</a> : null}
        </> : null}
      </SurfaceCard>
    </div>
  </AppPageShell>;
}
