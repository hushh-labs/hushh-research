"use client";

import type { ReactNode } from "react";
import { ArrowRight, ChevronLeft, Loader2, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { RiaProgress } from "@/components/ria/ui/ria-primitives";

export function OnboardingShell({
  currentStepIndex,
  totalSteps,
  eyebrow,
  title,
  description,
  canContinue,
  saving,
  isFirstStep,
  allowInvalidPress = false,
  heroImage,
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
  // Decorative advisor photo for the step. "hero" = full-bleed image above the
  // eyebrow (Welcome); "accent" = smaller image tucked to the top-right,
  // overlapping the header (all other steps). Transparent, feather-edged PNGs
  // that blend into the canvas — purely presentational (empty alt by default).
  // `badge` renders the circular "ADVISOR" flourish over the accent photo
  // (Verification step).
  heroImage?: {
    src: string;
    variant: "hero" | "accent";
    alt?: string;
    badge?: boolean;
  };
  // When true the Continue button stays pressable even if the step gate is not
  // satisfied, so the page can run field-level validation (scroll to the first
  // missing field + inline "fill this to continue") instead of a dead, silently
  // disabled button. The page's onContinue decides whether to advance.
  allowInvalidPress?: boolean;
  // Back is handled by swipe/nav in the pinned-chrome flow; kept optional so the
  // page can still pass it without a visible back control (design has none).
  onBack?: () => void;
  onContinue: () => void;
  children: ReactNode;
}) {
  const continueDisabled = saving || (!canContinue && !allowInvalidPress);
  const isHero = heroImage?.variant === "hero";
  const isAccent = heroImage?.variant === "accent";
  return (
    <div className="mx-auto flex w-full max-w-[393px] flex-col px-6 pb-0 pt-1">
      <div className="flex w-full flex-col">
        {/* Progress + step counter share one row (design has no back arrow —
            back/forward is by swipe within the pinned chrome). */}
        <div className="flex items-center gap-[14px] pt-1">
          {!isFirstStep && onBack ? (
            <button
              type="button"
              aria-label="Go back to previous onboarding step"
              onClick={onBack}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-transform active:scale-95"
              style={{
                background: "var(--card)",
                borderColor: "var(--ria-divider-outer)",
                boxShadow: "0 4px 14px rgba(62,48,30,0.05)",
                color: "var(--ria-muted)",
              }}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
            </button>
          ) : null}
          <RiaProgress
            total={totalSteps}
            currentIndex={currentStepIndex}
            className="min-w-0 flex-1"
          />
          <span
            aria-label={`Step ${currentStepIndex + 1} of ${totalSteps}`}
            className="inline-flex h-9 items-center rounded-[18px] border px-[14px] text-[14px] font-medium tabular-nums"
            style={{
              background: "var(--card)",
              borderColor: "var(--ria-divider-outer)",
              boxShadow: "0 4px 14px rgba(62,48,30,0.05)",
              color: "var(--ria-muted)",
            }}
          >
            {currentStepIndex + 1} / {totalSteps}
          </span>
        </div>
        <span role="status" aria-atomic="true" className="sr-only">
          {`Step ${currentStepIndex + 1} of ${totalSteps}`}
        </span>

        {isHero ? (
          <div
            className="-mx-6 mt-1.5 flex items-end justify-center"
            style={{ height: "min(298px, 34dvh)" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroImage!.src}
              alt={heroImage!.alt ?? ""}
              className="w-auto max-w-none select-none object-contain"
              style={{ height: "min(302px, 34.5dvh)" }}
              draggable={false}
            />
          </div>
        ) : null}

        <div
          className={cn(
            "space-y-2",
            isHero ? "mt-0" : "mt-[30px]",
            isAccent && "relative min-h-[196px]",
          )}
        >
          {isAccent ? (
            <div
              className="pointer-events-none absolute h-[214px] select-none"
              style={{ right: "-8px", top: "-13px" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroImage!.src}
                alt={heroImage!.alt ?? ""}
                className="h-full w-auto max-w-none object-contain"
                draggable={false}
              />
              {heroImage!.badge ? (
                <span
                  className="absolute flex flex-col items-center justify-center"
                  style={{
                    right: "82px",
                    top: "76px",
                    width: "62px",
                    height: "62px",
                    borderRadius: "50%",
                    background:
                      "radial-gradient(circle at 50% 36%, #FBEFD9, #F1DDBB)",
                    border: "2px solid rgba(201,139,46,0.55)",
                    boxShadow: "0 6px 16px rgba(113,83,43,0.16)",
                  }}
                >
                  <User
                    className="h-[19px] w-[19px]"
                    strokeWidth={1.9}
                    style={{ color: "var(--ria-gold-deep)" }}
                  />
                  <span
                    style={{
                      fontSize: "7.5px",
                      fontWeight: 700,
                      letterSpacing: "0.8px",
                      color: "var(--ria-gold-deep)",
                      marginTop: "1px",
                    }}
                  >
                    ADVISOR
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}
          <p className="ria-eyebrow">{eyebrow}</p>
          <h1
            className={cn(
              "ria-screen-title",
              isHero && "ria-screen-title--hero",
              isAccent ? "max-w-[212px]" : "max-w-[18ch]"
            )}
          >
            {title}
          </h1>
          <p
            className={cn(
              "text-[16px] leading-[1.4] text-[color:var(--ria-muted)]",
              isAccent ? "max-w-[232px]" : "max-w-[34rem] text-[17px]"
            )}
          >
            {description}
          </p>
        </div>

        <div className={cn(isHero ? "mt-[22px]" : "mt-[18px]")}>{children}</div>

        <div className="pb-[var(--ria-onboarding-cta-bottom-clearance)] pt-7">
          <button
            type="button"
            disabled={continueDisabled}
            onClick={onContinue}
            className={cn(
              "ria-cta w-full text-[17px]",
              continueDisabled && "cursor-not-allowed opacity-40",
            )}
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" />
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
