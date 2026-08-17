"use client";

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { DurationWheelPicker } from "./duration-wheel-picker";

export type DurationRung = { value: string; label: string };

/**
 * The duration ladder.
 *
 * A two-column scroll wheel is the right control for an arbitrary timer and
 * the wrong one for this: almost every share is one of five lengths, and the
 * wheel charged 200px of screen plus two coordinated drags to reach any of
 * them. The rungs are always visible, one tap each; the wheel is still here
 * for anything in between, behind `Custom`, where it costs nothing until
 * somebody asks for it.
 *
 * Rungs run from the 15-minute product floor (also the backend's floor —
 * `MIN_DURATION_HOURS = 0.25`) to a working day, roughly doubling each step.
 *
 * "Today" is deliberately absent. Its length is unreadable from its label —
 * 15 hours at 9am, 4 hours at 8pm — and it cannot survive the wheel at all:
 * `Number("today")` is NaN, so the wheel resolves it to 15 minutes and
 * writes "0.25" straight back over it.
 */
export const SHARE_DURATION_LADDER: DurationRung[] = [
  { value: "0.25", label: "15 min" },
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
  { value: "4", label: "4 hours" },
  { value: "8", label: "8 hours" },
];

export const SHARE_DURATION_UNTIL_STOP_VALUE = "until_stopped";

/** What `Custom` opens on when it is reached from the open-ended rung. */
const CUSTOM_SEED_VALUE = "1";

/**
 * Rows the on-demand wheel shows. 3, not the standalone 5: this panel opens
 * on a screen that was already too tall, and 5 rows is 200px. Must stay odd
 * — see the `pad` note in duration-wheel-picker's WheelColumn.
 */
export const DURATION_CUSTOM_VISIBLE_ROWS = 3;

/*
 * Exported so e2e/one-location-duration-ladder.layout.spec.ts measures the
 * SAME class strings this component ships, rather than a hand-copied harness
 * that can drift away from it.
 *
 * `min-h-11` (44px), not the `h-9` (36px) the surrounding chips use: 44pt is
 * Apple's minimum tap target and most of this app's users are on iPhone. A
 * raw <button>, not the morphy Button — that component's `size.default`
 * carries `min-h-[50px]` (a different tailwind-merge group from `h-*`, so it
 * survives every override) and `.ui-text-button-label`, which sets
 * `font-size: 17px !important`. At 17px "8 hours" does not fit an 80px cell
 * at 320px, and the grid reflows on exactly the phones that matter.
 *
 * From `sm` up the same cells stop being a grid and become a wrapping row of
 * content-width chips. A 3-column grid stretches: inside the 880px Location
 * shell each cell reached 258px, and inside the wider Share card 440px — six
 * slabs and a seventh full-width bar, 148px of screen to choose a number. As
 * chips the whole ladder is one 44px row. Phones keep the grid, because ragged
 * wrapping at 320px is worse than a tidy 3-column block and that layout is
 * already measured by e2e/one-location-duration-ladder.layout.spec.ts.
 */
export const DURATION_GRID_CLASS = "grid grid-cols-3 gap-2 sm:flex sm:flex-wrap";
export const DURATION_CELL_CLASS =
  "flex min-h-11 items-center justify-center whitespace-nowrap rounded-[14px] border px-2 text-center text-[15px] font-semibold leading-5 transition-colors touch-manipulation sm:px-4";
export const DURATION_CELL_OFF_CLASS =
  "border-border/70 bg-background text-foreground";
export const DURATION_CELL_ON_CLASS =
  "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]";

/**
 * "2h 45m" / "1h" / "45m" — six glyphs at most, so a live custom value still
 * fits the 80px cell at 320px.
 */
export function compactDurationLabel(value: string): string {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return "Custom";
  const totalMinutes = Math.round(hours * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!wholeHours) return `${minutes}m`;
  if (!minutes) return `${wholeHours}h`;
  return `${wholeHours}h ${minutes}m`;
}

export function DurationPresetPicker({
  value,
  onChange,
  rungs = SHARE_DURATION_LADDER,
  untilStopValue = SHARE_DURATION_UNTIL_STOP_VALUE,
  allowUntilStop = true,
  labelledBy,
}: {
  value: string;
  onChange: (next: string) => void;
  rungs?: DurationRung[];
  untilStopValue?: string;
  /**
   * False on the Request screen. "Until I stop" is a decision about your own
   * location; there is no such thing as asking to see someone else's until
   * THEY stop — the backend has no open-ended mode on that lane, and the
   * `durationHours` state this screen writes is shared with the public-link
   * and circle-invite lanes, which do `Number(value)` on it. Emitting a
   * non-numeric sentinel into it would send NaN to a `gt=0` field.
   */
  allowUntilStop?: boolean;
  labelledBy?: string;
}) {
  const isUntilStop = allowUntilStop && value === untilStopValue;
  const isCustomValue =
    !isUntilStop && !rungs.some((rung) => rung.value === value);

  // Seeded from the incoming value, so an edit that arrives on 2h47m opens
  // showing 2h47m instead of a preset it never chose.
  const [wheelOpen, setWheelOpen] = useState(isCustomValue);
  // The wheel has no row for the open-ended value, so remember the last real
  // number to hand it if Custom is opened from that rung. State, not a ref:
  // a ref written during render is what `react-hooks/refs` forbids, and this
  // one really is render-relevant — it decides what the wheel shows.
  const [lastTimed, setLastTimed] = useState(
    isUntilStop ? CUSTOM_SEED_VALUE : value,
  );
  useEffect(() => {
    if (!isUntilStop) setLastTimed(value);
  }, [isUntilStop, value]);

  const pickRung = useCallback(
    (next: string) => {
      setWheelOpen(false);
      onChange(next);
    },
    [onChange],
  );

  const openCustom = useCallback(() => {
    if (isUntilStop) onChange(lastTimed);
    setWheelOpen(true);
  }, [isUntilStop, lastTimed, onChange]);

  const customPressed = wheelOpen || isCustomValue;

  return (
    <div role="group" aria-labelledby={labelledBy} className="space-y-2">
      <div className={DURATION_GRID_CLASS}>
        {rungs.map((rung) => {
          const active = !wheelOpen && value === rung.value;
          return (
            <button
              key={rung.value}
              type="button"
              aria-pressed={active}
              onClick={() => pickRung(rung.value)}
              className={cn(
                DURATION_CELL_CLASS,
                active ? DURATION_CELL_ON_CLASS : DURATION_CELL_OFF_CLASS,
              )}
            >
              {rung.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={customPressed}
          aria-expanded={wheelOpen}
          onClick={() => (wheelOpen ? setWheelOpen(false) : openCustom())}
          className={cn(
            DURATION_CELL_CLASS,
            customPressed ? DURATION_CELL_ON_CLASS : DURATION_CELL_OFF_CLASS,
          )}
        >
          {isCustomValue ? compactDurationLabel(value) : "Custom"}
        </button>

        {/* The open-ended rung. Same height, border and radius as every cell
            beside it: it is the longest duration on the ladder, not a switch
            that greys out the control it sits under — which is where it was,
            and why its position read as wrong.

            It sits INSIDE the ladder, not under it. On a phone `col-span-3`
            gives it the full third row, which is the one place its label does
            not fit an 80px cell at 320px. From `sm` up the ladder is a
            wrapping chip row, where a column span means nothing and it is
            simply the last chip — so the whole control is one row instead of
            two rows plus a bar. */}
        {allowUntilStop ? (
          <button
            type="button"
            aria-pressed={isUntilStop}
            onClick={() => pickRung(untilStopValue)}
            className={cn(
              DURATION_CELL_CLASS,
              "col-span-3",
              isUntilStop ? DURATION_CELL_ON_CLASS : DURATION_CELL_OFF_CLASS,
            )}
          >
            Until I stop
          </button>
        ) : null}
      </div>

      {wheelOpen ? (
        <div className="space-y-2 pt-1">
          <DurationWheelPicker
            value={isUntilStop ? lastTimed : value}
            onChange={onChange}
            /* The toggle lives on the ladder above now — one piece of state,
               one control. */
            showUntilStop={false}
            /* The mask stops (30%/70%) still clear the centre row completely
               at 3 rows: full alpha spans 36–84px, the centre row spans
               40–80px. */
            visibleRows={DURATION_CUSTOM_VISIBLE_ROWS}
          />
          {/* No "Done" row. The wheel emits on every settle, so the value was
              already chosen before that button existed — it confirmed nothing
              and closed a panel the person can close by picking any other rung.
              It cost 52px on the tallest state of the tallest control on this
              screen, which is the screen that was called too busy. */}
        </div>
      ) : null}
    </div>
  );
}
