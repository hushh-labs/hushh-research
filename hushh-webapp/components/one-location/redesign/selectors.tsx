"use client";

/**
 * One Location redesign — selectors (duration / location type / reason chips / search).
 *
 * PRESENTATION ONLY. These are controlled inputs whose values are owned by the
 * existing page state (durationHours, requestMessage, recipientSearch, etc).
 * They do not introduce new business logic.
 */

import { useId } from "react";
import { Search } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormLabel,
  InputValue,
  RowDescription,
  RowLabel,
} from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import { DurationWheelPicker } from "./duration-wheel-picker";
import { DurationPresetPicker } from "./duration-presets";
import type { DurationRung } from "./duration-presets";

export const LOCATION_SEARCH_INPUT_CLASSNAME =
  "ui-text-input-value h-11 w-full rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] pl-10 pr-4 text-[color:var(--app-label)] outline-none transition-shadow placeholder:text-[color:var(--app-tertiary-label)] focus:ring-2 focus:ring-inset focus:ring-[color:var(--app-accent-ring)] [&::-webkit-search-cancel-button]:appearance-none";

/**
 * Mirrors the existing page DURATION_OPTIONS so the Select/menu values stay
 * identical. `0.25` is here because 15 minutes is the product floor for a
 * share, and the grant editor could not previously reach it — its shortest
 * option was 30 minutes, twice the floor.
 */
export const REDESIGN_DURATION_OPTIONS: { value: string; label: string }[] = [
  { value: "0.25", label: "15 min" },
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

export function DurationSelector({
  value,
  onChange,
  options = REDESIGN_DURATION_OPTIONS,
  label = "Duration",
  hint,
  presentation = "buttons",
  untilStopValue,
  allowUntilStop = true,
  maxWidthClassName = "max-w-[420px]",
  rungs,
}: {
  value: string;
  onChange: (next: string) => void;
  options?: { value: string; label: string }[];
  label?: string;
  /**
   * Read-back of what the current value means, on the label's own line
   * rather than a line of its own beneath the control — the two together
   * are one statement ("How long … Ends 4:35 PM") and cost 18px less.
   */
  hint?: string;
  presentation?: "buttons" | "select" | "wheel" | "ladder";
  /** Forwarded to the picker — the sentinel value its open-ended option
   * emits. Defaults to the wheel's own alias when omitted. */
  untilStopValue?: string;
  /**
   * False hides the open-ended option entirely — the rung on `ladder`, the
   * toggle on `wheel`. Set it on any lane whose value is later read with
   * `Number()`, because the sentinel is a non-numeric string.
   */
  allowUntilStop?: boolean;
  /**
   * Width cap for the whole group.
   *
   * Defaults to 420px because two of the seven call sites — the live-share
   * "New time" editor and the People tab's "New duration" — render straight
   * into the 880px shell with no column of their own, and without this they
   * stretch to 792px and their duration cells reach 258px. A caller whose
   * column is ALREADY measured passes `null` so the control fills it instead
   * of sitting short inside its own card.
   */
  maxWidthClassName?: string | null;
  /** Presets used by the visible ladder presentation. */
  rungs?: DurationRung[];
}) {
  const labelId = useId();

  return (
    // `max-w-[420px]` on the GROUP, not on the ladder inside it. The label and
    // the "Ends 1:25 AM" read-back live at this level; clamping only the
    // buttons left the hint floating ~370px to the right of the control it
    // reads back, on an 880px shell. Inert on every phone — the card is
    // narrower than 420 there — which is deliberate: this half of the report
    // was a desktop screenshot of 258px-wide duration cells.
    <div className={cn(maxWidthClassName, "space-y-2.5")}>
      {label || hint ? (
        // The read-back sits NEXT TO the label, not pushed to the far edge.
        // `justify-between` orphaned "Ends 4:03 AM" hundreds of px from the
        // "How long" it reads back — 277px at 1440 even with the group clamped,
        // and any wider column made it worse. They are one statement, so they
        // are now one group, and the width of the control stops deciding how
        // far apart they read.
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {label ? (
            <FormLabel as="p" id={labelId}>
              {label}
            </FormLabel>
          ) : (
            <span aria-hidden />
          )}
          {hint ? (
            <p className={cn(MUTED_TEXT, "shrink-0")} aria-live="polite">
              {hint}
            </p>
          ) : null}
        </div>
      ) : null}
      {presentation === "ladder" ? (
        <DurationPresetPicker
          value={value}
          onChange={onChange}
          {...(rungs ? { rungs } : {})}
          allowUntilStop={allowUntilStop}
          labelledBy={label ? labelId : undefined}
          {...(untilStopValue ? { untilStopValue } : {})}
        />
      ) : presentation === "wheel" ? (
        <DurationWheelPicker
          value={value}
          onChange={onChange}
          showUntilStop={allowUntilStop}
          {...(untilStopValue ? { untilStopValue } : {})}
        />
      ) : presentation === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            aria-label={label || "Duration"}
            aria-labelledby={label ? labelId : undefined}
            className="h-11 w-full rounded-[14px] border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] shadow-none"
          >
            <InputValue as="span">
              <SelectValue />
            </InputValue>
          </SelectTrigger>
          <SelectContent
            align="start"
            position="popper"
            className="rounded-[14px]"
          >
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div
          className="flex flex-wrap gap-2"
          role="radiogroup"
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : "Duration"}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(option.value)}
                className={cn(
                  "h-9 rounded-full border px-4 transition-colors touch-manipulation",
                  active
                    ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                    : "border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] text-[color:var(--app-label)] hover:border-[color:var(--app-accent-ring)] hover:bg-[color:var(--app-neutral-fill-strong)]",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type LocationTypeValue = "approximate" | "precise";

export function LocationTypeSelector({
  value,
  onChange,
  label = "Location type",
}: {
  value: LocationTypeValue;
  onChange: (next: LocationTypeValue) => void;
  label?: string;
}) {
  const options: {
    value: LocationTypeValue;
    title: string;
    description: string;
  }[] = [
    {
      value: "approximate",
      title: "Approximate area",
      description: "Better for privacy and battery life",
    },
    {
      value: "precise",
      title: "Precise live location",
      description: "Updates as you move.",
    },
  ];
  return (
    <div className="space-y-2">
      {label ? (
        <FormLabel as="p">{label}</FormLabel>
      ) : null}
      <div
        role="radiogroup"
        aria-label={label || "Location type"}
        className="grid gap-2"
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={cn(
                SUBCARD_SURFACE,
                "flex items-center justify-between p-3.5 text-left transition-colors",
                active &&
                  "border-[color:var(--app-accent)]/50 ring-1 ring-[color:var(--app-accent-ring)]",
              )}
            >
              <span>
                <RowLabel as="span" className="block">
                  {option.title}
                </RowLabel>
                <RowDescription as="span" className={cn(MUTED_TEXT, "block")}>
                  {option.description}
                </RowDescription>
              </span>
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border-2",
                  active
                    ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)]"
                    : "border-border",
                )}
              >
                {active ? (
                  <span className="h-2 w-2 rounded-full bg-white" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export type ReasonValue =
  "Safety check-in" | "Meeting nearby" | "Pick-up" | "Other";

export const REASON_CHIPS: ReasonValue[] = [
  "Safety check-in",
  "Meeting nearby",
  "Pick-up",
  "Other",
];

export function ReasonChips({
  value,
  onChange,
  label = "Reason",
  presentation = "buttons",
  placeholder = "Pick a reason…",
}: {
  value: ReasonValue | null;
  onChange: (next: ReasonValue) => void;
  label?: string;
  presentation?: "buttons" | "select";
  placeholder?: string;
}) {
  const labelId = useId();

  // Dropdown presentation to match DurationSelector's select variant, for a
  // denser Ask form. Buttons variant is retained for any other caller.
  if (presentation === "select") {
    return (
      <div className="space-y-2">
        {label ? <FormLabel as="p" id={labelId}>{label}</FormLabel> : null}
        <Select
          value={value ?? undefined}
          onValueChange={(next) => onChange(next as ReasonValue)}
        >
          <SelectTrigger
            aria-label={label || "Reason"}
            aria-labelledby={label ? labelId : undefined}
            className="h-11 w-full rounded-[14px] border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] shadow-none"
          >
            <InputValue as="span">
              <SelectValue placeholder={placeholder} />
            </InputValue>
          </SelectTrigger>
          <SelectContent
            align="start"
            position="popper"
            className="rounded-[14px]"
          >
            {REASON_CHIPS.map((reason) => (
              <SelectItem key={reason} value={reason}>
                {reason}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {label ? (
        <FormLabel as="p">{label}</FormLabel>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {REASON_CHIPS.map((reason) => {
          const active = reason === value;
          return (
            <button
              key={reason}
              type="button"
              onClick={() => onChange(reason)}
              className={cn(
                "h-10 rounded-[13px] px-3 transition-colors touch-manipulation",
                active
                  ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                  : "bg-[color:var(--app-secondary-system-fill)] text-foreground hover:bg-[color:var(--app-secondary-system-fill)]/80",
                )}
              >
              {reason}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PersonSearchInput({
  value,
  onChange,
  placeholder = "Search trusted people",
  voiceControlId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Anchors a contract action to this field so voice offers it only here. */
  voiceControlId?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--app-tertiary-label)]" />
      <input
        type="search"
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        data-voice-control-id={voiceControlId}
        // A name is not a dictionary word. Left on, iOS autocorrect rewrites an
        // uncommon surname mid-search and the list jumps to the wrong people or
        // empties, with the user watching their own typing change under them.
        // Autocapitalise is off for the same reason a search box is not a name
        // field: matching is case-insensitive, and a forced capital is one more
        // thing the keyboard did that the person did not ask for.
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
        onKeyDown={(event) => {
          // iOS soft-keyboard "return" must dismiss the keyboard; blurring the
          // field is what actually closes it in the Capacitor webview (there is
          // no form submit here). Without this the key reads "return", does
          // nothing, and the keyboard stays over the results being read.
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onFocus={(event) => {
          // Tapping this field on a small iPhone otherwise leaves it sitting
          // behind the keyboard, so the person types blind. The delay lets the
          // keyboard animate in, so the shrunken viewport is what gets measured.
          const field = event.currentTarget;
          window.setTimeout(() => {
            field.scrollIntoView({ block: "center", behavior: "smooth" });
          }, 250);
        }}
        className={LOCATION_SEARCH_INPUT_CLASSNAME}
      />
    </div>
  );
}
