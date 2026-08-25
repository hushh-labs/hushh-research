"use client";

import { useState } from "react";

import { AdvisorsNearby } from "@/components/connect/advisors-nearby";
import { InsuranceAgentsNearby } from "@/components/connect/insurance-agents-nearby";
import { PlacesNearby } from "@/components/connect/places-nearby";
import { FilterChip, FilterChipRow } from "@/lib/morphy-ux/ui";

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
      {/* Chips, not a segmented strip.

          Two reasons, and the second is why it changed now.

          It never fitted: measured at 320px, "Insurance" needed 69px and had
          59px, so this shipped as "Insuranc…" on the narrowest phones. A
          segmented strip divides its width between its options, so the labels
          were always going to lose. A chip sizes to its own content and the
          row wraps, which removes the constraint rather than tightening the
          padding against it.

          And Connect now has a strip above the People/RIAs/Around-you one, so
          this would have been the third pill strip on a 375px screen. These
          three are not three places you go -- they are three sources filtered
          by one location, a slice of the list below. Saying that with chips
          leaves one grammar on the surface: strip for where you are, chips for
          which slice. */}
      <FilterChipRow testId="nearby-directory-filters">
        {DIRECTORY_TABS.map((option) => (
          <FilterChip
            key={option.value}
            active={directory === option.value}
            onClick={() => setDirectory(option.value as NearbyDirectory)}
            testId={`nearby-directory-${option.value}`}
          >
            {option.label}
          </FilterChip>
        ))}
      </FilterChipRow>

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
