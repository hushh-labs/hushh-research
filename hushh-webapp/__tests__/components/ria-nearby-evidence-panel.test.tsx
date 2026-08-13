/**
 * The reviewed release attaches a note to every record it publishes: limited
 * coverage on all sixty, single source family on fifty-five. These pin the
 * reframing — that is a property of a careful first release, not a fault, and
 * an alarm on every profile teaches an advisor to ignore all of them.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NearbyEvidencePanel } from "@/components/ria/nearby/nearby-evidence-panel";
import type { NearbyEvidence } from "@/lib/services/nws-nearby-service";

function evidence(over: Partial<NearbyEvidence> = {}): NearbyEvidence {
  return {
    citationCount: 2,
    sourceFamilyCount: 1,
    factCount: 4,
    independentSourceFamilies: false,
    reviewFlags: ["SINGLE_SOURCE_FAMILY"],
    ...over,
  };
}

const RELEASE_WARNINGS = [
  "Limited evidence coverage; score is conservative.",
  "Most evidence comes from one source family.",
];

describe("evidence panel", () => {
  it("states how much evidence stands behind the record", () => {
    render(<NearbyEvidencePanel evidence={evidence()} warnings={[]} />);

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("reviewed facts")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("citations")).toBeInTheDocument();
    expect(screen.getByText("organisation")).toBeInTheDocument();
  });

  it("says plainly when nothing independent has confirmed the record", () => {
    // Two links from one organisation are not two confirmations. This is the
    // difference between a claim to act on and one to check first.
    render(<NearbyEvidencePanel evidence={evidence()} warnings={[]} />);

    expect(
      screen.getByText("Not yet confirmed by a second organisation"),
    ).toBeInTheDocument();
  });

  it("credits a record that independent organisations do confirm", () => {
    render(
      <NearbyEvidencePanel
        evidence={evidence({
          independentSourceFamilies: true,
          sourceFamilyCount: 2,
          reviewFlags: [],
        })}
        warnings={[]}
      />,
    );

    expect(screen.getByText("Confirmed by independent organisations")).toBeInTheDocument();
    expect(screen.getByText("organisations")).toBeInTheDocument();
  });

  it("does not render release notes as errors", () => {
    const { container } = render(
      <NearbyEvidencePanel evidence={evidence()} warnings={RELEASE_WARNINGS} />,
    );

    // Sixty of sixty records carry these. Red on all of them is alarm fatigue.
    expect(container.querySelector(".text-destructive")).toBeNull();
  });

  it("shows a flag instead of the warning that repeats it", () => {
    render(<NearbyEvidencePanel evidence={evidence()} warnings={RELEASE_WARNINGS} />);

    expect(screen.getByText("All citations come from one organisation")).toBeInTheDocument();
    // The flag already said it; saying it twice is noise.
    expect(
      screen.queryByText("Most evidence comes from one source family."),
    ).not.toBeInTheDocument();
  });

  it("falls back to the warning text when the release raised no flag", () => {
    render(<NearbyEvidencePanel evidence={evidence({ reviewFlags: [] })} warnings={RELEASE_WARNINGS} />);

    expect(
      screen.getByText("Limited evidence coverage; score is conservative."),
    ).toBeInTheDocument();
  });

  it("renders an unmapped flag readably rather than as a constant", () => {
    render(
      <NearbyEvidencePanel
        evidence={evidence({ reviewFlags: ["SOME_FUTURE_FLAG"] })}
        warnings={[]}
      />,
    );

    expect(screen.getByText("some future flag")).toBeInTheDocument();
  });
});
