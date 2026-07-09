import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

describe("top shell breadcrumbs", () => {
  it("treats consents as the profile privacy workspace by default", () => {
    expect(resolveTopShellBreadcrumb("/consents")).toEqual({
      backHref: "/profile/access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile/access" },
        { label: "Privacy", href: "/profile/access" },
        { label: "Consent center" },
      ],
    });
  });

  it("preserves a safe internal from param for consent back navigation", () => {
    const params = new URLSearchParams();
    params.set("from", "/one/kai/analysis?tab=history");

    expect(resolveTopShellBreadcrumb("/consents", params)).toEqual({
      backHref: "/one/kai/analysis?tab=history",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile/access" },
        { label: "Privacy", href: "/profile/access" },
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

    expect(resolveTopShellBreadcrumb("/one/setup/kai", unsafeParams)?.backHref).toBe(
      "/one/setup",
    );
  });

  it("gives the setup hub a back affordance to One home", () => {
    expect(resolveTopShellBreadcrumb("/one/setup")).toEqual({
      backHref: "/one",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup" },
      ],
    });

    expect(resolveTopShellBreadcrumb("/one/setup/")).toEqual({
      backHref: "/one",
      width: "content",
      align: "center",
      hideBack: false,
      items: [
        { label: "One", href: "/one" },
        { label: "Setup" },
      ],
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

    expect(resolveTopShellBreadcrumb("/one/kai/import", unsafeParams)?.backHref).toBe(
      "/one/setup",
    );
  });

  it("treats the PKM agent lab as a profile privacy surface", () => {
    expect(resolveTopShellBreadcrumb("/profile/pkm-agent-lab")).toEqual({
      backHref: "/profile/access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile/access" },
        { label: "Privacy", href: "/profile/access" },
        { label: "PKM Agent" },
      ],
    });
  });

  it("owns profile nested and legacy panels from the shared top bar", () => {
    const panelParams = new URLSearchParams();
    panelParams.set("panel", "my-data");

    expect(resolveTopShellBreadcrumb("/profile", panelParams)).toEqual({
      backHref: "/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile" },
        { label: "Memory", href: undefined },
      ],
    });

    const accountParams = new URLSearchParams();
    accountParams.set("panel", "account");

    expect(resolveTopShellBreadcrumb("/profile", accountParams)).toEqual({
      backHref: "/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile" },
        { label: "Account", href: undefined },
      ],
    });

    const detailParams = new URLSearchParams();
    detailParams.set("panel", "security");
    detailParams.set("detail", "vault");

    expect(resolveTopShellBreadcrumb("/profile", detailParams)).toEqual({
      backHref: "/profile/security",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile" },
        { label: "Security", href: "/profile/security" },
        { label: "Vault methods" },
      ],
    });

    const legacyTabParams = new URLSearchParams();
    legacyTabParams.set("tab", "preferences");

    expect(resolveTopShellBreadcrumb("/profile", legacyTabParams)).toEqual({
      backHref: "/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile" },
        { label: "Preferences", href: undefined },
      ],
    });
  });

  it("routes legacy receipts back to canonical Gmail", () => {
    expect(resolveTopShellBreadcrumb("/profile/receipts")).toEqual({
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
      { path: "/one/kyc", label: "Email" },
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
    expect(resolveTopShellBreadcrumb("/consents", consentFromOne)?.backHref).toBe(
      "/one",
    );
  });

  it("retraces setup-hub-opened capabilities back to the hub (?from=/one/setup)", () => {
    // From the Set up One hub, capability handoffs carry ?from=/one/setup so the
    // top-bar back returns to the hub (not Profile/dashboard) — "jaise aaya waise
    // wapas". Covers the origin-aware gated surfaces incl. PKM/connected-systems.
    const fromHub = new URLSearchParams();
    fromHub.set("from", "/one/setup");

    for (const path of [
      "/one/kyc",
      "/one/location",
      "/one/marketplace",
      "/one/gmail",
      "/one/pkm",
      "/one/connected-systems",
      "/consents",
    ]) {
      expect(resolveTopShellBreadcrumb(path, fromHub)?.backHref).toBe(
        "/one/setup",
      );
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
        "/consents",
      ]) {
        expect(resolveTopShellBreadcrumb(path, params)?.backHref).toBe(origin);
      }
    }

    // Unsafe origins are still rejected → the route's own default fallback.
    const unsafe = new URLSearchParams();
    unsafe.set("from", "https://evil.example/path");
    expect(resolveTopShellBreadcrumb("/one/kyc", unsafe)?.backHref).toBe("/one");
    expect(resolveTopShellBreadcrumb("/one/pkm", unsafe)?.backHref).toBe("/one");
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
