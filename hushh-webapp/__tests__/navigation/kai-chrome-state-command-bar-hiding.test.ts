import { describe, expect, it } from "vitest";

import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests: getKaiChromeState — command-bar hiding routes
 *
 * Implementation boundary (kai-chrome-state.ts):
 *
 *   const path = pathname ?? "";
 *
 *   const hideCommandBar =
 *     useOnboardingChrome          ||   // covered by existing tests
 *     path === ROUTES.HOME         ||   // exact equality "/"
 *     path === ROUTES.AGENT        ||   // exact equality "/agent"
 *     path.startsWith(ROUTES.LOGIN)          ||   // covered by existing tests
 *     path.startsWith(ROUTES.PHONE_MANDATE)  ||   // "/register-phone"
 *     path.startsWith(ROUTES.LOGOUT)         ||   // "/logout"
 *     path.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||  // "/labs/profile-appearance"
 *     isRiaOnboardingRoute(path);      // covered by existing tests
 *
 * This file covers the five branches NOT addressed by the existing
 * kai-chrome-state.test.ts:
 *   ROUTES.HOME, ROUTES.AGENT, ROUTES.PHONE_MANDATE, ROUTES.LOGOUT,
 *   ROUTES.LABS_PROFILE_APPEARANCE, and null/undefined pathname coalescing.
 *
 * All tests pass onboardingFlowActive: false to isolate each branch from the
 * useOnboardingChrome flag. hideBottomNav is always === hideCommandBar per
 * implementation; that invariant is verified where relevant.
 */

describe("getKaiChromeState — command-bar hiding routes", () => {
  describe("ROUTES.HOME ('/') hides the command bar via exact equality", () => {
    it("sets hideCommandBar to true for the root path", () => {
      const state = getKaiChromeState(ROUTES.HOME, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(true);
    });

    it("sets hideBottomNav to true for the root path", () => {
      const state = getKaiChromeState(ROUTES.HOME, {
        onboardingFlowActive: false,
      });
      expect(state.hideBottomNav).toBe(true);
    });

    it("does not treat a non-root path as home", () => {
      const state = getKaiChromeState("/other", {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(false);
    });
  });

  describe("ROUTES.AGENT ('/agent') hides the command bar via exact equality", () => {
    it("sets hideCommandBar to true for the agent path", () => {
      const state = getKaiChromeState(ROUTES.AGENT, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(true);
    });

    it("sets hideBottomNav to true for the agent path", () => {
      const state = getKaiChromeState(ROUTES.AGENT, {
        onboardingFlowActive: false,
      });
      expect(state.hideBottomNav).toBe(true);
    });
  });

  describe("ROUTES.PHONE_MANDATE ('/register-phone') hides via startsWith", () => {
    it("sets hideCommandBar to true for the exact phone mandate path", () => {
      const state = getKaiChromeState(ROUTES.PHONE_MANDATE, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(true);
    });

    it("sets hideCommandBar to true for a path nested under phone mandate", () => {
      const state = getKaiChromeState(`${ROUTES.PHONE_MANDATE}/verify`, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(true);
    });
  });

  describe("ROUTES.LOGOUT ('/logout') hides via startsWith", () => {
    it("sets hideCommandBar to true for the logout path", () => {
      const state = getKaiChromeState(ROUTES.LOGOUT, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(true);
    });
  });

  describe("ROUTES.LABS_PROFILE_APPEARANCE ('/labs/profile-appearance') hides via startsWith", () => {
    it("sets hideCommandBar to true for the exact labs profile appearance path", () => {
      const state = getKaiChromeState(ROUTES.LABS_PROFILE_APPEARANCE, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(true);
    });

    it("sets hideCommandBar to true for a path nested under labs profile appearance", () => {
      const state = getKaiChromeState(
        `${ROUTES.LABS_PROFILE_APPEARANCE}/settings`,
        { onboardingFlowActive: false },
      );
      expect(state.hideCommandBar).toBe(true);
    });
  });

  describe("null and undefined pathname coalesce to empty string — no crash, no hiding", () => {
    it("does not throw for null pathname and returns hideCommandBar false", () => {
      const state = getKaiChromeState(null, { onboardingFlowActive: false });
      expect(state.hideCommandBar).toBe(false);
    });

    it("does not throw for undefined pathname and returns hideCommandBar false", () => {
      const state = getKaiChromeState(undefined, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(false);
    });

    it("returns a complete KaiChromeState shape for null pathname", () => {
      const state = getKaiChromeState(null, { onboardingFlowActive: false });
      expect(state.isOnboardingRoute).toBe(false);
      expect(state.isImportRoute).toBe(false);
      expect(state.useOnboardingChrome).toBe(false);
      expect(state.hideBottomNav).toBe(false);
    });
  });

  describe("routes unaffected by this set of conditions", () => {
    it("does not hide the command bar for the ria home route", () => {
      const state = getKaiChromeState(ROUTES.RIA_HOME, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(false);
    });

    it("does not hide the command bar for the ria clients route", () => {
      const state = getKaiChromeState(ROUTES.RIA_CLIENTS, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(false);
    });

    it("does not hide the command bar for the profile route", () => {
      const state = getKaiChromeState(ROUTES.PROFILE, {
        onboardingFlowActive: false,
      });
      expect(state.hideCommandBar).toBe(false);
    });
  });
});