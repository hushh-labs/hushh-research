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
const PROFILE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../app/profile/profile-workspace-page.tsx"),
  "utf8",
);

describe("One Location settings placement", () => {
  it("keeps Settings as a compact Now-hub entry", () => {
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).toContain('testId="one-location-settings-entry"');
    expect(nowSource).toContain('title="Settings"');
    expect(nowSource).not.toContain('title="Privacy"');
  });

  it("owns Saved Locations and does not duplicate it in Profile preferences", () => {
    const settingsStart = HUB_SOURCE.indexOf("function LocationSettingsFlow");
    const settingsEnd = HUB_SOURCE.indexOf("/* PEOPLE HUB", settingsStart);
    const settingsSource = HUB_SOURCE.slice(settingsStart, settingsEnd);

    expect(settingsSource).toContain("<SavedLocationsSection />");
    expect(PROFILE_SOURCE).not.toContain("SavedLocationsSection");
  });

  it("does not render the settings entry inside focused action flows", () => {
    const actionFlowStart = HUB_SOURCE.indexOf("/* Task flows");
    const actionFlowEnd = HUB_SOURCE.indexOf(
      "/* Hub (Now | People | Links)",
      actionFlowStart,
    );
    const actionFlowSource = HUB_SOURCE.slice(actionFlowStart, actionFlowEnd);
    const sosStart = HUB_SOURCE.indexOf("function SosFlow");
    const sosEnd = HUB_SOURCE.indexOf("function ShareFlow", sosStart);
    const sosSource = HUB_SOURCE.slice(sosStart, sosEnd);

    expect(actionFlowSource).not.toContain("one-location-settings-entry");
    expect(sosSource).not.toContain(">Privacy<");
  });
});
