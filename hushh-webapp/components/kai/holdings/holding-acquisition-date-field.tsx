"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { addDays, addMonths, format, getDaysInMonth, parseISO, setMonth, setYear, startOfMonth } from "date-fns";
import { Calendar, ChevronLeft, ChevronRight } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { normalizeHoldingAcquisitionDate } from "@/lib/kai/holding-validation";
import { cn } from "@/lib/utils";

interface HoldingAcquisitionDateFieldProps {
  value?: string;
  max: string;
  error?: string;
  calendarOpen: boolean;
  onCalendarOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
}

const months = Array.from({ length: 12 }, (_, month) => format(new Date(2024, month, 1), "MMMM"));
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const navigationClass = "grid size-11 shrink-0 place-items-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40";
const selectClass = "min-h-11 min-w-0 gap-1 px-2";
const selectMenuClass = "max-h-[min(16rem,var(--radix-select-content-available-height))] rounded-[var(--app-card-radius-compact)]";

function displayDate(value?: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  return iso ? [iso[3], iso[2], iso[1]].join("/") : value ?? "";
}

export function HoldingAcquisitionDateField({
  value,
  max,
  error,
  calendarOpen,
  onCalendarOpenChange,
  onChange,
}: HoldingAcquisitionDateFieldProps) {
  const calendarId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const selectedDate = normalizeHoldingAcquisitionDate(value);
  const maxMonth = startOfMonth(parseISO(max));
  const [month, setVisibleMonth] = useState(() => maxMonth);
  const year = month.getFullYear();
  const earliestYear = Math.min(1900, year);

  useEffect(() => {
    if (calendarOpen) {
      panel.current?.focus({ preventScroll: true });
      panel.current?.scrollIntoView?.({ block: "nearest" });
    } else if (wasOpen.current) {
      trigger.current?.focus();
    }
    wasOpen.current = calendarOpen;
  }, [calendarOpen]);

  function toggleCalendar() {
    if (!calendarOpen) {
      const initialDate = selectedDate && selectedDate <= max ? selectedDate : max;
      setVisibleMonth(startOfMonth(parseISO(initialDate)));
    }
    onCalendarOpenChange(!calendarOpen);
  }

  function changeDate(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const raw = input.value;
    const pastedIso = displayDate(raw);
    const previous = displayDate(value);
    const inputType = (event.nativeEvent as InputEvent).inputType;
    let digits = raw.replace(/\D/g, "");
    let beforeCaret = raw.slice(0, input.selectionStart ?? raw.length).replace(/\D/g, "").length;
    // A generated slash isn't editable. Delete its adjacent digit and keep the caret there.
    if (inputType?.startsWith("delete") && raw.length < previous.length && digits === previous.replace(/\D/g, "")) {
      const index = inputType === "deleteContentBackward" ? Math.max(0, beforeCaret - 1) : beforeCaret;
      digits = digits.slice(0, index) + digits.slice(index + 1);
      beforeCaret = index;
    }
    const masked = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join("/");
    const formatted = pastedIso === raw ? masked : pastedIso;
    if (formatted !== raw) {
      const caret = pastedIso === raw
        ? Math.min(formatted.length, beforeCaret + Number(beforeCaret > 2) + Number(beforeCaret > 4))
        : formatted.length;
      input.value = formatted;
      input.setSelectionRange(caret, caret);
    }
    onChange(formatted);
  }

  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor="holding-acquisition-date" className="ui-text-form-label">Acquisition date</label>
      <div className="relative">
        <Input
          id="holding-acquisition-date"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "holding-acquisition-date-error" : undefined}
          className="h-11 pr-28 text-base sm:text-sm"
          type="text"
          inputMode="numeric"
          placeholder="DD/MM/YYYY"
          value={displayDate(value)}
          onChange={changeDate}
        />
        <div className="absolute inset-y-0 right-0 flex">
          <button
            type="button"
            onClick={() => { onChange(max); onCalendarOpenChange(false); }}
            className="ui-text-compact-button-label grid w-14 place-items-center text-[color:var(--app-accent)] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          >
            Today
          </button>
          <button
            ref={trigger}
            type="button"
            aria-label="Choose acquisition date from calendar"
            aria-expanded={calendarOpen}
            aria-controls={calendarOpen ? calendarId : undefined}
            onClick={toggleCalendar}
            className="grid w-11 place-items-center rounded-r-[var(--app-input-radius)] text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          >
            <Calendar className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {error ? <p id="holding-acquisition-date-error" className="ui-text-row-description text-destructive">{error}</p> : null}
      {calendarOpen && (
        <div
          id={calendarId}
          ref={panel}
          tabIndex={-1}
          role="group"
          aria-label="Acquisition date calendar"
          data-vaul-no-drag
          className="mx-auto w-full max-w-sm rounded-[var(--app-card-radius-standard)] border border-border bg-background p-2 outline-none"
        >
          <div className="mb-2 flex items-center gap-1">
            <button type="button" aria-label="Previous month" className={navigationClass}
              disabled={year === 1 && month.getMonth() === 0}
              onClick={() => setVisibleMonth(addMonths(month, -1))}>
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <Select value={String(month.getMonth())}
              onValueChange={(value) => setVisibleMonth(setMonth(month, Number(value)))}>
              <SelectTrigger aria-label="Acquisition month" className={cn(selectClass, "flex-1")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={selectMenuClass}>
                {months.map((label, index) => (
                  <SelectItem key={label} value={String(index)}
                    disabled={year === maxMonth.getFullYear() && index > maxMonth.getMonth()}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={(value) => {
              const next = setYear(month, Number(value));
              setVisibleMonth(next > maxMonth ? maxMonth : next);
            }}>
              <SelectTrigger aria-label="Acquisition year" className={selectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={selectMenuClass}>
                {Array.from({ length: maxMonth.getFullYear() - earliestYear + 1 }, (_, index) => {
                  const option = String(maxMonth.getFullYear() - index);
                  return <SelectItem key={option} value={option}>{option}</SelectItem>;
                })}
              </SelectContent>
            </Select>
            <button type="button" aria-label="Next month" className={navigationClass}
              disabled={month >= maxMonth}
              onClick={() => setVisibleMonth(addMonths(month, 1))}>
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-7 text-center ui-text-row-description text-muted-foreground" aria-hidden="true">
            {weekdays.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: month.getDay() }, (_, index) => <span key={index} aria-hidden="true" />)}
            {Array.from({ length: getDaysInMonth(month) }, (_, index) => {
              const date = addDays(month, index);
              const iso = format(date, "yyyy-MM-dd");
              const selected = iso === selectedDate;
              return (
                <button
                  key={iso}
                  type="button"
                  aria-label={format(date, "EEEE, MMMM d, yyyy")}
                  aria-pressed={selected}
                  disabled={iso > max}
                  className={cn(
                    "min-h-11 min-w-0 rounded-full text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-35",
                    selected ? "bg-primary text-primary-foreground" : "enabled:hover:bg-muted",
                  )}
                  onClick={() => {
                    onChange(iso);
                    onCalendarOpenChange(false);
                  }}
                >
                  {index + 1}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
