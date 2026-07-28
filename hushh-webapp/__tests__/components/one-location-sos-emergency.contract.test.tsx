import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
  it("renders a dialer only after the local emergency number resolves", () => {
    expect(SMS_PANEL_SOURCE).toContain(
      'emergencyStatus === "resolved" && emergency',
    );
    expect(SMS_PANEL_SOURCE).toContain("href={`tel:${emergency.number}`}");
    expect(SMS_PANEL_SOURCE).not.toContain("emergencyInfoForPoint");
    expect(SMS_PANEL_SOURCE).not.toContain('href="tel:911"');
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
