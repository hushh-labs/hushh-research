"use client";

import {
  useId,
  useRef,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { CheckIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/** The three places a private agent can live, in the order the screen offers them. */
export type HostingChoice = "shared" | "own" | "hosted";

export type HostingChoiceOption = {
  value: HostingChoice;
  /** A bare duotone registry glyph, drawn on a transparent well the way /one draws it. */
  icon: ComponentType<{ className?: string; size?: string | number }>;
  title: string;
  description: string;
  /** At most one quiet line under the description: a status, or decorative provider marks. */
  supporting?: ReactNode;
  /** The supporting line is purely visual (provider marks): hidden from assistive tech. */
  supportingDecorative?: boolean;
  /** Visible and honest, but not takeable (Hussh Pods while it is paused). */
  unavailable?: boolean;
  testId: string;
};

type HostingChoiceCardsProps = {
  options: readonly HostingChoiceOption[];
  /** The option in front of the person; null when nothing has been picked yet. */
  value: HostingChoice | null;
  onChange: (next: HostingChoice) => void;
  label: string;
  busy?: boolean;
};

/**
 * Where the agent lives, as three choice cards in one radio group.
 *
 * The house pattern is the provider choice beside it: picking a card only moves
 * the selection, and whatever the pick needs next appears below the group. So the
 * arrows can check options freely (one tab stop, arrows move within it) without
 * ever committing anything; the commit stays an explicit button press.
 *
 * An unavailable option keeps its card so the choice stays honest, but it is
 * disabled, skipped by the arrows, and carries no selection ring.
 */
export function HostingChoiceCards({
  options,
  value,
  onChange,
  label,
  busy = false,
}: HostingChoiceCardsProps) {
  const baseId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const takeable = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !option.unavailable);
  // One tab stop: the checked card, or the first takeable one before any pick.
  const tabStop =
    takeable.find(({ option }) => option.value === value)?.index ??
    takeable[0]?.index;

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      event.key
    ];
    if (step === undefined || takeable.length === 0) return;
    event.preventDefault();
    const position = takeable.findIndex((entry) => entry.index === index);
    const next =
      takeable[(position + step + takeable.length) % takeable.length];
    if (!next) return;
    onChange(next.option.value);
    buttons.current[next.index]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-busy={busy || undefined}
      className="flex flex-col gap-3"
    >
      {options.map((option, index) => {
        const checked = !option.unavailable && option.value === value;
        const titleId = `${baseId}-${option.value}-title`;
        const descriptionId = `${baseId}-${option.value}-description`;
        const supportingId = `${baseId}-${option.value}-supporting`;
        const Glyph = option.icon;
        return (
          // The wrapper owns the calm, staggered arrival (the shared utility turns
          // itself off under prefers-reduced-motion). It sits outside the card
          // because the animation's fill would otherwise pin the card's transform
          // and swallow its press feedback.
          <div
            key={option.value}
            className="motion-step-enter"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <button
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={titleId}
              aria-describedby={
                option.supporting && !option.supportingDecorative
                  ? `${descriptionId} ${supportingId}`
                  : descriptionId
              }
              aria-disabled={option.unavailable || undefined}
              disabled={option.unavailable}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={option.testId}
              data-state={
                checked
                  ? "checked"
                  : option.unavailable
                    ? "unavailable"
                    : "unchecked"
              }
              data-maintenance={option.unavailable ? "true" : undefined}
              className={cn(
                "group flex min-h-[88px] w-full items-center gap-4 rounded-2xl border p-4 text-left",
                "transition-[border-color,background-color,box-shadow] duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
                option.unavailable
                  ? "cursor-not-allowed border-[color:var(--app-card-border-standard)] bg-transparent"
                  : null,
                checked
                  ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)] shadow-[0_0_0_1px_var(--app-accent)]"
                  : option.unavailable
                    ? null
                    : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default)] shadow-[var(--app-card-shadow-standard)] hover:border-[color:var(--app-accent-border)]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center",
                  option.unavailable && "opacity-50 grayscale",
                )}
              >
                <Glyph size={28} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span
                  id={titleId}
                  className={cn(
                    "text-[15px] font-semibold leading-5",
                    option.unavailable
                      ? "text-[var(--app-text-secondary)]"
                      : "text-foreground",
                  )}
                >
                  {option.title}
                </span>
                <span
                  id={descriptionId}
                  className="text-pretty text-sm leading-5 text-[var(--app-text-secondary)]"
                >
                  {option.description}
                </span>
                {option.supporting ? (
                  <span
                    id={supportingId}
                    aria-hidden={option.supportingDecorative || undefined}
                    className="flex min-h-5 items-center gap-1.5 text-[13px] leading-5 text-[var(--app-text-secondary)]"
                  >
                    {option.supporting}
                  </span>
                ) : null}
              </span>
              {option.unavailable ? null : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                    checked
                      ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                      : "border-[var(--app-border)]",
                  )}
                >
                  {checked ? (
                    <CheckIcon className="h-3 w-3" weight="bold" />
                  ) : null}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
