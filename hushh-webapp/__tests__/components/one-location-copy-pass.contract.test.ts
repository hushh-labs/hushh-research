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
/** The route that owns the send, and therefore the toast that confirms it. */
const PAGE_SOURCE = repoFile("app/one/location/page.tsx");

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

  it("states the real ceilings on the controls, not in a footnote", () => {
    // "Links expire automatically" / "after the time you choose" told the owner
    // nothing they could plan around, and the footnote that replaced it
    // ("Up to 1 hour for a location link, 24 hours for an invite.") restated
    // in prose what the two pickers directly above it already say — on a tab
    // whose whole content is those pickers. It is gone; the guarantee it was
    // making is now asserted where it is actually enforced: no option on
    // either picker exceeds its ceiling.
    expect(HUB_SOURCE).not.toContain("Links expire after the time you choose.");
    expect(HUB_SOURCE).not.toMatch(/up to 1 hour for a location link/i);

    // The public-link picker. Anyone holding the URL can watch, so its ceiling
    // is an hour — deliberately below the private-share ceiling the invite
    // picker is bound by.
    const start = HUB_SOURCE.indexOf("PUBLIC_LINK_DURATION_OPTIONS");
    expect(start).toBeGreaterThan(-1);
    const publicLinkSection = HUB_SOURCE.slice(start, start + 1200);
    const publicHours = durationOptionsIn(publicLinkSection)
      .map((option) => Number.parseFloat(option.value))
      .filter((hours) => Number.isFinite(hours));

    expect(publicHours.length).toBeGreaterThan(0);
    for (const hours of publicHours) {
      expect(hours).toBeLessThanOrEqual(1);
    }
  });

  it("drops the amber banner that argued against the button below it", () => {
    // "Anyone with this link can see you" / "The link stops on its own." sat
    // above the duration picker on the one screen whose entire purpose is to
    // create the link. Both facts survive where they belong: the duration
    // buttons state how long the link lives, and the card that replaces this
    // block once a link exists carries the concise link visibility line on the
    // object it is about.
    expect(HUB_SOURCE).not.toContain('title="Anyone with this link can see you"');
    expect(HUB_SOURCE).not.toContain("The link stops on its own.");
    expect(HUB_SOURCE).not.toContain("<WarningCard");
    // The surviving statement, on the live link's own card.
    expect(HUB_SOURCE).toContain("Anyone with this link can see your location.");
  });

  it("drops the Request sent banner in favour of the toast that already fired", () => {
    // Reported on the Ask screen: "request sent is not looking cool, do you
    // really think we want a bar for this only". The screen was telling the
    // same fact three times -- a toast raised by `handleRequestAccess`, an
    // "Asked" pill and an "Asked just now ... waiting on them" line on every
    // row it applied to, and then a banner pinned above the search field to
    // announce something that stopped being news a second later.
    //
    // `frontend-pattern-catalog.md`: "Do not create inline route banners for
    // row-level saves... Inline errors are for stable page-blocking states
    // only." A sent request is neither, so the banner and the `justSent` latch
    // that drove it are both gone.
    // Matched on the constructs, not on the words: the code comment that
    // explains WHY the banner went is worth keeping, and a bare
    // `not.toContain("justSent")` would forbid writing it down.
    expect(HUB_SOURCE).not.toMatch(/const \[justSent/);
    expect(HUB_SOURCE).not.toMatch(/setJustSent\(/);
    expect(HUB_SOURCE).not.toMatch(/\{justSent \?/);
    // A line that is nothing but the words is a JSX text node -- i.e. a banner
    // rendering them. In a comment they are always preceded by `//` or `*`.
    expect(HUB_SOURCE).not.toMatch(/^\s*Request sent\.\s*$/m);

    // The channel that survives, and the durable per-row telling that made the
    // banner redundant in the first place.
    expect(PAGE_SOURCE).toContain(
      "Request sent. We'll notify you here when they respond.",
    );
    expect(HUB_SOURCE).toContain("waiting on them");
  });
});

describe("One Location — hub tab naming", () => {
  const locationTabs = TOP_SHELL_TAB_REGISTRY.location;

  it("labels the first tab Now while keeping its `now` query value", () => {
    const first = locationTabs.tabs[0];
    expect(first.label).toBe("Now");
    // The value is the deep-link contract (`?view=now`, Kai's
    // `location.open_now`). Renaming the label must not move it.
    expect(first.value).toBe("now");
    expect(locationTabs.defaultValue).toBe("now");
  });
});

describe("One Location — People actions stay reachable and single-flight", () => {
  // The "+" menus moved to the shared `ActionMenu`, which is a bottom sheet on
  // a phone and an anchored menu on a pointer -- an anchored menu opened
  // straight down ONTO the very list it belongs to. The properties this test
  // was written for did not change; where they are declared did.
  const ACTION_MENU_SOURCE = repoFile("components/app-ui/action-menu.tsx");

  it("keeps Find contacts listed and merely disabled while syncing", () => {
    const start = HUB_SOURCE.indexOf('voiceControlId: "one-location-find-contacts"');
    expect(start).toBeGreaterThan(-1);
    const addPeopleMenu = HUB_SOURCE.slice(start - 900, start + 200);

    // Present in the item list unconditionally -- a row that disappears
    // mid-action is not a disabled control, it is a missing one.
    expect(addPeopleMenu).toContain('id: "find-contacts"');
    expect(addPeopleMenu).toContain('disabled: vm.busy === "contactSync"');
    expect(addPeopleMenu).toContain('busy: vm.busy === "contactSync"');
  });

  it("refuses a second tap rather than queueing it, in both presentations", () => {
    // Single-flight is the point: the sheet returns early and the menu
    // preventDefaults, so a disabled row can never fire its action.
    expect(ACTION_MENU_SOURCE).toContain("if (item.disabled) return;");
    expect(ACTION_MENU_SOURCE).toContain("event.preventDefault();");
    // The pointer lane keeps the content mounted, as it always did.
    expect(ACTION_MENU_SOURCE).toContain("forceMount");
  });

  it("does not open a section's menu on top of that section's own list", () => {
    // The reported defect, pinned: on a phone the surface is a bottom sheet,
    // not a menu anchored under a "+" that sits above the list.
    expect(ACTION_MENU_SOURCE).toContain('side="bottom"');
    expect(ACTION_MENU_SOURCE).toContain("useIsMobile");
    // And the presentation is frozen while open, so a rotation cannot remount
    // the menu under the hand using it.
    expect(ACTION_MENU_SOURCE).toContain("if (!open) setSheetPresentation(isMobile);");
  });
});

describe("One Location — the Ask for location trail agrees with the screen", () => {
  it("uses one spelling for the crumb, the flow title and the hub row", () => {
    const params = new URLSearchParams({ action: "ask" });
    const crumbs = resolveTopShellBreadcrumb("/one/location", params);
    const last = crumbs?.items.at(-1)?.label;

    expect(last).toBe("Ask for location");
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

  it("keeps the default clamp for callers with no column of their own", () => {
    // The clamp is `DurationSelector`'s default, and it is what stops a
    // control rendering straight into the 880px shell from stretching to
    // ~792px with 258px duration cells.
    //
    // Its old headline example, the recipient-side "New duration" `select`,
    // is gone: that lane asks for time additively now, so there is nothing
    // absolute to pick. See `components/one-location/redesign/request-more-time`.
    // The live-share "New time" ladder opts out with `maxWidthClassName={null}`
    // on purpose (issue #6228) -- a wrapping row of content-width chips has
    // nothing to stretch, unlike the old grid. So this asserts the DEFAULT
    // still exists for the next caller that does not measure its own column,
    // which is the part neither of those two changes may quietly remove.
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

  it("does not draw a second card inside the clipped map preview", () => {
    // The report: the map's outline "does not follow the map's actual shape
    // and gets cut off at the corners". LocalMapPreview drew its own card --
    // border plus a 24px radius -- inside SharedWithMeCard's 14px clip, so
    // the child bulged past the parent on all four corners and the border was
    // sliced there. Standalone (Check-In) it still IS the card and keeps both.
    const page = repoFile("app/one/location/page.tsx");

    // The nested branch inherits the container's rounding rather than
    // asserting one of its own.
    expect(page).toContain('nested');
    expect(page).toContain('"rounded-[inherit]"');
    // ...and the standalone branch keeps the card it is.
    expect(page).toContain(
      '"rounded-[var(--app-card-radius-standard)] border border-border/70"',
    );

    // The one call site that sits inside a clipping container asks for it.
    expect(HUB_SOURCE).toContain(
      "// SharedWithMeCard already draws and clips the card",
    );
  });
});
