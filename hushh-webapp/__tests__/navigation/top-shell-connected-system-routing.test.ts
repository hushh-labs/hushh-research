import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the connected-systems branches inside
 * `resolveTopShellBreadcrumb`.
 *
 * Truth: the implementation has two adjacent branches:
 *
 *   Branch A — exact match:
 *     `pathname === ROUTES.CONNECTED_SYSTEMS`
 *     → 2-item breadcrumb, backHref: ROUTES.ONE_HOME
 *
 *   Branch B — prefix match:
 *     `pathname.startsWith(`${ROUTES.CONNECTED_SYSTEMS}/`)`
 *     → 3-item breadcrumb, backHref: ROUTES.CONNECTED_SYSTEMS, third
 *       label is always the hard-coded string "System detail"
 *
 * The prefix check uses a trailing slash (`/`), which means:
 *   - `/one/connected-systems`  → Branch A (exact)
 *   - `/one/connected-systems/` → Branch B (startsWith, trailing slash)
 *   - `/one/connected-systems/plaid` → Branch B
 *   - `/one/connected-systems-extra` → neither branch (no match)
 *
 * ROUTES.CONNECTED_SYSTEMS = "/one/connected-systems"
 * ROUTES.ONE_HOME           = "/one"
 */
describe("resolveTopShellBreadcrumb — connected-system routing", () => {
  it("exact ROUTES.CONNECTED_SYSTEMS → 2-item breadcrumb, backHref is ROUTES.ONE_HOME", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.CONNECTED_SYSTEMS);
    expect(result).toEqual({
      backHref: ROUTES.ONE_HOME,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Connected Systems" },
      ],
    });
  });

  it("detail path → 3-item breadcrumb, backHref is ROUTES.CONNECTED_SYSTEMS", () => {
    const result = resolveTopShellBreadcrumb(
      `${ROUTES.CONNECTED_SYSTEMS}/plaid`,
    );
    expect(result).toEqual({
      backHref: ROUTES.CONNECTED_SYSTEMS,
      width: "profile",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Connected Systems", href: ROUTES.CONNECTED_SYSTEMS },
        { label: "System detail" },
      ],
    });
  });

  it("deeply nested path still produces the same 3-item 'System detail' breadcrumb", () => {
    const result = resolveTopShellBreadcrumb(
      `${ROUTES.CONNECTED_SYSTEMS}/my-system/sub`,
    );
    expect(result?.items).toHaveLength(3);
    expect(result?.items[2]).toEqual({ label: "System detail" });
    expect(result?.backHref).toBe(ROUTES.CONNECTED_SYSTEMS);
  });

  it("third breadcrumb label is always the literal string 'System detail' regardless of system id", () => {
    const withPlaid = resolveTopShellBreadcrumb(
      `${ROUTES.CONNECTED_SYSTEMS}/plaid`,
    );
    const withSchwab = resolveTopShellBreadcrumb(
      `${ROUTES.CONNECTED_SYSTEMS}/schwab-direct`,
    );
    expect(withPlaid?.items[2]).toEqual({ label: "System detail" });
    expect(withSchwab?.items[2]).toEqual({ label: "System detail" });
  });

  it("paths that don't match either branch return null", () => {
    // No trailing slash — does not start with "/one/connected-systems/"
    expect(
      resolveTopShellBreadcrumb("/one/connected-systems-extra"),
    ).toBeNull();
  });
});