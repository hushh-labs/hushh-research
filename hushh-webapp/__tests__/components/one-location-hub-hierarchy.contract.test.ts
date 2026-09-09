import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HUB = path.join(
  process.cwd(),
  "components/one-location/redesign/location-redesign-hub.tsx",
);

const source = readFileSync(HUB, "utf8");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the hub`).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("Location hub hierarchy", () => {
  it("keeps exactly one Location title before the local tab strip and content", () => {
    const body = functionBody("LocationRedesignHub");
    const headerIndex = body.indexOf("<PageHeader");
    const titleMatches =
      body.match(/<PageTitle\s+as="span">\s*Location\s*<\/PageTitle>/g) ?? [];
    const tabsIndex = body.indexOf("<TopShellTabs");
    const swipeIndex = body.indexOf("<SwipeViews");
    const linksIndex = body.indexOf("<LinksHub");

    expect(countOccurrences(body, "<PageHeader")).toBe(1);
    expect(titleMatches).toHaveLength(1);
    expect(countOccurrences(body, "<TopShellTabs")).toBe(1);
    expect(countOccurrences(body, "<SwipeViews")).toBe(1);
    expect(headerIndex).toBeGreaterThan(-1);
    expect(tabsIndex).toBeGreaterThan(headerIndex);
    expect(swipeIndex).toBeGreaterThan(tabsIndex);
    expect(linksIndex).toBeGreaterThan(swipeIndex);
  });

  it("keeps focused Location action routes outside the tabbed hub chrome", () => {
    const body = functionBody("LocationRedesignHub");
    const flowGuardIndex = body.indexOf('if (flow !== "none")');
    const actionFlowIndex = body.indexOf(
      'data-testid="one-location-action-flow"',
    );
    const hubStartIndex = body.indexOf("/* Hub (Now | People | Links)");
    const actionFlowWindow = body.slice(flowGuardIndex, hubStartIndex);

    expect(flowGuardIndex).toBeGreaterThan(-1);
    expect(actionFlowIndex).toBeGreaterThan(flowGuardIndex);
    expect(hubStartIndex).toBeGreaterThan(actionFlowIndex);
    expect(actionFlowWindow).not.toContain("<PageHeader");
    expect(actionFlowWindow).not.toContain("<TopShellTabs");
    expect(actionFlowWindow).not.toContain("<SwipeViews");
    expect(actionFlowWindow).not.toContain("<LocationPermissionRecoveryCard");

    for (const flow of [
      '"share"',
      '"ask"',
      '"check-in"',
      '"sos"',
      '"active-shares"',
      '"shared-with-me"',
      '"needs-review"',
      '"settings"',
    ]) {
      expect(actionFlowWindow).toContain(`flow === ${flow}`);
    }
  });

  it("uses one shared enter transition when opening and closing focused flows", () => {
    const body = functionBody("LocationRedesignHub");
    const motionStart = body.indexOf(
      "usePageEnterAnimation(flowContainerRef",
    );
    const motionWindow = body.slice(motionStart, motionStart + 500);

    expect(motionStart).toBeGreaterThan(-1);
    expect(motionWindow).toContain("key: flow");
    expect(motionWindow).toContain("enabled: true");
    expect(body).toContain(
      '<div ref={flowContainerRef} className="space-y-4 sm:space-y-5">',
    );
    expect(body).toContain("ref={flowContainerRef}");
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

  it("keeps the People hub focused without the contact-sync explainer", () => {
    const peopleBody = functionBody("PeopleHub");

    expect(peopleBody).not.toContain("ContactInvitationNotice");
    expect(source).not.toContain(
      'import { ContactInvitationNotice } from "@/components/connections/contact-invitation-notice"',
    );
  });
});
