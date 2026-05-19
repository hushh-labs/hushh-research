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
    <div className="flex min-h-dvh flex-col px-5 py-6">
      <div className="mx-auto w-full max-w-lg flex-1 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-muted/60",
              isFirstStep && "invisible"
            )}
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5 text-foreground" />
          </button>

          <span className="inline-flex items-center rounded-full border border-border/50 bg-muted/30 px-3 py-1 text-xs font-medium tabular-nums text-muted-foreground">
            {currentStepIndex + 1} / {totalSteps}
          </span>
        </div>

        <div className="mt-5 flex gap-1.5">
          {Array.from({ length: totalSteps }, (_, i) => (
            <div
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                i <= currentStepIndex ? "bg-[#0071E3]" : "bg-muted/30"
              )}
            />
          ))}
        </div>

        <div className="mt-8 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#0071E3]">
            {eyebrow}
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>

        <div className="mt-8 flex-1">{children}</div>

        <div className="pb-6 pt-8">
          <button
            type="button"
            disabled={!canContinue || saving}
            onClick={onContinue}
            className={cn(
              "inline-flex w-full min-h-[52px] items-center justify-center gap-2 rounded-full bg-[#0071E3] px-6 text-[15px] font-semibold text-white transition-opacity",
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
