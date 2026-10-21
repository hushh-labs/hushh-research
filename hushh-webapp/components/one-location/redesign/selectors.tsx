"use client";

/**
 * One Location redesign — selectors (duration / location type / reason chips / search).
 *
 * PRESENTATION ONLY. These are controlled inputs whose values are owned by the
 * existing page state (durationHours, requestMessage, recipientSearch, etc).
 * They do not introduce new business logic.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { CheckIcon, ChevronDownIcon, Search } from "@/components/icons";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  FormLabel,
  InputValue,
  RowDescription,
  RowLabel,
} from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";
import { SearchClearButton } from "@/components/app-ui/search-clear-button";
import { SEARCH_INPUT_KEYBOARD_PROPS } from "@/components/app-ui/search-input-keyboard";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import { DurationWheelPicker } from "./duration-wheel-picker";
import { DurationPresetPicker } from "./duration-presets";
import type { DurationRung } from "./duration-presets";
import { DURATION_SELECTED_OPTION_CLASSNAME } from "./duration-option-styles";
import {
  DURATION_EQUAL_BUTTON_CLASSNAME,
  DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME,
} from "./location-cta-layout";

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
  allowCustom = true,
  centered = false,
  compact = false,
  equalWidthButtons = false,
  maxWidthClassName = "max-w-[420px]",
  selectClassName,
  activeClassName,
  rungs,
  disabled = false,
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
   * `ladder` only. False drops the `Custom` cell and its scroll wheel, leaving
   * the timed rungs plus the open-ended row as the whole choice (issue #6228).
   */
  allowCustom?: boolean;
  /**
   * `ladder` only. Centre the wrapping chip row from `sm` up and let the
   * open-ended row span the full phone grid, so the control reads as centred
   * and intentional inside a container much wider than it.
   */
  centered?: boolean;
  /** `ladder` only: render a centred, bounded 2x2 confirmation group. */
  compact?: boolean;
  /** `buttons` only: distribute a short option set evenly across the group. */
  equalWidthButtons?: boolean;
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
  /** `select` only: height and radius overrides for the trigger. */
  selectClassName?: string;
  /**
   * `buttons` and `ladder`. Overrides the selected-option border/background/text
   * classes for this one call site, leaving every other caller's default
   * `--app-accent` look untouched.
   */
  activeClassName?: string;
  /** Presets used by the visible ladder presentation. */
  rungs?: DurationRung[];
  /** Prevent changes while the owning flow is committing its current value. */
  disabled?: boolean;
}) {
  const labelId = useId();
  const [selectOpen, setSelectOpen] = useState(false);
  const [dialogBoundary, setDialogBoundary] = useState<HTMLElement | null>(null);
  const selectTriggerRef = useCallback((trigger: HTMLButtonElement | null) => {
    setDialogBoundary(
      trigger?.closest<HTMLElement>(
        '[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="drawer-content"]',
      ) ?? null,
    );
  }, []);

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
          allowCustom={allowCustom}
          centered={centered}
          compact={compact}
          labelledBy={label ? labelId : undefined}
          activeClassName={activeClassName}
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
        <Select
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          onOpenChange={setSelectOpen}
        >
          <SelectTrigger
            ref={selectTriggerRef}
            aria-label={label || "Duration"}
            aria-labelledby={label ? labelId : undefined}
            className={cn(
              "h-11 w-full rounded-[14px] border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] shadow-none",
              selectClassName,
            )}
          >
            <InputValue as="span">
              <SelectValue />
            </InputValue>
          </SelectTrigger>
          <SelectContent
            align="start"
            position="popper"
            side="bottom"
            collisionBoundary={dialogBoundary ?? undefined}
            collisionPadding={dialogBoundary ? 16 : undefined}
            className={cn(
              "rounded-[14px]",
              dialogBoundary && "max-h-[min(var(--radix-select-content-available-height),40dvh)]",
            )}
          >
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                className={dialogBoundary ? "min-h-11 py-2.5" : undefined}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
          {/* Radix portals the list, so reserve its space in modal layouts.
              The dialog grows naturally and keeps its viewport/keyboard cap;
              short screens scroll the options inside the dialog boundary. */}
          {selectOpen && dialogBoundary ? (
            <div
              aria-hidden="true"
              style={{ height: `min(${options.length * 44 + 18}px, 40dvh)` }}
            />
          ) : null}
        </Select>
      ) : (
        <div
          className={cn(
            equalWidthButtons
              ? DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME
              : "flex flex-wrap gap-2",
          )}
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
                  equalWidthButtons && DURATION_EQUAL_BUTTON_CLASSNAME,
                  active
                    ? (activeClassName ??
                      DURATION_SELECTED_OPTION_CLASSNAME)
                    : "border-[color:var(--app-separator)] bg-[color:var(--app-neutral-fill)] text-[color:var(--app-label)] hover:border-[color:var(--app-accent-ring)] hover:bg-[color:var(--app-neutral-fill-strong)]",
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
  placeholder = "Pick a reason…",
}: {
  value: ReasonValue | null;
  onChange: (next: ReasonValue) => void;
  label?: string;
  /** Both legacy presentations now use the same inline picker. */
  presentation?: "buttons" | "select";
  placeholder?: string;
}) {
  const labelId = useId();
  const valueId = useId();
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const closePicker = useCallback(() => {
    setExpanded(false);
    triggerRef.current?.focus();
  }, []);

  // Ask details owns depth 2. Its inline choice closes before that step unwinds.
  useBackLayer(
    ROUTES.ONE_LOCATION,
    expanded ? 3 : 0,
    () => {
      closePicker();
      return true;
    },
    { action: "ask" },
  );

  useEffect(() => {
    if (!expanded) return;
    const selected = optionsRef.current?.querySelector<HTMLButtonElement>(
      '[role="radio"][aria-checked="true"]',
    );
    (
      selected ?? optionsRef.current?.querySelector<HTMLButtonElement>("button")
    )?.focus();
  }, [expanded]);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        closePicker();
      }}
    >
      {label ? (
        <FormLabel as="p" id={labelId}>
          {label}
        </FormLabel>
      ) : null}
      <CollapsibleTrigger
        ref={triggerRef}
        aria-label={label || "Reason"}
        aria-describedby={valueId}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setExpanded(true);
        }}
      >
        <InputValue as="span" id={valueId}>
          {value ?? placeholder}
        </InputValue>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-[color:var(--app-secondary-label)]",
            expanded && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      {expanded ? (
        <CollapsibleContent>
          <ToggleGroupPrimitive.Root
            ref={optionsRef}
            type="single"
            value={value ?? ""}
            onValueChange={(next) => {
              if (next) onChange(next as ReasonValue);
              closePicker();
            }}
            role="radiogroup"
            aria-labelledby={label ? labelId : undefined}
            aria-label={label ? undefined : "Reason"}
            className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-2"
          >
            {REASON_CHIPS.map((reason) => (
              <ToggleGroupPrimitive.Item
                key={reason}
                value={reason}
                className={cn(
                  "flex min-h-11 min-w-0 items-center justify-between gap-1 rounded-[14px] border px-2 py-2 text-left transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
                  reason === value
                    ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]"
                    : "border-[color:var(--app-separator)] bg-[color:var(--app-neutral-fill)] text-foreground hover:border-[color:var(--app-accent-ring)] hover:bg-[color:var(--app-neutral-fill-strong)]",
                )}
              >
                <InputValue
                  as="span"
                  className={cn(
                    "shrink-0 whitespace-nowrap [--type-input-value-size:15px]",
                    reason === value && "[--app-label:var(--app-accent)]",
                  )}
                >
                  {reason}
                </InputValue>
                <CheckIcon
                  aria-hidden="true"
                  className={cn("size-3.5 shrink-0", reason !== value && "invisible")}
                />
              </ToggleGroupPrimitive.Item>
            ))}
          </ToggleGroupPrimitive.Root>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
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
        {...SEARCH_INPUT_KEYBOARD_PROPS}
        className={cn(LOCATION_SEARCH_INPUT_CLASSNAME, "pr-12")}
      />
      <SearchClearButton
        visible={value.length > 0}
        label={`Clear ${placeholder.toLowerCase()}`}
        onClear={() => onChange("")}
        className="text-[color:var(--app-tertiary-label)]"
      />
    </div>
  );
}
