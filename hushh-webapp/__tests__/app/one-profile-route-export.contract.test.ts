import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { legacyProfileRouteRedirectHref } from "@/lib/navigation/profile-pane";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * /one/profile redirects into the pane on /one. On the web that is a server
 * redirect from the request's search params; the Capacitor bundle has no
 * server and awaiting request-only search params during the static export
 * fails the build ("couldn't be rendered statically because it used await
 * searchParams"). The page must keep both halves, sharing one mapping.
 */
describe("/one/profile route", () => {
  it("keeps the Capacitor static export branch", () => {
    const source = readFileSync(
      path.join(repoRoot, "app", "one", "profile", "page.tsx"),
      "utf8",
    );
    expect(source).toContain('process.env.CAPACITOR_BUILD === "true"');
    expect(source).toContain("ProfileRouteClientRedirect");
    expect(source).toContain("legacyProfileRouteRedirectHref(query)");
    // The await must sit below the export guard.
    expect(source.indexOf('CAPACITOR_BUILD === "true"')).toBeLessThan(
      source.indexOf("await searchParams"),
    );
  });

  it("maps legacy profile addresses onto the pane the same way on both halves", () => {
    expect(legacyProfileRouteRedirectHref({})).toBe("/one?profile_pane=1");
    expect(legacyProfileRouteRedirectHref({ panel: "preferences" })).toBe(
      "/one?profile_pane=1&profile_panel=preferences",
    );
    expect(legacyProfileRouteRedirectHref({ tab: "security", detail: "devices" })).toBe(
      "/one?profile_pane=1&profile_panel=security&profile_detail=devices",
    );
    expect(
      legacyProfileRouteRedirectHref({ profile_panel: "preferences", profile_detail: "voice" }),
    ).toBe("/one?profile_pane=1&profile_panel=preferences&profile_detail=voice");
    expect(legacyProfileRouteRedirectHref({ panel: ["a", "b"] })).toBe(
      "/one?profile_pane=1&profile_panel=a",
    );
    expect(
      legacyProfileRouteRedirectHref(new URLSearchParams("tab=preferences&detail=gemini")),
    ).toBe("/one?profile_pane=1&profile_panel=preferences&profile_detail=gemini");
  });
});
