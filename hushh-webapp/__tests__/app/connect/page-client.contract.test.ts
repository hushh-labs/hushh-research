import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getDirectoryPersonDescription } from "@/app/connect/directory-person-label";

describe("Connect canonical surface contract", () => {
  it("uses the shared Profile/One header and settings-row geometry", () => {
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain("<AppPageShell");
    expect(source).toContain('width="reading"');
    expect(source).toContain("<PageHeader");
    expect(source).not.toContain('eyebrow="One"');
    expect(source).not.toContain("icon={Users}\n          accent");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).not.toContain("Private configuration");
    expect(source).not.toContain("icon={Sparkles}");
    // A person is their own face where we have one -- the directory payload
    // has always carried `photoUrl`, and drawing everyone with the same glyph
    // made the one screen that exists to tell people apart useless at it.
    //
    // The verified mark did NOT go away with the glyph. It still rides on the
    // row rather than the tab, so it means something in a search spanning both
    // halves of the directory -- it is now a badge ON the avatar, so the photo
    // says who and the badge says what, instead of one replacing the other.
    // Asserted as behaviour rather than an exact ternary so a later refactor
    // of the avatar is not blocked by the shape of this line.
    expect(source).toContain("<ConnectPersonAvatar");
    expect(source).toContain("photoUrl={person.photoUrl}");
    expect(source).toContain("verified={Boolean(person.isRia)}");
    expect(source).toContain("BadgeCheck");
    expect(source).toContain('aria-label="Verified advisor"');
    expect(source).toContain("separatorInset");
  });

  it("requires an explicit capability review whenever there is anything to review", () => {
    // This test was red on main from 2026-08-15 to 2026-08-16 and nobody saw
    // it, because vitest never ran on a pull request. Two intentional changes
    // moved past it: the dialog copy was polished (0b12f55d6), and the
    // empty-catalog auto-send was added on purpose (a8091214b, "ask each
    // advisor for their own scope") so a person with nothing to offer is not
    // shown an empty consent sheet.
    //
    // The invariant those changes did NOT alter is the one worth pinning:
    // a request opens the review sheet with NOTHING pre-granted, and the
    // auto-send path is reachable ONLY when the catalog is empty on both
    // sides. Asserting the copy was what made this test stale; asserting the
    // consent shape is what makes it durable.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    // The review sheet always opens pre-granting nothing, in both directions.
    expect(source).toContain("requestedHandles: []");
    expect(source).toContain("offeredHandles: []");

    // No path may send a request without opening the sheet. The empty-catalog
    // auto-send existed briefly and was removed on purpose: it made a request
    // that carried access and a request that carried none look identical from
    // the outside. Any re-introduction -- on both lists, on one, or on a
    // truthiness test -- is a silent consent regression.
    expect(source).not.toMatch(
      /if\s*\(\s*catalog\.(items|offerableItems)[\s\S]{0,120}?\)\s*\{\s*[\s\S]{0,80}?sendConnectionRequest\(/,
    );

    // Nothing may pre-select a capability for the person being asked.
    expect(source).not.toContain("requestedHandles: catalog.items");
    expect(source).not.toContain("offeredHandles: catalog.offerableItems");
  });

  it("keeps the three-tab strip narrow enough that no tab title truncates", () => {
    // Measured, not assumed. With the strip's stock 16px option padding, three
    // tabs on a 375px screen left "Around you" 77px of the 80px it needs, and
    // it rendered as "Around yo…". Tab titles are ours, not user content, so an
    // ellipsis in one is a defect rather than graceful degradation.
    //
    // Chromium against the built stylesheet, after this override: 320/360/375/
    // 390/430/768/1280px all clean, no horizontal overflow, strip height
    // unchanged. jsdom cannot catch a regression here -- it does no layout --
    // and Playwright is not in the blocking lane, so the override itself is
    // what gets pinned. Removing it puts the ellipsis straight back.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain(
      '"[&>button]:px-1 min-[360px]:[&>button]:px-3 sm:[&>button]:px-4.5"',
    );
    // Three tabs is the reason the padding has to give; a fourth would need the
    // measurement redone rather than this override stretched further.
    expect(source).toContain('["people", "advisors", "nearby"] as const');
  });

  it("renders a privacy-safe masked identity when duplicate names need disambiguation", () => {
    const serviceSource = readFileSync(
      join(process.cwd(), "lib/services/connections-service.ts"),
      "utf8",
    );

    expect(serviceSource).toContain("maskedPhone?: string | null");
    expect(serviceSource).toContain("maskedEmail?: string | null");
    expect(
      getDirectoryPersonDescription({
        displayName: "Abdul Zalil",
        email: null,
        maskedEmail: "a***l@example.com",
        maskedPhone: "******4455",
      }),
    ).toBe("a***l@example.com");
  });

  it("keeps email as the preferred secondary identity", () => {
    expect(
      getDirectoryPersonDescription({
        displayName: "Abdul Zalil",
        email: "abdul@example.test",
        maskedEmail: "a***l@example.test",
        maskedPhone: "******4455",
      }),
    ).toBe("abdul@example.test");
  });
});

describe("voice actions land on a surface that is actually showing", () => {
  it("brings Connections forward before it touches the inner strip", () => {
    // `setTab` moves a control that is not on screen while Circles is showing,
    // so "open people" reported success and did nothing. A voice action that
    // lies about what happened is worse than one that refuses: the person
    // stops watching for a result that is never coming.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    for (const action of [
      "connect.open_people",
      "connect.open_nearby",
      "connect.search_people",
    ]) {
      const start = source.indexOf(`useLocalOnboardingActionHandler("${action}"`);
      expect(start, action).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("useLocalOnboardingActionHandler", start + 10));
      expect(body, action).toContain('selectSurface("all")');
      // And it does so before the inner strip, so the strip is mounted.
      expect(
        body.indexOf('selectSurface("all")'),
        action,
      ).toBeLessThan(body.indexOf("setTab("));
    }
  });
});

describe("leaving a surface does not keep you inside a Circle", () => {
  it("clears the open Circle when the surface changes", () => {
    // `?action=` and `?circleId=` used to survive a surface switch, so going
    // Circle detail -> Connections -> Circles dropped the person back inside
    // the same roster instead of at the list with New circle on it.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    ).split("\r\n").join("\n");

    const start = source.indexOf("const selectSurface = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("const closeFlow", start) + 1 || start + 2000);

    expect(body).toContain('params.delete("action")');
    expect(body).toContain('params.delete("circleId")');
    expect(body).toContain('params.delete("code")');
    // Still names the surface it is moving to -- the App Router refuses a
    // navigation whose only change is the query string disappearing.
    expect(body).toContain("params.set(CONNECT_SURFACE_PARAM, next)");
  });
});

describe("the Location hub closes its flow when the tab changes", () => {
  it("clears the flow params rather than letting the effect reopen them", () => {
    const source = readFileSync(
      join(process.cwd(), "components/one-location/redesign/location-redesign-hub.tsx"),
      "utf8",
    ).split("\r\n").join("\n");

    const start = source.indexOf("const setTab = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 1800);

    expect(body).toContain("params.delete(FLOW_ACTION_PARAM)");
    expect(body).toContain('params.delete("circleId")');
    expect(body).toContain('setFlow("none")');
    expect(body).toContain("params.set(LOCATION_HUB_TAB_PARAM, next)");
  });
});

describe("the Circle flows do not spend the shared join rate limit", () => {
  it("wraps Preview in the busy gate, like Join beside it", () => {
    // Handed raw, the Preview button never disabled or spun for the whole
    // round trip, so a person tapped it again -- and `/circle-codes/resolve`
    // shares a 10-per-minute bucket with `/circle-codes/join`, so enough taps
    // locked them out of the thing they came to do.
    const source = readFileSync(
      join(process.cwd(), "components/connect/circles/connect-circles-tab.tsx"),
      "utf8",
    ).split("\r\n").join("\n");

    expect(source).toContain("withBusy(() => actions.resolveCode(code))");
    expect(source).not.toContain("onResolve={actions.resolveCode}");
  });
});

describe("a deep link into Location is not treated as a first run", () => {
  it("hides the onboarding takeover when the URL names an action", () => {
    // The gate reads auth, the vault, `mode`, `loadError` and one localStorage
    // flag -- and no query parameter at all, so every deep link into Location
    // put "Share your location easily with anyone" in front of the screen it
    // named. Setup stays ahead of this: inside the wizard the greeting IS the
    // screen.
    const source = readFileSync(
      join(process.cwd(), "app/one/location/page.tsx"),
      "utf8",
    ).split("\r\n").join("\n");

    const start = source.indexOf("const [locationOnboardingGate");
    const effect = source.slice(source.indexOf("if (loadError) {", start));
    const body = effect.slice(0, effect.indexOf("const introSeen"));

    expect(body).toContain('searchParams.get("action")?.trim()');
    expect(body).toContain('setLocationOnboardingGate("hidden")');
    // Setup is still decided before this point.
    expect(source.indexOf('if (mode === "setup")', start)).toBeLessThan(
      source.indexOf('searchParams.get("action")?.trim()', start),
    );
  });
});

describe("the Location roster hands a connection request to Connect", () => {
  it("does not send one itself", () => {
    // `config/protected-behaviors.json` names the capability review
    // (`connect-request-asks-before-it-shares`). The Location roster was the
    // last place that sent a request without it, and it has no cancel of its
    // own either, so its "Requested" was dead text.
    const source = readFileSync(
      join(process.cwd(), "app/one/location/page.tsx"),
      "utf8",
    ).split("\r\n").join("\n");

    const start = source.indexOf("const handleConnectCircleMember");
    const body = source.slice(start, source.indexOf("useCallback", start + 2000));

    expect(body).toContain("ROUTES.CONNECT");
    expect(body).toContain("action=circle-detail");
    expect(body).not.toContain("ConnectionsService.sendRequest");
  });
});
