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

describe("One Location SOS emergency actions", () => {
  it("keeps one local emergency row that opens the device dialer", () => {
    render(<LocalEmergencyDialerRow />);

    expect(
      screen.getByRole("link", { name: "Open local emergency dialer" }),
    ).toHaveAttribute("href", "tel:");
    expect(screen.getByText("Local Emergency")).toBeInTheDocument();
    expect(screen.getByText("Open your phone dialer")).toBeInTheDocument();
    expect(HUB_SOURCE.match(/<LocalEmergencyDialerRow \/>/g)).toHaveLength(1);
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
