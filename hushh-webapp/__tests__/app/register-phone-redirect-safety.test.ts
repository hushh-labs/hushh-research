import { describe, expect, it } from "vitest";

import { requiresVaultUnlockForRedirect } from "@/app/register-phone/page";

describe("register phone redirect vault guard", () => {
  it("requires vault unlock for protected app redirects", () => {
    expect(requiresVaultUnlockForRedirect("/kai")).toBe(true);
    expect(requiresVaultUnlockForRedirect("/consents")).toBe(true);
    expect(requiresVaultUnlockForRedirect("/profile/pkm-agent-lab")).toBe(true);
  });

  it("does not require vault unlock for empty or public redirects", () => {
    expect(requiresVaultUnlockForRedirect(null)).toBe(false);
    expect(requiresVaultUnlockForRedirect("")).toBe(false);
    expect(requiresVaultUnlockForRedirect("/login")).toBe(false);
  });
});