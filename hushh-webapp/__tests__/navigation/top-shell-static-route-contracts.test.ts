import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the static-route branches inside
 * `resolveTopShellBreadcrumb`.
 *
 * Truth: each branch below is a hard-coded exact `===` match against a
 * ROUTES constant. The return value is a literal object — no dynamic
 * computation occurs. These contracts are entirely determined by the
 * if-chain ordering in the source file.
 *
 * Routes covered:
 *   ROUTES.KAI_HOME    ("/one/kai")      → backHref: "/one"
 *   ROUTES.ONE_KYC     ("/one/kyc")      → backHref: "/profile"
 *   ROUTES.ONE_LOCATION("/one/location") → backHref: "/profile"
 *   ROUTES.PKM         ("/one/pkm")      → backHref: "/one"
 *   ROUTES.RIA_CLIENTS ("/ria/clients")  → backHref: "/ria"
 *   ROUTES.GMAIL       ("/one/gmail")    → backHref: "/one" (no from param)
 *
 * Paths that match none of the known branches return null.
 */
describe("resolveTopShellBreadcrumb — static route contracts", () => {
  it("ROUTES.KAI_HOME → backHref is ROUTES.ONE_HOME, items are ['One', 'Kai']", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.KAI_HOME);
    expect(result).toEqual({
      backHref: ROUTES.ONE_HOME,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Kai" },
      ],
    });
  });

  it("ROUTES.ONE_KYC → backHref is ROUTES.PROFILE, items are ['Profile', 'Email']", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.ONE_KYC);
    expect(result).toEqual({
      backHref: ROUTES.PROFILE,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: "Email" },
      ],
    });
  });

  it("ROUTES.ONE_LOCATION → backHref is ROUTES.PROFILE, items are ['Profile', 'Location']", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.ONE_LOCATION);
    expect(result).toEqual({
      backHref: ROUTES.PROFILE,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: "Location" },
      ],
    });
  });

  it("ROUTES.PKM → backHref is ROUTES.ONE_HOME, items are ['One', 'PKM']", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.PKM);
    expect(result).toEqual({
      backHref: ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "PKM" },
      ],
    });
  });

  it("ROUTES.RIA_CLIENTS → backHref is ROUTES.RIA_HOME, items are ['RIA', 'Clients']", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.RIA_CLIENTS);
    expect(result).toEqual({
      backHref: ROUTES.RIA_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "RIA", href: ROUTES.RIA_HOME },
        { label: "Clients" },
      ],
    });
  });

  it("ROUTES.GMAIL with no 'from' param → backHref is ROUTES.ONE_HOME, items are ['One', 'Gmail']", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.GMAIL);
    expect(result).toEqual({
      backHref: ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Gmail" },
      ],
    });
  });

  it("unmatched paths return null", () => {
    expect(resolveTopShellBreadcrumb(ROUTES.ONE_HOME)).toBeNull();
    expect(resolveTopShellBreadcrumb(ROUTES.AGENT)).toBeNull();
    expect(resolveTopShellBreadcrumb(ROUTES.MARKETPLACE)).toBeNull();
  });
});