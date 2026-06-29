import { describe, expect, it } from "vitest";

import { isRiaRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for isRiaRoute.
 *
 * Implementation (lib/navigation/routes.ts):
 *
 *   export function isRiaRoute(pathname: string): boolean {
 *     return pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`);
 *     // ROUTES.RIA_HOME = "/ria"
 *   }
 *
 * The prefix check is startsWith("/ria/") — with a trailing slash.
 * This is the critical contract: a path like "/ria-admin" shares the "/ria"
 * prefix but is separated by a hyphen, not a slash, so it does NOT match.
 */
describe("isRiaRoute", () => {
  describe("positive cases — RIA routes return true", () => {
    it("returns true for the RIA home route (exact match)", () => {
      expect(isRiaRoute("/ria")).toBe(true);
    });

    it("returns true for a direct child of the RIA home", () => {
      expect(isRiaRoute("/ria/clients")).toBe(true);
    });

    it("returns true for a deeply nested RIA path", () => {
      expect(isRiaRoute("/ria/clients/user-123/accounts")).toBe(true);
    });

    it("returns true for the RIA picks route", () => {
      expect(isRiaRoute("/ria/picks")).toBe(true);
    });
  });

  describe("slash-boundary contract — the critical guard", () => {
    it("returns false for a path that shares the /ria prefix but is separated by a hyphen", () => {
      // startsWith("/ria/") rejects "/ria-admin" — the slash is mandatory
      expect(isRiaRoute("/ria-admin")).toBe(false);
    });

    it("returns false for another hyphen-separated path sharing the /ria prefix", () => {
      expect(isRiaRoute("/ria-dashboard")).toBe(false);
    });
  });

  describe("negative cases — non-RIA routes return false", () => {
    it("returns false for an investor route", () => {
      expect(isRiaRoute("/one/kai")).toBe(false);
    });

    it("returns false for the public home route", () => {
      expect(isRiaRoute("/")).toBe(false);
    });

    it("returns false for an empty string", () => {
      expect(isRiaRoute("")).toBe(false);
    });
  });
});