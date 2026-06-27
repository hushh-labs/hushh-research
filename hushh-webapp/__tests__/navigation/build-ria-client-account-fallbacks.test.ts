import { describe, expect, it } from "vitest";

import { buildRiaClientAccountRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests: buildRiaClientAccountRoute — fallback boundaries
 *
 * Implementation boundary (routes.ts):
 *
 *   const normalizedClientId  = String(clientId  ?? "").trim();
 *   const normalizedAccountId = String(accountId ?? "").trim();
 *   if (!normalizedClientId || !normalizedAccountId) return ROUTES.RIA_CLIENTS;
 *
 * The guard uses a logical OR: if EITHER normalized identifier is empty after
 * String(x ?? "").trim(), the function returns ROUTES.RIA_CLIENTS ("/ria/clients")
 * immediately. Both identifiers must survive to a non-empty string for a valid
 * /ria/clients/{clientId}/accounts/{accountId} path to be produced.
 *
 * The testProfile flag follows the same ternary as buildRiaClientWorkspaceRoute:
 *   entries?.testProfile ? "1" : null
 * and is only reachable when both identifiers are non-empty.
 */

describe("buildRiaClientAccountRoute — fallback boundaries", () => {
  describe("null clientId triggers fallback regardless of accountId", () => {
    it("returns /ria/clients when clientId is null", () => {
      expect(buildRiaClientAccountRoute(null, "acct-1")).toBe("/ria/clients");
    });

    it("returns /ria/clients when clientId is undefined", () => {
      expect(buildRiaClientAccountRoute(undefined, "acct-1")).toBe(
        "/ria/clients",
      );
    });
  });

  describe("empty or whitespace clientId triggers fallback", () => {
    it("returns /ria/clients when clientId is empty string", () => {
      expect(buildRiaClientAccountRoute("", "acct-1")).toBe("/ria/clients");
    });

    it("returns /ria/clients when clientId is whitespace-only", () => {
      expect(buildRiaClientAccountRoute("  ", "acct-1")).toBe("/ria/clients");
    });
  });

  describe("null accountId triggers fallback regardless of clientId", () => {
    it("returns /ria/clients when accountId is null", () => {
      expect(buildRiaClientAccountRoute("c1", null)).toBe("/ria/clients");
    });

    it("returns /ria/clients when accountId is undefined", () => {
      expect(buildRiaClientAccountRoute("c1", undefined)).toBe("/ria/clients");
    });
  });

  describe("empty or whitespace accountId triggers fallback", () => {
    it("returns /ria/clients when accountId is empty string", () => {
      expect(buildRiaClientAccountRoute("c1", "")).toBe("/ria/clients");
    });

    it("returns /ria/clients when accountId is whitespace-only", () => {
      expect(buildRiaClientAccountRoute("c1", "  ")).toBe("/ria/clients");
    });
  });

  describe("both identifiers absent triggers fallback", () => {
    it("returns /ria/clients when both are null", () => {
      expect(buildRiaClientAccountRoute(null, null)).toBe("/ria/clients");
    });

    it("returns /ria/clients when both are empty strings", () => {
      expect(buildRiaClientAccountRoute("", "")).toBe("/ria/clients");
    });

    it("returns /ria/clients when no arguments are passed", () => {
      expect(buildRiaClientAccountRoute()).toBe("/ria/clients");
    });
  });

  describe("valid identifiers produce the accounts sub-path", () => {
    it("produces the accounts sub-path when both identifiers are non-empty", () => {
      expect(buildRiaClientAccountRoute("c1", "acct-1")).toBe(
        "/ria/clients/c1/accounts/acct-1",
      );
    });
  });

  describe("testProfile flag on valid routes", () => {
    it("emits test_profile=1 when testProfile is true and both identifiers are valid", () => {
      expect(
        buildRiaClientAccountRoute("c1", "acct-1", { testProfile: true }),
      ).toBe("/ria/clients/c1/accounts/acct-1?test_profile=1");
    });

    it("omits test_profile when testProfile is false and both identifiers are valid", () => {
      expect(
        buildRiaClientAccountRoute("c1", "acct-1", { testProfile: false }),
      ).toBe("/ria/clients/c1/accounts/acct-1");
    });

    it("omits test_profile when testProfile is null and both identifiers are valid", () => {
      expect(
        buildRiaClientAccountRoute("c1", "acct-1", { testProfile: null }),
      ).toBe("/ria/clients/c1/accounts/acct-1");
    });
  });
});