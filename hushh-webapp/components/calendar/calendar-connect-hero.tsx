import type { ReactNode } from "react";
import { CheckCircle2 } from "@/components/icons";

import { CalendarConnectIllustration } from "@/components/calendar/calendar-connect-illustration";
import { Button } from "@/components/ui/button";
import presentationStyles from "./calendar-presentation.module.css";

type CalendarConnectHeroProps = {
  journeyVariant: "workspace" | "onboarding";
  busy: boolean;
  /** Google authorization lapsed; announced to assistive tech only. */
  needsReauth: boolean;
  onConnect: () => void;
  /** Sign-in progress and cancel affordance, rendered under the action. */
  children?: ReactNode;
};

/**
 * Everything one Google consent asks for, by product, so nothing is a surprise
 * on Google's screen. The same set is requested for the first and every added
 * account. Email follow-ups stay off until turned on for each account.
 */
const SETUP_PERMISSIONS = [
  "Calendar: see events and free time; create, move and answer meetings you approve",
  "Google Meet: find your recordings and notes",
  "Google Drive: open Meet files and see details of files shared with you",
  "Gmail: find meeting follow-ups once turned on; send meeting emails you review",
] as const;

export function CalendarSetupPermissions() {
  return (
    <div className={`${presentationStyles.permissions} mt-5 w-full max-w-[320px] text-left`} data-testid="calendar-setup-permissions">
      <p className={presentationStyles.permissionsHeading}>What you allow on Google</p>
      <ul>
        {SETUP_PERMISSIONS.map((item) => (
          <li key={item}>
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The illustration whenever Calendar needs a connection. Presentational
 * only; the owner-bound connect flow stays with the page that renders it.
 */
export function CalendarConnectHero({
  journeyVariant,
  busy,
  needsReauth,
  onConnect,
  children,
}: CalendarConnectHeroProps) {
  return (
    <section
      aria-labelledby="calendar-connect-title"
      className={`${presentationStyles.setup} mx-auto flex w-full max-w-[420px] flex-col items-center text-center md:max-w-[480px]`}
      data-testid="calendar-connect-hero"
    >
      <CalendarConnectIllustration />

      <h1 id="calendar-connect-title" className="ui-text-agent-title mt-4">
        Bring your schedule{" "}
        <br />
        into One.
      </h1>

      {needsReauth ? (
        <p role="status" className="sr-only">
          Google authorization needs to be refreshed.
        </p>
      ) : null}

      <Button
        type="button"
        size="prominent"
        disabled={busy}
        onClick={onConnect}
        className="mx-auto mt-6 w-full max-w-[244px] shrink-0 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
        data-voice-control-id="open_calendar_connector"
        data-voice-action-id={
          journeyVariant === "onboarding" ? "setup.connect_calendar" : undefined
        }
        data-voice-label="Connect Calendar"
        data-voice-purpose="starts Google Calendar authorization from this Calendar agent."
      >
        Connect your calendar
      </Button>

      <CalendarSetupPermissions />

      {children}
    </section>
  );
}
