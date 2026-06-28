import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the marketplace-connections branch inside
 * `resolveTopShellBreadcrumb`.
 *
 * Truth: the branch activates for:
 *   `pathname === ROUTES.MARKETPLACE_CONNECTIONS`
 *   OR
 *   `pathname.startsWith(`${ROUTES.MARKETPLACE_CONNECTIONS}/`)`
 *
 * Once inside, a single boolean gate determines the result:
 *   `const isPortfolio = pathname.includes("/portfolio")`
 *
 * When isPortfolio is true:
 *   - backHref → ROUTES.MARKETPLACE_CONNECTIONS
 *   - items    → 3 items, third is { label: "Portfolio" }
 *
 * When isPortfolio is false:
 *   - backHref → ROUTES.MARKETPLACE
 *   - items    → 2 items (both retain their hrefs)
 *
 * ROUTES.MARKETPLACE             = "/marketplace"
 * ROUTES.MARKETPLACE_CONNECTIONS = "/marketplace/connections"
 */
describe("resolveTopShellBreadcrumb — marketplace portfolio branch selection", () => {
  it("exact ROUTES.MARKETPLACE_CONNECTIONS (no portfolio) → 2-item breadcrumb, backHref is ROUTES.MARKETPLACE", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.MARKETPLACE_CONNECTIONS);
    expect(result).toEqual({
      backHref: ROUTES.MARKETPLACE,
      width: "profile",
      align: "center",
      items: [
        { label: "Connect", href: ROUTES.MARKETPLACE },
        { label: "Connections", href: ROUTES.MARKETPLACE_CONNECTIONS },
      ],
    });
  });

  it("path containing '/portfolio' → 3-item breadcrumb, backHref is ROUTES.MARKETPLACE_CONNECTIONS", () => {
    const result = resolveTopShellBreadcrumb(
      `${ROUTES.MARKETPLACE_CONNECTIONS}/portfolio`,
    );
    expect(result).toEqual({
      backHref: ROUTES.MARKETPLACE_CONNECTIONS,
      width: "profile",
      align: "center",
      items: [
        { label: "Connect", href: ROUTES.MARKETPLACE },
        { label: "Connections", href: ROUTES.MARKETPLACE_CONNECTIONS },
        { label: "Portfolio" },
      ],
    });
  });

  it("sub-path without '/portfolio' → 2-item breadcrumb, backHref is ROUTES.MARKETPLACE", () => {
    const result = resolveTopShellBreadcrumb(
      `${ROUTES.MARKETPLACE_CONNECTIONS}/some-connection-id`,
    );
    expect(result?.items).toHaveLength(2);
    expect(result?.backHref).toBe(ROUTES.MARKETPLACE);
  });

  it("deeply nested path with '/portfolio' segment → still 3 items with 'Portfolio' label", () => {
    const result = resolveTopShellBreadcrumb(
      `${ROUTES.MARKETPLACE_CONNECTIONS}/conn-123/portfolio`,
    );
    expect(result?.items).toHaveLength(3);
    expect(result?.items[2]).toEqual({ label: "Portfolio" });
    expect(result?.backHref).toBe(ROUTES.MARKETPLACE_CONNECTIONS);
  });

  it("isPortfolio is a substring check — '/portfolio' anywhere in the path triggers it, including 'portfolioX'", () => {
    const exactPortfolio = resolveTopShellBreadcrumb(
      `${ROUTES.MARKETPLACE_CONNECTIONS}/portfolio`,
    );
    // "/marketplace/connections/portfolioX".includes("/portfolio") → true
    // because "/portfolio" is a prefix of "portfolioX"
    const prefixPortfolio = resolveTopShellBreadcrumb(
      `${ROUTES.MARKETPLACE_CONNECTIONS}/portfolioX`,
    );
    expect(exactPortfolio?.backHref).toBe(ROUTES.MARKETPLACE_CONNECTIONS);
    expect(prefixPortfolio?.backHref).toBe(ROUTES.MARKETPLACE_CONNECTIONS);
  });

  it("non-portfolio path: both 'Connect' and 'Connections' items retain their hrefs", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.MARKETPLACE_CONNECTIONS);
    expect(result?.items[0]).toEqual({
      label: "Connect",
      href: ROUTES.MARKETPLACE,
    });
    expect(result?.items[1]).toEqual({
      label: "Connections",
      href: ROUTES.MARKETPLACE_CONNECTIONS,
    });
  });
});