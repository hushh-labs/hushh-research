import type { ReactNode } from "react";

import { CalendarConnectIllustration } from "@/components/calendar/calendar-connect-illustration";
import { Button } from "@/components/ui/button";

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
 * Resting state of the Calendar screen while nothing is connected: first
 * connect and a lapsed Google authorization share this one hero and one
 * action. Presentational only; the owner-bound connect flow stays with the
 * page that renders it.
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
      className="mx-auto flex w-full max-w-[420px] flex-col items-center text-center"
      data-testid="calendar-connect-hero"
    >
      <CalendarConnectIllustration />

      <h1 id="calendar-connect-title" className="ui-text-agent-title mt-4">
        Bring your schedule{" "}
        <br />
        into One.
      </h1>

      <p className="ui-text-page-subtitle mt-3 max-w-[20rem]">
        See what’s ahead and make planning easier.
      </p>

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
        className="mx-auto mt-8 w-full max-w-[244px] shrink-0 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
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
