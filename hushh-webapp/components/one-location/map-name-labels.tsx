"use client";

import { memo } from "react";

import {
  MAP_NAME_LABEL_MAX_WIDTH_PX,
  MAP_NAME_LABEL_PIN_OFFSET_PX,
  type PlacedMapNameLabel,
} from "@/lib/one-location/map-name-labels";

export interface MapNameLabelsProps {
  labels: PlacedMapNameLabel[];
  /**
   * The camera is moving and the coordinates below describe where it WAS. Only
   * iOS and Android ever set this: those renderers report the camera once it
   * settles, so the honest thing to do mid-gesture is fade out rather than drag
   * a name across the map away from the pin it belongs to.
   */
  stalePositions?: boolean;
}

/**
 * The name that floats above each pin on Your Map.
 *
 * Deliberately inert: `pointer-events-none` all the way down, so a pill can
 * never swallow a pan, a pinch, or a tap meant for the pin underneath -- the
 * renderer's own marker-click listener stays the only thing that answers a tap
 * on a person. It is also `aria-hidden`, because it says nothing the people
 * tray below does not already say in a list a screen reader can move through.
 */
function MapNameLabelsImpl({ labels, stalePositions }: MapNameLabelsProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="one-location-map-name-labels"
      data-label-count={labels.length}
      // z-10 keeps the pills above the map surface and below every control:
      // the top chrome (z-30) and the people tray (z-20) are things you press,
      // and a name is not allowed to sit over one of them.
      className={`pointer-events-none absolute inset-0 z-10 overflow-hidden transition-opacity duration-200 ease-out motion-reduce:transition-none ${
        stalePositions ? "opacity-0" : "opacity-100"
      }`}
    >
      {labels.map((label) => {
        const isSelf = label.kind === "self";
        return (
          <span
            key={label.key}
            data-testid="one-location-map-name-label"
            data-kind={label.kind}
            data-stale={label.stale ? "true" : undefined}
            className={`absolute left-0 top-0 flex select-none items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-4 tracking-[-0.01em] shadow-[0_6px_20px_color-mix(in_oklab,var(--foreground)_22%,transparent)] backdrop-blur-md sm:text-[12px] ${
              isSelf
                ? "border-black/10 bg-white/95 text-foreground shadow-[0_1px_4px_rgba(60,64,67,0.30),0_1px_2px_rgba(60,64,67,0.18)] dark:border-white/15 dark:bg-background/95 dark:text-foreground"
                : label.stale
                  ? "border-border/70 bg-background/85 text-muted-foreground"
                  : "border-[var(--app-accent-border)] bg-background/90 text-foreground"
            }`}
            style={{
              // Positioned with a transform rather than left/top: on web the
              // camera reports every frame of a pan, and a compositor-only
              // property is what keeps fifty of these tracking their pins
              // without a layout pass each time.
              transform: `translate3d(${label.x}px, ${
                label.y - MAP_NAME_LABEL_PIN_OFFSET_PX
              }px, 0) translate(-50%, -100%)`,
              maxWidth: MAP_NAME_LABEL_MAX_WIDTH_PX,
            }}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isSelf
                  ? "hidden"
                  : ""
              }`}
              style={
                isSelf
                  ? undefined
                  : {
                      // The pin's own colour. Reading it from the same tint the
                      // renderer was given is what stops a grey "gone quiet"
                      // pin from wearing a live-coloured dot.
                      backgroundColor: label.stale
                        ? "var(--app-tertiary-label)"
                        : (label.tintCss ?? "var(--app-accent)"),
                    }
              }
            />
            <span className="min-w-0 truncate">{label.text}</span>
            {/* The tail. Without it, a name sitting between two nearby pins is
                a guess about which one it belongs to. */}
            <span
              className={`absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-[5px] rotate-45 rounded-[2px] border-b border-r ${
                isSelf
                  ? "border-black/10 bg-white/95 dark:border-white/15 dark:bg-background/95"
                  : label.stale
                    ? "border-border/70 bg-background/85"
                    : "border-[var(--app-accent-border)] bg-background/90"
              }`}
            />
          </span>
        );
      })}
    </div>
  );
}

export const MapNameLabels = memo(MapNameLabelsImpl);
