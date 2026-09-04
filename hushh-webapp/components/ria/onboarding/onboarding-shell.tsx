"use client";

import type { ReactNode } from "react";
import { ChevronLeft, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { Button } from "@/lib/morphy-ux/button";

export function OnboardingShell({
  currentStepIndex,
  totalSteps,
  eyebrow,
  title,
  description,
  canContinue,
  saving,
  isFirstStep,
  advisoryAccessReady = false,
  hideTerminal = false,
  allowInvalidPress = false,
  heroImage,
  onBack,
  onContinue,
  onSkip,
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
  hideTerminal?: boolean;
  // Decorative advisor photo for the step. "accent" is the shared compact
  // top-right composition used by every current RIA setup step. "hero" stays
  // available for a future full-bleed flow, but is not a special Welcome case.
  // Images are purely presentational (empty alt by default).
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
  onSkip?: () => void | Promise<void>;
  children: ReactNode;
}) {
  const continueDisabled = saving || (!canContinue && !allowInvalidPress);
  const isHero = heroImage?.variant === "hero";
  const isAccent = heroImage?.variant === "accent";
  useScrollReset(currentStepIndex, { enabled: true });
  return (
    <div className="mx-auto flex w-full max-w-[54rem] flex-col px-6 pb-[calc(var(--app-bottom-inset)+6rem)]">
      <div className="flex w-full flex-col">
        {/* Progress + step counter share one row (design has no back arrow —
            back/forward is by swipe within the pinned chrome). */}

      {/* Hide the progress bar step indicator if the user has already finished RIA onboarding previously */}
      {!advisoryAccessReady && (
        <div className="flex w-full items-center min-h-[3.5rem] mb-2 sm:mb-6 gap-4">
          <div className="flex items-center justify-center h-10 w-10 shrink-0">
            {!isFirstStep && onBack ? (
              <button
                type="button"
                aria-label="Go back to previous step"
                onClick={onBack}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted/20 text-muted-foreground transition-all hover:bg-muted/40 active:scale-95"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={2} />
              </button>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-1.5" aria-hidden="true">
            {Array.from({ length: totalSteps }, (_, i) => {
              const isDone = i < currentStepIndex;
              const isCurrent = i === currentStepIndex;
              return (
                <div
                  key={i}
                  className={cn(
                    "h-1.5 flex-1 rounded-full transition-colors",
                    isDone ? "bg-[color:var(--app-accent)]" :
                    isCurrent ? "bg-[color:var(--app-accent)] opacity-60" :
                    "bg-muted/40"
                  )}
                />
              );
            })}
          </div>

          <span
            aria-label={`Step ${currentStepIndex + 1} of ${totalSteps}`}
            className="flex h-7 items-center justify-center rounded-full bg-muted/20 px-3 text-[13px] font-medium tabular-nums tracking-wide text-muted-foreground"
          >
            {currentStepIndex + 1} / {totalSteps}
          </span>
        </div>
      )}

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
          <p className="ui-text-section-label mb-2 block px-[6px]">{eyebrow}</p>
          <h1
            className={cn(
              "ria-screen-title",
              isHero && "ria-screen-title--hero",
              isAccent ? "max-w-[212px]" : "max-w-[18ch]", "text-3xl font-bold tracking-tight text-foreground sm:text-4xl"
            )}
          >
            {title}
          </h1>
          <p
            className={cn(
              "text-[16px] leading-[1.5] text-muted-foreground",
              isAccent ? "max-w-[232px]" : "max-w-[34rem] text-[17px]"
            )}
          >
            {description}
          </p>
        </div>

        <div className={cn(isHero ? "mt-[22px]" : "mt-[18px]")}>{children}</div>

        {!hideTerminal ? (
          <div className="mt-8 space-y-1 pb-[calc(var(--app-bottom-inset)+6rem)]">
            <div className="mx-auto w-full sm:max-w-[22rem]">
              <Button
                type="button"
                onClick={onContinue}
                loading={saving}
                disabled={continueDisabled}
                variant="blue-gradient"
                effect="fill"
                size="lg"
                fullWidth
                className="h-12 text-base"
                data-voice-control-id="ria-onboarding-continue"
                data-voice-label="Continue"
                data-voice-purpose="Advance to the next RIA setup step"
              >
                Continue
              </Button>
            </div>
            {onSkip ? (
              <button
                type="button"
                className="mx-auto block min-h-11 px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
                onClick={() => void onSkip()}
              >
                Skip for now
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
