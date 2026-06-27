import { describe, expect, it } from "vitest";

import { buildRiaClientWorkspaceRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests: buildRiaClientWorkspaceRoute — testProfile flag
 *
 * Implementation boundary (routes.ts):
 *
 *   test_profile: entries?.testProfile ? "1" : null
 *
 * The ternary maps truthy testProfile to the string "1".
 * withQuery receives null for any falsy value and excludes it because
 * String(null ?? "").trim() === "" — the emptiness guard is never
 * satisfied, so no test_profile key appears in the output URL.
 *
 * The fallback (empty/null/whitespace clientId → ROUTES.RIA_CLIENTS)
 * fires before withQuery is called, so testProfile has no effect
 * when clientId is absent.
 */

describe("buildRiaClientWorkspaceRoute — testProfile flag", () => {
  describe("truthy testProfile emits test_profile=1", () => {
    it("emits test_profile=1 when testProfile is true", () => {
      expect(buildRiaClientWorkspaceRoute("c1", { testProfile: true })).toBe(
        "/ria/clients/c1?test_profile=1",
      );
    });

    it("emits test_profile=1 alongside tab when both are provided", () => {
      expect(
        buildRiaClientWorkspaceRoute("c1", { tab: "kai", testProfile: true }),
      ).toBe("/ria/clients/c1?tab=kai&test_profile=1");
    });

    it("emits test_profile=1 for every valid tab value", () => {
      const tabs = ["overview", "access", "kai", "explorer"] as const;
      for (const tab of tabs) {
        expect(
          buildRiaClientWorkspaceRoute("c1", { tab, testProfile: true }),
        ).toBe(`/ria/clients/c1?tab=${tab}&test_profile=1`);
      }
    });
  });

  describe("falsy testProfile produces no test_profile param", () => {
    it("omits test_profile when testProfile is false", () => {
      expect(buildRiaClientWorkspaceRoute("c1", { testProfile: false })).toBe(
        "/ria/clients/c1",
      );
    });

    it("omits test_profile when testProfile is null", () => {
      expect(buildRiaClientWorkspaceRoute("c1", { testProfile: null })).toBe(
        "/ria/clients/c1",
      );
    });

    it("omits test_profile when testProfile is not in entries", () => {
      expect(buildRiaClientWorkspaceRoute("c1", {})).toBe("/ria/clients/c1");
    });

    it("omits test_profile when entries are not provided", () => {
      expect(buildRiaClientWorkspaceRoute("c1")).toBe("/ria/clients/c1");
    });

    it("omits test_profile with tab present and testProfile false", () => {
      expect(
        buildRiaClientWorkspaceRoute("c1", { tab: "overview", testProfile: false }),
      ).toBe("/ria/clients/c1?tab=overview");
    });
  });

  describe("testProfile is irrelevant when clientId triggers the fallback", () => {
    it("returns /ria/clients for null clientId even when testProfile is true", () => {
      expect(buildRiaClientWorkspaceRoute(null, { testProfile: true })).toBe(
        "/ria/clients",
      );
    });

    it("returns /ria/clients for empty string clientId even when testProfile is true", () => {
      expect(buildRiaClientWorkspaceRoute("", { testProfile: true })).toBe(
        "/ria/clients",
      );
    });

    it("returns /ria/clients for whitespace-only clientId even when testProfile is true", () => {
      expect(buildRiaClientWorkspaceRoute("  ", { testProfile: true })).toBe(
        "/ria/clients",
      );
    });
  });
});