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
import {
  kaiAppDisplayTitleClassName,
  kaiAppSectionTitleClassName,
} from "@/components/kai/shared/kai-typography";

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
    prompt: "How long do you expect to keep this money invested?",
    options: [
      { value: "short_term" as const, label: "Less than 3 years" },
      { value: "medium_term" as const, label: "3–7 years" },
      { value: "long_term" as const, label: "More than 7 years" },
    ],
  },
  {
    id: "drawdown_response" as const,
    prompt: "If your portfolio drops 20%, what would you most likely do?",
    options: [
      { value: "reduce" as const, label: "Reduce investments to limit further losses" },
      { value: "stay" as const, label: "Stay invested and review the situation" },
      { value: "buy_more" as const, label: "Invest more at lower prices" },
    ],
  },
  {
    id: "volatility_preference" as const,
    prompt: "Which feels more comfortable to you?",
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

  const progressValue = useMemo(() => {
    return Math.round((step / total) * 100);
  }, [step, total]);
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
            ? "mx-auto flex min-h-[calc(100dvh-var(--top-content-pad)-var(--app-screen-footer-pad))] w-full max-w-[44rem] flex-col justify-center"
            : "w-full max-w-sm mx-auto flex min-h-[calc(100dvh-var(--app-screen-footer-pad))] flex-col",
          !isPageLayout && "min-h-0"
        )}
      >
        <div
          className={cn(
            isPageLayout
              ? "rounded-[32px] border border-black/[0.06] bg-white/[0.72] p-5 shadow-[0_24px_80px_-56px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:p-7 lg:p-8 dark:border-white/10 dark:bg-white/[0.07]"
              : "contents"
          )}
        >
          <div className={cn("space-y-2.5", isPageLayout ? "" : "pt-1")}>
            <div className="flex min-h-8 items-center justify-between gap-3">
              {reserveBackSlot ? (
                <Button
                  type="button"
                  variant="link"
                  effect="fade"
                  size="sm"
                  onClick={handleBack}
                  disabled={isSubmitting}
                  className={cn(
                    "h-8 rounded-full px-2.5 text-[14px] font-medium text-primary hover:bg-primary/10",
                    !showBack && "invisible pointer-events-none"
                  )}
                  showRipple={false}
                  aria-hidden={!showBack}
                  tabIndex={showBack ? 0 : -1}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
              ) : (
                <span />
              )}
              <span className="rounded-full bg-black/[0.035] px-3 py-1 text-[12px] font-medium tabular-nums text-muted-foreground dark:bg-white/10">
                {progressValue}%
              </span>
            </div>

            <div className="flex items-center justify-between text-[13px] text-muted-foreground">
              <span className="font-medium tracking-normal">
                Step {currentStep} of {total}
              </span>
            </div>
            <Progress
              value={progressValue}
              className="h-1 rounded-full bg-black/[0.045] dark:bg-white/10"
            />
          </div>

          <div
            className={cn(
              isPageLayout
                ? "mx-auto flex w-full max-w-[35rem] flex-col pt-8 sm:pt-10"
                : "flex flex-1 flex-col pt-5"
            )}
          >
            <div className={cn(isPageLayout ? "space-y-4 text-center" : "space-y-3")}>
              <p
                className={cn(
                  "text-muted-foreground leading-relaxed",
                  isPageLayout ? "text-[15px] sm:text-[16px]" : "text-xs"
                )}
              >
                No right or wrong answers. We’ll tune Kai to your investing style.
              </p>

              <div
                role="heading"
                aria-level={1}
                className={cn(
                  "tracking-normal text-balance text-foreground",
                  isPageLayout
                    ? kaiAppDisplayTitleClassName
                    : kaiAppSectionTitleClassName
                )}
              >
                {activeQuestion.prompt}
              </div>
            </div>

            <RadioGroup
              value={activeValue ?? ""}
              onValueChange={handleSelect}
              className={cn(isPageLayout ? "mt-8 gap-2.5 sm:mt-9" : "gap-3")}
            >
              {activeQuestion.options.map((opt) => (
                <RadioCardItem key={opt.value} value={opt.value} label={opt.label} />
              ))}
            </RadioGroup>

            <div className={cn("space-y-3.5", isPageLayout ? "pt-6" : "mt-auto pt-6")}>
              <Button
                type="button"
                variant="none"
                effect="fill"
                size="lg"
                fullWidth
                onClick={handlePrimary}
                disabled={!canContinue || isSubmitting}
                loading={isSubmitting}
                showRipple
                className={cn(
                  "h-11 rounded-full text-[15px] font-semibold shadow-[0_16px_34px_-24px_rgba(0,113,227,0.85)]",
                  canContinue
                    ? "!bg-primary !text-primary-foreground hover:!bg-primary/90"
                    : "!bg-muted !text-muted-foreground shadow-none"
                )}
              >
                {isSubmitting ? "Saving..." : primaryLabel}
                {!isSubmitting && <ArrowRight className="ml-2 h-5 w-5" />}
              </Button>

              {props.mode === "onboarding" && props.onSkip && (
                <Button
                  type="button"
                  variant="none"
                  effect="fill"
                  size="lg"
                  fullWidth
                  onClick={props.onSkip}
                  disabled={isSubmitting}
                  loading={isSubmitting}
                  showRipple
                  className="h-11 rounded-full !bg-primary/10 text-[15px] font-semibold !text-primary shadow-none hover:!bg-primary/15 dark:!bg-primary/15"
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
        "group w-full rounded-[18px] border px-4 py-3.5 text-left transition-[background-color,border-color,box-shadow,transform] sm:px-5",
        "min-h-[58px] focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/35",
        "border-black/[0.08] bg-white/68 shadow-[0_10px_30px_-28px_rgba(0,0,0,0.5)] backdrop-blur-xl",
        "hover:-translate-y-0.5 hover:bg-white/86 hover:shadow-[0_16px_38px_-32px_rgba(0,0,0,0.55)]",
        "data-[state=checked]:border-primary/55 data-[state=checked]:bg-primary/[0.08] data-[state=checked]:shadow-[0_16px_38px_-32px_rgba(0,113,227,0.7)]",
        "dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.09] dark:data-[state=checked]:bg-primary/15"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-medium leading-snug text-foreground sm:text-[16px]">
          {props.label}
        </p>
        <div
          aria-hidden="true"
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
            "border-muted-foreground/28 bg-background/60",
            "group-data-[state=checked]:border-primary"
          )}
        >
          <RadioGroupPrimitive.Indicator className="h-2.5 w-2.5 rounded-full bg-primary" />
        </div>
      </div>
    </RadioGroupPrimitive.Item>
  );
}
