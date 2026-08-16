"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import useEmblaCarousel from "embla-carousel-react";
import type { EmblaCarouselType, EmblaOptionsType } from "embla-carousel";

import { cn } from "@/lib/utils";

/** Mirrors check-in-flow.tsx's UNTIL_STOP_VALUE — the max accepted grant window. */
export const DURATION_WHEEL_UNTIL_STOP_VALUE = "24";

/** The backend caps a grant at 24 hours (`le=24`, consent-protocol/api/routes/one/location.py). */
const MAX_HOURS = 24;
const HOURS_VALUES = Array.from({ length: MAX_HOURS + 1 }, (_, i) => i); // 0..24
const MINUTE_VALUES = [0, 15, 30, 45];

/**
 * Which minutes exist at a given hour. Both ends of the range are product
 * rules, and both are expressed by REMOVING the row rather than by letting
 * someone land on it and yanking them off it:
 *
 *   0h  — 0h00m is not a duration, and 15 minutes is the floor for sharing.
 *   24h — 24h15m fails the backend's `le=24`, so the hour has only :00.
 *
 * The old code offered :00 at zero hours and then bounced the wheel back to
 * :15 under the person's finger. That bounce is why "1 hour" read as broken:
 * the natural order is minutes-then-hours, and minutes-first bounced.
 */
function minuteItemsForHour(hour: number): number[] {
  if (hour <= 0) return [15, 30, 45];
  if (hour >= MAX_HOURS) return [0];
  return MINUTE_VALUES;
}

const ALL_GRID_MINUTES = HOURS_VALUES.flatMap((h) =>
  minuteItemsForHour(h).map((m) => h * 60 + m),
); // 15..1440 in 15-minute steps, minus the two impossible ends

/** Exported so a layout fixture can derive the wheel's height instead of
 *  hand-copying it and silently drifting when this changes. */
export const DURATION_WHEEL_ITEM_HEIGHT_PX = 40;
const ITEM_HEIGHT = DURATION_WHEEL_ITEM_HEIGHT_PX;
const DEFAULT_VISIBLE_ROWS = 5;

function nearestGridMinutes(totalMinutes: number): number {
  // `<=`, not `<`: on an exact tie this rounds up to the later, larger
  // candidate rather than silently shrinking a caller's requested duration.
  return ALL_GRID_MINUTES.reduce((best, candidate) =>
    Math.abs(candidate - totalMinutes) <= Math.abs(best - totalMinutes) ? candidate : best,
  );
}

function formatDurationHours(hoursIndex: number, minutesValue: number): string {
  const totalMinutes = hoursIndex * 60 + minutesValue;
  return String(Math.round((totalMinutes / 60) * 100) / 100);
}

function parseDurationValue(
  value: string,
  untilStopValue: string,
): { untilStop: boolean; hoursIndex: number; minutesValue: number } {
  if (value === untilStopValue) {
    return { untilStop: true, hoursIndex: 1, minutesValue: 0 };
  }
  const num = Number(value);
  const totalMinutes = Number.isFinite(num) ? Math.round(num * 60) : 15;
  const nearest = nearestGridMinutes(totalMinutes);
  return {
    untilStop: false,
    hoursIndex: Math.floor(nearest / 60),
    minutesValue: nearest % 60,
  };
}

/**
 * One scroll wheel of real values, framed by `pad` blank spacer slides on
 * each side so the first/last real value can still center in the viewport.
 * Thanks to `align: "start"` (see the options below), Embla's own index
 * space (startIndex, scrollTo, selectedScrollSnap) already lines up with
 * REAL, 0-based item space -- no separate padded-index conversion needed
 * anywhere in this component.
 */
function WheelColumn({
  items,
  formatLabel,
  selectedIndex,
  onSettledIndex,
  apiRef,
  disabled,
  ariaLabel,
  unitSuffix,
  resyncToken,
  visibleRows,
}: {
  items: number[];
  formatLabel: (value: number) => string;
  selectedIndex: number;
  onSettledIndex: (index: number) => void;
  apiRef: MutableRefObject<EmblaCarouselType | null>;
  disabled: boolean;
  ariaLabel: string;
  unitSuffix: string;
  /** Bumped by the parent on an EXTERNAL value change (e.g. cancel-edit
   * resetting the field) to force this wheel to jump to `selectedIndex`. */
  resyncToken: number;
  visibleRows: number;
}) {
  // Blank rows on each side, as real (empty) slides -- not container padding.
  // Embla measures every slide's own offsetTop/offsetHeight to place snap
  // points; mixing in out-of-band CSS padding on the container was fighting
  // that math (the highlight bar landing one row off from the item Embla had
  // actually settled on, and the reachable scroll range coming up short of
  // the last item). Uniform slides, all real, all the same height, is the
  // case Embla's own alignment math is built to get right.
  //
  // Also equal to the center row's own row-index within the viewport -- see
  // the `align: "start"` note below for why that equality is what makes
  // `scrollTo(realIndex)` work with no further offset. It holds for any ODD
  // `visibleRows` (5 standalone, 3 inside the compact panel); an even value
  // would silently break the highlight alignment, so keep them odd.
  const pad = Math.floor(visibleRows / 2);
  const viewportHeight = ITEM_HEIGHT * visibleRows;

  // Seeded ONCE from the initial index and never touched again, and
  // `disabled` is deliberately NOT wired into any Embla option. Either one
  // changing the options object would make embla-carousel-react reInit the
  // whole engine (it reInits whenever the options it's passed are no longer
  // deep-equal) -- reInitializing mid-interaction, or the instant "Until I
  // stop" is toggled, is the exact failure mode swipe-views.tsx's
  // measurement comments warn against. Drag is fully blocked by the
  // ancestor's `pointer-events-none` while disabled, wheel-scroll
  // unsubscribes itself, and keyboard checks `disabled` directly -- so Embla
  // never needs to know, these options stay frozen for the component's
  // whole life, and Embla reInits only where this file asks it to.
  // `align: "start"`, not `"center"`: with `containScroll: false` (see
  // below), Embla's own `"center"` alignment measures against the SLIDE
  // CONTAINER's full size (here, all N+2*pad slides stacked) rather than the
  // visible viewport, so it centers each slide one whole viewport off from
  // where it's actually rendered -- the highlighted row and the physically
  // centered row pointing at two different numbers, on first mount and after
  // every scroll, with no way to correct it from the outside (its own
  // `reInit()` recomputes the exact same wrong number, since it's a
  // measurement convention, not stale data). `"start"` sidesteps that: it
  // flushes the REQUESTED slide's top edge to the viewport's top edge, no
  // container-size measurement involved at all. Requesting `realIndex`
  // directly (not `realIndex + pad`) still lands the right slide in the
  // CENTER row, not the top one: `pad` leading spacer slides already sit
  // above every real item, and `pad` is also exactly the center row's own
  // row-index in the viewport -- flushing slide `realIndex` to the top
  // pushes the real item `pad` slides later down into exactly the center row.
  const [startIndex] = useState(selectedIndex);
  const options: EmblaOptionsType = {
    axis: "y",
    loop: false,
    align: "start",
    containScroll: false,
    dragFree: false,
    skipSnaps: false,
    duration: 18,
    dragThreshold: 8,
    startIndex,
  };
  const [emblaRef, emblaApi] = useEmblaCarousel(options);

  useEffect(() => {
    apiRef.current = emblaApi ?? null;
  }, [emblaApi, apiRef]);

  // Latest settled index, read (not depended on) by the resync effect below
  // so it doesn't refire on every normal scroll-driven change -- only when
  // `resyncToken` actually bumps.
  const selectedIndexRef = useRef(selectedIndex);
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // Forces the wheel to the intended index the instant Embla is ready --
  // on MOUNT (deps: [emblaApi]) and again on every EXTERNAL resync (deps:
  // [resyncToken], e.g. cancel-edit resetting the field). `startIndex`
  // alone isn't enough for the resync case (the parent's `value` prop can
  // change after mount, well after Embla already settled somewhere else),
  // and doing this via a ref from the PARENT raced Embla's own async init
  // -- if the ref hadn't been populated yet the call silently no-op'd.
  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.scrollTo(selectedIndexRef.current, true);
    // resyncToken drives re-runs after mount; selectedIndexRef is read
    // fresh, not depended on, so this doesn't refire on every settle.
  }, [emblaApi, resyncToken]);

  // The Minutes column's row COUNT changes as Hours crosses 0 and 24 (see
  // minuteItemsForHour). Embla measures its slides once and caches them, so
  // without an explicit reInit the snap points -- and therefore the
  // highlight bar -- stay pinned to the old row count. Kept separate from
  // the resync effect above on purpose: a full remeasure on every external
  // value change would be a remeasure mid-flight.
  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit();
    emblaApi.scrollTo(selectedIndexRef.current, true);
  }, [emblaApi, items.length]);

  // `select` fires the INSTANT Embla commits to a new target index --
  // synchronously, the moment a drag release (or a programmatic `scrollTo`)
  // decides where it's going. `settle` only fires once the animation has
  // physically finished getting there. Listening to `settle` alone meant
  // the bold/highlighted row stayed on the OLD value for the whole flight
  // of the animation, and if another interaction started before it finished
  // settling, state could end up reflecting a stale target instead of
  // wherever the wheel actually was. Both events report the same index;
  // syncing on `select` too means state is never behind the visible wheel.
  useEffect(() => {
    if (!emblaApi) return;
    // `containScroll: false` plus spacer slides on both ends means Embla has
    // more snap points than there are real values, so a hard flick can
    // settle on one whose centred row is blank. Clamping the reported index
    // alone (what this did before) left the wheel physically showing an
    // empty row while state claimed the last real value. Correct on
    // `settle` only -- doing it on `select` would fight an in-flight
    // animation the person is still driving.
    const syncOn = (correctPosition: boolean) => () => {
      const real = emblaApi.selectedScrollSnap();
      const clamped = Math.min(items.length - 1, Math.max(0, real));
      if (correctPosition && clamped !== real) emblaApi.scrollTo(clamped);
      onSettledIndex(clamped);
    };
    const onSelect = syncOn(false);
    const onSettle = syncOn(true);
    emblaApi.on("select", onSelect);
    emblaApi.on("settle", onSettle);
    return () => {
      emblaApi.off("select", onSelect);
      emblaApi.off("settle", onSettle);
    };
  }, [emblaApi, onSettledIndex, items.length]);

  // Trackpad/mouse-wheel support. Embla's core only understands pointer
  // drag -- a physical scroll-wheel or two-finger trackpad gesture (the
  // primary desktop interaction for a vertical picker) does nothing without
  // this. `preventDefault` also stops the gesture from scrolling the sheet
  // the picker sits inside.
  //
  // A real trackpad swipe fires dozens of small `wheel` events in one
  // continuous gesture. A cooldown-based throttle (fire one step, then
  // ignore everything for N ms) DISCARDS whatever deltaY arrives during
  // that window instead of queuing it. Converting the running total
  // straight into however many whole steps it covers (keeping the leftover
  // remainder for the next event, never resetting to zero) means no motion
  // is lost and a fast swipe can jump several rows in one batch.
  useEffect(() => {
    if (!emblaApi || disabled) return;
    const node = emblaApi.rootNode();
    let accumulated = 0;
    let pendingReal = emblaApi.selectedScrollSnap();
    // 1.5 rows per unit of scroll input, not 0.6: a single Windows mouse-
    // wheel notch (deltaY ~100-120) was crossing the old, smaller threshold
    // 4-5 times over, jumping that many rows on one click -- nowhere near
    // the "roughly one row per notch" feel of a native picker.
    const threshold = ITEM_HEIGHT * 1.5;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < threshold) return;
      const steps = Math.trunc(accumulated / threshold);
      accumulated -= steps * threshold;
      pendingReal = Math.min(items.length - 1, Math.max(0, pendingReal + steps));
      emblaApi.scrollTo(pendingReal);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [emblaApi, disabled, items.length]);

  const onKeyDown = (event: KeyboardEvent) => {
    const api = apiRef.current;
    if (!api || disabled) return;
    const currentReal = api.selectedScrollSnap();
    const goTo = (real: number) =>
      api.scrollTo(Math.min(items.length - 1, Math.max(0, real)));
    if (event.key === "ArrowUp") {
      event.preventDefault();
      goTo(currentReal - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      goTo(currentReal + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(items.length - 1);
    }
  };

  return (
    <div
      ref={emblaRef}
      role="spinbutton"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={items.length - 1}
      aria-valuenow={selectedIndex}
      aria-valuetext={`${formatLabel(items[selectedIndex] ?? 0)} ${unitSuffix}`}
      aria-disabled={disabled}
      onKeyDown={onKeyDown}
      className="w-16 shrink-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
      style={{
        // Fixed, not left to its content: this column sits inside a `flex
        // items-center` row wrapper (its unit label beside it), and without
        // an explicit height here it would take its content's natural
        // height instead of the fixed viewport.
        height: viewportHeight,
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0, black 30%, black 70%, transparent 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0, black 30%, black 70%, transparent 100%)",
      }}
    >
      <div className="flex flex-col">
        {Array.from({ length: items.length + pad * 2 }, (_, paddedIndex) => {
          const realIndex = paddedIndex - pad;
          const value = items[realIndex];
          // Apple-style focus, computed from distance to the settled
          // selection (React state) rather than a per-scroll-frame
          // `getBoundingClientRect()` read -- that version re-measured every
          // slide on every 'scroll' event via requestAnimationFrame, a
          // forced-reflow read competing with Embla's OWN pointer tracking
          // on every frame of a drag, which read as the drag not responding.
          // This costs nothing during a drag: it only recomputes once the
          // row already snapped.
          //
          // Blur is reserved for the immediate neighbor rows only (distance
          // 1) -- the selected row stays fully sharp and bold, rows two or
          // more away fade out via opacity (and the mask gradient above)
          // instead of blurring.
          const distance = Math.abs(realIndex - selectedIndex);
          const isSelected = distance === 0;
          const opacity = isSelected ? 1 : distance === 1 ? 0.55 : 0.28;
          const blurPx = distance === 1 ? 1.1 : 0;
          const isSpacer = value === undefined;
          return (
            <div
              key={paddedIndex}
              aria-hidden={isSpacer ? true : undefined}
              className={cn(
                "flex items-center justify-center text-[17px] tabular-nums",
                isSelected ? "text-[color:var(--app-accent)]" : "text-foreground",
              )}
              style={
                isSpacer
                  ? { height: ITEM_HEIGHT }
                  : {
                      height: ITEM_HEIGHT,
                      opacity,
                      filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
                      fontWeight: isSelected ? 700 : 500,
                    }
              }
            >
              {isSpacer ? null : formatLabel(value)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Apple-style two-column duration wheel (hours 0-24, minutes 00/15/30/45)
 * plus an optional "Until I stop" toggle. Keeps the same `value`/`onChange`
 * decimal-hours string contract as the DurationSelector it replaces, so
 * callers need no other changes.
 */
export function DurationWheelPicker({
  value,
  onChange,
  untilStopValue = DURATION_WHEEL_UNTIL_STOP_VALUE,
  showUntilStop = true,
  visibleRows = DEFAULT_VISIBLE_ROWS,
}: {
  value: string;
  onChange: (next: string) => void;
  untilStopValue?: string;
  /**
   * False when the CALLER owns the open-ended option itself — the preset
   * ladder does. Two controls for one piece of state is what made the
   * toggle read as an override sitting on top of the wheel rather than as
   * one of the durations the wheel can hold.
   */
  showUntilStop?: boolean;
  /**
   * 5 standalone, 3 inside the ladder's on-demand Custom panel. Keep it
   * odd — see the `pad` note in WheelColumn.
   */
  visibleRows?: number;
}) {
  const initial = useMemo(
    () => parseDurationValue(value, untilStopValue),
    // Only ever used to seed initial state — re-syncing from later external
    // changes is handled by the effect below, keyed off `value` itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [hoursIndex, setHoursIndex] = useState(initial.hoursIndex);
  // The minute VALUE, not its index: the Minutes column's contents change
  // with the hour, so an index means different things at different hours.
  const [minutesValue, setMinutesValue] = useState(initial.minutesValue);
  const [untilStop, setUntilStop] = useState(initial.untilStop);
  // One token per column. A single shared token meant a minutes-only
  // correction also fired `scrollTo(hoursIndex, true)` — a hard teleport —
  // on the untouched Hours wheel.
  const [hoursResync, setHoursResync] = useState(0);
  const [minutesResync, setMinutesResync] = useState(0);
  const lastEmittedRef = useRef(value);
  const hoursApiRef = useRef<EmblaCarouselType | null>(null);
  const minutesApiRef = useRef<EmblaCarouselType | null>(null);

  const minuteItems = minuteItemsForHour(hoursIndex);
  // Computed fresh every render, so an invalid pairing is never emitted even
  // for the single render before the correction effect below runs.
  const minutesIndex = Math.max(0, minuteItems.indexOf(minutesValue));
  const effectiveMinutesValue = minuteItems[minutesIndex] ?? 15;

  // Hours moved to an hour where the current minute row no longer exists
  // (1 -> 0 while Minutes sat on :00, or 23 -> 24 while it sat on :45).
  // Land on the nearest row that does exist and resync only that column.
  useEffect(() => {
    if (effectiveMinutesValue === minutesValue) return;
    setMinutesValue(effectiveMinutesValue);
    setMinutesResync((token) => token + 1);
  }, [effectiveMinutesValue, minutesValue]);

  const onMinutesSettled = useCallback(
    (index: number) => {
      setMinutesValue(minuteItemsForHour(hoursIndex)[index] ?? 15);
    },
    [hoursIndex],
  );

  useEffect(() => {
    const next = untilStop
      ? untilStopValue
      : formatDurationHours(hoursIndex, effectiveMinutesValue);
    if (next === lastEmittedRef.current) return;
    lastEmittedRef.current = next;
    onChange(next);
  }, [untilStop, hoursIndex, effectiveMinutesValue, untilStopValue, onChange]);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    const parsed = parseDurationValue(value, untilStopValue);
    setUntilStop(parsed.untilStop);
    setHoursIndex(parsed.hoursIndex);
    setMinutesValue(parsed.minutesValue);
    setHoursResync((token) => token + 1);
    setMinutesResync((token) => token + 1);
  }, [value, untilStopValue]);

  const viewportHeight = ITEM_HEIGHT * visibleRows;

  return (
    <div className={cn("mx-auto max-w-[260px]", showUntilStop && "space-y-3")}>
      <div
        className={cn(
          "relative mx-auto flex items-center justify-center gap-6",
          untilStop && "pointer-events-none opacity-40",
        )}
        style={{ height: viewportHeight }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-[12px] border-y border-border/70 bg-muted/40"
          style={{ height: ITEM_HEIGHT }}
        />
        {/* Unit label sits INLINE, to the right of its column, not in a
            header row above the wheel -- matches iOS's own Timer picker.
            Static/non-scrolling, and deliberately muted rather than styled
            as part of the highlighted selection. */}
        <div className="flex items-center gap-2">
          <WheelColumn
            items={HOURS_VALUES}
            formatLabel={(h) => String(h)}
            selectedIndex={hoursIndex}
            onSettledIndex={setHoursIndex}
            apiRef={hoursApiRef}
            disabled={untilStop}
            ariaLabel="Hours"
            unitSuffix="hr"
            resyncToken={hoursResync}
            visibleRows={visibleRows}
          />
          <span className="text-sm font-medium text-muted-foreground">
            hours
          </span>
        </div>
        <div className="flex items-center gap-2">
          <WheelColumn
            items={minuteItems}
            formatLabel={(m) => String(m)}
            selectedIndex={minutesIndex}
            onSettledIndex={onMinutesSettled}
            apiRef={minutesApiRef}
            disabled={untilStop}
            ariaLabel="Minutes"
            unitSuffix="min"
            resyncToken={minutesResync}
            visibleRows={visibleRows}
          />
          <span className="text-sm font-medium text-muted-foreground">
            min
          </span>
        </div>
        {showUntilStop && untilStop ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-background/90 px-3 py-1 text-sm font-semibold text-foreground shadow-sm">
              Until you stop
            </span>
          </div>
        ) : null}
      </div>

      {showUntilStop ? (
        <button
          type="button"
          aria-pressed={untilStop}
          onClick={() => setUntilStop((prev) => !prev)}
          className={cn(
            "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors touch-manipulation",
            untilStop
              ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
              : "border-border/70 bg-background text-foreground hover:border-[color:var(--app-accent-ring)]",
          )}
        >
          Until I stop
        </button>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {untilStop
          ? "Duration: until you stop"
          : `Duration: ${hoursIndex} hours ${effectiveMinutesValue} minutes`}
      </p>
    </div>
  );
}
