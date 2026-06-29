import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the null-return paths of resolveTopShellBreadcrumb.
 *
 * Implementation boundaries (top-shell-breadcrumbs.ts):
 *
 * Two independent null-return sites exist:
 *
 * (A) Non-profile routes that fall through all named branches:
 *
 *   if (!pathname.startsWith(`${ROUTES.PROFILE}/`)) {
 *     return null;
 *   }
 *
 *   This guard fires for any pathname that:
 *   - is not handled by an earlier named branch (KAI_ANALYSIS, KAI_HOME,
 *     ONE_ONBOARDING, RIA_CLIENTS, CONSENTS, ONE_KYC, ONE_LOCATION, GMAIL,
 *     PKM, CONNECTED_SYSTEMS, MARKETPLACE_CONNECTIONS, PROFILE), and
 *   - does not start with "/profile/".
 *
 * (B) ROUTES.PROFILE with no recognized panel:
 *
 *   if (pathname === ROUTES.PROFILE) {
 *     const panel = profilePanelFromParams(searchParams); // may return ""
 *     const panelLabel = profilePanelLabel(panel);        // returns null for unknown/empty
 *     if (!panelLabel) {
 *       return null;
 *     }
 *     ...
 *   }
 *
 *   profilePanelLabel only recognizes: "account", "my-data", "access",
 *   "connected-systems", "preferences", "security", "support", "gmail".
 *   Any other value (including "") → null.
 *
 * Why behavior is guaranteed:
 * - The if-chain is exhaustive and has no default positive return.
 * - `||` in profilePanelFromParams is falsy-coalescing: null.get() → null,
 *   `null || ""` → "", trimmed → "" which is falsy → falls to tab check.
 * - Hard-coded string comparisons in profilePanelLabel produce null for any
 *   unrecognized input including the empty string.
 */
describe("resolveTopShellBreadcrumb — null-return paths", () => {
  describe("(A) routes not covered by any named branch", () => {
    it("returns null for ROUTES.AGENT (/agent) — no breadcrumb branch handles it", () => {
      expect(resolveTopShellBreadcrumb(ROUTES.AGENT)).toBeNull();
    });

    it("returns null for ROUTES.MARKETPLACE (/marketplace) — only /marketplace/connections is handled", () => {
      expect(resolveTopShellBreadcrumb(ROUTES.MARKETPLACE)).toBeNull();
    });

    it("returns null for ROUTES.ONE_HOME (/one) — the dashboard has no top-shell breadcrumb", () => {
      expect(resolveTopShellBreadcrumb(ROUTES.ONE_HOME)).toBeNull();
    });

    it("returns null for ROUTES.RIA_HOME (/ria) — only /ria/clients and its children are handled", () => {
      expect(resolveTopShellBreadcrumb(ROUTES.RIA_HOME)).toBeNull();
    });
  });

  describe("(B) ROUTES.PROFILE with no recognized panel", () => {
    it("returns null when searchParams is omitted entirely", () => {
      // profilePanelFromParams(undefined): panel="" (null||""), tab="" → returns ""
      // profilePanelLabel("") → null → !panelLabel → return null
      expect(resolveTopShellBreadcrumb(ROUTES.PROFILE)).toBeNull();
    });

    it("returns null when searchParams has no panel or tab param", () => {
      expect(
        resolveTopShellBreadcrumb(ROUTES.PROFILE, new URLSearchParams()),
      ).toBeNull();
    });

    it("returns null when panel param is a string not in the recognized set", () => {
      // "unknown-panel" passes the truthy panel check but profilePanelLabel returns null
      expect(
        resolveTopShellBreadcrumb(
          ROUTES.PROFILE,
          new URLSearchParams("panel=unknown-panel"),
        ),
      ).toBeNull();
    });

    it("returns null when tab is present but is not the legacy privacy remap and is not a recognized panel", () => {
      // tab="unknown" → not "privacy" → passes through as panel name "unknown"
      // profilePanelLabel("unknown") → null
      expect(
        resolveTopShellBreadcrumb(
          ROUTES.PROFILE,
          new URLSearchParams("tab=unknown"),
        ),
      ).toBeNull();
    });
  });
});