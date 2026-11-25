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
  const [visitedDirectories, setVisitedDirectories] = useState<
    ReadonlySet<NearbyDirectory>
  >(() => new Set(["advisors"]));

  const selectDirectory = (next: NearbyDirectory) => {
    setDirectory(next);
    setVisitedDirectories((current) => {
      if (current.has(next)) return current;
      return new Set([...current, next]);
    });
  };

  const filters = (
      <FilterChipRow testId="nearby-directory-filters">
        {DIRECTORY_TABS.map((option) => (
          <FilterChip
            key={option.value}
            active={directory === option.value}
            onClick={() => selectDirectory(option.value as NearbyDirectory)}
            testId={`nearby-directory-${option.value}`}
          >
            {option.label}
          </FilterChip>
        ))}
      </FilterChipRow>
  );

  return (
    <div className="space-y-4" data-testid="nearby-directories">
      {visitedDirectories.has("advisors") ? (
        <div hidden={directory !== "advisors"} aria-hidden={directory !== "advisors"}>
          <AdvisorsNearby getIdToken={getIdToken} filters={directory === "advisors" ? filters : undefined} />
        </div>
      ) : null}
      {visitedDirectories.has("insurance") ? (
        <div hidden={directory !== "insurance"} aria-hidden={directory !== "insurance"}>
          <InsuranceAgentsNearby getIdToken={getIdToken} filters={directory === "insurance" ? filters : undefined} />
        </div>
      ) : null}
      {visitedDirectories.has("places") ? (
        <div hidden={directory !== "places"} aria-hidden={directory !== "places"}>
          <PlacesNearby getIdToken={getIdToken} filters={directory === "places" ? filters : undefined} />
        </div>
      ) : null}
    </div>
  );
}
