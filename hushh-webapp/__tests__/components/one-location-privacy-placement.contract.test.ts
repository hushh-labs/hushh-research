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

describe("One Location privacy entry placement", () => {
  it("adds the privacy entry to every main hub tab", () => {
    const hubStart = HUB_SOURCE.indexOf("/* Hub (Now | People | Links | Inbox)");
    const hubEnd = HUB_SOURCE.indexOf("/* NOW HUB", hubStart);
    const hubSource = HUB_SOURCE.slice(hubStart, hubEnd);

    expect(hubSource.match(/<LocationHubPanel /g)).toHaveLength(4);
    expect(hubSource).toContain('data-testid="one-location-privacy-entry"');
    expect(hubSource).toMatch(/>\s*Settings\s*</);
    expect(hubSource).not.toMatch(/>\s*Privacy\s*</);
  });

  it("does not render the privacy entry inside focused action flows", () => {
    const actionFlowStart = HUB_SOURCE.indexOf("/* Task flows");
    const actionFlowEnd = HUB_SOURCE.indexOf("/* Hub (Now", actionFlowStart);
    const actionFlowSource = HUB_SOURCE.slice(actionFlowStart, actionFlowEnd);
    const sosStart = HUB_SOURCE.indexOf("function SosFlow");
    const sosEnd = HUB_SOURCE.indexOf("function ShareFlow", sosStart);
    const sosSource = HUB_SOURCE.slice(sosStart, sosEnd);

    expect(actionFlowSource).not.toContain("one-location-privacy-entry");
    expect(sosSource).not.toContain(">Privacy<");
  });
});
