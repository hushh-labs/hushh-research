"use client";

import { type ReactNode } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ArrowLeftIcon as ArrowLeft, CheckIcon as Check } from "@/components/icons";

import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { RadioGroup } from "@/components/ui/radio-group";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import { useKaiPreferencesWizard, type KaiPreferencesWizardModel, type WizardAnswers, type WizardCompletePayload } from "./use-kai-preferences-wizard";
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

export function KaiPreferencesWizard(props: {
  mode: "onboarding" | "edit";
  controller?: KaiPreferencesWizardModel;
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
  const owned = useKaiPreferencesWizard({ ...props, enabled: !props.controller });
  const { step, total, activeQuestion, activeValue, isSubmitting, canContinue, handleSelect,
    handlePrimary, handleBack, horizonDialogOpen, setHorizonDialogOpen, horizonAnchorChoice,
    setHorizonAnchorChoice, cancelHorizon, applyHorizon, primaryLabel, questions: QUESTIONS } = props.controller ?? owned;
  const layout = props.layout ?? "page";
  const reserveBackSlot = props.mode === "onboarding";
  const showBack = props.mode === "onboarding" && step > 0;
  const isPageLayout = layout === "page";

  return (
    <main
      data-top-content-anchor={isPageLayout ? "true" : undefined}
      className={cn(
        "w-full max-w-full bg-transparent flex flex-col",
        isPageLayout
          ? "min-h-[calc(100dvh-var(--app-scroll-bottom-pad,0px))] px-4 sm:px-6 pt-[var(--top-content-pad)] pb-[var(--app-scroll-bottom-pad)]"
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
                We’ll tune One to you.
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
                  "motion-reduce:transition-none",
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
            <AlertDialogCancel onClick={cancelHorizon}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="blue-gradient"
              effect="fill"
              size="sm"
              className="rounded-xl"
              onClick={applyHorizon}
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
