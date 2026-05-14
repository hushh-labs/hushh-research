"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface Step {
  id: string;
  title: string;
  description?: string;
}

export interface ProgressStepperProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: Step[];
  currentStepIndex: number;
}

// Extracted to prevent React StrictMode render-loop bugs
function StepIndicator({ status, index }: { status: "complete" | "current" | "upcoming"; index: number }) {
  if (status === "complete") {
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
        <Check className="size-4" aria-hidden="true" />
      </div>
    );
  }
  
  if (status === "current") {
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background text-sm font-semibold text-primary shadow-sm">
        {index + 1}
      </div>
    );
  }

  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-muted bg-background text-sm font-medium text-muted-foreground">
      {index + 1}
    </div>
  );
}

/**
 * Accessible KYC Progress Stepper
 * Provides clear visual and semantic routing for multi-step onboarding flows.
 * Uses strict ordered lists and aria-current for screen reader compatibility.
 */
export function ProgressStepper({
  steps,
  currentStepIndex,
  className,
  ...props
}: ProgressStepperProps) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className={cn("w-full overflow-hidden", className)} {...props}>
      <nav aria-label="Progress">
        <ol role="list" className="flex flex-col sm:flex-row sm:items-center w-full gap-4 sm:gap-0">
          {steps.map((step, index) => {
            const isComplete = index < currentStepIndex;
            const isCurrent = index === currentStepIndex;
            const isUpcoming = index > currentStepIndex;

            const status = isComplete ? "complete" : isCurrent ? "current" : "upcoming";

            return (
              <li
                key={step.id}
                className={cn("relative flex-1", index !== steps.length - 1 && "sm:pr-8")}
                aria-current={isCurrent ? "step" : undefined}
              >
                {/* Visual Connector Line (Hidden on mobile, visible on desktop) */}
                {index !== steps.length - 1 && (
                  <div
                    className="absolute left-0 top-4 hidden w-full -translate-y-1/2 sm:block"
                    aria-hidden="true"
                  >
                    <div
                      className={cn(
                        "h-0.5 w-full transition-colors duration-300",
                        isComplete ? "bg-primary" : "bg-muted"
                      )}
                    />
                  </div>
                )}

                <div className="relative flex items-start sm:items-center gap-3">
                  <StepIndicator status={status} index={index} />
                  
                  <div className="flex flex-col">
                    {/* A11y: Explicitly announce the status to screen readers */}
                    <span className="sr-only">
                      {isComplete ? "Completed step: " : isCurrent ? "Current step: " : "Upcoming step: "}
                    </span>
                    
                    <span
                      className={cn(
                        "text-sm font-semibold tracking-tight transition-colors duration-300",
                        isUpcoming ? "text-muted-foreground" : "text-foreground"
                      )}
                    >
                      {step.title}
                    </span>
                    
                    {step.description && (
                      <span className="text-xs text-muted-foreground line-clamp-1">
                        {step.description}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}