import type { Ref } from "react";
import { ChevronLeft, ChevronRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { calendarDayLabel, shiftCalendarDate } from "./calendar-schedule-presentation";

export function CalendarDateNavigation({ date, today, disabled, onChange, todayRef, label = "Selected date" }: {
  date: string; today: string; disabled?: boolean; onChange: (date: string) => void;
  todayRef?: Ref<HTMLButtonElement>; label?: string;
}) {
  return <div className="flex min-h-11 items-center justify-between gap-2">
    <label className="relative min-w-0 cursor-pointer rounded-md text-[13px] sm:text-[15px] focus-within:ring-2 focus-within:ring-[color:var(--app-accent-ring)]"><span className="font-semibold">{calendarDayLabel(date)}</span><input aria-label={label} type="date" value={date} disabled={disabled} onChange={event => { if (event.target.value) onChange(event.target.value); }} className="absolute inset-0 w-full cursor-pointer opacity-0" /></label>
    <div className="flex shrink-0 items-center gap-1"><Button ref={todayRef} size="sm" variant="outline" disabled={disabled} className="h-11 rounded-full !bg-[color:var(--app-card-surface-compact)] px-3 font-normal !text-[color:var(--app-label)] shadow-none" onClick={() => onChange(today)}>Today</Button><Button size="icon" variant="ghost" className="size-11 !text-[color:var(--app-label)]" aria-label="Previous day" disabled={disabled} onClick={() => onChange(shiftCalendarDate(date, -1))}><ChevronLeft className="size-4" /></Button><Button size="icon" variant="ghost" className="size-11 !text-[color:var(--app-label)]" aria-label="Next day" disabled={disabled} onClick={() => onChange(shiftCalendarDate(date, 1))}><ChevronRight className="size-4" /></Button></div>
  </div>;
}
