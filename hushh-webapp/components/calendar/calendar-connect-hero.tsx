import type { ReactNode } from "react";

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
              Find meeting requests and reminders in my email.
            </span>
            <span className="block text-muted-foreground">
              Optional. Right after Calendar, Google asks for one more permission to read email.
              Calendar works the same without it.
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
