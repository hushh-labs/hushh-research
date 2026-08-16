"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import useEmblaCarousel from "embla-carousel-react";
import type { EmblaCarouselType, EmblaOptionsType } from "embla-carousel";

import { cn } from "@/lib/utils";

/** Mirrors check-in-flow.tsx's UNTIL_STOP_VALUE — the max accepted grant window. */
export const DURATION_WHEEL_UNTIL_STOP_VALUE = "24";

const HOURS_VALUES = Array.from({ length: 11 }, (_, i) => i); // 0..10
// No "00" — the floor of the grid is 15 minutes, not a soft guard against it.
const MINUTE_VALUES = [15, 30, 45];
const ALL_GRID_MINUTES = HOURS_VALUES.flatMap((h) =>
  MINUTE_VALUES.map((m) => h * 60 + m),
); // 15..645 in 15-minute steps, 0h0m is not a representable state

const ITEM_HEIGHT = 40;
const VISIBLE_ROWS = 5;
const VIEWPORT_HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;
// Blank rows on each side, as real (empty) slides -- not container padding.
// Embla measures every slide's own offsetTop/offsetHeight to place snap
// points; mixing in out-of-band CSS padding on the container was fighting
// that math (the highlight bar landing one row off from the item Embla had
// actually settled on, and the reachable scroll range coming up short of
// the last item). Uniform slides, all real, all the same height, is the
// case Embla's own alignment math is built to get right.
//
// Also equal to the center row's own row-index within the viewport (row 2
// of 5, 0-based) -- see the `align: "start"` note on WheelColumn's options
// for why that equality is what makes `scrollTo(realIndex)` work with no
// further offset.
const PAD = Math.floor(VISIBLE_ROWS / 2); // 2

function nearestGridMinutes(totalMinutes: number): number {
  // `<=`, not `<`: on an exact tie (e.g. "1" hour sits exactly between 0h45m
  // and 1h15m once :00 is off the grid) this rounds up to the later, larger
  // candidate rather than silently shrinking a caller's requested duration.
  return ALL_GRID_MINUTES.reduce((best, candidate) =>
    Math.abs(candidate - totalMinutes) <= Math.abs(best - totalMinutes) ? candidate : best,
  );
}

function formatDurationHours(hoursIndex: number, minutesIndex: number): string {
  const totalMinutes = hoursIndex * 60 + (MINUTE_VALUES[minutesIndex] ?? 15);
  return String(Math.round((totalMinutes / 60) * 100) / 100);
}

function parseDurationValue(
  value: string,
  untilStopValue: string,
): { untilStop: boolean; hoursIndex: number; minutesIndex: number } {
  if (value === untilStopValue) {
    return { untilStop: true, hoursIndex: 1, minutesIndex: 0 };
  }
  const num = Number(value);
  const totalMinutes = Number.isFinite(num) ? Math.round(num * 60) : 15;
  const nearest = nearestGridMinutes(totalMinutes);
  const hoursIndex = Math.floor(nearest / 60);
  const minutesIndex = Math.max(0, MINUTE_VALUES.indexOf(nearest % 60));
  return { untilStop: false, hoursIndex, minutesIndex };
}

/**
 * One scroll wheel of real values, framed by `PAD` blank spacer slides on
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
}) {
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
  // whole life, and Embla reInits exactly once, at mount, and never again.
  // `align: "start"`, not `"center"`: with `containScroll: false` (see
  // below), Embla's own `"center"` alignment measures against the SLIDE
  // CONTAINER's full size (here, all N+2*PAD slides stacked -- 600px for
  // the Hours column) rather than the visible viewport (200px), so it
  // centers each slide 200px (one whole viewport) off from where it's
  // actually rendered -- the highlighted row and the physically centered
  // row pointing at two different numbers, on first mount and after every
  // scroll, with no way to correct it from the outside (its own `reInit()`
  // recomputes the exact same wrong number, since it's a measurement
  // convention, not stale data). `"start"` sidesteps that: it flushes the
  // REQUESTED slide's top edge to the viewport's top edge, no
  // container-size measurement involved at all. Requesting `realIndex`
  // directly (not `realIndex + PAD`) still lands the right slide in the
  // CENTER row, not the top one: `PAD` leading spacer slides already sit
  // above every real item, and `PAD` (by construction, `floor(VISIBLE_ROWS
  // / 2)`) is also exactly the center row's own row-index in the viewport
  // -- flushing slide `realIndex` to the top pushes the `PAD` slides after
  // it (the real item PAD slides later, i.e. index `realIndex + PAD`) down
  // into exactly the center row.
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
  // Depending on `emblaApi` itself (not a ref) here guarantees this reruns
  // the instant Embla actually becomes ready, no matter how the timing
  // landed.
  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.scrollTo(selectedIndexRef.current, true);
    // resyncToken drives re-runs after mount; selectedIndexRef is read
    // fresh, not depended on, so this doesn't refire on every settle.
  }, [emblaApi, resyncToken]);

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
    const sync = () => {
      const real = emblaApi.selectedScrollSnap();
      onSettledIndex(Math.min(items.length - 1, Math.max(0, real)));
    };
    emblaApi.on("select", sync);
    emblaApi.on("settle", sync);
    return () => {
      emblaApi.off("select", sync);
      emblaApi.off("settle", sync);
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
  //
  // Tracks its OWN pending target locally instead of re-reading
  // `emblaApi.selectedScrollSnap()` between events -- within one continuous
  // gesture that's several events queued back-to-back, and reading Embla's
  // index back out between them adds a round trip this doesn't need.
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
      className="w-14 shrink-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
      style={{
        // Fixed, not flex-stretched: this column sits inside a `flex
        // flex-col` header wrapper (label above it), and flex's default
        // `align-items: stretch` only fills the CROSS axis of a
        // column-direction parent (width), not its height. Without an
        // explicit height here, this box takes its content's natural
        // height instead of the fixed viewport.
        height: VIEWPORT_HEIGHT,
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0, black 30%, black 70%, transparent 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0, black 30%, black 70%, transparent 100%)",
      }}
    >
      <div className="flex flex-col">
        {Array.from({ length: items.length + PAD * 2 }, (_, paddedIndex) => {
          const realIndex = paddedIndex - PAD;
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
          // instead of blurring, so the wheel doesn't read as a uniform,
          // undifferentiated blur -- only the row right before/after the
          // selection is softened.
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
 * Apple-style two-column duration wheel (hours 0-10, minutes 15/30/45) plus
 * an "Until I stop" toggle. Keeps the same `value`/`onChange` decimal-hours
 * string contract as the DurationSelector it replaces, so callers need no
 * other changes.
 */
export function DurationWheelPicker({
  value,
  onChange,
  untilStopValue = DURATION_WHEEL_UNTIL_STOP_VALUE,
}: {
  value: string;
  onChange: (next: string) => void;
  untilStopValue?: string;
}) {
  const initial = useMemo(
    () => parseDurationValue(value, untilStopValue),
    // Only ever used to seed initial state — re-syncing from later external
    // changes is handled by the effect below, keyed off `value` itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [hoursIndex, setHoursIndex] = useState(initial.hoursIndex);
  const [minutesIndex, setMinutesIndex] = useState(initial.minutesIndex);
  const [untilStop, setUntilStop] = useState(initial.untilStop);
  // Bumped only when `value` changes from OUTSIDE this component (each
  // wheel already force-corrects to its own index once on mount regardless
  // of this value -- see the resync effect in WheelColumn).
  const [resyncToken, setResyncToken] = useState(0);
  const lastEmittedRef = useRef(value);
  const hoursApiRef = useRef<EmblaCarouselType | null>(null);
  const minutesApiRef = useRef<EmblaCarouselType | null>(null);

  useEffect(() => {
    const next = untilStop ? untilStopValue : formatDurationHours(hoursIndex, minutesIndex);
    if (next === lastEmittedRef.current) return;
    lastEmittedRef.current = next;
    onChange(next);
  }, [untilStop, hoursIndex, minutesIndex, untilStopValue, onChange]);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    const parsed = parseDurationValue(value, untilStopValue);
    setUntilStop(parsed.untilStop);
    setHoursIndex(parsed.hoursIndex);
    setMinutesIndex(parsed.minutesIndex);
    setResyncToken((token) => token + 1);
  }, [value, untilStopValue]);

  return (
    <div className="mx-auto max-w-[200px] space-y-3">
      {/* Labels live in their OWN row, above the wheel row entirely -- not
          stacked inside it. Mixing a label into each column's own flex-col
          wrapper pushed that column down by the label's height, so the
          selection highlight bar (centered against this whole block) no
          longer lined up with either column's actual centered row. Keeping
          the wheel row's only children the two fixed-height columns (plus
          the highlight bar) means `top-1/2` here is guaranteed to be each
          column's true center. */}
      <div className="flex justify-center gap-6">
        <span className="w-14 shrink-0 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Hours
        </span>
        <span className="w-14 shrink-0 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Minutes
        </span>
      </div>
      <div
        className={cn(
          "relative mx-auto flex justify-center gap-6",
          untilStop && "pointer-events-none opacity-40",
        )}
        style={{ height: VIEWPORT_HEIGHT }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-[12px] border-y border-border/70 bg-muted/40"
          style={{ height: ITEM_HEIGHT }}
        />
        <WheelColumn
          items={HOURS_VALUES}
          formatLabel={(h) => String(h)}
          selectedIndex={hoursIndex}
          onSettledIndex={setHoursIndex}
          apiRef={hoursApiRef}
          disabled={untilStop}
          ariaLabel="Hours"
          unitSuffix="hr"
          resyncToken={resyncToken}
        />
        <WheelColumn
          items={MINUTE_VALUES}
          formatLabel={(m) => String(m).padStart(2, "0")}
          selectedIndex={minutesIndex}
          onSettledIndex={setMinutesIndex}
          apiRef={minutesApiRef}
          disabled={untilStop}
          ariaLabel="Minutes"
          unitSuffix="min"
          resyncToken={resyncToken}
        />
        {untilStop ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-background/90 px-3 py-1 text-sm font-semibold text-foreground shadow-sm">
              Until you stop
            </span>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        aria-pressed={untilStop}
        onClick={() => setUntilStop((prev) => !prev)}
        className={cn(
          "h-9 rounded-full border px-4 text-sm font-medium transition-colors touch-manipulation",
          untilStop
            ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
            : "border-border/70 bg-background text-foreground hover:border-[color:var(--app-accent-ring)]",
        )}
      >
        Until I stop
      </button>

      <p className="sr-only" aria-live="polite">
        {untilStop
          ? "Duration: until you stop"
          : `Duration: ${hoursIndex} hours ${MINUTE_VALUES[minutesIndex]} minutes`}
      </p>
    </div>
  );
}
