"use client";

import { useMemo, useState } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { RadioGroup } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import type {
  DrawdownResponse,
  HorizonAnchorChoice,
  InvestmentHorizon,
  VolatilityPreference,
} from "@/lib/services/kai-profile-service";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type WizardAnswers = {
  investment_horizon: InvestmentHorizon | null;
  drawdown_response: DrawdownResponse | null;
  volatility_preference: VolatilityPreference | null;
};

type WizardCompletePayload = WizardAnswers & {
  horizonAnchorChoice?: HorizonAnchorChoice;
};

const QUESTIONS = [
  {
    id: "investment_horizon" as const,
    prompt: "How long do you expect to keep\nthis money invested?",
    options: [
      { value: "short_term" as const, label: "Less than 3 years" },
      { value: "medium_term" as const, label: "3–7 years" },
      { value: "long_term" as const, label: "More than 7 years" },
    ],
  },
  {
    id: "drawdown_response" as const,
    prompt: "If your portfolio drops 20%, what\nwould you most likely do?",
    options: [
      { value: "reduce" as const, label: "Reduce investments to limit further losses" },
      { value: "stay" as const, label: "Stay invested and review the situation" },
      { value: "buy_more" as const, label: "Invest more at lower prices" },
    ],
  },
  {
    id: "volatility_preference" as const,
    prompt: "Which feels more comfortable to\nyou?",
    options: [
      { value: "small" as const, label: "Smaller, steadier returns" },
      { value: "moderate" as const, label: "Moderate ups and downs for better returns" },
      { value: "large" as const, label: "Larger swings for higher potential returns" },
    ],
  },
] as const;

export function KaiPreferencesWizard(props: {
  mode: "onboarding" | "edit";
  layout?: "page" | "sheet";
  isSubmitting?: boolean;
  initialStep?: number;
  initialAnswers?: Partial<WizardAnswers>;
  onAnswersChange?: (answers: WizardAnswers) => void | Promise<void>;
  onBack?: () => void;
  onSkip?: () => void;
  onComplete: (payload: WizardCompletePayload) => void | Promise<void>;
}) {
  const total = QUESTIONS.length;
  const layout = props.layout ?? "page";
  const [step, setStep] = useState(() => {
    const initial = props.initialStep ?? 0;
    return Math.min(Math.max(initial, 0), total - 1);
  });
  const [answers, setAnswers] = useState<WizardAnswers>({
    investment_horizon: props.initialAnswers?.investment_horizon ?? null,
    drawdown_response: props.initialAnswers?.drawdown_response ?? null,
    volatility_preference: props.initialAnswers?.volatility_preference ?? null,
  });

  const [pendingHorizon, setPendingHorizon] = useState<InvestmentHorizon | null>(null);
  const [horizonDialogOpen, setHorizonDialogOpen] = useState(false);
  const [horizonAnchorChoice, setHorizonAnchorChoice] = useState<HorizonAnchorChoice>("from_now");

  const answeredCount = useMemo(() => {
    return QUESTIONS.reduce((count, question) => {
      return answers[question.id] ? count + 1 : count;
    }, 0);
  }, [answers]);

  const progressValue = useMemo(() => {
    return Math.round((answeredCount / total) * 100);
  }, [answeredCount, total]);
  const currentStep = step + 1;

  const isLast = step === total - 1;

  const activeQuestion = QUESTIONS[step]!;
  const activeValue = answers[activeQuestion.id];
  const isSubmitting = props.isSubmitting === true;

  const canContinue = Boolean(activeValue);

  function setAnswer<K extends keyof WizardAnswers>(key: K, value: WizardAnswers[K]) {
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
      void props.onAnswersChange?.(next);
      return next;
    });
  }

  function handleSelect(value: string) {
    if (activeQuestion.id !== "investment_horizon") {
      if (activeQuestion.id === "drawdown_response") {
        setAnswer("drawdown_response", value as DrawdownResponse);
      } else {
        setAnswer("volatility_preference", value as VolatilityPreference);
      }
      return;
    }

    const next = value as InvestmentHorizon;
    if (props.mode !== "edit") {
      setAnswer("investment_horizon", next);
      return;
    }

    const prev = answers.investment_horizon;
    if (!prev || prev === next) {
      setAnswer("investment_horizon", next);
      return;
    }

    // Edit semantics: anchor prompt on horizon changes.
    setPendingHorizon(next);
    setHorizonAnchorChoice("from_now");
    setHorizonDialogOpen(true);
  }

  async function handlePrimary() {
    if (!canContinue || isSubmitting) return;
    if (!isLast) {
      setStep((s) => Math.min(total - 1, s + 1));
      return;
    }

    await Promise.resolve(
      props.onComplete({
        ...answers,
        horizonAnchorChoice: props.mode === "edit" ? horizonAnchorChoice : undefined,
      })
    );
  }

  const primaryLabel =
    props.mode === "edit"
      ? isLast
        ? "Save changes"
        : "Next"
      : isLast
      ? "Continue"
      : "Next";

  const reserveBackSlot = props.mode === "onboarding";
  const showBack = props.mode === "onboarding" && step > 0;
  const canGoPrevious = step > 0;
  const isPageLayout = layout === "page";

  function handleBack() {
    if (isSubmitting) return;
    if (canGoPrevious) {
      setStep((s) => Math.max(0, s - 1));
      return;
    }

    props.onBack?.();
  }

  return (
    <main
      data-top-content-anchor={isPageLayout ? "true" : undefined}
      className={cn(
        "w-full bg-transparent flex flex-col",
        isPageLayout
          ? "min-h-[100dvh] px-5 pt-[var(--top-content-pad)] pb-[var(--app-screen-footer-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
          : "min-h-0 px-4 pt-4 pb-4"
      )}
    >
      <div
        className={cn(
          isPageLayout
            ? "mx-auto flex min-h-[calc(100dvh-var(--top-content-pad)-var(--app-screen-footer-pad))] w-full max-w-md flex-col sm:max-w-2xl lg:max-w-5xl xl:max-w-6xl"
            : "w-full max-w-sm mx-auto flex min-h-[calc(100dvh-var(--app-screen-footer-pad))] flex-col",
          !isPageLayout && "min-h-0"
        )}
      >
        <div className={cn("space-y-2", isPageLayout ? "pt-2 lg:pt-0" : "pt-1")}>
          {reserveBackSlot && (
            <div className="flex justify-start">
              <Button
                type="button"
                variant="link"
                effect="fade"
                size="sm"
                onClick={handleBack}
                disabled={isSubmitting}
                className={cn(
                  "h-auto p-0",
                  !showBack && "invisible pointer-events-none"
                )}
                showRipple={false}
                aria-hidden={!showBack}
                tabIndex={showBack ? 0 : -1}
              >
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">
              Step {currentStep} of {total}
            </span>
            <span className="tabular-nums">{progressValue}%</span>
          </div>
          <Progress value={progressValue} className="h-1 rounded-full bg-muted" />
        </div>

        <div
          className={cn(
            isPageLayout
              ? "grid flex-1 gap-6 pt-7 sm:gap-8 sm:pt-9 lg:grid-cols-[minmax(0,0.95fr)_minmax(24rem,0.85fr)] lg:items-start lg:gap-12 lg:pt-12 xl:gap-16"
              : "contents"
          )}
        >
          <div
            className={cn(
              isPageLayout
                ? "space-y-4 lg:pt-6"
                : "pt-6 space-y-3"
            )}
          >
            <p
              className={cn(
                "text-muted-foreground leading-relaxed",
                isPageLayout ? "text-sm sm:text-base lg:text-lg" : "text-xs"
              )}
            >
              There are no right or wrong answers.
              <br />
              Help us tailor your investment plan.
            </p>

            <p
              role="heading"
              aria-level={1}
              className={cn(
                "whitespace-pre-line tracking-tight text-balance",
                isPageLayout
                  ? "text-[clamp(2rem,4.2vw,4rem)] font-bold leading-[1.06]"
                  : "text-[clamp(0.95rem,2.8vw,1.2rem)] leading-[1.3] font-semibold"
              )}
            >
              {activeQuestion.prompt}
            </p>
          </div>

          <div
            className={cn(
              "min-w-0",
              isPageLayout ? "flex flex-col gap-5 lg:gap-6" : "flex flex-1 flex-col pt-5"
            )}
          >
            <RadioGroup
              value={activeValue ?? ""}
              onValueChange={handleSelect}
              className={cn(isPageLayout ? "gap-3 sm:gap-4" : "gap-3")}
            >
              {activeQuestion.options.map((opt) => (
                <RadioCardItem key={opt.value} value={opt.value} label={opt.label} />
              ))}
            </RadioGroup>

            <div className={cn("space-y-4", isPageLayout ? "pt-1" : "mt-auto pt-6")}>
              <Button
                type="button"
                size="lg"
                fullWidth
                onClick={handlePrimary}
                disabled={!canContinue || isSubmitting}
                loading={isSubmitting}
                showRipple
              >
                {isSubmitting ? "Saving..." : primaryLabel}
                {!isSubmitting && <ArrowRight className="ml-2 h-5 w-5" />}
              </Button>

              {props.mode === "onboarding" && props.onSkip && (
                <Button
                  type="button"
                  variant="blue-gradient"
                  effect="fade"
                  size="lg"
                  fullWidth
                  onClick={props.onSkip}
                  disabled={isSubmitting}
                  loading={isSubmitting}
                  showRipple={false}
                >
                  {isSubmitting ? "Saving..." : "Skip"}
                  {!isSubmitting && <ArrowRight className="ml-2 h-5 w-5" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={horizonDialogOpen} onOpenChange={setHorizonDialogOpen}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Update horizon anchor?</AlertDialogTitle>
            <AlertDialogDescription>
              You previously set your time horizon. Should this change apply starting now,
              or keep the original start date for reports?
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="grid gap-2 pt-2">
            <Button
              type="button"
              variant="none"
              effect="fill"
              size="sm"
              fullWidth
              className={cn(
                "h-auto justify-start rounded-xl border p-3 text-left transition-colors",
                horizonAnchorChoice === "from_now"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-50)]/40"
                  : "border-border hover:bg-muted/40"
              )}
              onClick={() => setHorizonAnchorChoice("from_now")}
              showRipple={false}
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold">Apply from now (default)</p>
                <p className="text-xs text-muted-foreground">
                  Updates anchor date to today.
                </p>
              </div>
            </Button>

            <Button
              type="button"
              variant="none"
              effect="fill"
              size="sm"
              fullWidth
              className={cn(
                "h-auto justify-start rounded-xl border p-3 text-left transition-colors",
                horizonAnchorChoice === "keep_original"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-50)]/40"
                  : "border-border hover:bg-muted/40"
              )}
              onClick={() => setHorizonAnchorChoice("keep_original")}
              showRipple={false}
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold">Keep original start date</p>
                <p className="text-xs text-muted-foreground">
                  Preserves the previous anchor for continuity.
                </p>
              </div>
            </Button>
          </div>

          <AlertDialogFooter className="pt-2">
            <AlertDialogCancel onClick={() => setPendingHorizon(null)}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="blue-gradient"
              effect="fill"
              size="sm"
              className="rounded-xl"
              onClick={() => {
                if (pendingHorizon) {
                  setAnswer("investment_horizon", pendingHorizon);
                }
                setPendingHorizon(null);
                setHorizonDialogOpen(false);
              }}
              showRipple
            >
              Apply
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function RadioCardItem(props: { value: string; label: string }) {
  return (
    <RadioGroupPrimitive.Item
      value={props.value}
      className={cn(
        "w-full rounded-2xl border p-4 text-left transition-colors sm:p-5 lg:p-6",
        "focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/40",
        "data-[state=checked]:border-[var(--brand-primary)] data-[state=checked]:bg-[var(--brand-50)]/30",
        "hover:bg-muted/40"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold leading-snug sm:text-base lg:text-lg">
          {props.label}
        </p>
        <div
          className={cn(
            "h-5 w-5 rounded-full border grid place-items-center",
            "border-muted-foreground/30"
          )}
        >
          <RadioGroupPrimitive.Indicator className="h-2.5 w-2.5 rounded-full bg-[var(--brand-primary)]" />
        </div>
      </div>
    </RadioGroupPrimitive.Item>
  );
}
