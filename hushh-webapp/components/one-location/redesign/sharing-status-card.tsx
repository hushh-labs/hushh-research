"use client";

/**
 * SharingStatusCard — the Now-tab hero status card (Apple Blue v2 design).
 *
 * A map-style card showing whether you're currently sharing your live location:
 * a LIVE/OFF badge, the status headline + subtitle, an "Ends in …" sub-card
 * while sharing (or a "Tap to share" CTA while private), your circle rendered as
 * avatar markers on the map, and a privacy footer. The map is a decorative SVG
 * that matches the design mock; the live Google map still lives in the Device
 * readiness section.
 */

import { Clock, Loader2, Lock, Navigation } from "lucide-react";

import { LiveMap } from "@/components/one-location/live-map";
import type { PlainLocationPoint } from "@/lib/one-location/types";

export type StatusMarkerPerson = { id: string; name: string };

// Avatar marker positions (px), mirroring the design's right-side placement.
const MARKER_SLOTS = [
  { top: 44, right: 30 },
  { top: 150, right: 20 },
  { top: 206, right: 104 },
] as const;

// Distinct avatar tints (we render initials — the app has names, not photos).
const MARKER_TINTS = ["#8b5cf6", "#3b82f6", "#f59e0b"] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

function MapBackdrop() {
  return (
    <svg
      className="absolute inset-0 h-full w-full dark:[filter:invert(0.92)_hue-rotate(180deg)_saturate(0.8)]"
      viewBox="0 0 362 300"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="362" height="300" fill="#eef0f2" />
      <g fill="#e5e8ec">
        <rect x="150" y="16" width="60" height="44" rx="3" />
        <rect x="224" y="10" width="50" height="56" rx="3" />
        <rect x="286" y="24" width="64" height="46" rx="3" />
        <rect x="158" y="120" width="54" height="50" rx="3" />
        <rect x="228" y="126" width="60" height="42" rx="3" />
        <rect x="300" y="118" width="52" height="54" rx="3" />
        <rect x="164" y="216" width="58" height="48" rx="3" />
        <rect x="238" y="222" width="50" height="44" rx="3" />
        <rect x="300" y="214" width="54" height="52" rx="3" />
      </g>
      <g stroke="#f6f8fa" strokeWidth="9" fill="none">
        <path d="M150 0V300" />
        <path d="M150 90H362" />
        <path d="M150 196H362" />
        <path d="M288 0V300" />
        <path d="M218 90V196" />
      </g>
      <g stroke="#dfe3e8" strokeWidth="1.5" fill="none">
        <path d="M150 0V300" />
        <path d="M150 90H362" />
        <path d="M150 196H362" />
      </g>
      {/* Soft geofence circle + your blue self-marker. */}
      <circle cx="252" cy="150" r="66" fill="#3b82f6" opacity="0.12" />
      <circle cx="252" cy="150" r="10" fill="#2563eb" stroke="#ffffff" strokeWidth="3" />
    </svg>
  );
}

export function SharingStatusCard({
  isSharing,
  title,
  subtitle,
  endsLabel,
  startedLabel,
  people,
  point,
  onTapShare,
  live,
  onToggle,
  onToggleOff,
  toggleBusy,
}: {
  isSharing: boolean;
  title: string;
  subtitle: string;
  endsLabel?: string | null;
  startedLabel?: string | null;
  people: StatusMarkerPerson[];
  /** Your live location — renders the real map behind the overlay. */
  point?: PlainLocationPoint | null;
  onTapShare: () => void;
  /**
   * Whether the LIVE/OFF badge shows as live. Defaults to `isSharing` when not
   * provided. Distinct from `isSharing` so a captured self-location (shown on
   * the map, not yet shared) can also read as LIVE.
   */
  live?: boolean;
  /** Tapping the OFF badge captures / refreshes your live location. */
  onToggle?: () => void;
  /**
   * Tapping the LIVE badge turns the live preview OFF (true toggle). When not
   * provided, tapping while live falls back to `onToggle` (refresh capture) —
   * e.g. while an active share drives the LIVE state and must not be stopped
   * from this badge.
   */
  onToggleOff?: () => void;
  toggleBusy?: boolean;
}) {
  const markers = people.slice(0, MARKER_SLOTS.length);
  const showLive = live ?? isSharing;

  return (
    <div className="relative overflow-hidden rounded-[20px] bg-white shadow-[0_4px_16px_rgba(0,0,0,0.06)] dark:bg-[#1f1f24]">
      <div className="relative h-[280px]">
        {/* Backdrop: the real live map when we have a fix, else a stylised map. */}
        {point ? (
          <div className="pointer-events-none absolute inset-0">
            <LiveMap point={point} className="h-full w-full" />
          </div>
        ) : (
          <MapBackdrop />
        )}

        {/* Left→right surface fade so text stays readable over the map. */}
        <div className="absolute inset-0 bg-[linear-gradient(100deg,#ffffff_30%,rgba(255,255,255,0.9)_46%,rgba(255,255,255,0)_72%)] dark:bg-[linear-gradient(100deg,#1f1f24_30%,rgba(31,31,36,0.9)_46%,rgba(31,31,36,0)_72%)]" />

        {/* Circle members as avatar markers. */}
        {markers.map((person, i) => {
          const slot = MARKER_SLOTS[i] ?? MARKER_SLOTS[0]!;
          const tint = MARKER_TINTS[i % MARKER_TINTS.length] ?? MARKER_TINTS[0]!;
          return (
            <div
              key={person.id}
              className="absolute h-11 w-11"
              style={{ top: slot.top, right: slot.right }}
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full border-[3px] border-white text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.15)]"
                style={{ backgroundColor: tint }}
              >
                {initialsOf(person.name)}
              </span>
              <span className="absolute bottom-0.5 right-0.5 h-[11px] w-[11px] rounded-full border-2 border-white bg-[#34c759]" />
            </div>
          );
        })}

        {/* Text overlay. */}
        <div className="absolute left-5 right-5 top-5">
          <button
            type="button"
            onClick={showLive ? (onToggleOff ?? onToggle) : onToggle}
            disabled={toggleBusy || (showLive ? !(onToggleOff ?? onToggle) : !onToggle)}
            aria-pressed={showLive}
            aria-label={
              showLive
                ? onToggleOff
                  ? "Turn off live location preview"
                  : "Live location on"
                : "Turn on live location"
            }
            className="inline-flex items-center gap-[7px] rounded-full bg-white px-3 py-1.5 shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition active:scale-95 disabled:opacity-70 enabled:cursor-pointer dark:bg-[#2f2f35] dark:shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
          >
            {toggleBusy ? (
              <Loader2 className="h-[11px] w-[11px] animate-spin text-[#6b7280]" />
            ) : (
              <span
                className="h-[9px] w-[9px] rounded-full"
                style={{ backgroundColor: showLive ? "#34c759" : "#9ca3af" }}
              />
            )}
            <span
              className="text-xs font-bold tracking-[0.5px]"
              style={{ color: showLive ? "#12a150" : "#6b7280" }}
            >
              {showLive ? "LIVE" : "OFF"}
            </span>
          </button>

          <h2 className="mt-3.5 text-[25px] font-bold leading-none tracking-[-0.4px] text-[#1c1c2e] dark:text-white">
            {title}
          </h2>
          <p className="mt-1.5 max-w-[210px] text-[15px] leading-[20px] text-[#8E8E93]">
            {subtitle}
          </p>

          {isSharing ? (
            <div className="mt-[18px] inline-flex items-center gap-[11px] rounded-[14px] bg-white px-3.5 py-[11px] shadow-[0_2px_8px_rgba(0,0,0,0.06)] dark:bg-[#2f2f35] dark:shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[#efe9fb] dark:bg-[#7c5cff]/20">
                <Clock className="h-[15px] w-[15px] text-[#7c5cff] dark:text-[#a78bfa]" />
              </span>
              <span className="block">
                <span className="block text-[15px] font-bold text-[#1c1c2e] dark:text-white">
                  {endsLabel ?? "Sharing live"}
                </span>
                {startedLabel ? (
                  <span className="mt-px block text-[15px] leading-[20px] text-[#8E8E93]">
                    {startedLabel}
                  </span>
                ) : null}
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={onTapShare}
              className="mt-[18px] inline-flex items-center gap-[9px] rounded-full bg-[color:var(--app-accent)] px-5 py-3 text-[color:var(--app-accent-fg)] shadow-[0_4px_14px_rgba(0,122,255,0.32)]"
            >
              <Navigation className="h-4 w-4" />
              <span className="text-base font-semibold">Tap to share</span>
            </button>
          )}
        </div>
      </div>

      {/* Privacy footer. */}
      <div className="flex items-center gap-[11px] border-t border-black/[0.06] px-[18px] py-3.5 dark:border-white/[0.08]">
        <Lock className="h-[15px] w-[15px] text-black/40 dark:text-white/40" />
        <span className="text-[15px] leading-[20px] text-[#8E8E93]">
          Your location is only visible to your circle.
        </span>
      </div>
    </div>
  );
}
