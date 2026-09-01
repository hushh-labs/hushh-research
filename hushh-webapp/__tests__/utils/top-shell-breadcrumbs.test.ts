import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

describe("top shell breadcrumbs", () => {
  it("returns a query-selected saved analysis to its Analysis workspace", () => {
    expect(
      resolveTopShellBreadcrumb(
        "/one/kai",
        new URLSearchParams(
          "tab=analysis&analysis_id=run%3Adebate_123&ticker=NVDA",
        ),
      ),
    ).toEqual({
      backHref: "/one/kai?tab=analysis",
      width: "content",
      align: "center",
      items: [
        { label: "Finance", href: "/one/kai?tab=market" },
        { label: "Analysis", href: "/one/kai?tab=analysis" },
        { label: "NVDA analysis" },
      ],
    });
  });

  it("returns every welcome workspace tab to One", () => {
    const research = new URLSearchParams("tab=research");
    const blog = new URLSearchParams("tab=blog");
    const developers = new URLSearchParams("tab=developers");

    expect(resolveTopShellBreadcrumb("/welcome", research)).toMatchObject({
      hideBack: false,
      backHref: "/one",
    });
    expect(resolveTopShellBreadcrumb("/welcome", blog)).toMatchObject({
      hideBack: false,
      backHref: "/one",
    });
    expect(resolveTopShellBreadcrumb("/welcome", developers)).toMatchObject({
      hideBack: false,
      backHref: "/one",
    });
  });

  it("keeps a shared back affordance on the Connect root", () => {
    expect(resolveTopShellBreadcrumb("/one/connect")).toEqual({
      backHref: "/one",
      width: "profile",
      align: "center",
      hideBack: false,
      items: [{ label: "One" }],
    });
  });

  it("uses the shared top-left back affordance for Calendar", () => {
    expect(resolveTopShellBreadcrumb("/one/calendar")).toEqual({
      backHref: "/one",
      width: "profile",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Calendar" }],
    });
  });

  it("returns a query-selected CRM detail to the static connected-systems workspace", () => {
    expect(
      resolveTopShellBreadcrumb(
        "/one/connected-systems",
        new URLSearchParams("system=customer-crm"),
      ),
    ).toEqual({
      backHref: "/one/connected-systems",
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: "/one" },
        { label: "Connected Systems", href: "/one/connected-systems" },
        { label: "CRM" },
      ],
    });
  });

  it("uses a loaded CRM registry label for a connected-system detail", () => {
    expect(
      resolveTopShellBreadcrumb("/one/connected-systems/crm_002", undefined, {
        connectedSystemLabel: "Chase",
      }),
    ).toMatchObject({
      items: [
        { label: "One", href: "/one" },
        { label: "Connected Systems", href: "/one/connected-systems" },
        { label: "Chase" },
      ],
    });
  });

  it("returns the One-owned consent workspace to One by default", () => {
    expect(resolveTopShellBreadcrumb("/one/consent")).toEqual({
      backHref: "/one",
      width: "profile",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Consent Center" }],
    });
  });

  it("preserves a safe internal from param for consent back navigation", () => {
    const params = new URLSearchParams();
    params.set("from", "/one/kai/analysis?tab=history");

    expect(resolveTopShellBreadcrumb("/one/consent", params)).toEqual({
      backHref: "/one/kai/analysis?tab=history",
      width: "profile",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Consent Center" }],
    });
  });

  it("uses sanitized from params for Kai setup wizard back navigation", () => {
    const params = new URLSearchParams();
    params.set("from", "/one?mode=finance");

    expect(resolveTopShellBreadcrumb("/one/setup/kai", params)).toEqual({
      backHref: "/one?mode=finance",
      width: "content",
      align: "center",
      // Back is now always available on the wizard so the user is never trapped
      // on the questionnaire; re-entry honors the `from` origin.
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
      ],
    });

    // Bare entry (no `from`) still shows back, falling to the setup hub rather
    // than bypassing the gate to /one.
    expect(resolveTopShellBreadcrumb("/one/setup/kai")).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
      ],
    });

    const unsafeParams = new URLSearchParams();
    unsafeParams.set("from", "//evil.example/path");

    expect(
      resolveTopShellBreadcrumb("/one/setup/kai", unsafeParams)?.backHref,
    ).toBe("/one/setup");
  });

  it("retraces the Kai finance workspace back to the setup hub (?from=/one/setup)", () => {
    // Finishing finance setup can land the user in the Kai dashboard. When the
    // origin is the setup hub, back must return there so they can continue
    // onboarding the other capabilities instead of being dropped at One home.
    const fromSetup = new URLSearchParams();
    fromSetup.set("from", "/one/setup");
    expect(resolveTopShellBreadcrumb("/one/kai", fromSetup)).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      items: [{ label: "Set up", href: "/one/setup" }, { label: "Finance" }],
    });

    // No origin → Kai home still falls back to One home (unchanged behavior).
    expect(resolveTopShellBreadcrumb("/one/kai")).toEqual({
      backHref: "/one",
      width: "content",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Finance" }],
    });

    // Unsafe origins are rejected → One home fallback.
    const unsafe = new URLSearchParams();
    unsafe.set("from", "//evil.example/path");
    expect(resolveTopShellBreadcrumb("/one/kai", unsafe)?.backHref).toBe(
      "/one",
    );
  });

  it("routes agent back-nav to One home once onboarding is dismissed", () => {
    const fromSetup = new URLSearchParams();
    fromSetup.set("from", "/one/setup");

    // First onboarding (not dismissed): retrace into the hub is preserved.
    expect(resolveTopShellBreadcrumb("/one/kai", fromSetup)?.backHref).toBe(
      "/one/setup",
    );

    // Dismissed: an agent surface never retraces into setup, even with a stale
    // ?from=/one/setup marker — this is the "back from every sub-agent → setup"
    // regression.
    expect(
      resolveTopShellBreadcrumb("/one/kai", fromSetup, { setupDismissed: true })
        ?.backHref,
    ).toBe("/one");

    // Setup-internal pages keep their retrace to the hub (deliberate entries
    // like Connections stay reachable and go back to the hub).
    expect(
      resolveTopShellBreadcrumb("/one/setup/connections", undefined, {
        setupDismissed: true,
      })?.backHref,
    ).toBe("/one/setup");

    // A non-setup ?from origin is unaffected by the dismissal rewrite.
    const fromGmail = new URLSearchParams();
    fromGmail.set("from", "/one/gmail");
    expect(
      resolveTopShellBreadcrumb("/one/kai", fromGmail, { setupDismissed: true })
        ?.backHref,
    ).toBe("/one/gmail");
  });

  it("returns every base Finance tab to One", () => {
    for (const tab of ["market", "portfolio", "analysis"]) {
      const params = new URLSearchParams();
      params.set("tab", tab);
      expect(resolveTopShellBreadcrumb("/one/kai", params)?.backHref).toBe(
        "/one",
      );
    }
  });

  it("keeps the setup hub forward-only after phone verification", () => {
    expect(resolveTopShellBreadcrumb("/one/setup")).toEqual({
      backHref: "/",
      width: "content",
      align: "center",
      hideBack: true,
      items: [{ label: "One", href: "/" }, { label: "Setup" }],
    });

    expect(resolveTopShellBreadcrumb("/one/setup/")).toEqual({
      backHref: "/",
      width: "content",
      align: "center",
      hideBack: true,
      items: [{ label: "One", href: "/" }, { label: "Setup" }],
    });

    const fromDashboard = new URLSearchParams();
    fromDashboard.set("return_to", "/one");
    expect(
      resolveTopShellBreadcrumb("/one/setup", fromDashboard)?.backHref,
    ).toBe("/one");
  });

  it("shows shared top-left back navigation for the RIA claim flow", () => {
    expect(resolveTopShellBreadcrumb("/ria/claim")).toEqual({
      backHref: "/ria/onboarding",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "RIA", href: "/ria/onboarding" },
        { label: "Claim profile" },
      ],
    });

    const returnToSetup = new URLSearchParams();
    returnToSetup.set("return_to", "/one/setup");

    expect(resolveTopShellBreadcrumb("/ria/claim", returnToSetup)).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [{ label: "RIA", href: "/one/setup" }, { label: "Claim profile" }],
    });
  });

  it("gives per-capability setup steps a back affordance to the hub", () => {
    expect(resolveTopShellBreadcrumb("/one/setup/finance")).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
        { label: "Finance" },
      ],
    });

    expect(resolveTopShellBreadcrumb("/one/setup/connected-systems")).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
        {
          label:
            process.env.NEXT_PUBLIC_HUSHH_LOCAL_CRM_ENABLED === "true"
              ? "CRM"
              : "Connected Systems",
        },
      ],
    });

    expect(resolveTopShellBreadcrumb("/one/setup/finance/")).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
        { label: "Finance" },
      ],
    });
  });

  it("keeps bare RIA re-entry independent from the completed One setup hub", () => {
    expect(resolveTopShellBreadcrumb("/ria/onboarding")).toEqual({
      backHref: "/one",
      width: "content",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Setup" }],
    });

    const fromSetup = new URLSearchParams("from=/one/setup");
    expect(
      resolveTopShellBreadcrumb("/ria/onboarding", fromSetup)?.backHref,
    ).toBe("/one/setup");
  });

  it("gives the portfolio import setup continuation a back affordance", () => {
    const params = new URLSearchParams();
    params.set("from", "/one/setup/kai?from=/one/setup");

    expect(resolveTopShellBreadcrumb("/one/kai/import", params)).toEqual({
      backHref: "/one/setup/kai?from=/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
        { label: "Portfolio" },
      ],
    });

    expect(resolveTopShellBreadcrumb("/one/kai/import")).toEqual({
      backHref: "/one/setup",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup", href: "/one/setup" },
        { label: "Portfolio" },
      ],
    });

    const unsafeParams = new URLSearchParams();
    unsafeParams.set("from", "https://evil.example/path");

    expect(
      resolveTopShellBreadcrumb("/one/kai/import", unsafeParams)?.backHref,
    ).toBe("/one/setup");
  });

  it("treats the PKM agent lab as a Memory surface", () => {
    expect(resolveTopShellBreadcrumb("/one/profile/pkm-agent-lab")).toEqual({
      backHref: "/one/profile/my-data",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile/my-data" },
        { label: "Memory", href: "/one/profile/my-data" },
        { label: "PKM Agent" },
      ],
    });
  });

  it("returns the profile root to its origin (origin-aware, avoids the dashboard glitch)", () => {
    // The reported bug: opening Profile from Location and pressing Back always
    // jumped to the One dashboard. Profile is opened from every screen (the
    // avatar), so — like the other One capabilities — its back target is now
    // origin-aware via a validated `?from`.
    const fromLocation = new URLSearchParams();
    fromLocation.set("from", "/one/location");
    expect(resolveTopShellBreadcrumb("/one/profile", fromLocation)).toEqual({
      backHref: "/one/location",
      width: "profile",
      align: "center",
      items: [
        { label: "Location", href: "/one/location" },
        { label: "Profile" },
      ],
    });

    const fromGmail = new URLSearchParams();
    fromGmail.set("from", "/one/gmail");
    expect(resolveTopShellBreadcrumb("/one/profile", fromGmail)).toEqual({
      backHref: "/one/gmail",
      width: "profile",
      align: "center",
      items: [{ label: "Gmail", href: "/one/gmail" }, { label: "Profile" }],
    });

    // No origin → the historic default (back to the One dashboard) is preserved.
    expect(resolveTopShellBreadcrumb("/one/profile")).toEqual({
      backHref: "/one",
      width: "profile",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Profile" }],
    });

    // Unsafe / protocol-relative origins are rejected → One dashboard fallback.
    const unsafe = new URLSearchParams();
    unsafe.set("from", "//evil.example/path");
    expect(resolveTopShellBreadcrumb("/one/profile", unsafe)?.backHref).toBe(
      "/one",
    );
  });

  it("keeps the profile origin while drilling into a panel and stepping back", () => {
    // The `from` origin survives on the internal Profile crumb/back targets so
    // Profile → panel → back all the way out still returns to the real origin
    // (not the dashboard).
    const fromLocation = new URLSearchParams();
    fromLocation.set("from", "/one/location");
    fromLocation.set("panel", "security");
    const config = resolveTopShellBreadcrumb("/one/profile", fromLocation);
    // Back from the panel returns to the profile ROOT, and the root itself keeps
    // the origin marker so the next Back leaves to Location.
    expect(config?.backHref).toBe("/one/profile?from=%2Fone%2Flocation");
    expect(config?.items?.[0]).toEqual({
      label: "Profile",
      href: "/one/profile?from=%2Fone%2Flocation",
    });
  });

  it("keeps Connect as the origin for a person profile opened from Connect", () => {
    const fromConnect = new URLSearchParams();
    fromConnect.set("from", "/one/connect");

    expect(
      resolveTopShellBreadcrumb("/people/person-ref-scoped", fromConnect),
    ).toEqual({
      backHref: "/one/connect",
      width: "profile",
      align: "center",
      items: [
        { label: "Connect", href: "/one/connect" },
        { label: "Profile" },
      ],
    });

    const unsafeOrigin = new URLSearchParams();
    unsafeOrigin.set("from", "//evil.example/one/connect");
    expect(
      resolveTopShellBreadcrumb("/people/person-ref-scoped", unsafeOrigin),
    ).toBeNull();
  });

  it("nests the connection detail under Memory → Sharing", () => {
    const connectionParams = new URLSearchParams();
    connectionParams.set("id", "c-scoped");

    expect(
      resolveTopShellBreadcrumb(
        "/one/profile/access/connection",
        connectionParams,
      ),
    ).toEqual({
      backHref: "/one/profile/access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Memory", href: "/one/profile/my-data" },
        { label: "Sharing", href: "/one/profile/access" },
        { label: "Connection detail" },
      ],
    });
  });

  it("returns the Memory → Sharing sub-view to the Memory panel", () => {
    expect(resolveTopShellBreadcrumb("/one/profile/access")).toEqual({
      backHref: "/one/profile/my-data",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Memory", href: "/one/profile/my-data" },
        { label: "Sharing" },
      ],
    });
  });

  it("owns profile nested and legacy panels from the shared top bar", () => {
    const panelParams = new URLSearchParams();

    panelParams.set("panel", "my-data");

    expect(resolveTopShellBreadcrumb("/one/profile", panelParams)).toEqual({
      backHref: "/one/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Memory", href: undefined },
      ],
    });

    const accountParams = new URLSearchParams();
    accountParams.set("panel", "account");

    expect(resolveTopShellBreadcrumb("/one/profile", accountParams)).toEqual({
      backHref: "/one/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Account", href: undefined },
      ],
    });

    const detailParams = new URLSearchParams();
    detailParams.set("panel", "security");
    detailParams.set("detail", "vault");

    expect(resolveTopShellBreadcrumb("/one/profile", detailParams)).toEqual({
      backHref: "/one/profile/security",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Security", href: "/one/profile/security" },
        { label: "Vault methods" },
      ],
    });

    const legacyTabParams = new URLSearchParams();
    legacyTabParams.set("tab", "preferences");

    expect(resolveTopShellBreadcrumb("/one/profile", legacyTabParams)).toEqual({
      backHref: "/one/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Preferences", href: undefined },
      ],
    });

    // Regulatory profile lives in the RIA workspace. The legacy Profile route
    // deliberately has no breadcrumb or visible Profile panel for it.
    expect(resolveTopShellBreadcrumb("/one/profile/regulatory")).toBeNull();

    const regulatoryParams = new URLSearchParams();
    regulatoryParams.set("panel", "regulatory");

    expect(
      resolveTopShellBreadcrumb("/one/profile", regulatoryParams)?.items,
    ).not.toContainEqual({ label: "Regulatory profile", href: undefined });
  });

  it("routes legacy receipts back to canonical Gmail", () => {
    expect(resolveTopShellBreadcrumb("/one/profile/receipts")).toEqual({
      backHref: "/one/gmail",
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: "/one" },
        { label: "Gmail", href: "/one/gmail" },
        { label: "Legacy receipts" },
      ],
    });
  });

  it("routes dashboard-opened capability surfaces back to /one (origin-aware)", () => {
    // Email / Location / Marketplace were reachable from BOTH the Profile panels
    // and the /one dashboard tiles. Direct/cold One capability entry now falls
    // back to the Agents dashboard, while explicit safe origins still retrace.
    const surfaces: Array<{ path: string; label: string }> = [
      { path: "/one/kyc", label: "KYC" },
      { path: "/one/location", label: "Location" },
      { path: "/one/marketplace", label: "Marketplace" },
    ];

    for (const { path, label } of surfaces) {
      const expectedItems =
        path === "/one/location"
          ? [{ label: "One" }]
          : [{ label: "One", href: "/one" }, { label }];
      // No origin → Agents dashboard.
      expect(resolveTopShellBreadcrumb(path)).toEqual({
        backHref: "/one",
        width: "profile",
        align: "center",
        items: expectedItems,
      });

      // Opened from the dashboard (?from=/one) → back to the dashboard, and the
      // leading crumb reflects the real origin ("One").
      const fromOne = new URLSearchParams();
      fromOne.set("from", "/one");
      expect(resolveTopShellBreadcrumb(path, fromOne)).toEqual({
        backHref: "/one",
        width: "profile",
        align: "center",
        items: expectedItems,
      });

      // Unsafe / protocol-relative origins are rejected → Agents fallback.
      const unsafe = new URLSearchParams();
      unsafe.set("from", "//evil.example/path");
      expect(resolveTopShellBreadcrumb(path, unsafe)?.backHref).toBe("/one");
    }

    // Consent center already honored `?from`; confirm the dashboard origin flows
    // through so its back returns to /one too.
    const consentFromOne = new URLSearchParams();
    consentFromOne.set("from", "/one");
    expect(
      resolveTopShellBreadcrumb("/one/consent", consentFromOne)?.backHref,
    ).toBe("/one");
  });

  it("returns the single top-bar back button to the Location hub while a focused flow is open", () => {
    // Location focused screens (Check-In, Alert, Share, Ask, Invite, Settings,
    // Temp link, and share details) are tracked
    // via /one/location?action=<slug>. The one top-left back button must return
    // to the Location hub (strip the action param) rather than leaving to /one —
    // this is the fix for the "two back buttons" UX. The in-content back arrows
    // were removed so this is the ONLY back affordance on those screens.
    const cases: Array<[string, string]> = [
      ["check-in", "Check-In"],
      // Must equal the flow's own TaskFlowHeader title. A crumb that reads
      // differently from the screen it names is how a trail stops describing
      // where you are.
      ["places-visited", "Places you've been"],
      ["private-check-in", "Private Check-In"],
      // The implementation action id stays sos; the visible product name is shared.
      ["sos", "Save My Soul"],
      // NOTE: sms-contacts is deliberately absent from this table — it is the
      // one flow whose back target is not the hub (it retraces to whoever
      // opened it), so its label and back href are asserted separately below.
      ["share", "Share location"],
      ["ask", "Ask for location"],
      ["invite", "Invite to Circle"],
      ["temp-link", "Public link"],
      ["settings", "Settings"],
      // Legacy bookmarks are labelled correctly while the hub canonicalizes
      // `action=privacy` to `action=settings`.
      ["privacy", "Settings"],
      ["active-shares", "Active shares"],
      ["shared-with-me", "Shared with me"],
      ["needs-review", "Needs review"],
    ];

    for (const [action, label] of cases) {
      const params = new URLSearchParams();
      params.set("action", action);
      expect(resolveTopShellBreadcrumb("/one/location", params)).toEqual({
        backHref: "/one/location?view=now",
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: "/one" },
          { label: "Location", href: "/one/location" },
          { label },
        ],
      });
    }

    // Back from a private check-in returns to check-in's own route. It must
    // never name Your Map: that screen withholds the check-in sheet, so
    // pointing back at it made the one control whose job is to retrace a step
    // land on a screen the flow is not on, which then redirected away again.
    const fromNearbyCheckIn = new URLSearchParams();
    fromNearbyCheckIn.set("action", "private-check-in");
    fromNearbyCheckIn.set("source", "nearby");
    expect(
      resolveTopShellBreadcrumb("/one/location", fromNearbyCheckIn),
    ).toEqual({
      backHref: "/one/location/check-in",
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: "/one" },
        { label: "Location", href: "/one/location" },
        { label: "Private Check-In" },
      ],
    });
    fromNearbyCheckIn.set(
      "returnToken",
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(
      resolveTopShellBreadcrumb("/one/location", fromNearbyCheckIn)?.backHref,
    ).toBe(
      "/one/location/check-in?resume=123e4567-e89b-12d3-a456-426614174000",
    );

    // Opened from Profile: the leading crumb reflects the real origin, but back
    // still returns to the Location hub (not Profile) while the flow is open.
    const fromProfile = new URLSearchParams();
    fromProfile.set("from", "/one/profile");
    fromProfile.set("action", "check-in");
    expect(resolveTopShellBreadcrumb("/one/location", fromProfile)).toEqual({
      backHref: "/one/location?view=now",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Location", href: "/one/location" },
        { label: "Check-In" },
      ],
    });

    // No action param → unchanged hub behavior (back leaves to /one).
    expect(resolveTopShellBreadcrumb("/one/location")?.backHref).toBe("/one");
  });

  it("returns a focused flow to the hub TAB it was opened from (Links/People/Settings)", () => {
    // Regression: opening "Create a new link" from Links, "Invite trusted
    // person" from People, or "SMS contacts" from Settings must return Back to
    // that ORIGINATING tab — not the default "Now" tab. `openFlow` keeps the
    // current `?view=` tab in the URL alongside `?action=`, so the breadcrumb
    // resolver retraces to it.

    // Links → Create a new link (temp-link) → back to Links.
    const fromLinks = new URLSearchParams();
    fromLinks.set("view", "links");
    fromLinks.set("action", "temp-link");
    expect(
      resolveTopShellBreadcrumb("/one/location", fromLinks)?.backHref,
    ).toBe("/one/location?view=links");

    // People → Invite trusted person (invite) → back to People.
    const fromPeople = new URLSearchParams();
    fromPeople.set("view", "people");
    fromPeople.set("action", "invite");
    expect(
      resolveTopShellBreadcrumb("/one/location", fromPeople)?.backHref,
    ).toBe("/one/location?view=people");

    // Settings → SMS contacts → back to the Settings flow (not "Now").
    const fromSettings = new URLSearchParams();
    fromSettings.set("action", "sms-contacts");
    const settingsTrail = resolveTopShellBreadcrumb(
      "/one/location",
      fromSettings,
    );
    expect(settingsTrail?.backHref).toBe("/one/location?action=settings");
    expect(settingsTrail?.items.map((item) => item.label)).toEqual([
      "One",
      "Location",
      "Emergency contacts",
    ]);

    // SOS → SMS contacts → back to SOS. Contacts is reachable mid-emergency,
    // and returning that person to Settings drops them out of the flow they
    // were in the middle of, at the worst possible moment.
    const fromSos = new URLSearchParams();
    fromSos.set("action", "sms-contacts");
    fromSos.set("source", "sos");
    const sosTrail = resolveTopShellBreadcrumb("/one/location", fromSos);
    expect(sosTrail?.backHref).toBe("/one/location?action=sos");
    expect(sosTrail?.items.map((item) => item.label)).toEqual([
      "One",
      "Location",
      "Save My Soul",
      "Emergency contacts",
    ]);

    // An unrecognised source is not an emergency; Settings stays the default.
    const fromUnknown = new URLSearchParams();
    fromUnknown.set("action", "sms-contacts");
    fromUnknown.set("source", "nearby");
    const unknownTrail = resolveTopShellBreadcrumb(
      "/one/location",
      fromUnknown,
    );
    expect(unknownTrail?.backHref).toBe("/one/location?action=settings");
    expect(unknownTrail?.items.map((item) => item.label)).toEqual([
      "One",
      "Location",
      "Emergency contacts",
    ]);
  });
  it("retraces setup-hub-opened capabilities through their terminal acknowledgement", () => {
    // From the Set up One hub, capability handoffs carry ?from=/one/setup so the
    // top-bar back returns to the hub (not Profile/dashboard) — "jaise aaya waise
    // wapas". Covers the six-item onboarding catalog's app-shell surfaces.
    const fromHub = new URLSearchParams();
    fromHub.set("from", "/one/setup");

    const expected = new Map([
      ["/one/kyc", "/one/setup"],
      ["/one/location", "/one/setup"],
      ["/one/gmail", "/one/setup"],
      ["/one/connected-systems", "/one/setup"],
    ]);
    for (const [path, backHref] of expected) {
      expect(resolveTopShellBreadcrumb(path, fromHub)?.backHref).toBe(backHref);
    }
  });

  it("retraces capability surfaces opened from the agent / other origins (?from=<route>)", () => {
    // Non-dashboard, non-Profile entry points (agent chat, consent inbox,
    // permission gate, kai command) tag the capability href with the CURRENT
    // route as origin so the top-bar back retraces there instead of falling to
    // Profile. The resolver honors any safe internal `from`.
    const origins = ["/one", "/one/kai", "/one/kai/analysis?tab=history"];

    for (const origin of origins) {
      const params = new URLSearchParams();
      params.set("from", origin);

      for (const path of [
        "/one/kyc",
        "/one/location",
        "/one/marketplace",
        "/one/pkm",
        "/one/consent",
      ]) {
        expect(resolveTopShellBreadcrumb(path, params)?.backHref).toBe(origin);
      }
    }

    // Unsafe origins are still rejected → the route's own default fallback.
    const unsafe = new URLSearchParams();
    unsafe.set("from", "https://evil.example/path");
    expect(resolveTopShellBreadcrumb("/one/kyc", unsafe)?.backHref).toBe(
      "/one",
    );
    expect(resolveTopShellBreadcrumb("/one/pkm", unsafe)?.backHref).toBe(
      "/one",
    );
  });

  it("returns Portfolio details to the tab-level Portfolio index", () => {
    const expectedLabels = new Map([
      ["/one/kai/portfolio/holdings", "Holdings"],
      ["/one/kai/portfolio/allocation", "Allocation"],
      ["/one/kai/portfolio/performance", "Performance"],
      ["/one/kai/portfolio/sources", "Portfolio source"],
    ]);

    for (const [route, label] of expectedLabels) {
      expect(resolveTopShellBreadcrumb(route)).toEqual({
        backHref: "/one/kai?tab=portfolio",
        width: "content",
        align: "center",
        items: [
          { label: "One", href: "/one" },
          { label: "Portfolio", href: "/one/kai?tab=portfolio" },
          { label },
        ],
      });
    }
  });

  it("owns ria client workspace back navigation from the shared top bar", () => {
    expect(resolveTopShellBreadcrumb("/ria/clients/user_123")).toEqual({
      backHref: "/ria/clients",
      width: "profile",
      align: "center",
      items: [
        { label: "RIA", href: "/ria/profile" },
        { label: "Clients", href: "/ria/clients" },
        { label: "Workspace" },
      ],
    });

    expect(
      resolveTopShellBreadcrumb("/ria/clients/user_123/accounts/account_456"),
    ).toEqual({
      backHref: "/ria/clients/user_123",
      width: "profile",
      align: "center",
      items: [
        { label: "RIA", href: "/ria/profile" },
        { label: "Clients", href: "/ria/clients" },
        { label: "Workspace", href: "/ria/clients/user_123" },
        { label: "Account detail" },
      ],
    });

    expect(
      resolveTopShellBreadcrumb("/ria/clients/user_123/requests/request_789"),
    ).toEqual({
      backHref: "/ria/clients/user_123",
      width: "profile",
      align: "center",
      items: [
        { label: "RIA", href: "/ria/profile" },
        { label: "Clients", href: "/ria/clients" },
        { label: "Workspace", href: "/ria/clients/user_123" },
        { label: "Request detail" },
      ],
    });
  });

  it("deepens Picks into Debate config for the ?view=debate sub-view", () => {
    const debateView = new URLSearchParams("view=debate");

    // Debate config lives one level below Picks, so Back returns to Picks and
    // the trail carries a fourth "Debate" crumb.
    expect(resolveTopShellBreadcrumb("/ria/picks", debateView)).toEqual({
      backHref: "/ria/picks",
      width: "content",
      align: "center",
      items: [
        { label: "One", href: "/one" },
        { label: "RIA", href: "/ria/profile" },
        { label: "Picks", href: "/ria/picks" },
        { label: "Debate" },
      ],
    });

    // Without the view param, bare Picks is untouched: three crumbs, Back to
    // the canonical RIA Profile tab.
    expect(resolveTopShellBreadcrumb("/ria/picks")).toEqual({
      backHref: "/ria/profile",
      width: "content",
      align: "center",
      items: [
        { label: "One", href: "/one" },
        { label: "RIA", href: "/ria/profile" },
        { label: "Picks" },
      ],
    });
  });

  it("keeps bare Picks for unknown or wrong-case view values", () => {
    const barePicks = {
      backHref: "/ria/profile",
      width: "content" as const,
      align: "center" as const,
      items: [
        { label: "One", href: "/one" },
        { label: "RIA", href: "/ria/profile" },
        { label: "Picks" },
      ],
    };

    // An unrecognized view value must not deepen into the Debate crumb; it stays
    // a plain three-crumb Picks with Back to RIA.
    expect(
      resolveTopShellBreadcrumb(
        "/ria/picks",
        new URLSearchParams("view=garbage"),
      ),
    ).toEqual(barePicks);

    // The Picks debate match is case-sensitive (view === "debate"), so a
    // capitalized value is treated as unknown rather than the debate sub-view.
    expect(
      resolveTopShellBreadcrumb(
        "/ria/picks",
        new URLSearchParams("view=Debate"),
      ),
    ).toEqual(barePicks);
  });

  it("gives the wallet card a way back to the row that opened it", () => {
    // It had no entry at all, so the resolver returned null and the top shell
    // rendered no breadcrumb -- leaving the screen with no way out. The Back
    // control inside the workspace is a stage control between steps of the
    // pass flow, present in only one stage, so it never served as the exit.
    expect(resolveTopShellBreadcrumb("/one/wallet-card")).toEqual({
      backHref: "/one/profile/account",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Account", href: "/one/profile/account" },
        { label: "Apple Wallet" },
      ],
    });
  });

  it("sends the wallet card back to Account, the panel it is reached from", () => {
    // profile-workspace-page.tsx pushes this route from the Apple Wallet row
    // inside the Account panel. Backing out to bare /one/profile would land
    // somebody a level above the row they tapped.
    const config = resolveTopShellBreadcrumb("/one/wallet-card");
    expect(config?.backHref).toBe("/one/profile/account");
    expect(config?.backHref).not.toBe("/one/profile");
  });
});
