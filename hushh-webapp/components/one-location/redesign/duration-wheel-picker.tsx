"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import useEmblaCarousel from "embla-carousel-react";
import type { EmblaCarouselType, EmblaOptionsType } from "embla-carousel";

import { cn } from "@/lib/utils";

// Not "24" -- once a literal 24 hours became reachable on the wheel (see
// MAX_HOURS below), the wheel could legitimately emit the string "24"
// itself (24h + 0min), which would collide with this sentinel on a fresh
// mount and get misread as "Until I stop" instead of a real 24-hour
// selection. Confirmed unused anywhere else in the codebase, so changing
// it is fully self-contained to this file.
export const DURATION_WHEEL_UNTIL_STOP_VALUE = "until_stopped";

/** The backend caps a grant at 24 hours (`le=24`, consent-protocol/api/routes/one/location.py). */
const MAX_HOURS = 24;
const HOURS_VALUES = Array.from({ length: MAX_HOURS + 1 }, (_, i) => i); // 0..24
const MINUTE_VALUES = [0, 15, 30, 45];

/**
 * Which minutes exist at a given hour. Both ends of the range are product
 * rules, and both are now expressed by REMOVING the row rather than by
 * letting someone land on it and yanking them off it:
 *
 *   0h  — 0h00m is not a duration, and 15 minutes is the floor for sharing.
 *   24h — 24h15m (24.25) fails the backend's `le=24`; 24h0m is exactly 24.0
 *         and is the real ceiling, so that hour has only :00.
 *
 * Both constraints arrived on main as live guards that let the wheel settle
 * on the invalid row and then bounced it back — :00 at zero hours snapping
 * to :15, and any nonzero minute at 24h snapping to :00. The rule is the
 * same; showing it is what stops it feeling broken. The natural order is
 * minutes-then-hours, and minutes-first is exactly the direction that
 * bounced, which is why "1 hour" read as unreachable.
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

/**
 * The wheel's own frame.
 *
 * Centred on a phone, where the 260px column IS the screen. Left-aligned from
 * `sm` up: the ladder that opens it is a left-aligned chip row there, and a
 * 260px wheel floating in the middle of a 790px card is the dead space the
 * Custom panel was reported for. Exported for the same reason as the item
 * height — e2e/one-location-duration-ladder.layout.spec.ts measures this exact
 * string rather than a copy of it.
 */
export const DURATION_WHEEL_FRAME_CLASS = "mx-auto max-w-[260px] sm:mx-0";
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

/**
 * The wheel value nearest `hours`, as the same decimal-hours string the wheel
 * itself emits.
 *
 * For seeding the wheel from something measured rather than chosen — "what is
 * left on this share" is 0.53 hours, and the wheel will show 30 min for it
 * whatever the caller holds in state. Without this the two disagree: the
 * screen reads 30 min and Save sends 0.53, which is a change the person never
 * made and did not see.
 *
 * Clamped to the grid's own ends rather than to written-down numbers: this
 * clamp was authored against a 23h45m ceiling and the wheel gained 24h0m in
 * the same week, which would have snapped a genuine 24-hour share down to
 * 23.75 with nothing failing. Reading the bounds off `ALL_GRID_MINUTES` means
 * the next change to the grid carries this with it.
 *
 * A number it cannot read falls to the shortest step, never the longest: a
 * duration nobody could parse must not open the editor pre-loaded on the
 * longest share the product allows.
 */
export function snapToWheelDurationHours(hours: number): string {
  const floor = Math.min(...ALL_GRID_MINUTES);
  const ceiling = Math.max(...ALL_GRID_MINUTES);
  const requested = Number.isFinite(hours) ? Math.round(hours * 60) : floor;
  const minutes = nearestGridMinutes(
    Math.min(Math.max(requested, floor), ceiling),
  );
  return String(Math.round((minutes / 60) * 100) / 100);
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
  // deep-equal) -- reInitializing mid-interaction is the exact failure mode
  // swipe-views.tsx's measurement comments warn against. Wheel-scroll
  // unsubscribes itself and keyboard checks `disabled` directly -- so Embla
  // never needs to know, these options stay frozen for the component's
  // whole life, and Embla reInits only where this file asks it to.
  //
  // `disabled` no longer has a live caller: toggling "Until I stop" now
  // UNMOUNTS both columns rather than fading them behind a
  // `pointer-events-none` ancestor, so this prop is the belt to that
  // braces -- it keeps the column non-interactive on its own terms if it is
  // ever rendered in that state again.
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
  //
  // This replaces the pair of live guards that used to bounce the wheel off
  // 0h00m and off 24h + any nonzero minute: the invalid rows are simply not
  // in the column, so there is nothing to bounce off.
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

  /**
   * The open-ended state, gated on the caller actually offering it.
   *
   * `untilStop` alone was enough to grey the wheel out and emit the sentinel,
   * but it is seeded from `value` -- so a lane that sets `showUntilStop={false}`
   * (the Request screen: you cannot ask to watch someone until THEY stop) and
   * is handed the sentinel anyway got a dead control with no toggle to escape
   * it, and kept emitting the non-numeric sentinel into a field that lane later
   * runs `Number()` over. Reading both means such a value is recovered to a
   * real duration on the first emit instead.
   */
  const openEnded = showUntilStop && untilStop;

  useEffect(() => {
    const next = openEnded
      ? untilStopValue
      : formatDurationHours(hoursIndex, effectiveMinutesValue);
    if (next === lastEmittedRef.current) return;
    lastEmittedRef.current = next;
    onChange(next);
  }, [openEnded, hoursIndex, effectiveMinutesValue, untilStopValue, onChange]);

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
    <div
      className={cn(DURATION_WHEEL_FRAME_CLASS, showUntilStop && "space-y-3")}
    >
      {/* Choosing the open-ended option COLLAPSES the wheel rather than
          greying it out. It used to stay mounted at `opacity-40` with a chip
          reading "Until you stop" laid over it -- and because that chip was a
          child of the faded wrapper, the one label meant to state the choice
          was itself rendered at 40%: a grey sentence floating in the middle of
          a grey control, disagreeing with the blue "Until I stop" button
          directly under it. Two labels, two voices, one state.

          Collapsing is also what the preset ladder already does (`pickRung`
          closes its Custom panel), so the two duration controls behave the
          same way, and the pressed button is the single place the state is
          stated. */}
      {openEnded ? null : (
      <div
        className="relative mx-auto flex items-center justify-center gap-6"
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
            disabled={openEnded}
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
            disabled={openEnded}
            ariaLabel="Minutes"
            unitSuffix="min"
            resyncToken={minutesResync}
            visibleRows={visibleRows}
          />
          <span className="text-sm font-medium text-muted-foreground">
            min
          </span>
        </div>
      </div>
      )}

      {showUntilStop ? (
        <button
          type="button"
          aria-pressed={openEnded}
          onClick={() => setUntilStop((prev) => !prev)}
          className={cn(
            "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors touch-manipulation",
            openEnded
              ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
              : "border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] text-[color:var(--app-label)] hover:border-[color:var(--app-accent-ring)] hover:bg-[color:var(--app-neutral-fill-strong)]",
          )}
        >
          Until I stop
        </button>
      ) : null}

      {/* Says the same words the button says. It used to announce "until you
          stop" against a button reading "Until I stop", so the screen reader
          and the screen described the same choice differently. */}
      <p className="sr-only" aria-live="polite">
        {openEnded
          ? "Duration: until I stop"
          : `Duration: ${hoursIndex} hours ${effectiveMinutesValue} minutes`}
      </p>
    </div>
  );
}
