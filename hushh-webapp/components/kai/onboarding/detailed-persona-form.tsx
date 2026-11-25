"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Check } from "@/components/icons";
import {
  detailedPersonaQuestions,
  type DetailedPersonaAnswer,
  type DetailedPersonaAnswers,
} from "@/lib/kai/detailed-persona";
import type { PersonaPreferences } from "@/lib/kai/investing-persona";
import { FinancePersonaReveal } from "./finance-persona-form";
import styles from "./finance-persona.module.css";

const answerTones = ["careful", "balanced", "growth"] as const;

export function DetailedPersonaForm({
  initial,
  onSave,
  onDone,
  onSavingChange,
}: {
  initial: PersonaPreferences;
  onSave: (answers: DetailedPersonaAnswers) => Promise<PersonaPreferences>;
  onDone: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [answers, setAnswers] = useState<(DetailedPersonaAnswer | undefined)[]>(
    () =>
      initial.detailed_assessment_v1 ??
      detailedPersonaQuestions.map(() => undefined),
  );
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState<PersonaPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const total = detailedPersonaQuestions.length;
  const question = detailedPersonaQuestions[step]!;
  const final = step === total - 1;
  const focusQuestion = useCallback(
    (node: HTMLLegendElement | null) => {
      if (step > 0) node?.focus();
    },
    [step],
  );

  const proceed = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current) return;
    if (!final) {
      setAnswers((previous) => previous.map((answer, index) => index === step ? answer ?? null : answer));
      setStep(step + 1);
      return;
    }
    const completed = answers.map((value) => value ?? null);
    saving.current = true;
    setBusy(true);
    onSavingChange(true);
    setError(false);
    try {
      setSaved(await onSave(completed));
    } catch {
      setError(true);
    } finally {
      saving.current = false;
      setBusy(false);
      onSavingChange(false);
    }
  };
  if (saved)
    return (
      <FinancePersonaReveal
        preferences={saved}
        actionLabel="Back to analysis"
        onDone={onDone}
      />
    );

  return (
    <form
      className={`${styles.form} ${styles.assessmentForm}`}
      onSubmit={(event) => void proceed(event)}
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 ui-text-helper-text">
        <p>Question {step + 1} of {total}</p>
        <p>{step < 8 ? "Risk comfort" : "Planning needs"}</p>
      </div>
      <div
        className={styles.assessmentProgress}
        role="progressbar"
        aria-label="Assessment answers"
        aria-valuenow={answers.filter((answer) => answer !== undefined).length}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        {detailedPersonaQuestions.map(({ prompt }, index) => {
          const answer = answers[index];
          const tone = answer === undefined ? "future" : answer === null ? "unsure" : answerTones[answer];
          return <span key={prompt} data-tone={tone} data-current={index === step ? "true" : undefined} aria-hidden="true" />;
        })}
      </div>
      <div className={styles.detailedQuestion}>
        <fieldset key={step} disabled={busy}>
          <legend tabIndex={-1} ref={focusQuestion}>{question.prompt}</legend>
          {question.choices.map((label, index) => {
            const value = ([0, 1, 2] as const)[index]!;
            return <button key={label} type="button" className={styles.choice}
              aria-pressed={answers[step] === value}
              onClick={() => setAnswers(previous => previous.map((current, item) =>
                item === step ? current === value ? null : value : current))}>
              <span className={styles.box} aria-hidden="true"><Check size={14} /></span>
              <span>{label}</span>
            </button>;
          })}
        </fieldset>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          Couldn’t save your assessment. Try again.
        </p>
      ) : null}
      <footer className={`${styles.actions} ${styles.assessmentActions}`}>
        <ShellActionSurface
          variant="pill"
          className="ui-text-compact-button-label"
          disabled={busy}
          onClick={() => step > 0 ? setStep(step - 1) : onDone()}
        >
          Back
        </ShellActionSurface>
        <ShellActionSurface
          type="submit"
          variant="pill"
          className={`${styles.primary} ui-text-compact-button-label`}
          rippleEffect="fill"
          disabled={busy}
        >
          {busy ? "Saving…" : final ? "Save assessment" : "Continue"}
        </ShellActionSurface>
      </footer>
    </form>
  );
}
