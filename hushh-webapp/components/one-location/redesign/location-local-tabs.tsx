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
      className={className}
    />
  );
}
