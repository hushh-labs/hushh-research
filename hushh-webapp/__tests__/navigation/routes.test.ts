import { describe, expect, it } from "vitest";

import {
  buildRiaClientAccountRoute,
  buildRiaClientRequestRoute,
  buildRiaClientWorkspaceRoute,
  isKaiOnboardingRoute,
  isPublicRoute,
  isRiaRoute,
} from "@/lib/navigation/routes";



describe("navigation routes", () => {
  it("preserves query parameter integrity for ria workspace tabs", () => {
    expect(buildRiaClientWorkspaceRoute("client-123", { tab: "kai" })).toBe(
      "/ria/clients/client-123?tab=kai"
    );

    expect(buildRiaClientWorkspaceRoute("client 123", { tab: "access" })).toBe(
      "/ria/clients/client%20123?tab=access"
    );
  });

  it("preserves encoded route segments for ria account and request routes", () => {
    expect(buildRiaClientAccountRoute("client 123", "acct 456")).toBe(
      "/ria/clients/client%20123/accounts/acct%20456"
    );

    expect(buildRiaClientRequestRoute("client 123", "request 789")).toBe(
      "/ria/clients/client%20123/requests/request%20789"
    );
  });
    it("preserves public route classification stability", () => {
    expect(isPublicRoute("/")).toBe(true);
    expect(isPublicRoute("/developers")).toBe(true);
    expect(isPublicRoute("/login")).toBe(true);

    expect(isPublicRoute("/ria")).toBe(false);
    expect(isPublicRoute("/kai")).toBe(false);
  });

  it("preserves ria route classification for nested workspace paths", () => {
    expect(isRiaRoute("/ria")).toBe(true);
    expect(isRiaRoute("/ria/clients")).toBe(true);
    expect(isRiaRoute("/ria/clients/client-123")).toBe(true);

    expect(isRiaRoute("/kai")).toBe(false);
  });

  it("preserves kai onboarding route detection for nested onboarding paths", () => {
    expect(isKaiOnboardingRoute("/kai/onboarding")).toBe(true);
    expect(isKaiOnboardingRoute("/kai/onboarding/complete")).toBe(true);

    expect(isKaiOnboardingRoute("/kai")).toBe(false);
  });
});