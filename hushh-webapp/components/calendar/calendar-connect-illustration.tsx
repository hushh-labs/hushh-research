import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * Decorative collage for the Calendar connect screen: a sample schedule card
 * flanked by four calendar app tiles.
 *
 * Purely presentational and `aria-hidden`; the screen's heading and button
 * carry the meaning. The copy inside the card is sample artwork, not owner
 * information, and is fixed so the illustration renders identically on the
 * server, the client and the native shell.
 *
 * Responsive without any layout code: the wrapper is a size container and
 * every length inside is in `em`, with 1em = 1/42 of the container width. The
 * collage therefore scales as one picture, never reflows, and is capped at its
 * 420px design width on wide screens.
 */

const TILE_BASE =
  "absolute z-10 flex size-[7.6em] items-center justify-center rounded-[2.2em] border border-black/5 bg-white shadow-[0_1.4em_3em_-0.6em_rgba(0,0,0,0.09),0_0.2em_0.6em_-0.1em_rgba(0,0,0,0.04)] dark:border-white/10 dark:shadow-none";

const SCALE_STYLE: CSSProperties = { fontSize: "calc(100cqw / 42)" };

const AGENDA = [
  {
    time: "9:00 AM",
    title: "Team sync",
    span: "9:00 – 10:00 AM",
    tint: "bg-[#EEF5FF] dark:bg-[color:var(--app-accent-surface)]",
    bar: "bg-[color:var(--app-accent)]",
  },
  {
    time: "11:00 AM",
    title: "Product review",
    span: "11:00 AM – 12:00 PM",
    tint: "bg-[#E8F8F0] dark:bg-[color:var(--app-success-surface)]",
    bar: "bg-[#10B981]",
  },
  {
    time: "4:00 PM",
    title: "Focus time",
    span: "4:00 – 5:00 PM",
    tint: "bg-[#FFF0F2] dark:bg-[color:var(--app-destructive-surface)]",
    bar: "bg-[#F43F5E]",
  },
] as const;

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const DATES = [5, 6, 7, 8, 9, 10, 11] as const;
const TODAY = 8;

const DOT_COLORS = [
  "bg-emerald-500",
  "bg-blue-500",
  "bg-amber-400",
  "bg-rose-500",
  "bg-blue-400",
  "bg-cyan-400",
  "bg-emerald-400",
  "bg-indigo-500",
  "bg-rose-400",
  "bg-emerald-500",
  "bg-orange-400",
  "bg-blue-500",
] as const;

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[1.2em] fill-none stroke-current"
      strokeWidth={2.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline
        points={direction === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"}
      />
    </svg>
  );
}

function GoogleCalendarTile() {
  return (
    <div className={`${TILE_BASE} left-0 top-[8.8em] rotate-[-10deg]`}>
      <svg viewBox="12 12 40 40" fill="none" className="size-[4.5em]">
        <rect x="13" y="13" width="38" height="38" rx="8" fill="white" />
        <path d="M43 13H51V51H43V13Z" fill="#EA4335" />
        <path d="M13 43H51V51H13V43Z" fill="#34A853" />
        <path d="M13 13H21V51H13V13Z" fill="#4285F4" />
        <path d="M13 13H51V21H13V13Z" fill="#1A73E8" />
        <path d="M43 43H51V51H43V43Z" fill="#FBBC04" />
        <text
          x="32"
          y="41"
          textAnchor="middle"
          fill="#1A73E8"
          fontSize="20"
          fontWeight="700"
          fontFamily="inherit"
        >
          31
        </text>
      </svg>
    </div>
  );
}

function OutlookTile() {
  return (
    <div className={`${TILE_BASE} left-[1.1em] top-[19.8em] rotate-[-8deg]`}>
      {/* The logo is a flat-white-background raster; multiply lets the white
          disappear into the tile instead of showing a faint square. */}
      <Image
        src="/brand/calendar-apps/outlook.png"
        alt=""
        width={256}
        height={256}
        unoptimized
        className="size-[5em] object-contain mix-blend-multiply"
      />
    </div>
  );
}

function AppleCalendarTile() {
  return (
    <div
      className={`${TILE_BASE} right-0 top-[9.4em] rotate-[10deg] flex-col justify-between overflow-hidden p-[0.9em]`}
    >
      <div className="w-full rounded-t-[1.1em] bg-[#FF3B30] py-[0.2em] text-center">
        <span className="block text-[0.95em] font-bold leading-none tracking-widest text-white">
          JUL
        </span>
      </div>
      <div className="-mt-[0.2em] flex flex-1 items-center justify-center pb-[0.2em]">
        <span className="text-[2.9em] font-light leading-none tracking-tight text-slate-900">
          17
        </span>
      </div>
    </div>
  );
}

function DotsCalendarTile() {
  return (
    <div
      className={`${TILE_BASE} right-[0.7em] top-[20.9em] rotate-[9deg] flex-col justify-start overflow-hidden p-[0.9em]`}
    >
      <div className="mb-[0.8em] h-[1.3em] w-full rounded-t-[1em] bg-[#FF3B30]" />
      <div className="grid grid-cols-4 gap-[0.6em] pt-[0.2em]">
        {DOT_COLORS.map((color, index) => (
          <span
            key={index}
            className={`size-[0.6em] rounded-full ${color}`}
          />
        ))}
      </div>
    </div>
  );
}

function ScheduleCard() {
  return (
    <div className="relative z-20 mx-auto w-[23em] rotate-[-2.5deg] rounded-[2.8em] border border-black/5 bg-[color:var(--app-primary-surface)] px-[1.9em] py-[1.8em] shadow-[0_2.2em_4.8em_-1.2em_rgba(25,42,70,0.12),0_0.6em_1.6em_-0.4em_rgba(25,42,70,0.04)] dark:border-[color:var(--app-separator)] dark:shadow-none">
      <div className="mb-[1.8em] flex items-center justify-between">
        <p className="text-[1.5em] font-bold leading-none tracking-tight text-[color:var(--app-label)]">
          October 2026
        </p>
        <div className="flex items-center gap-[1em] text-[color:var(--app-secondary-label)]">
          <Chevron direction="left" />
          <Chevron direction="right" />
        </div>
      </div>

      <div className="mb-[0.6em] grid grid-cols-7 text-center text-[1em] font-medium leading-[1.5] text-[color:var(--app-tertiary-label)]">
        {WEEKDAYS.map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>

      <div className="mb-[2em] grid grid-cols-7 items-center text-center text-[1.15em] font-medium leading-none text-[color:var(--app-secondary-label)]">
        {DATES.map((date) =>
          date === TODAY ? (
            <span key={date} className="flex justify-center">
              <span className="flex size-[2.2em] items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[1em] font-bold text-white">
                {date}
              </span>
            </span>
          ) : (
            <span key={date} className="py-[0.4em]">
              {date}
            </span>
          ),
        )}
      </div>

      <div className="space-y-[1em]">
        {AGENDA.map((item) => (
          <div key={item.title} className="flex items-center gap-[0.8em] text-left">
            <span className="w-[4.8em] shrink-0 pr-[0.2em] text-right text-[1em] font-medium leading-[1.25] text-[color:var(--app-tertiary-label)]">
              {item.time}
            </span>
            <div
              className={`flex min-w-0 flex-1 items-center gap-[0.9em] rounded-[1.2em] px-[1em] py-[1.1em] ${item.tint}`}
            >
              <span className={`h-[2.8em] w-[0.3em] shrink-0 rounded-full ${item.bar}`} />
              <div className="min-w-0">
                <p className="truncate text-[1.25em] font-semibold leading-tight text-[color:var(--app-label)]">
                  {item.title}
                </p>
                <p className="mt-[0.15em] text-[0.95em] font-medium leading-tight tracking-tight text-[color:var(--app-secondary-label)]">
                  {item.span}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CalendarConnectIllustration() {
  return (
    <div
      aria-hidden="true"
      data-testid="calendar-connect-illustration"
      className="pointer-events-none mx-auto w-full max-w-[420px] select-none [container-type:inline-size]"
    >
      <div className="relative w-full py-[2.4em]" style={SCALE_STYLE}>
        <GoogleCalendarTile />
        <OutlookTile />
        <AppleCalendarTile />
        <DotsCalendarTile />
        <ScheduleCard />
      </div>
    </div>
  );
}
