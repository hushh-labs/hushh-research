"use client";

import { useRef, useState } from "react";
import {
  addDays,
  addMonths,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { cn } from "@/lib/utils";

const MONTHS = Array.from({ length: 12 }, (_, month) =>
  format(new Date(2024, month, 1), "MMMM"),
);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function displayDate(value: string): string {
  return value ? format(parseISO(value), "MMM d, yyyy") : "Choose date";
}

/** A single, explicit two-tap range control for the narrow request sheet. */
export function MobileDocumentDateRange({
  start,
  end,
  onStartChange,
  onEndChange,
}: {
  start: string;
  end: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState<"start" | "end" | null>(null);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const startButton = useRef<HTMLButtonElement>(null);
  const endButton = useRef<HTMLButtonElement>(null);
  const firstDay = startOfWeek(startOfMonth(month));
  const days = Array.from({ length: 42 }, (_, index) => addDays(firstDay, index));
  const years = Array.from(
    { length: Math.max(new Date().getFullYear() + 11 - 1900, month.getFullYear() - 1899) },
    (_, index) => 1900 + index,
  );

  const open = (field: "start" | "end") => {
    if (editing === field) {
      setEditing(null);
      return;
    }
    const relevantDate = field === "start" ? start : end || start;
    if (relevantDate) setMonth(startOfMonth(parseISO(relevantDate)));
    setEditing(field);
  };

  const choose = (date: Date) => {
    const selected = format(date, "yyyy-MM-dd");
    if (editing === "start") {
      onStartChange(selected);
      if (end && end < selected) onEndChange("");
      setEditing("end");
      endButton.current?.focus();
    } else {
      onEndChange(selected);
      setEditing(null);
      endButton.current?.focus();
    }
  };

  return (
    <div className="min-w-0 space-y-3 sm:hidden" data-mobile-document-dates>
      <div className="grid grid-cols-2 gap-2">
        {(["start", "end"] as const).map((field) => (
          <button
            key={field}
            ref={field === "start" ? startButton : endButton}
            type="button"
            aria-label={`${field === "start" ? "Start" : "End"} date: ${displayDate(field === "start" ? start : end)}`}
            aria-expanded={editing === field}
            aria-controls="mobile-document-calendar"
            onClick={() => open(field)}
            className={cn(
              "min-h-14 min-w-0 rounded-[var(--app-input-radius)] border bg-[color:var(--app-secondary-surface)] px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)]",
              editing === field
                ? "border-[color:var(--app-accent)]"
                : "border-[color:var(--app-separator)]",
            )}
          >
            <span className="block text-xs text-[color:var(--app-secondary-label)]">
              {field === "start" ? "Start date" : "End date"}
            </span>
            <span className="block truncate text-sm font-medium text-[color:var(--app-label)]">
              {displayDate(field === "start" ? start : end)}
            </span>
          </button>
        ))}
      </div>
      {editing ? (
        <div id="mobile-document-calendar" role="group" aria-label={`Choose ${editing} date`}>
          <span role="status" className="sr-only">
            {editing === "start" ? "Choose a start date." : "Choose an end date on or after the start date."}
          </span>
          <div className="mb-2 flex min-h-11 items-center justify-between gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(addMonths(month, -1))}
              className="min-h-11 min-w-11 rounded-full text-[color:var(--app-accent)] focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)]"
            >
              ‹
            </button>
            <select
              aria-label="Month"
              value={month.getMonth()}
              onChange={(event) =>
                setMonth(new Date(month.getFullYear(), Number(event.target.value), 1))
              }
              className="min-h-11 min-w-0 flex-1 rounded-[var(--app-input-radius)] bg-[color:var(--app-secondary-surface)] px-1 text-center text-sm font-semibold text-[color:var(--app-label)]"
            >
              {MONTHS.map((label, index) => (
                <option key={label} value={index}>{label}</option>
              ))}
            </select>
            <select
              aria-label="Year"
              value={month.getFullYear()}
              onChange={(event) =>
                setMonth(new Date(Number(event.target.value), month.getMonth(), 1))
              }
              className="min-h-11 w-[72px] rounded-[var(--app-input-radius)] bg-[color:var(--app-secondary-surface)] px-1 text-center text-sm font-semibold text-[color:var(--app-label)]"
            >
              {years.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(addMonths(month, 1))}
              className="min-h-11 min-w-11 rounded-full text-[color:var(--app-accent)] focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)]"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 text-center text-xs text-[color:var(--app-secondary-label)]">
            {WEEKDAYS.map((day) => <span key={day} className="min-w-11">{day}</span>)}
          </div>
          <div className="grid grid-cols-7" data-calendar-days>
            {days.map((date) => {
              const value = format(date, "yyyy-MM-dd");
              if (date.getMonth() !== month.getMonth())
                return <span key={value} aria-hidden="true" className="min-h-11 min-w-11" />;
              const selected = value === start || value === end;
              const inRange = Boolean(start && end && value > start && value < end);
              const unavailable = editing === "end" && Boolean(start && value < start);
              return (
                <button
                  key={value}
                  type="button"
                  aria-label={format(date, "EEEE, MMMM d, yyyy")}
                  aria-pressed={selected}
                  disabled={unavailable}
                  onClick={() => choose(date)}
                  className={cn(
                    "min-h-11 min-w-11 rounded-full text-sm font-medium focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)] disabled:opacity-30",
                    selected
                      ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                      : inRange
                        ? "bg-[color:var(--app-accent-tint)] text-[color:var(--app-label)]"
                        : "text-[color:var(--app-label)]",
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
