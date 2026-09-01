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
 * `MIN_DURATION_HOURS = 0.25`) to a compact upper choice. Anything between
 * or beyond these common picks belongs behind `Custom`, where it is still one
 * deliberate tap away without making the default state read like a settings
 * panel.
 *
 * "Today" is deliberately absent. Its length is unreadable from its label —
 * 15 hours at 9am, 4 hours at 8pm — and it cannot survive the wheel at all:
 * `Number("today")` is NaN, so the wheel resolves it to 15 minutes and
 * writes "0.25" straight back over it.
 */
export const SHARE_DURATION_LADDER: DurationRung[] = [
  { value: "0.25", label: "15 min" },
  { value: "1", label: "1 hour" },
];

/**
 * Asking someone else for their location.
 *
 * Three rungs plus `Custom`, which the picker appends -- four cells, two rows
 * of two on a phone. It was five rungs plus Custom, and six cells is where a
 * ladder stops being a row of choices and starts being a keypad: the screen it
 * sits on also carries four Reason chips, a recipient rail and two stacked
 * actions, so the duration question alone was three rows of the card.
 *
 * The three that stay are the ones an ask is actually made in -- "where are
 * you now" (15 min), the default hour, and an afternoon (2 hours). 4 and 8
 * hours did not disappear: `Custom` reaches any value the backend accepts, and
 * a cell that is one deliberate tap away is not a feature removed.
 *
 * This is `FULL_DURATION_LADDER` renamed, not a second constant beside it.
 * That name was already only half true -- issue #6228 moved the live-share
 * editor onto {@link CHANGE_TIME_DURATION_LADDER}, leaving "full" describing
 * one lane -- and once trimmed it would have been the SHORTEST ladder in the
 * file while still calling itself the fullest.
 */
export const REQUEST_DURATION_LADDER: DurationRung[] = [
  { value: "0.25", label: "15 min" },
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
];

/**
 * The "Change time" ladder — the live-share end-time editor that opens from
 * the running-share card.
 *
 * Four common lengths plus the open-ended rung, and nothing else: no `8 hours`
 * and no `Custom` wheel. Changing a share that is already running is a quick
 * decision, and the sixth near-identical choice plus a two-drag scroll wheel
 * made the panel read like a settings screen sitting under the live clock.
 * Anything between these lengths is still reachable by stopping the share and
 * starting a new one.
 */
export const CHANGE_TIME_DURATION_LADDER: DurationRung[] = [
  { value: "0.25", label: "15 min" },
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
  { value: "4", label: "4 hours" },
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
 * `font-size: 17px !important`. At 17px "Until I stop" does not fit a compact
 * iPhone cell, and the grid reflows on exactly the phones that matter.
 *
 * From `sm` up the same cells stop being a grid and become a wrapping row of
 * content-width chips. A fixed grid stretches: inside the 880px Location
 * shell each cell reached 258px, and inside the wider Share card 440px —
 * slabs instead of choices. As
 * chips the whole ladder is one 44px row. Phones keep the grid, because ragged
 * wrapping at 320px is worse than a tidy two-column block and that layout is
 * already measured by e2e/one-location-duration-ladder.layout.spec.ts.
 */
export const DURATION_GRID_CLASS =
  "grid grid-cols-2 gap-2 sm:flex sm:flex-wrap";
export const DURATION_CELL_CLASS =
  "flex min-h-11 items-center justify-center whitespace-nowrap rounded-[14px] border px-2 text-center text-[15px] font-semibold leading-5 transition-colors touch-manipulation sm:px-4";
export const DURATION_CELL_OFF_CLASS =
  "border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] text-[color:var(--app-label)] hover:border-[color:var(--app-accent-ring)] hover:bg-[color:var(--app-neutral-fill-strong)]";
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
  allowCustom = true,
  centered = false,
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
  /**
   * False drops the `Custom` cell and the scroll wheel behind it entirely, for
   * lanes where the timed rungs plus the open-ended row are the whole choice
   * (the live-share "New time" editor — see issue #6228). An off-grid incoming
   * value simply leaves no rung pressed; the read-back hint still states it.
   */
  allowCustom?: boolean;
  /**
   * From `sm` up, centre the wrapping chip row inside its container rather than
   * letting it start at the far left, and on the phone grid let the open-ended
   * row span both columns so it does not sit alone in the left cell. Used by
   * the "Change time" editor, whose container is much wider than the ladder.
   */
  centered?: boolean;
  labelledBy?: string;
}) {
  const isUntilStop = allowUntilStop && value === untilStopValue;
  const isCustomValue =
    !isUntilStop && !rungs.some((rung) => rung.value === value);

  // Seeded from the incoming value, so an edit that arrives on 2h47m opens
  // showing 2h47m instead of a preset it never chose. Never opens when the
  // wheel is disabled — there is no cell to close it from.
  const [wheelOpen, setWheelOpen] = useState(allowCustom && isCustomValue);
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
      <div className={cn(DURATION_GRID_CLASS, centered && "sm:justify-center")}>
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
        {allowCustom ? (
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
        ) : null}

        {/* The open-ended rung. Same height, border and radius as every cell
            beside it: it is the longest duration on the ladder, not a switch
            that greys out the control it sits under.

            It sits INSIDE the ladder, not under it, and shares the same
            two-by-two mobile grid as the timed choices. From `sm` up the
            ladder is a wrapping chip row, where it is simply the last chip.

            `centered` gives it both columns of the phone grid, so with an even
            number of timed rungs beside it, it is a full-width row rather than
            a lone chip in the left cell. */}
        {allowUntilStop ? (
          <button
            type="button"
            aria-pressed={isUntilStop}
            onClick={() => pickRung(untilStopValue)}
            className={cn(
              DURATION_CELL_CLASS,
              centered && "col-span-2 sm:col-span-1",
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
