import { describe, expect, it } from "vitest";

import { isPublicRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for isPublicRoute.
 *
 * Implementation (lib/navigation/routes.ts):
 *
 *   export function isPublicRoute(pathname: string): boolean {
 *     return (
 *       pathname === ROUTES.HOME ||              // "/"
 *       pathname === ROUTES.DEVELOPERS ||        // "/developers"
 *       pathname === ROUTES.LOGIN ||             // "/login"
 *       pathname === ROUTES.PHONE_MANDATE ||     // "/register-phone"
 *       pathname === ROUTES.LOGOUT ||            // "/logout"
 *       pathname === ROUTES.PROFILE ||           // "/profile"
 *       pathname.startsWith(`${ROUTES.ONE_LOCATION}/request/`)  // "/one/location/request/*"
 *     );
 *   }
 *
 * Six exact-equality checks plus one startsWith prefix check.
 * Critical contract: children of the six exact-match routes are NOT public —
 * only the listed paths themselves match. The sole exception is the
 * /one/location/request/* prefix, which is open-ended.
 */
describe("isPublicRoute", () => {
  describe("exact-match public routes", () => {
    it("returns true for the home route", () => {
      expect(isPublicRoute("/")).toBe(true);
    });

    it("returns true for the developers route", () => {
      expect(isPublicRoute("/developers")).toBe(true);
    });

    it("returns true for the login route", () => {
      expect(isPublicRoute("/login")).toBe(true);
    });

    it("returns true for the phone mandate route", () => {
      expect(isPublicRoute("/register-phone")).toBe(true);
    });

    it("returns true for the logout route", () => {
      expect(isPublicRoute("/logout")).toBe(true);
    });

    it("returns true for the profile route", () => {
      expect(isPublicRoute("/profile")).toBe(true);
    });
  });

  describe("prefix-match public route — /one/location/request/*", () => {
    it("returns true for a direct path under /one/location/request/", () => {
      expect(isPublicRoute("/one/location/request/abc-123")).toBe(true);
    });

    it("returns true for a nested path under /one/location/request/", () => {
      expect(isPublicRoute("/one/location/request/abc-123/confirm")).toBe(true);
    });

    it("returns false for /one/location without the /request/ segment", () => {
      expect(isPublicRoute("/one/location")).toBe(false);
    });

    it("returns false for /one/location/request without a trailing slash and segment", () => {
      // startsWith("/one/location/request/") requires the trailing slash
      expect(isPublicRoute("/one/location/request")).toBe(false);
    });
  });

  describe("exact-match boundary — children of exact-match routes are NOT public", () => {
    it("returns false for a path under /profile", () => {
      expect(isPublicRoute("/profile/settings")).toBe(false);
    });

    it("returns false for a path under /developers", () => {
      expect(isPublicRoute("/developers/docs")).toBe(false);
    });
  });

  describe("authenticated routes — return false", () => {
    it("returns false for the RIA home route", () => {
      expect(isPublicRoute("/ria")).toBe(false);
    });

    it("returns false for the investor KAI home route", () => {
      expect(isPublicRoute("/one/kai")).toBe(false);
    });

    it("returns false for the ONE home route", () => {
      expect(isPublicRoute("/one")).toBe(false);
    });
  });
});