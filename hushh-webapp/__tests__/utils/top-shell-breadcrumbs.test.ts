import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

describe("top shell breadcrumbs", () => {
  it("treats consents as the profile privacy workspace by default", () => {
    expect(resolveTopShellBreadcrumb("/consents")).toEqual({
      backHref: "/profile?panel=access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile?panel=access" },
        { label: "Privacy", href: "/profile?panel=access" },
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
        { label: "Profile", href: "/profile?panel=access" },
        { label: "Privacy", href: "/profile?panel=access" },
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
  });

  it("treats the PKM agent lab as a profile privacy surface", () => {
    expect(resolveTopShellBreadcrumb("/profile/pkm-agent-lab")).toEqual({
      backHref: "/profile?panel=access",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile?panel=access" },
        { label: "Privacy", href: "/profile?panel=access" },
        { label: "PKM Agent" },
      ],
    });
  });

  it("owns profile query-state panels from the shared top bar", () => {
    const panelParams = new URLSearchParams();
    panelParams.set("panel", "my-data");

    expect(resolveTopShellBreadcrumb("/profile", panelParams)).toEqual({
      backHref: "/profile",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile" },
        { label: "My Data", href: undefined },
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
      backHref: "/profile?panel=security",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile" },
        { label: "Security", href: "/profile?panel=security" },
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
