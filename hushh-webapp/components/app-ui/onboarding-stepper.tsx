"use client";

import { useEffect, useRef, useState } from "react";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/**
 * OnboardingStepper — the accessible, reusable step indicator for guided flows.
 *
 * WHY THIS EXISTS
 * The repo had no dedicated accessible stepper: the Kai wizard's "Step X of Y"
 * was a plain `<span>` (no `aria-current`, no live region) so screen readers
 * never heard step changes, and `StepProgressBar` is a page-LOAD bar (announces
 * "Page loaded.") — wrong semantics for a wizard.
 *
 * ACCESSIBILITY CONTRACT
 * - Steps render as an ordered list (`<ol>`); the active step carries
 *   `aria-current="step"`.
 * - A dedicated `role="status" aria-atomic` sr-only region announces the active
 *   step's position and label on every change.
 * - The progress bar carries `aria-valuetext` (e.g. "Step 2 of 4").
 * - The dot rail is decorative (`aria-hidden`) — the `<ol>` + live region are
 *   the source of truth for assistive tech, so dots never duplicate
 *   announcements.
 *
 * SCREEN-FIT
 * This lives in the FIXED (non-scrolling) header of a flow. It is intentionally
 * compact (~28px) and never owns the scroll container.
 */
export interface OnboardingStep {
  /** Stable id for the step. */
  id: string;
  /** Short, plain-language label announced to assistive tech. */
  label: string;
}

export interface OnboardingStepperProps {
  steps: readonly OnboardingStep[];
  /** Zero-based index of the active step. */
  currentIndex: number;
  /** Accessible name for the stepper region. Default "Setup steps". */
  ariaLabel?: string;
  /** Show the visible "Step X of Y" text + percentage. Default true. */
  showLabel?: boolean;
  className?: string;
}

export function OnboardingStepper({
  steps,
  currentIndex,
  ariaLabel = "Setup steps",
  showLabel = true,
  className,
}: OnboardingStepperProps) {
  const total = steps.length;
  const safeIndex = Math.min(Math.max(currentIndex, 0), Math.max(total - 1, 0));
  const human = total > 0 ? safeIndex + 1 : 0;
  const activeStep = steps[safeIndex];
  const progressValue = total > 1 ? Math.round((safeIndex / (total - 1)) * 100) : 100;
  const valueText =
    total > 0
      ? `Step ${human} of ${total}${activeStep ? `: ${activeStep.label}` : ""}`
      : "";

  // Announce step changes via a dedicated live region. We mirror the message
  // into local state on change so screen readers reliably re-announce.
  const [announcement, setAnnouncement] = useState("");
  const lastIndexRef = useRef<number>(-1);
  useEffect(() => {
    if (total === 0) return;
    if (lastIndexRef.current === safeIndex) return;
    lastIndexRef.current = safeIndex;
    setAnnouncement(valueText);
  }, [safeIndex, total, valueText]);

  if (total === 0) return null;

  return (
    <nav aria-label={ariaLabel} className={cn("space-y-1.5", className)}>
      <span role="status" aria-atomic="true" className="sr-only">
        {announcement}
      </span>

      {showLabel ? (
        <div className="flex items-center justify-between text-[13px] text-muted-foreground">
          <span className="font-medium tracking-normal">
            Step {human} of {total}
          </span>
          <span className="text-[12px] font-medium tabular-nums text-muted-foreground">
            {progressValue}%
          </span>
        </div>
      ) : null}

      {/* Source of truth for assistive tech. Visually it is just the dot rail. */}
      <ol className="flex items-center gap-1.5" aria-label={ariaLabel}>
        {steps.map((step, index) => {
          const isActive = index === safeIndex;
          const isComplete = index < safeIndex;
          return (
            <li
              key={step.id}
              aria-current={isActive ? "step" : undefined}
              className="flex-1"
            >
              <span className="sr-only">
                {step.label}
                {isComplete ? " (completed)" : isActive ? " (current)" : ""}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "block h-1 rounded-full transition-colors duration-200",
                  isActive || isComplete
                    ? "bg-foreground/70"
                    : "bg-foreground/15",
                )}
              />
            </li>
          );
        })}
      </ol>

      <Progress
        value={progressValue}
        aria-label={ariaLabel}
        aria-valuetext={valueText}
        className="sr-only"
      />
    </nav>
  );
}
