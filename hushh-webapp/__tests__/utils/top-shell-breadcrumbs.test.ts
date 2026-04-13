import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

describe("top shell breadcrumbs", () => {
  it("treats consents as the profile privacy workspace by default", () => {
    expect(resolveTopShellBreadcrumb("/consents")).toEqual({
      backHref: "/profile?tab=privacy",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile?tab=privacy" },
        { label: "Privacy", href: "/profile?tab=privacy" },
        { label: "Consent center" },
      ],
    });
  });

  it("preserves a safe internal from param for consent back navigation", () => {
    const params = new URLSearchParams();
    params.set("from", "/kai/analysis?tab=history");

    expect(resolveTopShellBreadcrumb("/consents", params)).toEqual({
      backHref: "/kai/analysis?tab=history",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile?tab=privacy" },
        { label: "Privacy", href: "/profile?tab=privacy" },
        { label: "Consent center" },
      ],
    });
  });

  it("treats the PKM agent lab as a profile privacy surface", () => {
    expect(resolveTopShellBreadcrumb("/profile/pkm-agent-lab")).toEqual({
      backHref: "/profile?tab=privacy",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: "/profile?tab=privacy" },
        { label: "Privacy", href: "/profile?tab=privacy" },
        { label: "PKM Agent" },
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

    expect(resolveTopShellBreadcrumb("/ria/clients/user_123/accounts/account_456")).toEqual({
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

    expect(resolveTopShellBreadcrumb("/ria/clients/user_123/requests/request_789")).toEqual({
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
