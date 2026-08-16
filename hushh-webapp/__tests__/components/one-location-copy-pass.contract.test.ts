import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TOP_SHELL_TAB_REGISTRY } from "@/lib/navigation/top-shell-tabs";
import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

const repoFile = (...segments: string[]) =>
  fs.readFileSync(path.resolve(__dirname, "../..", ...segments), "utf8");

const HUB_SOURCE = repoFile(
  "components/one-location/redesign/location-redesign-hub.tsx",
);
const CONNECT_SOURCE = repoFile("app/connect/page-client.tsx");

/**
 * The duration ceiling is owned by the consent protocol, not by the web app.
 * Reading it out of the Python policy rather than hardcoding 24 here is the
 * point of the test: if someone raises or lowers the server bound, the
 * assertion below moves with it instead of quietly going stale.
 */
const LOCATION_POLICY_SOURCE = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../consent-protocol/hushh_mcp/operons/location/policy.py",
  ),
  "utf8",
);

function serverMaxShareHours(): number {
  const match = /^MAX_LOCATION_SHARE_HOURS\s*=\s*([\d.]+)/m.exec(
    LOCATION_POLICY_SOURCE,
  );
  if (!match) {
    throw new Error(
      "MAX_LOCATION_SHARE_HOURS not found in the location policy operon — " +
        "the duration ceiling moved and this contract needs re-pointing.",
    );
  }
  return Number.parseFloat(match[1]);
}

/** Every `{ value: "…", label: "…" }` duration option authored in the hub. */
function durationOptionsIn(source: string): { value: string; label: string }[] {
  return [...source.matchAll(/\{\s*value:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ value: m[1], label: m[2] }));
}

describe("One Location — link durations stay inside the server's ceiling", () => {
  it("offers no invite duration the API would reject", () => {
    // The invite picker used to offer "7 days" (168h). CreateCircleInviteRequest
    // bounds durationHours at `le=24` and normalize_duration_hours raises
    // "between 15 minutes and 24 hours", so picking it returned HTTP 422 —
    // a control that could only ever fail, with no explanation on screen.
    const start = HUB_SOURCE.indexOf('<SectionCard title="Invite expires after">');
    expect(start).toBeGreaterThan(-1);
    const inviteSection = HUB_SOURCE.slice(start, start + 1200);

    const max = serverMaxShareHours();
    const numeric = durationOptionsIn(inviteSection)
      .map((option) => Number.parseFloat(option.value))
      .filter((hours) => Number.isFinite(hours));

    expect(numeric.length).toBeGreaterThan(0);
    for (const hours of numeric) {
      expect(hours).toBeLessThanOrEqual(max);
    }
    expect(inviteSection).not.toContain('label: "7 days"');
  });

  it("states the real ceilings rather than a vague promise", () => {
    // "Links expire automatically" / "after the time you choose" told the owner
    // nothing they could plan around.
    expect(HUB_SOURCE).toContain("up to 1 hour for a location link");
    expect(HUB_SOURCE).not.toContain("Links expire after the time you choose.");
  });
});

describe("One Location — hub tab naming", () => {
  const locationTabs = TOP_SHELL_TAB_REGISTRY.location;

  it("labels the first tab Menu while keeping its `now` query value", () => {
    const first = locationTabs.tabs[0];
    expect(first.label).toBe("Menu");
    // The value is the deep-link contract (`?view=now`, Kai's
    // `location.open_now`). Renaming the label must not move it.
    expect(first.value).toBe("now");
    expect(locationTabs.defaultValue).toBe("now");
  });
});

describe("One Location — the Request location trail agrees with the screen", () => {
  it("uses one spelling for the crumb, the flow title and the hub row", () => {
    const params = new URLSearchParams({ action: "ask" });
    const crumbs = resolveTopShellBreadcrumb("/one/location", params);
    const last = crumbs?.items.at(-1)?.label;

    expect(last).toBe("Request location");
    // The header contract: the last crumb IS the screen's title.
    expect(HUB_SOURCE).toContain(`<TaskFlowHeader title="${last}" />`);
    // …and the hub row that opens it names the same thing.
    expect(HUB_SOURCE).toContain(`title="${last}"`);
    expect(HUB_SOURCE).not.toContain('title="Request Location"');
  });
});

describe("Connect — no dead Scopes viewer", () => {
  it("drops the per-connection Scopes control and its dialog", () => {
    // It opened a read-only dialog of raw scope handles with every row
    // disabled: nothing to act on, and mostly the internal handle string.
    // Match the rendered label expression, not the bare word — the source
    // still explains in a comment why the control is gone.
    expect(CONNECT_SOURCE).not.toMatch(/\?\s*"Loading…"\s*:\s*"Scopes"/);
    expect(CONNECT_SOURCE).not.toMatch(/>\s*Scopes\s*</);
    expect(CONNECT_SOURCE).not.toContain("viewInformationScopes");
    expect(CONNECT_SOURCE).not.toContain("informationScopeDraft");
    expect(CONNECT_SOURCE).not.toContain("ConnectionInformationScopeCatalog");
  });

  it("keeps Remove, the control that still does something", () => {
    expect(CONNECT_SOURCE).toContain("pendingRemoveId");
  });
});
