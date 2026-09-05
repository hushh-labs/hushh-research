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

  it("offers Ask for location inside the compact Now actions", () => {
    // Request location is an action, not status or utility. The compact Now
    // tab shows Ask, Check in, SMS, count-backed Activity rows, and the quiet
    // More rows without dashboard section labels or the old active-shares row.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).toContain('data-testid="one-location-now-actions"');
    expect(nowSource).toContain('testId: "one-location-request-row"');
    expect(nowSource).toContain('title: "Ask for location"');
    expect(nowSource).toContain('title: "Save My Soul"');

    const actionsIndex = nowSource.indexOf("LocationActionGrid");
    const requestIndex = nowSource.indexOf('title: "Ask for location"');
    const activityIndex = nowSource.indexOf("one-location-now-activity");
    const moreIndex = nowSource.indexOf("one-location-now-more");
    expect(actionsIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(actionsIndex);
    expect(activityIndex).toBeGreaterThan(requestIndex);
    expect(moreIndex).toBeGreaterThan(activityIndex);
    expect(nowSource).toContain('title: "Map"');
    expect(nowSource).toContain('title: "Settings"');
    expect(nowSource).not.toContain('title: "Active shares"');
    expect(nowSource).not.toContain("LocationNowGroupLabel");

    // Reuses the existing ask flow rather than introducing a second one, so
    // voice and the search bar keep naming a single control.
    expect(nowSource).toContain('controlId: "one-location-action-ask"');
    expect(HUB_SOURCE).toContain('onRequestLocation={() => openFlow("ask")}');
  });

  it("gives Ask for location an icon distinct from Share location", () => {
    // These two actions are opposites -- give a location out, ask for one in.
    // They sit in one grid now, so the glyphs must be distinct at a glance.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    const requestIndex = nowSource.indexOf('title: "Ask for location"');
    const requestItem = nowSource.slice(requestIndex, requestIndex + 240);

    expect(requestIndex).toBeGreaterThan(-1);
    expect(requestItem).toContain('<LocationMenuGlyph name="ask"');
    expect(nowSource).toContain('data-location-share-pulse-icon=""');
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
