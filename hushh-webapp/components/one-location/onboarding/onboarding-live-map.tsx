"use client";

import { UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import { cn } from "@/lib/utils";

const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1c212a" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8d99a8" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#14171d" }] },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#0f1620" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#2a313d" }],
  },
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
];

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
  const { status } = useGoogleMaps({ enabled: Boolean(point) });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    if (status !== "ready" || !point) return;
    const host = hostRef.current;
    if (!host) return;

    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches;

    const map = new google.maps.Map(host, {
      center: point,
      zoom: 16,
      disableDefaultUI: true,
      gestureHandling: "none",
      keyboardShortcuts: false,
      clickableIcons: false,
      styles: prefersDark ? DARK_MAP_STYLES : undefined,
    });
    setRendered(true);

    return () => {
      // Google keeps no dispose hook; dropping the node is the supported way to
      // release the instance, and the host is unmounted with this screen.
      google.maps.event.clearInstanceListeners(map);
      setRendered(false);
    };
  }, [point, status]);

  const live = rendered && status === "ready";

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      data-testid="onboarding-live-map"
      data-map-state={live ? "live" : "stylised"}
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

      {/* The empty seat. Dashed and unlabelled by design: it shows where a
          circle member will land without inventing a person who is not there,
          which is what makes the invite below feel necessary rather than
          administrative. */}
      <span
        className="pointer-events-none absolute left-[62%] top-[38%] flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-dashed border-[color:var(--app-accent)]/45 bg-white/55 dark:bg-white/[0.06]"
        data-onboarding-map-companion
      >
        <UserPlus
          className="h-4 w-4 text-[color:var(--app-accent)]/70"
          strokeWidth={2.2}
        />
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
        [data-onboarding-map-companion] {
          animation: oneOnboardingSeat 620ms cubic-bezier(0.22, 1, 0.36, 1) both;
          animation-delay: 900ms;
        }
        @keyframes oneOnboardingSeat {
          from { opacity: 0; transform: translate(-50%, -30%) scale(0.7); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-onboarding-map-pulse] { animation: none; opacity: 0.35; }
          [data-onboarding-map-companion] {
            animation: none;
            opacity: 1;
            transform: translate(-50%, -50%);
          }
        }
      `}</style>
    </div>
  );
}
