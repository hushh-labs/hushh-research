"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import {
  getInvestingPersona,
  personaPlanningNote,
  type PersonaPreferences,
} from "@/lib/kai/investing-persona";
import styles from "./finance-persona.module.css";

const questions = [
  {
    key: "investment_horizon",
    prompt:
      "When do you expect to start withdrawing money from these investments?",
    choices: [
      ["short_term", "Less than 3 years"],
      ["medium_term", "In 3–7 years"],
      ["long_term", "More than 7 years"],
    ],
  },
  {
    key: "drawdown_response",
    prompt:
      "If a $10,000 investment fell to $8,000 in a market downturn, what would you do first?",
    choices: [
      ["reduce", "Sell some investments to limit further losses"],
      ["stay", "Keep my investments while I review my plan"],
      ["buy_more", "Consider investing more if my plan still fits"],
    ],
  },
  {
    key: "volatility_preference",
    prompt:
      "Which of these hypothetical one-year investments would you choose?",
    hint: "In each example, the gain and loss are equally likely.",
    choices: [
      ["small", "Lose 5% or gain 8%"],
      ["moderate", "Lose 15% or gain 18%"],
      ["large", "Lose 30% or gain 35%"],
    ],
  },
  {
    key: "loss_capacity",
    prompt:
      "If your investments stayed down for a year, would you need to sell any?",
    choices: [
      ["essentials", "I’d probably need to sell to cover bills"],
      [
        "delay_goal",
        "I could cover bills, but I might delay a planned expense",
      ],
      ["flexible", "I could keep the money invested without changing my plans"],
    ],
  },
] as const;

function answer<T extends string>(
  data: FormData,
  question: { key: string; choices: readonly (readonly [T, string])[] },
): T | null {
  const value = data.get(question.key);
  return question.choices.find(([choice]) => choice === value)?.[0] ?? null;
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
  onSkip,
  onSavingChange,
}: {
  initial?: PersonaPreferences;
  onboarding?: boolean;
  onSave: (preferences: PersonaPreferences) => Promise<void | false>;
  onDone: () => void;
  onSkip?: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const id = useId();
  const [saved, setSaved] = useState<PersonaPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current) return;
    const data = new FormData(event.currentTarget);
    const preferences = {
      investment_horizon: answer(data, questions[0]),
      drawdown_response: answer(data, questions[1]),
      volatility_preference: answer(data, questions[2]),
      loss_capacity: answer(data, questions[3]),
    } satisfies PersonaPreferences;
    saving.current = true;
    setBusy(true);
    onSavingChange?.(true);
    setError(null);
    try {
      const result = await onSave(preferences);
      if (result === false) return;
      setSaved(preferences);
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
        actionLabel={onboarding ? "Continue to import" : "Back to analysis"}
      />
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => void submit(event)}
      aria-busy={busy}
    >
      {onboarding ? (
        <header>
          <p className="ui-text-helper-text">Finance setup · Step 2 of 3</p>
          <h1 className="ui-text-page-title">
            Let’s build your financial persona
          </h1>
        </header>
      ) : null}
      <p className="ui-text-body">
        {onboarding
          ? "Think about the investments you plan to add to Finance."
          : "Think about the investments you want One to review."}{" "}
        Your answers help One tailor your portfolio review.
      </p>
      <div className={styles.questions}>
        {questions.map((question, index) => {
          const hintId = `${id}-${question.key}`;
          return (
            <fieldset
              key={question.key}
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
              {[
                ...question.choices,
                ["unknown", "I’m not sure yet"] as const,
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={question.key}
                    value={value}
                    required
                    defaultChecked={
                      initial
                        ? (initial[question.key] ?? "unknown") === value
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
        {onSkip ? (
          <ShellActionSurface variant="pill" onClick={onSkip} disabled={busy}>
            Skip for now
          </ShellActionSurface>
        ) : null}
        <ShellActionSurface
          type="submit"
          variant="pill"
          className={styles.primary}
          rippleEffect="fill"
          disabled={busy}
        >
          {busy ? "Saving…" : "Save persona"}
        </ShellActionSurface>
      </footer>
    </form>
  );
}
