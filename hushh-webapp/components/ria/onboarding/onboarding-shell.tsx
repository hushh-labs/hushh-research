"use client";

import type { ReactNode } from "react";
import { ArrowRight, Loader2, User } from "lucide-react";
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
  isLastStep,
  advisoryAccessReady,
  allowInvalidPress = false,
  heroImage,
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
    <div className="flex w-full flex-col px-4 pb-3 pt-2 sm:px-5 sm:pb-4 sm:pt-3">
      <div className="mx-auto flex w-full max-w-[43rem] flex-col">
        {/* Progress + step counter share one row (design has no back arrow —
            back/forward is by swipe within the pinned chrome). */}
        <div className="flex items-center gap-[14px] pt-1">
          <RiaProgress
            total={totalSteps}
            currentIndex={currentStepIndex}
            className="flex-1"
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
          <div className="-mx-4 mt-1.5 flex h-[240px] items-end justify-center sm:-mx-5 sm:h-[298px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroImage!.src}
              alt={heroImage!.alt ?? ""}
              className="h-full w-auto max-w-none select-none object-contain"
              draggable={false}
            />
          </div>
        ) : null}

        <div className={cn("mt-6 space-y-2 sm:mt-7", isAccent && "relative min-h-[196px]")}>
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

        <div className="mt-6 sm:mt-7">{children}</div>

        <div className="pb-[calc(var(--bottom-chrome-stack-height,var(--app-screen-footer-pad))+0.75rem)] pt-7 sm:pt-8">
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
