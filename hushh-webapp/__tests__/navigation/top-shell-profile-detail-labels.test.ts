import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the private `profileDetailLabel` lookup table
 * inside `resolveTopShellBreadcrumb`.
 *
 * Truth: `profileDetailLabel` is an exhaustive if-chain using exact `===`
 * matches and `startsWith()` prefix checks. Every label returned is a
 * hard-coded string literal. The function is exercised here via
 * `resolveTopShellBreadcrumb` at `ROUTES.PROFILE` with a recognised `panel`
 * param (to satisfy the `panelLabel` guard) and each known `detail` value.
 *
 * Key implementation guarantees:
 *  - `!detail` guard on line 1 → null/empty detail always returns null
 *  - `startsWith("domain:")` / `startsWith("connection:")` prefix branches
 *    match before the `===` branches (order matters in the chain)
 *  - `startsWith("support-compose:")` catches any compose ticket id
 *  - Unknown detail falls through to `return null`, which suppresses the
 *    third breadcrumb item and flips backHref from panelHref to ROUTES.PROFILE
 */
describe("resolveTopShellBreadcrumb — profile detail label lookup table", () => {
  it("maps detail=appearance to 'Appearance' as third breadcrumb", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=appearance"),
    );
    expect(result).toEqual({
      backHref: "/profile?panel=account",
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: "Account", href: "/profile?panel=account" },
        { label: "Appearance" },
      ],
    });
  });

  it("maps detail=kai-preferences to 'Kai preferences'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=kai-preferences"),
    );
    expect(result?.items[2]).toEqual({ label: "Kai preferences" });
  });

  it("maps detail=device to 'On-device first'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=device"),
    );
    expect(result?.items[2]).toEqual({ label: "On-device first" });
  });

  it("maps detail=vault to 'Vault methods'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=vault"),
    );
    expect(result?.items[2]).toEqual({ label: "Vault methods" });
  });

  it("maps detail=session to 'Session' with security panel backHref", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=security&detail=session"),
    );
    expect(result?.items[2]).toEqual({ label: "Session" });
    expect(result?.backHref).toBe("/profile?panel=security");
  });

  it("maps detail=danger to 'Danger zone'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=security&detail=danger"),
    );
    expect(result?.items[2]).toEqual({ label: "Danger zone" });
  });

  it("maps detail=gmail-connection to 'Connection'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=gmail&detail=gmail-connection"),
    );
    expect(result?.items[2]).toEqual({ label: "Connection" });
  });

  it("maps detail=gmail-actions to 'Actions'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=gmail&detail=gmail-actions"),
    );
    expect(result?.items[2]).toEqual({ label: "Actions" });
  });

  it("maps detail=support-routing to 'Routing'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=support&detail=support-routing"),
    );
    expect(result?.items[2]).toEqual({ label: "Routing" });
  });

  it("maps support-compose: prefix (any suffix) to 'Compose'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=support&detail=support-compose:welcome"),
    );
    expect(result?.items[2]).toEqual({ label: "Compose" });
  });

  it("maps domain: prefix (any domain value) to 'Domain detail'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=domain:google.com"),
    );
    expect(result?.items[2]).toEqual({ label: "Domain detail" });
  });

  it("maps connection: prefix (any connection id) to 'Connection detail'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=connection:plaid"),
    );
    expect(result?.items[2]).toEqual({ label: "Connection detail" });
  });

  it("returns null for unknown detail — produces only 2 items and backHref is ROUTES.PROFILE", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=unrecognised-value"),
    );
    expect(result).toEqual({
      backHref: ROUTES.PROFILE,
      width: "profile",
      align: "center",
      items: [
        { label: "Profile", href: ROUTES.PROFILE },
        { label: "Account" },
      ],
    });
  });

  it("selects panelHref as backHref when detail is recognised, ROUTES.PROFILE when not", () => {
    const withDetail = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account&detail=appearance"),
    );
    expect(withDetail?.backHref).toBe("/profile?panel=account");

    const withoutDetail = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=account"),
    );
    expect(withoutDetail?.backHref).toBe(ROUTES.PROFILE);
  });
});