"use client";

import { useEffect, useRef, useState } from "react";
import { MapPinOff } from "lucide-react";
import { useTheme } from "next-themes";

import { googleMapsLocationEmbedUrl } from "@/lib/one-location/maps-urls";
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
 * There are exactly three things it can draw, and they are not interchangeable:
 *
 *   live         a coordinate and a working Maps script -- the real thing
 *   embed        a coordinate but no usable Maps script -- still a real map,
 *                the same keyless Google embed `live-map.tsx` degrades to,
 *                because a missing or referrer-blocked browser key is common
 *                enough that it is the entire local-dev story
 *   unavailable  no coordinate at all -- the only case with no map to show
 *
 * The screen used to draw one stylised picture for all three: a grid, two
 * diagonal streaks and a pulsing blue dot floating over nothing. It looked
 * composed, which is most of why nobody read it as broken -- and under a
 * headline that says "You're on the map." it was a picture of a map the person
 * was not on. A decorative grid is not a fallback; it is a claim.
 */
export function OnboardingLiveMap({
  point,
  emptyLabel = "Map unavailable",
  className,
}: {
  point: { lat: number; lng: number } | null;
  /**
   * What to say when there is no coordinate to draw. The caller knows why --
   * Location refused is a different sentence from Maps not loading -- and
   * guessing here would put the wrong one on screen.
   */
  emptyLabel?: string;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";
  const { status } = useGoogleMaps({ enabled: Boolean(point) });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [rendered, setRendered] = useState(false);
  /**
   * Depend on the numbers, not the object.
   *
   * `point` is computed by the caller, so a render that changes nothing about
   * where the person is still hands this component a fresh object. With that
   * object in the effect below's dependencies, every such render tore the map
   * down and built a new one -- and the cleanup's `setRendered(false)` flashes
   * the fallback on the way through. That was invisible while this screen was
   * never given a point at all; it is not invisible now.
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
    mapRef.current = map;
    setRendered(true);

    return () => {
      // Google keeps no dispose hook; dropping the node is the supported way to
      // release the instance, and the host is unmounted with this screen.
      google.maps.event.clearInstanceListeners(map);
      mapRef.current = null;
      setRendered(false);
    };
    // `lat`/`lng` are read on construction but are deliberately NOT
    // dependencies: the device keeps answering while this screen is open, and
    // rebuilding a google.maps.Map on every fix would blink the finale several
    // times in the few seconds it exists. The camera follows in the effect
    // below instead. `colorScheme` stays, because Google accepts it only at
    // construction, so a theme change genuinely is a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorScheme, status]);

  // The device is still reporting while this screen is open. Follow it with the
  // camera rather than a rebuild -- the same reason `live-map.tsx` pans.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat === null || lng === null) return;
    map.setCenter({ lat, lng });
  }, [lat, lng]);

  const live = rendered && status === "ready";
  const hasPoint = lat !== null && lng !== null;
  // A coordinate with no usable Maps script still deserves a real map. This is
  // the same keyless embed every other Location surface degrades to.
  const embedded = hasPoint && !live;
  const mapState = live ? "live" : embedded ? "embed" : "unavailable";

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      data-testid="onboarding-live-map"
      data-map-state={mapState}
      // Two very different reasons used to produce the same stylised picture:
      // nobody gave this screen a coordinate, or the Maps script never became
      // usable. They were indistinguishable from the outside, which is most of
      // why the first one went unnoticed -- the screen looked composed and said
      // nothing. Saying which is which costs one attribute.
      data-map-point={hasPoint ? "ready" : "none"}
      // Decorative while it is a map: the headline already says what it shows.
      // Not decorative when it cannot draw one -- then it is the only thing on
      // the screen explaining why, and a screen reader must hear it.
      aria-hidden={hasPoint ? true : undefined}
    >
      <div ref={hostRef} className="absolute inset-0" />

      {embedded && lat !== null && lng !== null ? (
        <iframe
          title="Map of where you are"
          src={googleMapsLocationEmbedUrl({ lat, lng })}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          // Out of the tab order. An iframe is focusable by default, and this
          // one sits inside an `aria-hidden` container -- focusable content
          // hidden from assistive technology is a trap, not a decoration.
          tabIndex={-1}
          // A backdrop, exactly like the live map above it. The keyless embed
          // has no dark mode, so dark theme applies the same invert+hue-rotate
          // filter live-map uses to stop the surface glowing white.
          className="pointer-events-none absolute inset-0 h-full w-full border-0 dark:[filter:invert(0.9)_hue-rotate(180deg)_saturate(0.85)]"
          data-testid="onboarding-live-map-embed"
        />
      ) : null}

      {/* No coordinate, so no map and no pin. A pin here would point at a place
          nobody knows, which is exactly what the old grid did. */}
      {!hasPoint ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#eef3f8] text-[#6b7280] dark:bg-[#161b23] dark:text-[#8d99a8]"
          data-testid="onboarding-live-map-empty"
        >
          <MapPinOff className="h-6 w-6" strokeWidth={1.8} aria-hidden="true" />
          <p className="text-[14px] font-medium leading-5">{emptyLabel}</p>
        </div>
      ) : null}

      {/* The pin is ours on both real-map paths: a Google marker cannot carry
          the pulse, and keeping one renderer means the animation is identical
          whether the tiles came from the script or the embed. */}
      {hasPoint ? (
        <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span
            className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--app-accent)]/20"
            data-onboarding-map-pulse
          />
          <span className="relative flex h-5 w-5 items-center justify-center rounded-full border-[3px] border-white bg-[color:var(--app-accent)] shadow-[0_6px_18px_rgba(24,57,91,0.35)]" />
        </span>
      ) : null}

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
