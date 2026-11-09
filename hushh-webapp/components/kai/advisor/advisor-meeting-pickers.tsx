"use client";

import { useMemo, useState } from "react";
import { addDays, addMonths, format, getDaysInMonth, parseISO, startOfMonth } from "date-fns";
import { Calendar, ChevronLeft, ChevronRight } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown } from "@/components/icons";
import { bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZoneChoiceLabel, calendarTimeZoneChoiceLabelForWallTime, calendarTimeZoneChoices } from "@/lib/calendar/calendar-time-zone";

const hours = Array.from({ length: 24 }, (_, value) => String(value).padStart(2, "0"));
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

function TimePart({ label, values, value, onChange, disabled }: {
  label: string; values: readonly string[]; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger aria-label={label} className={fieldClass}><SelectValue placeholder={label} /></SelectTrigger>
    <SelectContent className={menuClass}>
      {values.map((part) => <SelectItem key={part} value={part} className="rounded-lg">{part}</SelectItem>)}
    </SelectContent>
  </Select>;
}

export function AdvisorTimePicker({ hour, minute, onHour, onMinute, disabled }: {
  hour: string; minute: string; onHour: (value: string) => void; onMinute: (value: string) => void; disabled: boolean;
}) {
  return <div className="grid grid-cols-2 gap-2" role="group" aria-label="Time, 24-hour clock">
    <TimePart label="Hour" values={hours} value={hour} onChange={onHour} disabled={disabled} />
    <TimePart label="Minute" values={minutes} value={minute} onChange={onMinute} disabled={disabled} />
  </div>;
}

export function AdvisorDurationPicker({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger aria-label="Duration" className={fieldClass}><SelectValue /></SelectTrigger>
    <SelectContent className={menuClass}>
      {["15", "30", "60"].map((part) => <SelectItem key={part} value={part} className="rounded-lg">{part} minutes</SelectItem>)}
    </SelectContent>
  </Select>;
}

export function AdvisorTimeZonePicker({ value, date, time, onChange, disabled }: {
  value: string; date: string; time: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => calendarTimeZoneChoices(value), [value]);
  const label = (zone: string) => date && time
    ? calendarTimeZoneChoiceLabelForWallTime(zone, date, time)
    : calendarTimeZoneChoiceLabel(zone, date ? `${date}T12:00:00Z` : undefined);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ShellActionSurface type="button" variant="pill" aria-label={`Time zone, ${label(value)}`}
          disabled={disabled} className={`${fieldClass} justify-between`}>
          {label(value)} <ChevronDown aria-hidden className="size-4" />
        </ShellActionSurface>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Choose time zone"
        className="w-[var(--radix-popover-trigger-width)] rounded-[var(--app-card-radius-compact)] p-1">
        <Command>
          <CommandInput aria-label="Search time zone" placeholder="Search city or time zone" />
          <CommandList className="max-h-40" data-vaul-no-drag>
            <CommandEmpty>No matching time zones.</CommandEmpty>
            {zones.map((zone) => (
              <CommandItem key={zone} value={zone}
                keywords={zone === "Asia/Kolkata" ? ["Kolkata", "Mumbai", "Calcutta"] : [zone.replaceAll("_", " ")]}
                onSelect={() => { onChange(zone); setOpen(false); }}
                className="min-h-9 rounded-lg">
                {label(zone)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
