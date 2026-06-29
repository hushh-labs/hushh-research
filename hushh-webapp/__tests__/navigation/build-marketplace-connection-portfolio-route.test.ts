import { describe, expect, it } from "vitest";

import { buildMarketplaceConnectionPortfolioRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for buildMarketplaceConnectionPortfolioRoute.
 *
 * Implementation boundary (routes.ts):
 *
 *   export function buildMarketplaceConnectionPortfolioRoute(connectionId?: string | null) {
 *     const normalized = String(connectionId ?? "").trim();
 *     if (!normalized) return ROUTES.RIA_CLIENTS;
 *     return buildRiaClientWorkspaceRoute(normalized, { tab: "kai" });
 *   }
 *
 *   ROUTES.RIA_CLIENTS  = "/ria/clients"
 *   ROUTES.KAI_ANALYSIS = "/one/kai/analysis"  (not used here)
 *
 * Truth-first:
 *   - String(connectionId ?? "").trim() is guaranteed by the JS spec:
 *       undefined / null → "" after nullish coalescing → trim → ""
 *       whitespace-only  → "" after trim
 *       empty string     → "" directly
 *   - !normalized is truthy for all of the above → early return "/ria/clients".
 *   - For any non-empty normalized value the function delegates to
 *     buildRiaClientWorkspaceRoute(normalized, { tab: "kai" }).
 *   - The `tab: "kai"` is hard-coded in the function body; callers cannot
 *     override it. buildRiaClientWorkspaceRoute then encodes the normalized
 *     value via encodeURIComponent and appends ?tab=kai via URLSearchParams.
 */
describe("buildMarketplaceConnectionPortfolioRoute", () => {
  describe("fallback to RIA_CLIENTS — empty / nullish connectionId", () => {
    it("returns /ria/clients when called with no arguments", () => {
      expect(buildMarketplaceConnectionPortfolioRoute()).toBe("/ria/clients");
    });

    it("returns /ria/clients for null", () => {
      expect(buildMarketplaceConnectionPortfolioRoute(null)).toBe("/ria/clients");
    });

    it("returns /ria/clients for an empty string", () => {
      expect(buildMarketplaceConnectionPortfolioRoute("")).toBe("/ria/clients");
    });

    it("returns /ria/clients for a whitespace-only string — trimmed to empty", () => {
      expect(buildMarketplaceConnectionPortfolioRoute("  ")).toBe("/ria/clients");
    });
  });

  describe("valid connectionId — delegates with hard-coded tab=kai", () => {
    it("produces the workspace route with tab=kai for a plain connectionId", () => {
      expect(buildMarketplaceConnectionPortfolioRoute("conn-1")).toBe(
        "/ria/clients/conn-1?tab=kai"
      );
    });

    it("encodes spaces in connectionId via encodeURIComponent before building the path", () => {
      expect(buildMarketplaceConnectionPortfolioRoute("conn 1")).toBe(
        "/ria/clients/conn%201?tab=kai"
      );
    });

    it("always appends tab=kai regardless of the connectionId value — hard-coded in function body", () => {
      const result = buildMarketplaceConnectionPortfolioRoute("any-connection-id");
      expect(result).toContain("tab=kai");
    });

    it("never appends any other tab value — only tab=kai is produced", () => {
      const result = buildMarketplaceConnectionPortfolioRoute("conn-2");
      // tab=kai must be present and no other tab= parameter
      expect(result).toBe("/ria/clients/conn-2?tab=kai");
    });
  });
});