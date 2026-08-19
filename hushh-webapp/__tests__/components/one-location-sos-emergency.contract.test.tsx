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
const GLOBALS_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../app/globals.css"),
  "utf8",
);
const SMS_CONTACTS_SOURCE = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../components/one-location/redesign/sms-contacts-flow.tsx",
  ),
  "utf8",
);
const ROUTE_LAYOUT_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../lib/navigation/app-route-layout.ts"),
  "utf8",
);
const PROVIDERS_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../app/providers.tsx"),
  "utf8",
);
const LOCATION_PAGE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../app/one/location/page.tsx"),
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

  // SOS is a Location task flow, not a second app. These assertions are on the
  // source because the failure they guard against is structural: the panel used
  // to paint itself over the entire viewport, which removed the shell's top-bar
  // breadcrumb and forced a duplicate back arrow into the content.
  it("renders SOS inside the shell rather than over it", () => {
    expect(SMS_PANEL_SOURCE).not.toContain("fixed inset-0");
    expect(SMS_PANEL_SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SMS_PANEL_SOURCE).not.toContain("100dvh");
  });

  it("uses the shared TaskFlowHeader, titled with its own crumb", () => {
    expect(SMS_PANEL_SOURCE).toContain("TaskFlowHeader");
    expect(SMS_PANEL_SOURCE).toContain('title="Emergency help"');
    // No route-local <h1>: the header primitive owns the title element.
    expect(SMS_PANEL_SOURCE).not.toContain("<h1");
  });

  it("keeps the design's palette on tokens so light theme is not blind", () => {
    for (const token of [
      "--sos-core-from",
      "--sos-core-to",
      "--sos-glow-rgb",
      "--sos-ring-track",
      "--sos-control-surface",
      "--sos-label",
      "--sos-live-face",
    ]) {
      expect(SMS_PANEL_SOURCE).toContain(token);
      // Declared for BOTH themes: once on :root, once under .dark.
      expect(GLOBALS_SOURCE.split(token).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it("scales the ring through one viewBox instead of per-breakpoint copies", () => {
    // A second hardcoded ring size is how the mobile and desktop rings drift.
    expect(SMS_PANEL_SOURCE).toContain('viewBox="0 0 344 344"');
    expect(SMS_PANEL_SOURCE).toContain("RING_CIRCUMFERENCE");
    expect(SMS_PANEL_SOURCE).toContain('vectorEffect="non-scaling-stroke"');
    expect(SMS_PANEL_SOURCE).not.toMatch(/viewBox="0 0 232 232"/);
  });

  it("leaves the single back control to the top bar", () => {
    expect(SMS_PANEL_SOURCE).not.toContain("ChevronLeft");
    expect(SMS_PANEL_SOURCE).not.toContain('aria-label="Back to Location"');
  });

  // The deeper cause of the missing header, and the one a component-level fix
  // could not reach: the shell had a rule that blanked the top and bottom
  // chrome for these two `?action=` values, so the panel could be perfectly
  // in-flow and still render with no back control, no trail and no avatar.
  it("never hides the shell chrome for a Location action flow", () => {
    expect(ROUTE_LAYOUT_SOURCE).not.toContain(
      "shouldSuppressPersistentChromeForRouteState",
    );
    expect(PROVIDERS_SOURCE).not.toContain(
      "shouldSuppressPersistentChromeForRouteState",
    );
    // Chrome visibility stays a property of the route, decided in one place.
    expect(PROVIDERS_SOURCE).toContain(
      'routeLayout.persistentChrome === "none"',
    );
  });

  it("keeps SMS contacts — reachable from SOS — on the same header system", () => {
    expect(SMS_CONTACTS_SOURCE).toContain("TaskFlowHeader");
    expect(SMS_CONTACTS_SOURCE).toContain('title="SMS contacts"');
    expect(SMS_CONTACTS_SOURCE).not.toContain("<h1");
    expect(SMS_CONTACTS_SOURCE).not.toContain("ChevronLeft");
    expect(SMS_CONTACTS_SOURCE).not.toContain("fixed inset-0");
    expect(SMS_CONTACTS_SOURCE).not.toContain("100dvh");
  });

  it("keeps SOS motion in the app's single motion driver", () => {
    // Keyframes belong in app/globals.css, never an inline <style> island.
    expect(SMS_PANEL_SOURCE).not.toContain("@keyframes");
    expect(SMS_PANEL_SOURCE).not.toContain("<style>");
    expect(GLOBALS_SOURCE).toContain("@keyframes sosRadarPulse");
    expect(GLOBALS_SOURCE).toContain("@keyframes sosCorePulse");
    expect(GLOBALS_SOURCE).toContain("@keyframes sosHalo");
    expect(GLOBALS_SOURCE).toContain("[data-sos-pulse]");
    expect(GLOBALS_SOURCE).toContain("[data-sos-core]");
  });

  // Nothing in this flow sends an SMS. It creates a location grant, publishes
  // an encrypted envelope, and the backend fires ONE push notification. The
  // screen used to promise delivery "by SMS -- even with no internet" and the
  // toasts reported "SMS sent to N contacts", which is the most dangerous kind
  // of wrong copy: someone can hold that button instead of calling for help.
  // If an SMS channel is ever built, delete this test in the same PR.
  it("never promises a channel the flow does not have", () => {
    for (const source of [SMS_PANEL_SOURCE, LOCATION_PAGE_SOURCE]) {
      expect(source).not.toMatch(/SMS sent/i);
      expect(source).not.toMatch(/SMS not sent/i);
      expect(source).not.toMatch(/by SMS/i);
      expect(source).not.toMatch(/no internet/i);
    }
  });

  it("keeps the emergency red on the theme-aware destructive token", () => {
    expect(SMS_PANEL_SOURCE).toContain("var(--app-destructive)");
    // Raw Apple hexes reintroduce a light-mode-blind surface.
    expect(SMS_PANEL_SOURCE).not.toMatch(/#(ff3b30|ff453a|1c1c1e|d70015)/i);
  });
});
