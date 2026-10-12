"use client";

import { Button } from "@/components/ui/button";

/** An explicit permission action over the live neutral map, without an interstitial. */
export function MapRendererAccess({ onAccept, inline = false }: { onAccept: () => void; inline?: boolean }) {
  return (
    <section
      aria-label="Google Maps access"
      data-testid="one-location-map-renderer-access"
      className={`flex flex-col items-start gap-2 rounded-2xl border border-border/60 bg-background/95 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-3 ${inline ? "mb-4 px-3" : "absolute inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-20 mx-auto max-w-lg px-4 shadow-lg backdrop-blur-xl"}`}
    >
      <p className="w-full min-w-0 flex-1 text-sm leading-5 text-muted-foreground sm:w-auto">
        Show your location with Google Maps.
      </p>
      <Button size="compact" className="min-h-11 shrink-0 px-3" onClick={onAccept}>
        Use Google Maps
      </Button>
    </section>
  );
}
