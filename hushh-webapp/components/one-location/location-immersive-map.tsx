"use client";

import { useRouter } from "next/navigation";
import { MapPinned, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Temporary release-safe placeholder for the immersive map route.
 *
 * The native Maps SDK requires separately restricted mobile credentials and a
 * validated Android toolchain. Until that contract is deployed and verified,
 * this route must neither initialize a map provider nor decrypt coordinates.
 */
export function LocationImmersiveMap() {
  const router = useRouter();

  return (
    <main
      className="relative grid h-[100dvh] w-full place-items-center overflow-hidden bg-background px-6"
      data-testid="one-location-map-unavailable"
      data-ambient-chrome-ignore
    >
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="absolute left-4 top-[max(1rem,env(safe-area-inset-top))] rounded-full shadow-lg"
        aria-label="Close Your Map"
        onClick={() => router.replace(ROUTES.ONE_LOCATION)}
      >
        <X className="h-5 w-5" />
      </Button>
      <section className="w-full max-w-sm rounded-[var(--app-card-radius-compact)] border border-border/70 bg-card p-6 text-center shadow-xl">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <MapPinned className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-foreground">Your Map is unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          We are completing the secure native Maps setup. Your active shares remain available from Location.
        </p>
        <Button className="mt-5 w-full" onClick={() => router.replace(ROUTES.ONE_LOCATION)}>
          Back to Location
        </Button>
      </section>
    </main>
  );
}
