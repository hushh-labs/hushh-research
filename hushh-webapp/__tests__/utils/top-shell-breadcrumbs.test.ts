import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

describe("top shell breadcrumbs", () => {
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
      items: [{ label: "One", href: "/one" }, { label: "Connect" }],
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
        { label: "System detail" },
      ],
    });
  });

  it("treats consents as the profile privacy workspace by default", () => {
    expect(resolveTopShellBreadcrumb("/one/consent")).toEqual({
      backHref: "/one/profile/access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile/access" },
        { label: "Privacy", href: "/one/profile/access" },
        { label: "Consent center" },
      ],
    });
  });

  it("preserves a safe internal from param for consent back navigation", () => {
    const params = new URLSearchParams();
    params.set("from", "/one/kai/analysis?tab=history");

    expect(resolveTopShellBreadcrumb("/one/consent", params)).toEqual({
      backHref: "/one/kai/analysis?tab=history",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile/access" },
        { label: "Privacy", href: "/one/profile/access" },
        { label: "Consent center" },
      ],
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
      items: [{ label: "Set up", href: "/one/setup" }, { label: "Kai" }],
    });

    // No origin → Kai home still falls back to One home (unchanged behavior).
    expect(resolveTopShellBreadcrumb("/one/kai")).toEqual({
      backHref: "/one",
      width: "content",
      align: "center",
      items: [{ label: "One", href: "/one" }, { label: "Kai" }],
    });

    // A Kai subroute opened during onboarding preserves the setup origin on the
    // Kai-home hop so the retrace can still reach the hub.
    expect(
      resolveTopShellBreadcrumb("/one/kai/investments", fromSetup)?.backHref,
    ).toBe("/one/kai?tab=market&from=%2Fone%2Fsetup");

    // Unsafe origins are rejected → One home fallback.
    const unsafe = new URLSearchParams();
    unsafe.set("from", "//evil.example/path");
    expect(resolveTopShellBreadcrumb("/one/kai", unsafe)?.backHref).toBe(
      "/one",
    );
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

  it("gives the setup hub an authored onboarding parent and honors return_to", () => {
    expect(resolveTopShellBreadcrumb("/one/setup")).toEqual({
      backHref: "/",
      width: "content",
      align: "center",
      hideBack: false,
      items: [{ label: "One", href: "/" }, { label: "Setup" }],
    });

    expect(resolveTopShellBreadcrumb("/one/setup/")).toEqual({
      backHref: "/",
      width: "content",
      align: "center",
      hideBack: false,
      items: [{ label: "One", href: "/" }, { label: "Setup" }],
    });

    const fromDashboard = new URLSearchParams();
    fromDashboard.set("return_to", "/one");
    expect(
      resolveTopShellBreadcrumb("/one/setup", fromDashboard)?.backHref,
    ).toBe("/one");
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
        { label: "Connected Systems" },
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

  it("treats the PKM agent lab as a profile privacy surface", () => {
    expect(resolveTopShellBreadcrumb("/one/profile/pkm-agent-lab")).toEqual({
      backHref: "/one/profile/access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile/access" },
        { label: "Privacy", href: "/one/profile/access" },
        { label: "PKM Agent" },
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

    expect(resolveTopShellBreadcrumb("/one/profile/regulatory")).toEqual({
      backHref: "/one/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Regulatory profile", href: undefined },
      ],
    });

    const regulatoryParams = new URLSearchParams();
    regulatoryParams.set("panel", "regulatory");

    expect(resolveTopShellBreadcrumb("/one/profile", regulatoryParams)).toEqual({
      backHref: "/one/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/one/profile" },
        { label: "Regulatory profile", href: undefined },
      ],
    });
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
      // No origin → Agents dashboard.
      expect(resolveTopShellBreadcrumb(path)).toEqual({
        backHref: "/one",
        width: "profile",
        align: "center",
        items: [{ label: "One", href: "/one" }, { label }],
      });

      // Opened from the dashboard (?from=/one) → back to the dashboard, and the
      // leading crumb reflects the real origin ("One").
      const fromOne = new URLSearchParams();
      fromOne.set("from", "/one");
      expect(resolveTopShellBreadcrumb(path, fromOne)).toEqual({
        backHref: "/one",
        width: "profile",
        align: "center",
        items: [{ label: "One", href: "/one" }, { label }],
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

  it("returns the single top-bar back button to the Location hub while a quick-action flow is open", () => {
    // Location quick-action screens (Check-In, Drive To, Pick Me Up, Safe
    // Arrival, SOS/Alert, Share, Ask, Invite, Privacy, Temp link) are tracked
    // via /one/location?action=<slug>. The one top-left back button must return
    // to the Location hub (strip the action param) rather than leaving to /one —
    // this is the fix for the "two back buttons" UX. The in-content back arrows
    // were removed so this is the ONLY back affordance on those screens.
    const cases: Array<[string, string]> = [
      ["check-in", "Check-In"],
      ["drive-to", "Drive To"],
      ["pick-me-up", "Pick Me Up"],
      ["safe-arrival", "Safe Arrival"],
      ["sos", "Safety"],
      ["share", "Share location"],
      ["ask", "Ask someone"],
      ["invite", "Invite to Circle"],
      ["temp-link", "Public link"],
      ["privacy", "Privacy"],
    ];

    for (const [action, label] of cases) {
      const params = new URLSearchParams();
      params.set("action", action);
      expect(resolveTopShellBreadcrumb("/one/location", params)).toEqual({
        backHref: "/one/location",
        width: "profile",
        align: "center",
        items: [
          { label: "One", href: "/one" },
          { label: "Location", href: "/one/location" },
          { label },
        ],
      });
    }

    // Opened from Profile: the leading crumb reflects the real origin, but back
    // still returns to the Location hub (not Profile) while the flow is open.
    const fromProfile = new URLSearchParams();
    fromProfile.set("from", "/one/profile");
    fromProfile.set("action", "check-in");
    expect(resolveTopShellBreadcrumb("/one/location", fromProfile)).toEqual({
      backHref: "/one/location",
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

  it("owns ria client workspace back navigation from the shared top bar", () => {
    expect(resolveTopShellBreadcrumb("/ria/clients/user_123")).toEqual({
      backHref: "/ria/clients",
      width: "profile",
      align: "center",
      items: [
        { label: "RIA", href: "/ria" },
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
        { label: "RIA", href: "/ria" },
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
        { label: "RIA", href: "/ria" },
        { label: "Clients", href: "/ria/clients" },
        { label: "Workspace", href: "/ria/clients/user_123" },
        { label: "Request detail" },
      ],
    });
  });
});
