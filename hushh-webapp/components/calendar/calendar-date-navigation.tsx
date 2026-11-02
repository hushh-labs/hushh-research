import type { Ref } from "react";
import { ChevronLeft, ChevronRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { calendarDayLabel, shiftCalendarDate } from "./calendar-schedule-presentation";

export function CalendarDateNavigation({ date, today, disabled, onChange, todayRef, label = "Selected date" }: {
  date: string; today: string; disabled?: boolean; onChange: (date: string) => void;
  todayRef?: Ref<HTMLButtonElement>; label?: string;
}) {
  const isToday = date === today;
  return <div className="flex min-h-11 items-center justify-between gap-2">
    <label className="relative flex min-h-11 min-w-0 cursor-pointer items-center rounded-md text-[13px] sm:text-[15px] focus-within:ring-2 focus-within:ring-[color:var(--app-accent-ring)]"><span className="font-semibold">{calendarDayLabel(date)}</span><input aria-label={label} type="date" value={date} disabled={disabled} onChange={event => { if (event.target.value) onChange(event.target.value); }} className="absolute inset-0 w-full cursor-pointer opacity-0" /></label>
    <div role="group" aria-label="Change day" className="flex shrink-0 items-center"><Button size="icon" variant="ghost" className="size-11 !text-[color:var(--app-label)]" aria-label="Previous day" disabled={disabled} onClick={() => onChange(shiftCalendarDate(date, -1))}><ChevronLeft className="size-4" /></Button><Button ref={todayRef} size="sm" variant="outline" disabled={disabled} aria-current={isToday ? "date" : undefined} data-today={isToday ? "true" : undefined} className={cn("h-11 min-w-[4.5rem] rounded-full px-3 font-normal shadow-none", isToday ? "!border-transparent !bg-[color:var(--app-accent-surface)] !text-[color:var(--app-accent)]" : "!bg-[color:var(--app-card-surface-compact)] !text-[color:var(--app-label)]")} onClick={() => onChange(today)}>Today</Button><Button size="icon" variant="ghost" className="size-11 !text-[color:var(--app-label)]" aria-label="Next day" disabled={disabled} onClick={() => onChange(shiftCalendarDate(date, 1))}><ChevronRight className="size-4" /></Button></div>
  </div>;
}
