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
  /**
   * The optional email choice for a brand-new connection. Absent when the
   * account is being reconnected, so nobody is asked twice.
   */
  mailChoice?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Sign-in progress and cancel affordance, rendered under the action. */
  children?: ReactNode;
};

/** Everything first-time setup asks Google for, stated up front so nothing asks again later. */
const SETUP_PERMISSIONS = [
  "See your events and when you are free",
  "Create, move and respond to meetings you approve",
  "Find your calendars, meeting recordings and notes",
  "Send meeting emails only after you review them",
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
 * The second and last first-time setup step: Mail, so sending a reviewed
 * decline or reschedule note never needs another Google prompt.
 */
export function CalendarMailStep({
  busy,
  onAllow,
  onSkip,
  children,
}: {
  busy: boolean;
  onAllow: () => void;
  onSkip: () => void;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="calendar-mail-step-title"
      className={`${presentationStyles.setup} mx-auto flex w-full max-w-[420px] flex-col items-center text-center md:max-w-[480px]`}
      data-testid="calendar-mail-step"
    >
      <CalendarConnectIllustration />
      <h1 id="calendar-mail-step-title" className="ui-text-agent-title mt-4">
        One more step.
      </h1>
      <p className={`${presentationStyles.support} mt-2 max-w-[320px] text-muted-foreground`}>
        Allow Mail so One can send the notes you review and spot meeting requests. Nothing is sent without your approval.
      </p>
      <Button
        type="button"
        size="prominent"
        disabled={busy}
        onClick={onAllow}
        className="mx-auto mt-6 w-full max-w-[244px] shrink-0 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
      >
        Allow Mail
      </Button>
      <button
        type="button"
        disabled={busy}
        onClick={onSkip}
        className="mt-2 min-h-11 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
      >
        Not now
      </button>
      {children}
    </section>
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
  mailChoice,
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

      <CalendarSetupPermissions />

      {mailChoice ? (
        <label className="mt-6 flex w-full max-w-[320px] items-start gap-3 text-left text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0"
            checked={mailChoice.checked}
            disabled={busy}
            onChange={(event) => mailChoice.onChange(event.target.checked)}
          />
          <span>
            <span className="block font-medium">
              Watch my email for meeting requests and reminders.
            </span>
            <span className="block text-muted-foreground">
              Optional. Setup asks for Mail access in its next step either way.
            </span>
          </span>
        </label>
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

      {children}
    </section>
  );
}
