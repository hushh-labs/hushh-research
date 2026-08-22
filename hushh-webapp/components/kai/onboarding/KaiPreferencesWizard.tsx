"use client";

import { useState, type ReactNode } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ArrowLeft, Check } from "lucide-react";

import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { RadioGroup } from "@/components/ui/radio-group";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import {
  useLocalOnboardingActionHandler,
  type LocalOnboardingActionResult,
} from "@/lib/agent/local-onboarding-actions";
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
import { kaiAppSectionTitleClassName } from "@/components/kai/shared/kai-typography";

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
    prompt: "How long will this stay invested?",
    options: [
      { value: "short_term" as const, label: "Less than 3 years" },
      { value: "medium_term" as const, label: "3–7 years" },
      { value: "long_term" as const, label: "More than 7 years" },
    ],
  },
  {
    id: "drawdown_response" as const,
    prompt: "Portfolio down 20%, what's your move?",
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
  onComplete: (payload: WizardCompletePayload) => void | Promise<void>;
  /**
   * Route-owned terminal actions (for example, Skip Finance setup). Keeping
   * this inside the wizard's bounded viewport prevents a sibling footer from
   * extending a fullscreen flow underneath persistent onboarding chrome.
   */
  terminalFooter?: ReactNode;
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

  // Voice parity: answering a question by voice sets the same answer state as
  // tapping its radio option, then advances exactly like tapping the
  // Next/Continue button would (or completes the wizard on the last
  // question). If voice answers a question other than the one on screen, we
  // jump there first rather than silently skipping ahead.
  async function answerQuestionByVoice<K extends keyof WizardAnswers>(
    questionId: K,
    value: WizardAnswers[K]
  ): Promise<LocalOnboardingActionResult> {
    const questionIndex = QUESTIONS.findIndex((q) => q.id === questionId);
    if (questionIndex === -1) {
      return { status: "failed", summary: "Unknown wizard question." };
    }
    if (questionIndex !== step) {
      setStep(questionIndex);
      setAnswer(questionId, value);
      return {
        status: "succeeded",
        summary: `Recorded ${String(questionId).replaceAll("_", " ")}.`,
      };
    }

    setAnswer(questionId, value);
    if (questionIndex === total - 1) {
      const nextAnswers: WizardAnswers = { ...answers, [questionId]: value };
      await Promise.resolve(
        props.onComplete({
          ...nextAnswers,
          horizonAnchorChoice: props.mode === "edit" ? horizonAnchorChoice : undefined,
        })
      );
      return { status: "succeeded", summary: "Preferences saved." };
    }
    setStep((s) => Math.min(total - 1, s + 1));
    return { status: "succeeded", summary: "Moving to the next question." };
  }

  useLocalOnboardingActionHandler("kai.setup.answer_horizon", async (slots) => {
    const value = String(slots.answer ?? "").trim();
    if (value !== "short_term" && value !== "medium_term" && value !== "long_term") {
      return { status: "blocked", summary: "That's not one of the horizon options." };
    }
    return answerQuestionByVoice("investment_horizon", value as InvestmentHorizon);
  });

  useLocalOnboardingActionHandler("kai.setup.answer_drawdown", async (slots) => {
    const value = String(slots.answer ?? "").trim();
    if (value !== "reduce" && value !== "stay" && value !== "buy_more") {
      return { status: "blocked", summary: "That's not one of the drawdown options." };
    }
    return answerQuestionByVoice("drawdown_response", value as DrawdownResponse);
  });

  useLocalOnboardingActionHandler("kai.setup.answer_volatility", async (slots) => {
    const value = String(slots.answer ?? "").trim();
    if (value !== "small" && value !== "moderate" && value !== "large") {
      return { status: "blocked", summary: "That's not one of the volatility options." };
    }
    return answerQuestionByVoice("volatility_preference", value as VolatilityPreference);
  });

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
  // In onboarding, step 0 relies on the shared route-level TopAppBar back
  // chevron to leave the flow entirely (this wizard is rendered under a
  // "flow" layout route, which keeps that chrome visible) — showing a
  // second "Back" pill here for step 0 would be a redundant, visually
  // duplicate affordance for the exact same action. From step 1 onward the
  // wizard's own Back pill is the only way to walk back through the
  // questions (the TopAppBar cannot do that), so it stays visible there.
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
          ? "min-h-[calc(100dvh-var(--app-scroll-bottom-pad,0px))] px-5 pt-[var(--top-content-pad)] pb-[var(--app-scroll-bottom-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
          : "min-h-0 px-4 pt-4 pb-4"
      )}
    >
      <div
        className={cn(
          isPageLayout
            ? "mx-auto flex min-h-[calc(100dvh-var(--top-content-pad)-var(--app-scroll-bottom-pad,0px))] w-full max-w-[25rem] flex-1 flex-col py-6"
            : "w-full max-w-sm mx-auto flex min-h-[calc(100dvh-var(--app-screen-footer-pad))] flex-col",
          !isPageLayout && "min-h-0"
        )}
      >
        <div
          className={cn(
            isPageLayout
              ? "flex w-full flex-1 flex-col justify-center"
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
              <span className="type-footnote tabular-nums text-muted-foreground">
                Step {step + 1} of {total}
              </span>
            </div>

            <OnboardingStepper
              steps={QUESTIONS.map((q) => ({ id: q.id, label: q.prompt }))}
              currentIndex={step}
              showLabel={false}
              ariaLabel="Investment preferences setup"
            />
          </div>

          <div
            className={cn(
              isPageLayout
                ? "mx-auto flex w-full flex-col pt-8 sm:pt-9"
                : "flex flex-1 flex-col pt-5"
            )}
          >
            <div className={cn(isPageLayout ? "space-y-2 text-left" : "space-y-2")}>
              <p
                className={cn(
                  "text-muted-foreground",
                  isPageLayout ? "type-subhead" : "type-footnote"
                )}
              >
                We’ll tune Kai to you.
              </p>

              <div
                role="heading"
                aria-level={1}
                className={cn(
                  "text-balance text-foreground",
                  isPageLayout ? "type-title1" : kaiAppSectionTitleClassName
                )}
              >
                {activeQuestion.prompt}
              </div>
            </div>

            <RadioGroup
              value={activeValue ?? ""}
              onValueChange={handleSelect}
              className={cn(isPageLayout ? "mt-8 sm:mt-9" : "mt-6")}
            >
              <SettingsGroup testId="kai-wizard-options">
                {activeQuestion.options.map((opt) => (
                  <RadioOptionRow key={opt.value} value={opt.value} label={opt.label} />
                ))}
              </SettingsGroup>
            </RadioGroup>

            <div className={cn("space-y-3", isPageLayout ? "pt-8" : "mt-auto pt-6")}>
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
                  "h-12 rounded-full type-headline",
                  "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
                  "active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100",
                  canContinue
                    ? "!bg-primary !text-primary-foreground hover:!bg-primary/90"
                    : "!bg-muted !text-muted-foreground"
                )}
              >
                {isSubmitting ? "Saving..." : primaryLabel}
              </Button>
            </div>
          </div>
        </div>
        {isPageLayout && props.terminalFooter ? (
          <div className="w-full shrink-0">{props.terminalFooter}</div>
        ) : null}
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

function RadioOptionRow(props: { value: string; label: string }) {
  return (
    <SettingsRow
      asChild
      title={props.label}
      trailing={
        <Check
          aria-hidden="true"
          strokeWidth={2.5}
          className={cn(
            "h-[18px] w-[18px] shrink-0 text-accent-strong",
            "opacity-0 motion-safe:scale-90",
            "transition-[opacity,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] motion-reduce:transition-none",
            "group-data-[state=checked]/opt:opacity-100 group-data-[state=checked]/opt:scale-100"
          )}
        />
      }
    >
      <RadioGroupPrimitive.Item
        value={props.value}
        className={cn(
          "group/opt",
          "[&]:focus-visible:ring-2 [&]:focus-visible:ring-ring [&]:focus-visible:ring-inset",
          "transition-[background-color] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] motion-reduce:transition-none",
          "data-[state=checked]:bg-accent-surface"
        )}
      />
    </SettingsRow>
  );
}
