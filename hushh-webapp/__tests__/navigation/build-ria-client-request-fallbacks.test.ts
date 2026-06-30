import { describe, expect, it } from "vitest";

import { buildRiaClientRequestRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests: buildRiaClientRequestRoute — fallback boundaries
 *
 * Implementation boundary (routes.ts):
 *
 *   const normalizedClientId  = String(clientId  ?? "").trim();
 *   const normalizedRequestId = String(requestId ?? "").trim();
 *   if (!normalizedClientId || !normalizedRequestId) return ROUTES.RIA_CLIENTS;
 *
 * The guard uses a logical OR: if EITHER normalized identifier is empty after
 * String(x ?? "").trim(), the function returns ROUTES.RIA_CLIENTS ("/ria/clients")
 * immediately. Both identifiers must be non-empty for a valid
 * /ria/clients/{clientId}/requests/{requestId} path to be produced.
 *
 * This is the same guard pattern as buildRiaClientAccountRoute, applied to
 * the requests sub-resource path.
 *
 * The testProfile flag follows the same ternary used throughout:
 *   entries?.testProfile ? "1" : null
 */

describe("buildRiaClientRequestRoute — fallback boundaries", () => {
  describe("null clientId triggers fallback regardless of requestId", () => {
    it("returns /ria/clients when clientId is null", () => {
      expect(buildRiaClientRequestRoute(null, "req-1")).toBe("/ria/clients");
    });

    it("returns /ria/clients when clientId is undefined", () => {
      expect(buildRiaClientRequestRoute(undefined, "req-1")).toBe(
        "/ria/clients",
      );
    });
  });

  describe("empty or whitespace clientId triggers fallback", () => {
    it("returns /ria/clients when clientId is empty string", () => {
      expect(buildRiaClientRequestRoute("", "req-1")).toBe("/ria/clients");
    });

    it("returns /ria/clients when clientId is whitespace-only", () => {
      expect(buildRiaClientRequestRoute("  ", "req-1")).toBe("/ria/clients");
    });
  });

  describe("null requestId triggers fallback regardless of clientId", () => {
    it("returns /ria/clients when requestId is null", () => {
      expect(buildRiaClientRequestRoute("c1", null)).toBe("/ria/clients");
    });

    it("returns /ria/clients when requestId is undefined", () => {
      expect(buildRiaClientRequestRoute("c1", undefined)).toBe("/ria/clients");
    });
  });

  describe("empty or whitespace requestId triggers fallback", () => {
    it("returns /ria/clients when requestId is empty string", () => {
      expect(buildRiaClientRequestRoute("c1", "")).toBe("/ria/clients");
    });

    it("returns /ria/clients when requestId is whitespace-only", () => {
      expect(buildRiaClientRequestRoute("c1", "  ")).toBe("/ria/clients");
    });
  });

  describe("both identifiers absent triggers fallback", () => {
    it("returns /ria/clients when both are null", () => {
      expect(buildRiaClientRequestRoute(null, null)).toBe("/ria/clients");
    });

    it("returns /ria/clients when both are empty strings", () => {
      expect(buildRiaClientRequestRoute("", "")).toBe("/ria/clients");
    });

    it("returns /ria/clients when no arguments are passed", () => {
      expect(buildRiaClientRequestRoute()).toBe("/ria/clients");
    });
  });

  describe("valid identifiers produce the requests sub-path", () => {
    it("produces the requests sub-path when both identifiers are non-empty", () => {
      expect(buildRiaClientRequestRoute("c1", "req-1")).toBe(
        "/ria/clients/c1/requests/req-1",
      );
    });
  });

  describe("testProfile flag on valid routes", () => {
    it("emits test_profile=1 when testProfile is true and both identifiers are valid", () => {
      expect(
        buildRiaClientRequestRoute("c1", "req-1", { testProfile: true }),
      ).toBe("/ria/clients/c1/requests/req-1?test_profile=1");
    });

    it("omits test_profile when testProfile is false and both identifiers are valid", () => {
      expect(
        buildRiaClientRequestRoute("c1", "req-1", { testProfile: false }),
      ).toBe("/ria/clients/c1/requests/req-1");
    });

    it("omits test_profile when testProfile is null and both identifiers are valid", () => {
      expect(
        buildRiaClientRequestRoute("c1", "req-1", { testProfile: null }),
      ).toBe("/ria/clients/c1/requests/req-1");
    });
  });
});