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
  it("keeps the old Settings entry out of the compact Now hub", () => {
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).not.toContain('testId="one-location-settings-entry"');
    expect(nowSource).not.toContain('title="Privacy"');
  });

  it("keeps Now private-first with More actions behind the shared action menu", () => {
    // Now answers who can see the user first. Extra actions still exist, but
    // they sit behind one quiet More actions row instead of a dashboard grid.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).toContain("LocationNowStatePanel");
    expect(nowSource).toContain('"Private"');
    expect(nowSource).toContain('"No one can see your location"');
    expect(nowSource).toContain('"Share only when you choose."');
    expect(nowSource).toContain('"Share my location"');
    expect(nowSource).toContain('data-testid="one-location-request-row"');
    expect(nowSource).toContain('label="More actions"');
    expect(nowSource).toContain('id: "arrival-confirm"');
    expect(nowSource).toContain('label: "Save My Soul"');

    const primaryIndex = nowSource.indexOf("LocationNowStatePanel");
    const requestIndex = nowSource.indexOf("onRequestLocation={onRequestLocation}");
    const activityIndex = nowSource.indexOf("one-location-now-activity");
    expect(primaryIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(primaryIndex);
    expect(activityIndex).toBeGreaterThan(requestIndex);
    expect(nowSource).not.toContain('title: "Active shares"');
    expect(nowSource).not.toContain("LocationActionGrid");
    expect(nowSource).not.toContain("LocationNowGroupLabel");

    // Reuses the existing ask flow rather than introducing a second one, so
    // voice and the search bar keep naming a single control.
    expect(nowSource).toContain('data-voice-control-id="one-location-action-ask"');
    expect(HUB_SOURCE).toContain('onRequestLocation={() => openFlow("ask")}');
  });

  it("keeps Location unavailable as a dominant Now state, not a global tab warning", () => {
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);
    const hubStart = HUB_SOURCE.indexOf("/* Hub (Now | People | Links)");
    const hubEnd = HUB_SOURCE.indexOf("<TopShellTabs", hubStart);
    const headerSource = HUB_SOURCE.slice(hubStart, hubEnd);

    expect(nowSource).toContain('"Location unavailable"');
    expect(nowSource).toContain('"Location access is off"');
    expect(nowSource).toContain('"Turn it on to share your location."');
    expect(nowSource).toContain('"Turn on Location"');
    expect(headerSource).not.toContain("LocationPermissionRecoveryCard");
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
