"use client";

import { useMemo, useState } from "react";
import { calendarTimeZoneChoiceLabel, calendarTimeZoneChoiceLabelForWallTime, calendarTimeZoneChoices } from "@/lib/calendar/calendar-time-zone";

/** Native search and accessibility, with readable labels and exact IANA values. */
export function CalendarTimeZoneSelect({ value, at, date, time, onChange, disabled, className }: {
  value: string;
  at?: string | number;
  date?: string;
  time?: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  const zones = useMemo(() => calendarTimeZoneChoices(value), [value]);
  const ordinaryLabels = useMemo(() => date && time ? null : zones.map(zone => calendarTimeZoneChoiceLabel(zone, at)), [zones, at, date, time]);
  const wallTimeLabels = useMemo(() => date && time && focused
    ? zones.map(zone => calendarTimeZoneChoiceLabelForWallTime(zone, date, time))
    : null, [zones, date, time, focused]);

  return <select aria-label="Time zone" value={value} onChange={event => onChange(event.target.value)} onPointerDown={() => setFocused(true)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} disabled={disabled} className={className}>
    {zones.map((zone, index) => <option key={zone} value={zone}>{wallTimeLabels?.[index] ?? (date && time
      ? zone === value ? calendarTimeZoneChoiceLabelForWallTime(zone, date, time) : zone.split("/").at(-1)?.replaceAll("_", " ") || "Local time"
      : ordinaryLabels?.[index])}</option>)}
  </select>;
}
