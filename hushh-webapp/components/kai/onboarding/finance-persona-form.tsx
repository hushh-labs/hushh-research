"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { KAI_PREFERENCE_QUESTIONS } from "@/lib/kai/preference-questions";
import {
  getInvestingPersona,
  personaPlanningNote,
  type PersonaPreferences,
} from "@/lib/kai/investing-persona";
import styles from "./finance-persona.module.css";

const editQuestions = [
  {
    id: "investment_horizon",
    prompt:
      "When do you expect to start withdrawing money from these investments?",
    options: [
      { value: "short_term", label: "Less than 3 years" },
      { value: "medium_term", label: "In 3–7 years" },
      { value: "long_term", label: "More than 7 years" },
    ],
  },
  {
    id: "drawdown_response",
    prompt:
      "If your investments fell 20% in a market downturn, what would you do first?",
    options: [
      { value: "reduce", label: "Sell some investments to limit further losses" },
      { value: "stay", label: "Keep my investments while I review my plan" },
      { value: "buy_more", label: "Consider investing more if my plan still fits" },
    ],
  },
  {
    id: "volatility_preference",
    prompt:
      "Which of these hypothetical one-year investments would you choose?",
    hint: "In each example, the gain and loss are equally likely.",
    options: [
      { value: "small", label: "Lose 5% or gain 8%" },
      { value: "moderate", label: "Lose 15% or gain 18%" },
      { value: "large", label: "Lose 30% or gain 35%" },
    ],
  },
  {
    id: "loss_capacity",
    prompt:
      "If your investments stayed down for a year, would you need to sell any?",
    options: [
      { value: "essentials", label: "I’d probably need to sell to cover bills" },
      { value: "delay_goal", label: "I could cover bills, but I might delay a planned expense" },
      { value: "flexible", label: "I could keep the money invested without changing my plans" },
    ],
  },
] as const;

function answer<T extends string>(
  data: FormData,
  question: { id: string; options: readonly { value: T }[] },
): T | null {
  const selected = data.get(question.id);
  return question.options.find(({ value }) => value === selected)?.value ?? null;
}

export function FinancePersonaBadge({
  preferences,
}: {
  preferences: PersonaPreferences;
}) {
  const persona = getInvestingPersona(preferences);
  return (
    <span className={styles.badge} data-persona={persona.kind}>
      {persona.label}
    </span>
  );
}

export function FinancePersonaReveal({
  preferences,
  onDone,
  actionLabel,
}: {
  preferences: PersonaPreferences;
  onDone: () => void;
  actionLabel: string;
}) {
  return (
    <section className={styles.reveal} aria-label="Your investing persona">
      <h2
        className="ui-text-section-label"
        tabIndex={-1}
        ref={(heading) => heading?.focus()}
      >
        Your investing persona
      </h2>
      <FinancePersonaBadge preferences={preferences} />
      <p>{getInvestingPersona(preferences).description}</p>
      <p className="ui-text-helper-text">{personaPlanningNote(preferences)}</p>
      <ShellActionSurface
        variant="pill"
        className={styles.primary}
        rippleEffect="fill"
        onClick={onDone}
      >
        {actionLabel}
      </ShellActionSurface>
    </section>
  );
}

export function FinancePersonaForm({
  initial,
  onboarding = false,
  onSave,
  onDone,
  onSavingChange,
}: {
  initial?: PersonaPreferences;
  onboarding?: boolean;
  onSave: (preferences: PersonaPreferences) => Promise<void | false>;
  onDone: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const id = useId();
  const [saved, setSaved] = useState<PersonaPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const questions = onboarding ? KAI_PREFERENCE_QUESTIONS : editQuestions;
  const [horizon, drawdown, volatility, capacity] = questions;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current) return;
    const data = new FormData(event.currentTarget);
    // Onboarding answers live in state (tap to choose, tap again to clear); a
    // question left unanswered is saved as "not sure yet".
    if (onboarding) for (const [key, value] of Object.entries(picked)) data.set(key, value);
    const preferences = {
      investment_horizon: answer(data, horizon),
      drawdown_response: answer(data, drawdown),
      volatility_preference: answer(data, volatility),
      ...(capacity ? { loss_capacity: answer(data, capacity) } : {}),
    } satisfies PersonaPreferences;
    saving.current = true;
    setBusy(true);
    onSavingChange?.(true);
    setError(null);
    try {
      if (await onSave(preferences) === false) return;
      if (onboarding) onDone();
      else setSaved(preferences);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn’t save your persona. Try again.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
      onSavingChange?.(false);
    }
  };

  if (saved) {
    return (
      <FinancePersonaReveal
        preferences={saved}
        onDone={onDone}
        actionLabel="Back to analysis"
      />
    );
  }

  return (
    <form
      className={onboarding ? `app-type-compact ${styles.form} ${styles.onboarding}` : styles.form}
      onSubmit={(event) => void submit(event)}
      aria-busy={busy}
    >
      {onboarding ? (
        <header>
          <p className="ui-text-helper-text">Finance setup</p>
          <h1 className="ui-text-page-title">
            Let’s build your financial persona
          </h1>
        </header>
      ) : null}
      {onboarding ? null : (
        <p className="ui-text-body">
          Think about the investments you want One to review. Your answers help
          One tailor your portfolio review.
        </p>
      )}
      <div className={styles.questions}>
        {questions.map((question, index) => {
          const hintId = `${id}-${question.id}`;
          return (
            <fieldset
              key={question.id}
              disabled={busy}
              aria-describedby={"hint" in question ? hintId : undefined}
            >
              <legend>
                <span aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {question.prompt}
              </legend>
              {"hint" in question ? (
                <p id={hintId} className="ui-text-helper-text">
                  {question.hint}
                </p>
              ) : null}
              {onboarding
                ? question.options.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      className={styles.choice}
                      aria-pressed={picked[question.id] === value}
                      onClick={() =>
                        setPicked((current) => {
                          const { [question.id]: chosen, ...rest } = current;
                          return chosen === value ? rest : { ...rest, [question.id]: value };
                        })
                      }
                    >
                      {label}
                    </button>
                  ))
                : [
                ...question.options,
                { value: "unknown", label: "I’m not sure yet" },
              ].map(({ value, label }) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={question.id}
                    value={value}
                    required
                    defaultChecked={
                      initial
                        ? (initial[question.id] ?? "unknown") === value
                        : false
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <footer className={styles.actions}>
        <ShellActionSurface
          type="submit"
          variant="pill"
          className={styles.primary}
          rippleEffect="fill"
          disabled={busy}
        >
          {busy ? "Saving…" : onboarding ? "Continue" : "Save persona"}
        </ShellActionSurface>
      </footer>
    </form>
  );
}
