"use client";

/**
 * The requester's living consent card body (contract C1 + C3).
 *
 * Public surface
 * - `ConsentCardPhaseContext`: the chat (lane C2) provides
 *   `(bundleId) => RequesterCardPhase | null`. Return "reading" while One reads
 *   what was shared and "answered" once One's reply has landed; null otherwise.
 * - `RequesterProgressBody`: props `{ progress, phase?, personName, purpose, details? }`.
 *   `details` is the reveal slot; it is dropped, never hidden, once access ends.
 * - `RequestTimeline`: the calm rail, reusable on its own.
 *
 * Motion: one subtle pulse on the current step while something is in motion,
 * `motion-safe:` only, so it is off under prefers-reduced-motion. Colour and
 * state changes use 150ms transitions.
 */
import { createContext, type ReactNode } from "react";
import { CheckCircle2, Clock, MinusCircle } from "@/components/icons";
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";
import { AccessEndedNotice } from "./access-ended-notice";
import {
  formatDay,
  formatTime,
  isAccessEnded,
  progressHeadline,
  progressMoment,
  timelineFor,
  type RequestProgress,
  type RequesterCardPhase,
  type TimelineStep,
} from "./request-progress";

export type { RequesterCardPhase } from "./request-progress";

export const ConsentCardPhaseContext = createContext<((bundleId: string) => RequesterCardPhase | null) | null>(null);

export function RequestTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol aria-label="Request progress" data-testid="request-timeline"
      className={`grid ${steps.length === 5 ? "grid-cols-5" : "grid-cols-6"}`}>
      {steps.map((step, index) => {
        const reached = step.state !== "upcoming";
        const neutral = step.tone === "neutral";
        return (
          <li key={step.key} data-step={step.key} data-state={step.state}
            aria-current={step.state === "current" ? "step" : undefined}
            className="relative flex min-w-0 flex-col items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden="true"
                className={`absolute right-1/2 top-[4px] h-px w-full transition-colors duration-150 ${
                  reached ? neutral ? "bg-muted-foreground/40" : "bg-accent-strong/60" : "bg-border"}`} />
            ) : null}
            <span aria-hidden="true" className="relative flex h-[9px] w-[9px] items-center justify-center">
              {step.state === "current" ? (
                <span data-testid="timeline-pulse"
                  className="absolute -inset-1 rounded-full bg-accent-strong/25 motion-safe:animate-pulse" />
              ) : null}
              <span className={`relative h-[9px] w-[9px] rounded-full transition-colors duration-150 ${
                step.state === "upcoming" ? "bg-border"
                  : neutral ? "bg-muted-foreground/70" : "bg-accent-strong"}`} />
            </span>
            <span className={`max-w-full truncate text-[11px] leading-4 transition-colors duration-150 ${
              step.state === "current" ? "font-medium text-foreground"
                : reached ? "text-foreground/75" : "text-muted-foreground/70"}`}>
              {step.label}
              <span className="sr-only">{step.state === "done" ? ", done" : step.state === "current" ? ", now" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Status glyphs are registry duotone glyphs in a semantic tone: what was shared
 * reads as success, what was not and when access ends read as neutral. A bare
 * grey line glyph (a plain tick, a dash) carried no tone and read as a bullet.
 */
const SHARED_GLYPH = SEMANTIC_ROLE_CLASSES.success.glyph;
const NEUTRAL_GLYPH = SEMANTIC_ROLE_CLASSES.neutral.glyph;

function LabelLine({ icon, title, labels }: { icon: ReactNode; title: string; labels: string[] }) {
  if (!labels.length) return null;
  return (
    <p className="flex items-start gap-2 text-sm leading-6">
      <span className="mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0">
        <span className="text-muted-foreground">{title} </span>
        <span className="text-foreground">{labels.join(", ")}</span>
      </span>
    </p>
  );
}

export function RequesterProgressBody({ progress, phase, personName, purpose, details }: {
  progress: RequestProgress;
  phase?: RequesterCardPhase | null;
  personName: string;
  purpose: string;
  /** Reveal controls and shared details; rendered only while access is live. */
  details?: ReactNode;
}) {
  const steps = timelineFor(progress, phase);
  const ended = isAccessEnded(progress);
  const moment = formatTime(progressMoment(progress));
  const labelsWith = (...statuses: string[]) =>
    progress.fields.filter((field) => statuses.includes(field.status)).map((field) => field.label);
  const shared = labelsWith("granted");
  const declined = labelsWith("denied");
  const endedLabels = labelsWith("granted", "revoked", "expired");
  const live = progress.outcome === "granted" || progress.outcome === "partially_granted";
  const endsOn = live ? formatDay(progress.accessEndsAt) : null;

  return (
    <div className="space-y-4" data-testid="requester-progress" data-outcome={progress.outcome} data-phase={phase ?? "none"}>
      <p className="text-sm leading-6 text-foreground">{purpose}</p>
      <RequestTimeline steps={steps} />
      {/* Once access ends, the notice below is the status; one voice, not two. */}
      {ended ? null : (
        <p role="status" className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
          <span>{progressHeadline(progress, personName, phase)}</span>
          {moment ? <span className="text-xs font-normal text-muted-foreground">{moment}</span> : null}
        </p>
      )}
      {live ? (
        <div className="space-y-1">
          {/* A full grant already names what was shared in the headline. */}
          {progress.outcome === "partially_granted" || phase ? (
            <LabelLine icon={<CheckCircle2 className={`h-4 w-4 ${SHARED_GLYPH}`} aria-hidden="true" />} title="Shared" labels={shared} />
          ) : null}
          <LabelLine icon={<MinusCircle className={`h-4 w-4 ${NEUTRAL_GLYPH}`} aria-hidden="true" />} title="Not shared" labels={declined} />
          {endsOn ? (
            <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <Clock className={`h-4 w-4 shrink-0 ${NEUTRAL_GLYPH}`} aria-hidden="true" />
              <span>Access ends {endsOn}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {progress.outcome === "denied" ? (
        <LabelLine icon={<MinusCircle className={`h-4 w-4 ${NEUTRAL_GLYPH}`} aria-hidden="true" />} title="Not shared" labels={declined.length ? declined : progress.fields.map((field) => field.label)} />
      ) : null}

      {ended ? (
        <AccessEndedNotice personName={personName}
          labels={endedLabels.length ? endedLabels : progress.fields.map((field) => field.label)}
          reason={progress.outcome === "revoked" ? "revoked" : "expired"}
          endedAt={progress.endedAt ?? progress.accessEndsAt} />
      ) : live ? details : null}
    </div>
  );
}
