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

  it("offers Request Location directly above Settings in the Now hub", () => {
    // The Now hub listed every way to give a location out -- Share, Map, Active
    // shares, Shared with me -- and no way to ask for one; asking was reachable
    // only from the People tab. Placement matters: it belongs with the other
    // list entries, immediately above Settings, not buried in Quick actions.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);

    expect(nowSource).toContain('testId="one-location-request-row"');
    expect(nowSource).toContain('title="Request location"');

    const requestIndex = nowSource.indexOf('title="Request location"');
    const settingsIndex = nowSource.indexOf('title="Settings"');
    expect(requestIndex).toBeGreaterThan(-1);
    expect(settingsIndex).toBeGreaterThan(requestIndex);

    // Reuses the existing ask flow rather than introducing a second one, so
    // voice and the search bar keep naming a single control.
    expect(nowSource).toContain('voiceControlId="one-location-action-ask"');
    expect(HUB_SOURCE).toContain('onRequestLocation={() => openFlow("ask")}');
  });

  it("gives every Now navigation row one distinct semantic icon", () => {
    // The current product direction intentionally adds scan-friendly icons to
    // the formerly text-only reference rows. They stay inside the shared
    // SettingsRow wells so light/dark/accent themes and row geometry remain
    // owned by the design system.
    const nowStart = HUB_SOURCE.indexOf("function NowHub");
    const nowEnd = HUB_SOURCE.indexOf("function LocationDetailFlow", nowStart);
    const nowSource = HUB_SOURCE.slice(nowStart, nowEnd);
    const groupStart = nowSource.indexOf(
      'data-testid="one-location-now-primary"',
    );
    const groupEnd = nowSource.indexOf("</section>", groupStart);
    const groupSource = nowSource.slice(groupStart, groupEnd);

    expect(groupSource).toContain('title="Request location"');
    expect(groupSource).toContain('title="Settings"');
    expect(groupSource.match(/icon=\{/gu)).toHaveLength(6);
    expect(groupSource).toContain("icon={Map}");
    expect(groupSource).toContain("icon={RadioTower}");
    expect(groupSource).toContain("icon={MapPinCheck}");
    expect(groupSource).toContain("icon={ShieldQuestion}");
    expect(groupSource).toContain("icon={MessageCircleQuestion}");
    expect(groupSource).toContain("icon={Settings2}");
    expect(groupSource).toMatch(
      /icon=\{RadioTower\}[\s\S]*?iconTone=\{vm\.activeOwnerGrants\.length > 0 \? "green" : "gray"\}/u,
    );
    expect(groupSource).toMatch(
      /icon=\{ShieldQuestion\}[\s\S]*?iconTone=\{vm\.pendingOwnerRequests\.length > 0 \? "orange" : "gray"\}/u,
    );
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
