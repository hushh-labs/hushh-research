"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function OnboardingShell({
  currentStepIndex,
  totalSteps,
  eyebrow,
  title,
  description,
  canContinue,
  saving,
  isFirstStep,
  isLastStep,
  advisoryAccessReady,
  onBack,
  onContinue,
  children,
}: {
  currentStepIndex: number;
  totalSteps: number;
  eyebrow: string;
  title: string;
  description: string;
  canContinue: boolean;
  saving: boolean;
  isFirstStep: boolean;
  isLastStep: boolean;
  advisoryAccessReady: boolean;
  onBack: () => void;
  onContinue: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col px-4 pb-3 pt-2 sm:px-5 sm:pb-4 sm:pt-3">
      <div className="mx-auto flex w-full max-w-[43rem] flex-col">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted/60",
              isFirstStep && "invisible"
            )}
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <span className="inline-flex items-center rounded-full border border-border/60 bg-card/70 px-3 py-1 text-xs font-medium tabular-nums text-muted-foreground shadow-[0_8px_24px_rgba(15,23,42,0.06)] backdrop-blur dark:bg-card/45 dark:shadow-none">
            {currentStepIndex + 1} / {totalSteps}
          </span>
        </div>

        <div className="mt-4 flex gap-1.5">
          {Array.from({ length: totalSteps }, (_, i) => (
            <div
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                i <= currentStepIndex ? "bg-primary" : "bg-muted/40"
              )}
            />
          ))}
        </div>

        <div className="mt-6 space-y-2 sm:mt-7">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {eyebrow}
          </p>
          <h1 className="max-w-[15ch] text-[34px] font-bold leading-[1.05] tracking-normal text-foreground sm:max-w-[18ch] sm:text-[44px]">
            {title}
          </h1>
          <p className="max-w-[34rem] text-[16px] leading-[1.55] text-muted-foreground">
            {description}
          </p>
        </div>

        <div className="mt-7 sm:mt-8">{children}</div>

        <div className="pb-[calc(var(--bottom-chrome-stack-height,var(--app-screen-footer-pad))+0.75rem)] pt-7 sm:pt-8">
          <button
            type="button"
            disabled={!canContinue || saving}
            onClick={onContinue}
            className={cn(
              "inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-primary px-6 text-[17px] font-semibold text-primary-foreground shadow-[0_12px_32px_rgba(0,113,227,0.22)] transition-opacity dark:shadow-none",
              (!canContinue || saving) && "opacity-40 cursor-not-allowed"
            )}
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : isLastStep && advisoryAccessReady ? (
              <>
                Continue to Dashboard
                <ArrowRight className="h-4 w-4" />
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
