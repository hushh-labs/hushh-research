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
});
