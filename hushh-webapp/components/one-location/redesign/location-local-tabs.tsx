"use client";

/**
 * LocationLocalTabs — Figma "Now | People | Links | Inbox" local navigator.
 *
 * PRESENTATION ONLY. This wraps the app-wide `SegmentedTabs` primitive so the
 * tab background, active pill, colors, and typography are IDENTICAL to the
 * segmented tabs used elsewhere (profile settings, etc). It is NOT the global
 * app footer (components/navbar.tsx), which stays untouched, and it only appears
 * on hub/state screens, never inside focused task flows.
 */

import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { cn } from "@/lib/utils";

export type LocationHubTab = "now" | "people" | "links" | "inbox";

const TAB_LABELS: Record<LocationHubTab, string> = {
  now: "Now",
  people: "People",
  links: "Links",
  inbox: "Inbox",
};

const TAB_ORDER: LocationHubTab[] = ["now", "people", "links", "inbox"];

export function LocationLocalTabs({
  value,
  onChange,
  badges,
  className,
}: {
  value: LocationHubTab;
  onChange: (next: LocationHubTab) => void;
  /** Optional per-tab count badges (e.g. inbox: 1 new). */
  badges?: Partial<Record<LocationHubTab, number>>;
  className?: string;
}) {
  const options = TAB_ORDER.map((tab) => {
    const count = badges?.[tab];
    return {
      value: tab,
      label: count ? `${TAB_LABELS[tab]} (${count})` : TAB_LABELS[tab],
    };
  });

  return (
    <SegmentedTabs
      value={value}
      onValueChange={(next) => onChange(next as LocationHubTab)}
      options={options}
      className={cn(
        // Location: accent active pill (accent-tinted fill + accent text),
        // scoped to the location tabs by overriding the shared segmented-tab
        // CSS vars here — the app-wide primitive stays untouched. Follows the
        // active accent preference (iOS Blue default, Molten Gold opt-in).
        "[--app-segmented-active-surface:var(--app-accent-surface)] [--app-segmented-active-foreground:var(--app-accent)] [--app-segmented-active-border:transparent]",
        // Squarish shape per the design (container 16px, tab pills 12px) instead
        // of the primitive's full-round. Literal px values because this app's
        // --radius scale is large (rounded-xl ≈ 24px here). tailwind-merge lets
        // rounded-[16px] override the primitive's rounded-full on the container.
        "rounded-[16px] [&_button]:rounded-[12px]",
        className,
      )}
    />
  );
}
