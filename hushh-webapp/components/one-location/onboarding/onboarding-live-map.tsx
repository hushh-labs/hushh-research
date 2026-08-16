"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import { cn } from "@/lib/utils";

/**
 * The map behind the last onboarding screen.
 *
 * Deliberately not the workspace map: no markers, no controls, no gestures. Its
 * only job is to be the moment a new person sees themselves on a real map, so
 * it renders a single pin and nothing that can be interacted with or that could
 * fail loudly.
 *
 * The stylised fallback is not a degraded state to apologise for -- a missing
 * or referrer-blocked Maps key is common enough (it is the entire local-dev
 * story) that the final screen must look composed without one. Onboarding must
 * never end on an error panel.
 */
export function OnboardingLiveMap({
  point,
  className,
}: {
  point: { lat: number; lng: number } | null;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";
  const { status } = useGoogleMaps({ enabled: Boolean(point) });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);
  /**
   * Depend on the numbers, not the object.
   *
   * `point` is computed by the caller, so a render that changes nothing about
   * where the person is still hands this component a fresh object. With that
   * object in the effect below's dependencies, every such render tore the map
   * down and built a new one -- and the cleanup's `setRendered(false)` flashes
   * the stylised fallback on the way through. That was invisible while this
   * screen was never given a point at all; it is not invisible now.
   */
  const lat = point?.lat ?? null;
  const lng = point?.lng ?? null;

  useEffect(() => {
    if (status !== "ready" || lat === null || lng === null) return;
    const host = hostRef.current;
    if (!host) return;

    // Matched to the map used when capturing home/work, so the same place does
    // not look like two different products one screen apart: same zoom, same
    // colorScheme property (not the legacy `styles`, which that surface uses
    // only on its native path), same chrome-free presentation. It reads the
    // app theme rather than the OS, for the same reason -- an app forced to
    // light on a dark phone should not show a dark map here and a light one
    // there.
    const map = new google.maps.Map(host, {
      center: { lat, lng },
      zoom: 17,
      disableDefaultUI: true,
      clickableIcons: false,
      colorScheme,
      // The one deliberate difference: this map is a backdrop, not a picker,
      // so it never takes a gesture.
      gestureHandling: "none",
      keyboardShortcuts: false,
    });
    setRendered(true);

    return () => {
      // Google keeps no dispose hook; dropping the node is the supported way to
      // release the instance, and the host is unmounted with this screen.
      google.maps.event.clearInstanceListeners(map);
      setRendered(false);
    };
    // `colorScheme` belongs here: Google accepts it only at construction, so a
    // theme change genuinely is a rebuild. A coordinate change is a rebuild
    // too, but a real one -- and it can now only happen when the coordinate
    // itself differs, not merely when its wrapper object does.
  }, [colorScheme, lat, lng, status]);

  const live = rendered && status === "ready";

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      data-testid="onboarding-live-map"
      data-map-state={live ? "live" : "stylised"}
      // Two very different reasons produce the same stylised picture: nobody
      // gave this screen a coordinate, or the Maps script never became usable.
      // For two months they were indistinguishable from the outside, which is
      // most of why the first one went unnoticed -- the screen looked composed
      // and said nothing. Saying which is which costs one attribute.
      data-map-point={point ? "ready" : "none"}
      aria-hidden="true"
    >
      <div ref={hostRef} className="absolute inset-0" />

      {/* Drawn under the real map too, so the transition from fallback to live
          is a fade rather than a flash of empty tiles. */}
      {!live ? (
        <div className="absolute inset-0 bg-[#eef3f8] dark:bg-[#161b23]">
          <div
            className="absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                "linear-gradient(0deg, rgba(120,140,170,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(120,140,170,0.16) 1px, transparent 1px)",
              backgroundSize: "38px 38px",
            }}
          />
          <div
            className="absolute -left-[12%] top-[18%] h-[36%] w-[150%] -rotate-[14deg] rounded-full bg-white/70 dark:bg-white/[0.05]"
            aria-hidden="true"
          />
          <div
            className="absolute -right-[22%] top-[58%] h-[26%] w-[120%] rotate-[9deg] rounded-full bg-white/60 dark:bg-white/[0.04]"
            aria-hidden="true"
          />
        </div>
      ) : null}

      {/* The pin is ours in both cases: a Google marker cannot carry the pulse,
          and keeping one renderer means the animation is identical either way. */}
      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <span
          className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--app-accent)]/20"
          data-onboarding-map-pulse
        />
        <span className="relative flex h-5 w-5 items-center justify-center rounded-full border-[3px] border-white bg-[color:var(--app-accent)] shadow-[0_6px_18px_rgba(24,57,91,0.35)]" />
      </span>

      <style>{`
        [data-onboarding-map-pulse] {
          animation: oneOnboardingPulse 2600ms ease-out infinite;
        }
        @keyframes oneOnboardingPulse {
          0%   { transform: translate(-50%, -50%) scale(0.35); opacity: 0.55; }
          70%  { transform: translate(-50%, -50%) scale(1);    opacity: 0; }
          100% { transform: translate(-50%, -50%) scale(1);    opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-onboarding-map-pulse] { animation: none; opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}
