import fs from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocalEmergencyDialerRow } from "@/components/one-location/redesign/local-emergency-dialer-row";

const HUB_SOURCE = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../components/one-location/redesign/location-redesign-hub.tsx",
  ),
  "utf8",
);
const SMS_PANEL_SOURCE = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../components/one-location/redesign/sos-panel.tsx",
  ),
  "utf8",
);

describe("One Location SMS emergency actions", () => {
  it("opens the US 911 dialer only after an explicit user tap", () => {
    render(<LocalEmergencyDialerRow />);

    expect(
      screen.getByRole("link", { name: "Call 911" }),
    ).toHaveAttribute("href", "tel:911");
    expect(screen.getByText("Emergency services")).toBeInTheDocument();
    expect(screen.getByText("United States")).toBeInTheDocument();
    expect(SMS_PANEL_SOURCE).toContain("href={`tel:${emergency.number}`}");
  });

  it("does not advertise unimplemented SOS support actions", () => {
    expect(HUB_SOURCE).not.toContain('title="Emergency Contact"');
    expect(HUB_SOURCE).not.toContain('title="Crisis Support"');
    expect(HUB_SOURCE).not.toContain('title="Safety Check"');
  });

  it("keeps ambient tint sampling outside every Location action flow", () => {
    expect(HUB_SOURCE).toContain('data-testid="one-location-action-flow"');
    expect(HUB_SOURCE).toContain("data-ambient-chrome-ignore");
  });
});
