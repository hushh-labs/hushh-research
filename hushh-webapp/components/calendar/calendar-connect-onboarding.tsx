"use client";

import type { CSSProperties } from "react";

import { AnimatedClock, AnimatedEye, AnimatedSlidersHorizontal, CalendarDays, Loader2 } from "@/components/icons";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { Button } from "@/lib/morphy-ux/button";

type CalendarConnectOnboardingProps = {
  onboarding: boolean;
  busy: boolean;
  skipping: boolean;
  onConnect: () => void;
  onSkip?: () => void;
};

/** Presentation only; CalendarAgentPage owns authorization and connection state. */
export function CalendarConnectOnboarding({
  onboarding,
  busy,
  skipping,
  onConnect,
  onSkip,
}: CalendarConnectOnboardingProps) {
  return (
    <section
      aria-labelledby="calendar-connect-title"
      className="mx-auto flex w-full max-w-md flex-col gap-5 rounded-3xl bg-card p-5 dark:bg-muted sm:p-6"
      style={{
        "--foundation-title1-size": "var(--type-page-title-size)",
        "--foundation-title1-line": "var(--type-page-title-line)",
        "--foundation-title1-weight": "var(--type-page-title-weight)",
        "--foundation-title3-size": "var(--type-row-label-size)",
        "--foundation-title3-line": "var(--type-row-label-line)",
      } as CSSProperties}
      data-calendar-connect-onboarding
    >
      <header className="flex flex-col items-center gap-2 text-center">
        <AgentSectionIcon
          id="calendar-connect"
          icon={{ kind: "lucide", icon: CalendarDays }}
          size="card"
          className="mb-1 bg-muted text-primary shadow-none ring-0 dark:bg-background"
        />
        <h1 id="calendar-connect-title" className="ui-text-page-title text-foreground">
          Google Calendar
        </h1>
        <p className="ui-text-page-subtitle text-muted-foreground text-balance">
          Plan your day with One.
        </p>
      </header>

      <ul className="flex flex-col gap-4">
        <li className="group/controls flex items-start gap-3">
          <AnimatedClock className="mt-0.5 size-5 shrink-0 text-foreground" />
          <div className="min-w-0 space-y-1">
            <h2 className="ui-text-headline text-foreground">See what’s ahead</h2>
            <p className="ui-text-page-subtitle text-muted-foreground">
              Events and free time.
            </p>
          </div>
        </li>
        <li className="group/controls flex items-start gap-3">
          <AnimatedSlidersHorizontal className="mt-0.5 size-5 shrink-0 text-foreground" surfaceClassName="fill-card dark:fill-muted" />
          <div className="min-w-0 space-y-1">
            <h2 className="ui-text-headline text-foreground">You’re in control</h2>
            <p className="ui-text-page-subtitle text-muted-foreground">
              Choose what One can do.
            </p>
          </div>
        </li>
        <li className="group/controls flex items-start gap-3">
          <AnimatedEye className="mt-0.5 size-5 shrink-0 text-foreground" surfaceClassName="fill-card dark:fill-muted" />
          <div className="min-w-0 space-y-1">
            <h2 className="ui-text-headline text-foreground">Review before confirming</h2>
            <p className="ui-text-page-subtitle text-muted-foreground">
              Approve every change.
            </p>
          </div>
        </li>
      </ul>

      <div className="flex flex-col items-center gap-3">
        <p className="ui-text-helper-text text-center text-muted-foreground">
          Private by default. Disconnect anytime.
        </p>
        <Button
          type="button"
          variant="blue-gradient"
          effect="fill"
          size="prominent"
          fullWidth
          loading={busy}
          disabled={skipping}
          onClick={onConnect}
          className="h-auto min-h-14 whitespace-normal py-3 text-center"
          data-voice-control-id="open_calendar_connector"
          data-voice-action-id={onboarding ? "setup.connect_calendar" : undefined}
          data-voice-label="Connect"
          data-voice-purpose="starts Google Calendar authorization from this Calendar agent."
        >
          {busy ? <Loader2 className="mr-2 size-4 shrink-0 animate-spin" aria-hidden /> : null}
          Connect
        </Button>
        {onboarding && onSkip ? (
          <Button
            type="button"
            variant="link"
            effect="fill"
            size="standard"
            loading={skipping}
            disabled={busy}
            onClick={onSkip}
            data-voice-control-id="skip_calendar_setup"
            data-voice-action-id="setup.skip_calendar"
            data-voice-label="Not now"
            data-voice-purpose="returns to setup without recording Calendar as complete."
          >
            {skipping ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Not now
          </Button>
        ) : null}
      </div>
    </section>
  );
}
