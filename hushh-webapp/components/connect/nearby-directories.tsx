"use client";

import { useState } from "react";

import { AdvisorsNearby } from "@/components/connect/advisors-nearby";
import { InsuranceAgentsNearby } from "@/components/connect/insurance-agents-nearby";
import { PlacesNearby } from "@/components/connect/places-nearby";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";

type NearbyDirectory = "advisors" | "insurance" | "places";

const DIRECTORY_TABS = [
  { value: "advisors", label: "Advisors" },
  { value: "insurance", label: "Insurance" },
  { value: "places", label: "Places" },
];

/**
 * Everything the "Around you" tab can show, and the switch between them.
 *
 * Two kinds of answer live here and the order says which is which. Advisors and
 * insurance are looked up against registries — FINRA BrokerCheck and the
 * Nationwide locator — where the useful thing is that the row is verifiable.
 * Places comes from a general provider, where the useful thing is only that it
 * is close. Keeping the registry-backed pair first, and default, means the tab
 * still opens on a verifiable answer rather than on a list of coffee shops.
 *
 * `advisors` is the default because it is what this tab already did. Someone
 * who opens Connect and taps "Around you" sees exactly what they saw before
 * this component existed; the other two are a segment away, not in the way.
 *
 * Each directory owns its own fetching, so switching costs one request for the
 * directory you switched to and nothing for the two you did not.
 */
export function NearbyDirectories({
  getIdToken,
}: {
  getIdToken: () => Promise<string | null>;
}) {
  const [directory, setDirectory] = useState<NearbyDirectory>("advisors");

  return (
    <div className="space-y-4" data-testid="nearby-directories">
      <SegmentedTabs
        value={directory}
        onValueChange={(value) => setDirectory(value as NearbyDirectory)}
        options={DIRECTORY_TABS}
        // Same compact padding as the Connect strip above it, for the same
        // reason and found the same way: measured at 320px, "Insurance" needed
        // 69px and had 59px, so this has been shipping as "Insuranc…" on the
        // narrowest phones. Three tabs do not fit at the stock 16px option
        // padding. Nothing changes from 640px up.
        className="[&>button]:px-1 min-[360px]:[&>button]:px-3 sm:[&>button]:px-4.5"
      />

      {directory === "places" ? (
        <PlacesNearby getIdToken={getIdToken} />
      ) : directory === "insurance" ? (
        <InsuranceAgentsNearby getIdToken={getIdToken} />
      ) : (
        <AdvisorsNearby getIdToken={getIdToken} />
      )}
    </div>
  );
}
