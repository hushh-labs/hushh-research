"use client";

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, addMonths, format, getDaysInMonth, parseISO, startOfMonth } from "date-fns";
import { Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, Clock } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./advisor-review.module.css";
import { bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZoneChoiceLabel, calendarTimeZoneChoiceLabelForWallTime, calendarTimeZoneChoices } from "@/lib/calendar/calendar-time-zone";

const hours = Array.from({ length: 12 }, (_, value) => String(value + 1).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, value) => String(value).padStart(2, "0"));
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const menuClass = "rounded-[var(--app-card-radius-compact)] max-h-[min(11rem,var(--radix-select-content-available-height))]";
const fieldClass = "min-h-11 w-full min-w-0";

export function AdvisorDatePicker({ value, zone, onChange, disabled }: {
  value: string; zone: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const today = bookingLocalFields(new Date().toISOString(), zone).date;
  const [month, setMonth] = useState(() => startOfMonth(parseISO(value || today)));
  const minMonth = startOfMonth(parseISO(today));
  return (
    <Popover onOpenChange={(open) => { if (open) setMonth(startOfMonth(parseISO(value || today))); }}>
      <PopoverTrigger asChild>
        <ShellActionSurface type="button" variant="pill" aria-label={value ? `Date, ${value}` : "Choose date"} disabled={disabled} className={fieldClass}>
          <Calendar aria-hidden className="size-4" />
          {value ? format(parseISO(value), "d MMM yyyy") : "Choose date"}
        </ShellActionSurface>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Choose meeting date" className="w-80 max-w-[calc(100vw-2rem)] rounded-[var(--app-card-radius-standard)] p-2">
        <div className="mb-1 flex items-center justify-between">
          <ShellActionSurface type="button" variant="icon" aria-label="Previous month" disabled={month <= minMonth}
            onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft aria-hidden className="size-4" /></ShellActionSurface>
          <span aria-live="polite" className="ui-text-section-label">{format(month, "MMMM yyyy")}</span>
          <ShellActionSurface type="button" variant="icon" aria-label="Next month"
            onClick={() => setMonth(addMonths(month, 1))}><ChevronRight aria-hidden className="size-4" /></ShellActionSurface>
        </div>
        <div className="grid grid-cols-7 text-center ui-text-helper-text" aria-hidden>
          {days.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: month.getDay() }, (_, index) => <span key={index} aria-hidden />)}
          {Array.from({ length: getDaysInMonth(month) }, (_, index) => {
            const day = addDays(month, index);
            const iso = format(day, "yyyy-MM-dd");
            return <PopoverClose key={iso} asChild>
              <button type="button" aria-label={format(day, "EEEE, MMMM d, yyyy")} aria-pressed={value === iso}
                disabled={iso < today} onClick={() => onChange(iso)}
                className="min-h-10 rounded-full text-sm enabled:hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground disabled:opacity-40">
                {index + 1}
              </button>
            </PopoverClose>;
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimePart({ label, values, value, onChange, scroll }: {
  label: string; values: readonly string[]; value: string; onChange: (value: string) => void; scroll?: boolean;
}) {
  const name = useId();
  const column = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = column.current;
    const selected = list?.querySelector<HTMLInputElement>("input:checked");
    if (scroll && list && selected?.parentElement) {
      list.scrollTop = Math.max(0, selected.parentElement.offsetTop - 36);
    }
  }, [scroll]);
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 px-1 ui-text-row-description">{label}</legend>
      <div ref={column} data-vaul-no-drag className={scroll
        ? "relative max-h-36 snap-y snap-proximity touch-pan-y overflow-y-auto overscroll-contain"
        : undefined}>
        {values.map((part) => (
          <label key={part} className={`${styles.timeChoice} relative flex min-h-9 snap-start cursor-pointer items-center justify-center px-1
            has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-primary`}>
            <input type="radio" className="sr-only" name={name} value={part}
              checked={value === part} onChange={() => onChange(part)} />
            {part}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function clockParts(value: string) {
  const hour = Number(value.slice(0, 2));
  return {
    hour: String(hour % 12 || 12).padStart(2, "0"),
    minute: value.slice(3) || "00",
    period: hour >= 12 ? "PM" : "AM",
  };
}

export function AdvisorTimePicker({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const [draft, setDraft] = useState(() => clockParts(value));
  const shown = clockParts(value);
  const label = value ? `${shown.hour}:${shown.minute} ${shown.period}` : "Choose time";

  return (
    <Popover modal onOpenChange={(open) => { if (open) setDraft(clockParts(value)); }}>
      <PopoverTrigger asChild>
        <ShellActionSurface type="button" variant="pill" aria-label={value ? `Time, ${label}` : label}
          disabled={disabled} className={`${fieldClass} justify-between ui-text-compact-button-label`}>
          {label}<Clock aria-hidden className="size-4 shrink-0" />
        </ShellActionSurface>
      </PopoverTrigger>
      <PopoverContent align="end" withBackdrop={false} aria-label="Choose meeting time"
        className="w-62 max-w-[calc(100vw-2rem)] rounded-[var(--app-card-radius-standard)] p-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <TimePart label="Hour" values={hours} value={draft.hour} scroll
            onChange={(hour) => setDraft((current) => ({ ...current, hour }))} />
          <TimePart label="Minute" values={minutes} value={draft.minute} scroll
            onChange={(minute) => setDraft((current) => ({ ...current, minute }))} />
          <TimePart label="AM / PM" values={["AM", "PM"]} value={draft.period}
            onChange={(period) => setDraft((current) => ({ ...current, period }))} />
        </div>
        <div className="mt-2 flex justify-end border-t pt-1.5">
          <PopoverClose asChild>
            <ShellActionSurface type="button" variant="pill" className={`${styles.timeDone} min-h-9 ui-text-compact-button-label`}
              onClick={() => {
                const hour = Number(draft.hour) % 12 + (draft.period === "PM" ? 12 : 0);
                onChange(`${String(hour).padStart(2, "0")}:${draft.minute}`);
              }}>Done</ShellActionSurface>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AdvisorDurationPicker({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger aria-label="Duration" className="min-h-11 w-fit min-w-0 gap-2"><SelectValue /></SelectTrigger>
    <SelectContent className={menuClass}>
      {["15", "30", "60"].map((part) => <SelectItem key={part} value={part} className="rounded-lg">{part} minutes</SelectItem>)}
    </SelectContent>
  </Select>;
}

export function AdvisorTimeZonePicker({ value, deviceZone, date, time, onChange, disabled }: {
  value: string; deviceZone: string; date: string; time: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => calendarTimeZoneChoices(value), [value]);
  const display = useCallback((zone: string) => {
    const label = date && time
      ? calendarTimeZoneChoiceLabelForWallTime(zone, date, time)
      : calendarTimeZoneChoiceLabel(zone, date ? `${date}T12:00:00Z` : undefined);
    const [city = "Local time", offset = label] = label.endsWith(")") ? label.slice(0, -1).split(" (") : ["UTC", label];
    return { city: zone === "Asia/Kolkata" ? "Mumbai, Kolkata" : city, offset };
  }, [date, time]);
  const choices = useMemo(
    () => open ? zones.map((zone) => ({ zone, ...display(zone) })) : [],
    [open, zones, display],
  );
  const selected = display(value);
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ShellActionSurface type="button" variant="pill" aria-label={`Time zone, ${selected.city}, ${selected.offset}`}
          disabled={disabled} className={`${fieldClass} justify-between ui-text-compact-button-label`}>
          <span className="min-w-0 flex-1 truncate text-left">{selected.city}</span>
          <span className="shrink-0 ui-text-row-description">{selected.offset}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        </ShellActionSurface>
      </PopoverTrigger>
      <PopoverContent align="start" withBackdrop={false} aria-label="Choose time zone"
        className="w-[var(--radix-popover-trigger-width)] rounded-[var(--app-card-radius-compact)] p-1">
        <Command>
          <CommandInput aria-label="Search time zone" placeholder="Search city or time zone" />
          <CommandList className="max-h-40 touch-pan-y overscroll-contain" data-vaul-no-drag>
            <CommandEmpty>No matching time zones.</CommandEmpty>
            {choices.map(({ zone, city, offset }) => (
              <CommandItem key={zone} value={zone}
                keywords={[city, zone.replaceAll("_", " "), ...(zone === "Asia/Kolkata" ? ["Calcutta"] : [])]}
                onSelect={() => { onChange(zone); setOpen(false); }}
                className="min-h-9 rounded-lg">
                {zone === value ? <Check aria-hidden className="size-3 shrink-0" /> : null}
                <span className="min-w-0 flex-1">
                  {city}
                  {zone === deviceZone ? <span className="block ui-text-helper-text">Device time zone</span> : null}
                </span>
                <span className="shrink-0 ui-text-helper-text">{offset}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
