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

  it("offers Ask for location beside Share location in Quick actions", () => {
    // The Now hub listed every way to give a location out -- Share, Map, Active
    // shares, Shared with me -- and no way to ask for one; asking was reachable
    // only from the People tab. It has since moved out of the status list and
    // into the Quick actions grid, next to Share location: the two are the
    // same kind of decision (give a location out / ask for one in), so they
    // belong in the same "things you DO" group, not split across a list and a
    // grid. The visible label is "Ask for location"; the internal flow name
    // ("ask") and its voice control id are unchanged.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).toContain('testId="one-location-request-row"');
    expect(nowSource).toContain('title="Ask for location"');

    const requestIndex = nowSource.indexOf('title="Ask for location"');
    const shareIndex = nowSource.indexOf('title="Share location"');
    const settingsIndex = nowSource.indexOf('title="Settings"');
    expect(requestIndex).toBeGreaterThan(-1);
    expect(shareIndex).toBeGreaterThan(-1);
    // Same grid, not split across the grid and the status list below it.
    expect(requestIndex).toBeGreaterThan(shareIndex);
    expect(settingsIndex).toBeGreaterThan(requestIndex);

    // Reuses the existing ask flow rather than introducing a second one, so
    // voice and the search bar keep naming a single control.
    expect(nowSource).toContain('controlId="one-location-action-ask"');
    expect(HUB_SOURCE).toContain('onRequestLocation={() => openFlow("ask")}');
  });

  it("gives Ask for location an icon distinct from Share location", () => {
    // These two tiles are opposites -- give a location out, ask for one in --
    // and sit side by side in the same grid. `Send` was used first and reads
    // as the same paper-plane silhouette as `Navigation` at tile size, so the
    // pair looked like one repeated icon.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    const iconFor = (title: string) => {
      const titleIndex = nowSource.indexOf(`title="${title}"`);
      expect(titleIndex).toBeGreaterThan(-1);
      const cardStart = nowSource.lastIndexOf("<QuickActionCard", titleIndex);
      return /icon=\{<(\w+)/.exec(nowSource.slice(cardStart, titleIndex))?.[1];
    };

    const requestIcon = iconFor("Ask for location");
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
