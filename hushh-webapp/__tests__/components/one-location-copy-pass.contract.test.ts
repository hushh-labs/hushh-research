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
    // Anchored on the row rather than the card that used to wrap it: the
    // invite fields became one grouped card, so "Invite expires after" is now
    // a SettingsRow titled "Expires after". What this test is about -- that no
    // option exceeds the API's 24h ceiling -- is unchanged.
    const start = HUB_SOURCE.indexOf('title="Expires after"');
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
    // The header contract: the last crumb IS the screen's title. Matched on
    // the title prop rather than a whole single-line element, so the guard
    // survives the header gaining an eyebrow or a description and wrapping
    // across lines -- the spelling is what this test is about.
    expect(HUB_SOURCE).toMatch(
      new RegExp(`<TaskFlowHeader[^>]*title="${last}"`, "s"),
    );
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

describe("One Location — the Share confirm step is a measured column", () => {
  // This screen has been reported twice for the same thing, and the first fix
  // made it worse: the duration control was clamped to 420px inside a card that
  // was still 824px, so the card had 372px of dead space and its two fields
  // disagreed by 108px. Nothing caught it because every layout spec on this
  // surface tops out at 430px — there is no desktop viewport anywhere in the
  // Location contracts, so a desktop-only regression is invisible.
  //
  // These are source assertions, not geometry. They pin the two decisions that
  // were wrong, so a future edit has to be deliberate about both.

  it("measures the column, so the card cannot stretch to the shell", () => {
    const confirmStep = HUB_SOURCE.slice(
      HUB_SOURCE.indexOf('title="Ready to share?"') - 1200,
      HUB_SOURCE.indexOf('title="Ready to share?"'),
    );
    expect(confirmStep).toContain("max-w-[560px]");
  });

  it("lets the duration control fill that measured column", () => {
    // Inside a column that is already measured, a second clamp on the control
    // only makes it disagree with the note field beside it.
    expect(HUB_SOURCE).toContain("maxWidthClassName={null}");
  });

  it("keeps the default clamp for the two editors that have no column", () => {
    // The live-share "New time" editor and the People tab's "New duration"
    // render straight into the 880px shell. Without the default they stretch to
    // ~792px and their duration cells reach 258px — the exact state an earlier
    // round was fixing.
    const selectors = repoFile(
      "components/one-location/redesign/selectors.tsx",
    );
    expect(selectors).toContain('maxWidthClassName = "max-w-[420px]"');
  });

  it("keeps the duration read-back beside its label, not pushed to the edge", () => {
    // `justify-between` orphaned "Ends 4:03 AM" 277px from the "How long" it
    // reads back, and every widening made that worse. They are one statement.
    const selectors = repoFile(
      "components/one-location/redesign/selectors.tsx",
    );
    // The className only — the comment above it names the class it removed.
    const classNames = [...selectors.matchAll(/className=\{?"([^"]+)"/g)].map(
      (m) => m[1],
    );
    const labelRowClass = classNames.find((c) => c.includes("items-baseline"));
    expect(labelRowClass).toBeTruthy();
    expect(labelRowClass).not.toContain("justify-between");
    // And the hint is no longer right-aligned into the far corner.
    expect(classNames.some((c) => c.includes("text-right"))).toBe(false);
  });
});
