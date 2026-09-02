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
    expect(source).toContain('width="agent"');
    expect(source).toContain("<PageHeader");
    expect(source).toContain('title="Connect"');
    expect(source).toContain('titleRole="agent"');
    expect(source).not.toContain("icon={BookUser}");
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
    expect(source).toContain("ConnectionPersonAvatar");
    expect(source).toContain("photoUrl={connection.photoUrl ?? null}");
    expect(source).toContain("photoUrl={person.photoUrl}");
    expect(source).toContain("verified={Boolean(person.isRia)}");

    const avatarSource = readFileSync(
      join(process.cwd(), "components/connections/connection-person-avatar.tsx"),
      "utf8",
    );
    expect(avatarSource).toContain("BadgeCheck");
    expect(avatarSource).toContain('aria-label="Verified advisor"');
    expect(source).toContain("separatorInset");
  });

  it("sends the visible Connect action directly without a one-person review dialog", () => {
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    const start = source.indexOf("const sendConnectRequest = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 500);

    expect(body).toContain("await sendConnectionRequest(person)");
    expect(body).not.toContain("getScopeCatalog");
    expect(source).not.toContain("<DialogTitle>Send connection request</DialogTitle>");
    expect(source).not.toContain("setScopeDraft");
  });

  it("keeps Connect navigation on the shared module tab primitive plus a compact directory menu", () => {
    // The old four-option strip was readable only through width overrides and
    // still competed with the page title. Connect now follows the Location hub
    // rhythm: one primary route strip, then a compact directory selector inside
    // the Connections surface.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );
    const tabs = readFileSync(
      join(process.cwd(), "lib/navigation/top-shell-tabs.ts"),
      "utf8",
    );
    const topShellTabs = readFileSync(
      join(process.cwd(), "components/app-ui/top-shell-tabs.tsx"),
      "utf8",
    );

    expect(source).toContain("<TopShellTabs");
    expect(source).toContain("TOP_SHELL_TAB_REGISTRY.connect");
    expect(source).not.toContain("<SegmentedTabs");
    expect(tabs).toContain("connect: {");
    expect(tabs).toContain('{ value: "all", label: "Connections"');
    expect(tabs).toContain('value: "circles"');
    expect(tabs).toContain('label: "Circles"');
    expect(topShellTabs).toContain('tabSet.id === "location" || tabSet.id === "connect"');
    expect(source).toContain(
      'const CONNECT_DIRECTORY_TABS = (["people", "advisors", "nearby"] as const).map(',
    );
    expect(source).toContain(
      "aria-label={`Current directory: ${CONNECT_TAB_LABEL[tab]}`}",
    );
    expect(source).not.toContain(
      '["people", "advisors", "circles", "nearby"] as const',
    );
    expect(source).not.toContain('aria-label="Select people"');
  });

  it("keeps Create and Join Circle as focused tasks outside the Connect dashboard chrome", () => {
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );
    const providers = readFileSync(
      join(process.cwd(), "app/providers.tsx"),
      "utf8",
    );
    const routes = readFileSync(
      join(process.cwd(), "lib/navigation/connect-routes.ts"),
      "utf8",
    );

    expect(routes).toContain(
      'export type FocusedConnectCircleAction = "create-circle" | "join-circle";',
    );
    expect(source).toContain("const isFocusedCircleTask =");
    expect(source).toContain("{isFocusedCircleTask ? (");
    expect(source).toContain('max-w-[560px]');
    expect(source).toContain("connectCircleTaskTitle(circleFlowAction)");
    expect(providers).toContain("const focusedConnectCircleChromeFlow =");
    expect(providers).toContain("isFocusedConnectCircleTask(");
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
  it("brings the directory surface forward before it touches the hub tab", () => {
    // `setTab` moves a control that is not active while Circles is showing, so
    // "open people" reported success and did nothing. A voice action that lies
    // about what happened is worse than one that refuses: the person stops
    // watching for a result that is never coming.
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
      // And it does so before the hub tab changes, so the directory is active.
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
