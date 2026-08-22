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

  it("offers Request Location inside the unified Actions grid", () => {
    // Request location is an action, not status or utility. It belongs beside
    // Share location, Check-In, and SMS in the Actions grid, while
    // Settings stays quiet in More.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).toContain('data-testid="one-location-now-actions"');
    expect(nowSource).toContain('testId: "one-location-request-row"');
    expect(nowSource).toContain('title: "Request location"');
    expect(nowSource).toContain('title: "SMS"');

    const actionsIndex = nowSource.indexOf("LocationActionGrid");
    const requestIndex = nowSource.indexOf('title: "Request location"');
    const activityIndex = nowSource.indexOf("one-location-now-activity");
    const moreIndex = nowSource.indexOf("one-location-now-more");
    const settingsIndex = nowSource.indexOf('title="Settings"');
    expect(actionsIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(actionsIndex);
    expect(activityIndex).toBeGreaterThan(requestIndex);
    expect(moreIndex).toBeGreaterThan(activityIndex);
    expect(settingsIndex).toBeGreaterThan(moreIndex);

    // Reuses the existing ask flow rather than introducing a second one, so
    // voice and the search bar keep naming a single control.
    expect(nowSource).toContain('controlId: "one-location-action-ask"');
    expect(HUB_SOURCE).toContain('onRequestLocation={() => openFlow("ask")}');
  });

  it("gives Request Location an icon distinct from Share location", () => {
    // These two actions are opposites -- give a location out, ask for one in.
    // They sit in one grid now, so the glyphs must be distinct at a glance.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    const iconFor = (title: string) => {
      const titleIndex = nowSource.indexOf(`title: "${title}"`);
      expect(titleIndex).toBeGreaterThan(-1);
      return /icon: <(\w+) \/>/.exec(
        nowSource.slice(titleIndex, titleIndex + 180),
      )?.[1];
    };

    const requestIcon = iconFor("Request location");
    const shareIcon = iconFor("Share location");

    expect(requestIcon).toBeTruthy();
    expect(shareIcon).toBeTruthy();
    expect(requestIcon).not.toBe(shareIcon);
    // Both plane glyphs are interchangeable at this size; neither belongs here.
    expect(["Send", "Navigation"]).not.toContain(requestIcon);
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
