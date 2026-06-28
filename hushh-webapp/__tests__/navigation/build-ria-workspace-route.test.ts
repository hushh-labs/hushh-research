import { describe, expect, it } from "vitest";

import {
  buildRiaClientWorkspaceRoute,
  buildRiaWorkspaceRoute,
} from "@/lib/navigation/routes";

/**
 * Characterization tests for buildRiaWorkspaceRoute.
 *
 * Implementation boundary (routes.ts):
 *
 *   export function buildRiaWorkspaceRoute(
 *     clientId?: string | null,
 *     entries?: { tab?: ...; testProfile?: boolean | null }
 *   ) {
 *     return buildRiaClientWorkspaceRoute(clientId, entries);
 *   }
 *
 * Truth-first:
 *   - buildRiaWorkspaceRoute is a direct delegating alias.  Its body contains
 *     a single return statement that forwards both arguments unchanged to
 *     buildRiaClientWorkspaceRoute.  No transformation, no default injection.
 *   - For every possible (clientId, entries) pair the two functions produce
 *     byte-for-byte identical output.
 *   - The fallback contract (null / undefined / whitespace clientId → ROUTES.RIA_CLIENTS)
 *     is inherited from buildRiaClientWorkspaceRoute via delegation.
 */
describe("buildRiaWorkspaceRoute alias passthrough contract", () => {
  describe("output identity with buildRiaClientWorkspaceRoute", () => {
    it("produces the same output when called with no arguments", () => {
      expect(buildRiaWorkspaceRoute()).toBe(buildRiaClientWorkspaceRoute());
    });

    it("produces the same output for null clientId", () => {
      expect(buildRiaWorkspaceRoute(null)).toBe(buildRiaClientWorkspaceRoute(null));
    });

    it("produces the same output for undefined clientId", () => {
      expect(buildRiaWorkspaceRoute(undefined)).toBe(
        buildRiaClientWorkspaceRoute(undefined)
      );
    });

    it("produces the same output for a plain clientId", () => {
      expect(buildRiaWorkspaceRoute("client-1")).toBe(
        buildRiaClientWorkspaceRoute("client-1")
      );
    });

    it("produces the same output when a tab entry is supplied", () => {
      expect(buildRiaWorkspaceRoute("client-1", { tab: "kai" })).toBe(
        buildRiaClientWorkspaceRoute("client-1", { tab: "kai" })
      );
    });

    it("produces the same output when testProfile is true", () => {
      expect(buildRiaWorkspaceRoute("client-1", { testProfile: true })).toBe(
        buildRiaClientWorkspaceRoute("client-1", { testProfile: true })
      );
    });

    it("produces the same output when both tab and testProfile are provided", () => {
      expect(
        buildRiaWorkspaceRoute("client-1", { tab: "access", testProfile: true })
      ).toBe(
        buildRiaClientWorkspaceRoute("client-1", { tab: "access", testProfile: true })
      );
    });
  });

  describe("inherited fallback — null clientId resolves to RIA_CLIENTS", () => {
    it("returns /ria/clients for null via delegation", () => {
      expect(buildRiaWorkspaceRoute(null)).toBe("/ria/clients");
    });

    it("returns /ria/clients when called with no arguments via delegation", () => {
      expect(buildRiaWorkspaceRoute()).toBe("/ria/clients");
    });
  });

  describe("inherited workspace route shape", () => {
    it("produces the expected path and tab param for a valid clientId", () => {
      expect(buildRiaWorkspaceRoute("client-1", { tab: "kai" })).toBe(
        "/ria/clients/client-1?tab=kai"
      );
    });

    it("produces the expected test_profile flag via delegation", () => {
      expect(buildRiaWorkspaceRoute("client-1", { testProfile: true })).toBe(
        "/ria/clients/client-1?test_profile=1"
      );
    });
  });
});