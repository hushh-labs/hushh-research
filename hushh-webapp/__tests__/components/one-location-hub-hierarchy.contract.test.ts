import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HUB = path.join(
  process.cwd(),
  "components/one-location/redesign/location-redesign-hub.tsx",
);

const source = readFileSync(HUB, "utf8");

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the hub`).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("Location hub hierarchy", () => {
  it("keeps the module header before the local tab strip and Links content", () => {
    const body = functionBody("LocationRedesignHub");
    const headerIndex = body.indexOf("<PageHeader");
    const tabsIndex = body.indexOf("<TopShellTabs");
    const swipeIndex = body.indexOf("<SwipeViews");
    const linksIndex = body.indexOf("<LinksHub");

    expect(headerIndex).toBeGreaterThan(-1);
    expect(tabsIndex).toBeGreaterThan(headerIndex);
    expect(swipeIndex).toBeGreaterThan(tabsIndex);
    expect(linksIndex).toBeGreaterThan(swipeIndex);
  });

  it("uses the central Location tab registry for the in-hub tabs and pager", () => {
    const body = functionBody("LocationRedesignHub");
    const tabsWindow = body.slice(
      body.indexOf("<TopShellTabs"),
      body.indexOf("<SwipeViews"),
    );
    const swipeWindow = body.slice(
      body.indexOf("<SwipeViews"),
      body.indexOf("</SwipeViews>"),
    );

    expect(tabsWindow).toContain("LOCATION_TAB_DEFINITION");
    expect(tabsWindow).toContain("activeValue: tab");
    expect(swipeWindow).toContain("tabSetId={LOCATION_TAB_DEFINITION.id}");
    expect(swipeWindow).toContain("options={LOCATION_SWIPE_OPTIONS}");
  });

  it("keeps Now, People, and Links on shared Location primitives", () => {
    const peopleBody = functionBody("PeopleHub");
    const linksBody = functionBody("LinksHub");

    expect(source).toContain("const LOCATION_GROUP_SURFACE");
    expect(source).not.toContain("PEOPLE_GROUP_SURFACE");
    expect(peopleBody).toContain("className={LOCATION_GROUP_SURFACE}");

    expect(linksBody).toContain("<SettingsGroup");
    expect(linksBody).toContain(
      "shellClassName={LOCATION_GROUP_SHELL_CLASSNAME}",
    );
    expect(linksBody).toContain("<SettingsRow");
    expect(linksBody).toContain("<DurationSelector");
    expect(linksBody).not.toContain("<TemporaryLinkCard");
    expect(linksBody).not.toContain("SUBCARD_SURFACE");
  });
});
