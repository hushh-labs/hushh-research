"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import { useLocalOnboardingActionHandler, type LocalOnboardingActionResult } from "@/lib/agent/local-onboarding-actions";
import type { DrawdownResponse, HorizonAnchorChoice, InvestmentHorizon, VolatilityPreference } from "@/lib/services/kai-profile-service";

export type WizardAnswers = {
  investment_horizon: InvestmentHorizon | null;
  drawdown_response: DrawdownResponse | null;
  volatility_preference: VolatilityPreference | null;
};
export type WizardCompletePayload = WizardAnswers & { horizonAnchorChoice?: HorizonAnchorChoice };
export const KAI_PREFERENCE_QUESTIONS = [
  { id: "investment_horizon", prompt: "How long will this stay invested?", options: [
    { value: "short_term", label: "Less than 3 years" }, { value: "medium_term", label: "3–7 years" }, { value: "long_term", label: "More than 7 years" },
  ] },
  { id: "drawdown_response", prompt: "Portfolio down 20%, what's your move?", options: [
    { value: "reduce", label: "Reduce investments to limit further losses" }, { value: "stay", label: "Stay invested and review the situation" }, { value: "buy_more", label: "Invest more at lower prices" },
  ] },
  { id: "volatility_preference", prompt: "Which feels more comfortable to you?", options: [
    { value: "small", label: "Smaller, steadier returns" }, { value: "moderate", label: "Moderate ups and downs for better returns" }, { value: "large", label: "Larger swings for higher potential returns" },
  ] },
] as const;
type State = { step: number; answers: WizardAnswers; pendingHorizon: InvestmentHorizon | null; horizonDialogOpen: boolean; horizonAnchorChoice: HorizonAnchorChoice };
export type KaiPreferencesWizardOptions = {
  mode: "onboarding" | "edit"; isSubmitting?: boolean; initialStep?: number; initialAnswers?: Partial<WizardAnswers>;
  onAnswersChange?: (answers: WizardAnswers) => void | Promise<void>; onBack?: () => void;
  onComplete: (payload: WizardCompletePayload) => void | Promise<void>;
  enabled?: boolean; resetKey?: unknown;
};

/** The existing wizard's single volatile state/operation owner, shared by web
 * and native renderers. No financial writer or native persistence lives here. */
export function useKaiPreferencesWizard(props: KaiPreferencesWizardOptions) {
  const enabled = props.enabled !== false;
  const total = KAI_PREFERENCE_QUESTIONS.length;
  const visit = useMemo(() => ({ live: false, pending: false, enabled, key: props.resetKey, state: null as State | null }), [props.resetKey, enabled]);
  const initial: State = {
    step: Math.min(Math.max(props.initialStep ?? 0, 0), total - 1),
    answers: { investment_horizon: props.initialAnswers?.investment_horizon ?? null,
      drawdown_response: props.initialAnswers?.drawdown_response ?? null, volatility_preference: props.initialAnswers?.volatility_preference ?? null },
    pendingHorizon: null, horizonDialogOpen: false, horizonAnchorChoice: "from_now",
  };
  const [stored, setStored] = useState<{ visit: typeof visit; value: State } | null>(null);
  const value = stored?.visit === visit ? stored.value : visit.state ?? initial;
  // Initial answers seed a visit once. An async saveDraft echo is not an
  // instruction to reset the active question or replace newer local choices.
  useLayoutEffect(() => { visit.state ??= value; }, [visit, value]);
  const currentState = () => visit.state ?? value;
  const [pendingVisit, setPendingVisit] = useState<typeof visit | null>(null);
  useLayoutEffect(() => { visit.live = enabled; return () => { visit.live = false; }; }, [visit, enabled]);
  const busy = props.isSubmitting === true || pendingVisit === visit;
  const write = (update: (state: State) => State) => {
    if (!visit.live || visit.pending || props.isSubmitting) return;
    const next = update(currentState()); visit.state = next; setStored({ visit, value: next });
  };
  const setAnswer = <K extends keyof WizardAnswers>(key: K, entry: WizardAnswers[K]) => {
    if (!visit.live || visit.pending || props.isSubmitting) return;
    const answers = { ...currentState().answers, [key]: entry };
    write(state => ({ ...state, answers }));
    void props.onAnswersChange?.(answers);
  };
  const select = (question: keyof WizardAnswers, entry: string) => {
    const definition = KAI_PREFERENCE_QUESTIONS.find(item => item.id === question);
    if (!definition?.options.some(option => option.value === entry) || !visit.live || visit.pending || props.isSubmitting) return false;
    if (question === "investment_horizon" && props.mode === "edit" && currentState().answers.investment_horizon && currentState().answers.investment_horizon !== entry) {
      write(state => ({ ...state, pendingHorizon: entry as InvestmentHorizon, horizonAnchorChoice: "from_now", horizonDialogOpen: true }));
      return false;
    }
    setAnswer(question, entry as WizardAnswers[typeof question]); return true;
  };
  const complete = async () => {
    if (!visit.live || visit.pending || props.isSubmitting || currentState().horizonDialogOpen ||
      !Object.values(currentState().answers).every(Boolean)) return "blocked" as const;
    visit.pending = true; setPendingVisit(visit);
    try {
      await props.onComplete({ ...currentState().answers, horizonAnchorChoice: props.mode === "edit" ? currentState().horizonAnchorChoice : undefined });
      return "saved" as const;
    } catch {
      return "failed" as const; // The operation owner presents its outcome; never replay.
    } finally {
      visit.pending = false;
      if (visit.live) setPendingVisit(current => current === visit ? null : current);
    }
  };
  const answerByVoice = async (question: keyof WizardAnswers, entry: string): Promise<LocalOnboardingActionResult> => {
    if (!visit.live || visit.pending || props.isSubmitting || currentState().horizonDialogOpen) return { status: "blocked", summary: "Finish the current preference choice first." };
    const index = KAI_PREFERENCE_QUESTIONS.findIndex(item => item.id === question);
    const priorStep = currentState().step;
    if (index !== priorStep) write(state => ({ ...state, step: index }));
    if (!select(question, entry)) return { status: "blocked", summary: "Choose how the changed time horizon should apply." };
    if (index !== priorStep) return { status: "succeeded", summary: `Recorded ${question.replaceAll("_", " ")}.` };
    if (index === total - 1) {
      const outcome = await complete();
      if (outcome === "saved") return { status: "succeeded", summary: "Preferences saved." };
      return outcome === "failed" ? { status: "failed", summary: "Preferences couldn't be saved. Please retry." }
        : { status: "blocked", summary: "Complete all three preferences before saving." };
    }
    write(state => ({ ...state, step: state.step + 1 }));
    return { status: "succeeded", summary: "Moving to the next question." };
  };
  useLocalOnboardingActionHandler("kai.setup.answer_horizon", async slots => {
    const entry = String(slots.answer ?? "").trim();
    if (!["short_term", "medium_term", "long_term"].includes(entry)) return { status: "blocked", summary: "That's not one of the horizon options." };
    return answerByVoice("investment_horizon", entry);
  }, { enabled });
  useLocalOnboardingActionHandler("kai.setup.answer_drawdown", async slots => {
    const entry = String(slots.answer ?? "").trim();
    if (!["reduce", "stay", "buy_more"].includes(entry)) return { status: "blocked", summary: "That's not one of the drawdown options." };
    return answerByVoice("drawdown_response", entry);
  }, { enabled });
  useLocalOnboardingActionHandler("kai.setup.answer_volatility", async slots => {
    const entry = String(slots.answer ?? "").trim();
    if (!["small", "moderate", "large"].includes(entry)) return { status: "blocked", summary: "That's not one of the volatility options." };
    return answerByVoice("volatility_preference", entry);
  }, { enabled });
  const activeQuestion = KAI_PREFERENCE_QUESTIONS[value.step]!;
  const isLast = value.step === total - 1;
  const canContinue = Boolean(value.answers[activeQuestion.id]);
  const handlePrimary = async () => {
    if (!visit.live || !canContinue || busy || currentState().horizonDialogOpen) return;
    if (currentState().step < total - 1) write(state => ({ ...state, step: state.step + 1 }));
    else await complete();
  };
  const handleBack = () => {
    if (!visit.live) return false;
    if (busy) return true;
    if (currentState().horizonDialogOpen) { write(state => ({ ...state, horizonDialogOpen: false, pendingHorizon: null })); return true; }
    if (currentState().step > 0) { write(state => ({ ...state, step: state.step - 1 })); return true; }
    props.onBack?.(); return false;
  };
  const applyHorizon = () => {
    if (!visit.live || visit.pending || props.isSubmitting || !currentState().pendingHorizon) return;
    const answers = { ...currentState().answers, investment_horizon: currentState().pendingHorizon };
    write(state => ({ ...state, answers, pendingHorizon: null, horizonDialogOpen: false }));
    void props.onAnswersChange?.(answers);
  };
  return { ...value, total, activeQuestion, activeValue: value.answers[activeQuestion.id], isSubmitting: busy,
    isLast, canContinue, questions: KAI_PREFERENCE_QUESTIONS, handlePrimary, handleBack, applyHorizon,
    handleSelect: (entry: string) => select(activeQuestion.id, entry),
    setHorizonDialogOpen: (open: boolean) => write(state => ({ ...state, horizonDialogOpen: open, ...(!open ? { pendingHorizon: null } : {}) })),
    setHorizonAnchorChoice: (choice: HorizonAnchorChoice) => write(state => ({ ...state, horizonAnchorChoice: choice })),
    cancelHorizon: () => write(state => ({ ...state, pendingHorizon: null, horizonDialogOpen: false })),
    primaryLabel: props.mode === "edit" ? isLast ? "Save changes" : "Next" : isLast ? "Continue" : "Next",
  };
}
export type KaiPreferencesWizardModel = ReturnType<typeof useKaiPreferencesWizard>;
