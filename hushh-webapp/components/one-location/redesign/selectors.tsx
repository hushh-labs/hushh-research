"use client";

/**
 * One Location redesign — selectors (duration / location type / reason chips / search).
 *
 * PRESENTATION ONLY. These are controlled inputs whose values are owned by the
 * existing page state (durationHours, requestMessage, recipientSearch, etc).
 * They do not introduce new business logic.
 */

import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";

/** Mirrors the existing page DURATION_OPTIONS so the Select/menu values stay identical. */
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
}: {
  value: string;
  onChange: (next: string) => void;
  options?: { value: string; label: string }[];
  label?: string;
}) {
  return (
    <div className="space-y-2">
      {label ? (
        <p className="text-sm font-semibold text-foreground">{label}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                "h-9 rounded-full border px-4 text-sm font-medium transition-colors touch-manipulation",
                active
                  ? "border-[#0a84ff] bg-[#0a84ff] text-white"
                  : "border-border/70 bg-background text-foreground hover:border-[#0a84ff]/40",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
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
      description: "Better for privacy",
    },
    {
      value: "precise",
      title: "Precise live location",
      description: "Updates while you move",
    },
  ];
  return (
    <div className="space-y-2">
      {label ? (
        <p className="text-sm font-semibold text-foreground">{label}</p>
      ) : null}
      <div className="grid gap-2">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                SUBCARD_SURFACE,
                "flex items-center justify-between p-3.5 text-left transition-colors",
                active && "border-[#0a84ff]/50 ring-1 ring-[#0a84ff]/30",
              )}
            >
              <span>
                <span className="block text-sm font-semibold text-foreground">
                  {option.title}
                </span>
                <span className={cn(MUTED_TEXT, "block")}>
                  {option.description}
                </span>
              </span>
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border-2",
                  active
                    ? "border-[#0a84ff] bg-[#0a84ff]"
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
  | "Safety check-in"
  | "Meeting nearby"
  | "Pick-up"
  | "Other";

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
}: {
  value: ReasonValue | null;
  onChange: (next: ReasonValue) => void;
  label?: string;
}) {
  return (
    <div className="space-y-2">
      {label ? (
        <p className="text-sm font-semibold text-foreground">{label}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {REASON_CHIPS.map((reason) => {
          const active = reason === value;
          return (
            <button
              key={reason}
              type="button"
              onClick={() => onChange(reason)}
              className={cn(
                "h-9 rounded-full border px-3.5 text-sm font-medium transition-colors touch-manipulation",
                active
                  ? "border-[#0a84ff] bg-[#0a84ff]/10 text-[#0a84ff]"
                  : "border-border/70 bg-background text-foreground hover:border-[#0a84ff]/40",
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
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-[14px] border border-border/70 bg-background pl-10 pr-4 text-base text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-[#0a84ff]/25"
      />
    </div>
  );
}
