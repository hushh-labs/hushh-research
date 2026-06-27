/**
 * Characterization tests — resolveConsentSupportingCopy fallback chain
 *                         + resolveCompactConsentSummary
 *
 * Implementation boundary:
 *   lib/consent/consent-display.ts
 *   resolveConsentSupportingCopy, resolveCompactConsentSummary
 *
 * resolveConsentSupportingCopy — priority waterfall (truthy checks):
 *   1. additionalAccessSummary (truthy)  → return verbatim
 *   2. scopeDescription        (truthy)  → return verbatim
 *   3. reason                  (truthy)  → return verbatim
 *   4. kind === "invite"                 → "Invitation waiting for investor approval."
 *   5. isScopeUpgrade && existingGrantedScopes.length > 0
 *                                        → "Additional access is requested beyond
 *                                            what is already approved."
 *   6. fallback                          → humanizeConsentScope(scope)
 *
 * resolveCompactConsentSummary — separate, shorter waterfall:
 *   1. kind === "invite"    → "Relationship request pending review."
 *   2. isScopeUpgrade       → "Additional access request pending review."
 *      (no existingGrantedScopes check — differs from resolveConsentSupportingCopy)
 *   3. fallback             → humanizeConsentScope(scope)
 *
 * Both are pure input→output; no IO, no state.
 */

import { describe, it, expect } from "vitest";
import {
  resolveConsentSupportingCopy,
  resolveCompactConsentSummary,
} from "@/lib/consent/consent-display";

// ---------------------------------------------------------------------------
// resolveConsentSupportingCopy — priority waterfall
// ---------------------------------------------------------------------------

describe("resolveConsentSupportingCopy — additionalAccessSummary (priority 1)", () => {
  it("returns additionalAccessSummary verbatim when it is present", () => {
    expect(resolveConsentSupportingCopy({ additionalAccessSummary: "Custom summary" })).toBe(
      "Custom summary"
    );
  });

  it("additionalAccessSummary takes precedence over scopeDescription and reason", () => {
    expect(
      resolveConsentSupportingCopy({
        additionalAccessSummary: "First",
        scopeDescription: "Second",
        reason: "Third",
      })
    ).toBe("First");
  });

  it("does NOT short-circuit on an empty additionalAccessSummary (truthy check — empty string is falsy)", () => {
    expect(
      resolveConsentSupportingCopy({
        additionalAccessSummary: "",
        scopeDescription: "Fallback description",
      })
    ).toBe("Fallback description");
  });
});

describe("resolveConsentSupportingCopy — scopeDescription (priority 2)", () => {
  it("returns scopeDescription verbatim when additionalAccessSummary is absent", () => {
    expect(resolveConsentSupportingCopy({ scopeDescription: "Scope description" })).toBe(
      "Scope description"
    );
  });

  it("scopeDescription takes precedence over reason", () => {
    expect(
      resolveConsentSupportingCopy({
        scopeDescription: "Scope desc",
        reason: "Some reason",
      })
    ).toBe("Scope desc");
  });
});

describe("resolveConsentSupportingCopy — reason (priority 3)", () => {
  it("returns reason verbatim when additionalAccessSummary and scopeDescription are absent", () => {
    expect(resolveConsentSupportingCopy({ reason: "Access needed" })).toBe("Access needed");
  });
});

describe("resolveConsentSupportingCopy — kind === 'invite' (priority 4)", () => {
  it("returns the invite message when kind is 'invite' and no higher-priority field is set", () => {
    expect(resolveConsentSupportingCopy({ kind: "invite" })).toBe(
      "Invitation waiting for investor approval."
    );
  });

  it("returns the invite message even when scope is present (kind check precedes humanizeConsentScope)", () => {
    expect(
      resolveConsentSupportingCopy({ kind: "invite", scope: "vault.owner" })
    ).toBe("Invitation waiting for investor approval.");
  });
});

describe("resolveConsentSupportingCopy — scope upgrade (priority 5)", () => {
  it("returns the scope upgrade message when isScopeUpgrade is true and existingGrantedScopes is non-empty", () => {
    expect(
      resolveConsentSupportingCopy({
        isScopeUpgrade: true,
        existingGrantedScopes: ["vault.read"],
      })
    ).toBe("Additional access is requested beyond what is already approved.");
  });

  it("falls through to humanizeConsentScope when isScopeUpgrade is true but existingGrantedScopes is empty", () => {
    expect(
      resolveConsentSupportingCopy({
        isScopeUpgrade: true,
        existingGrantedScopes: [],
        scope: "pkm.read",
      })
    ).toBe("Personal Knowledge Model access");
  });

  it("falls through to humanizeConsentScope when isScopeUpgrade is true but existingGrantedScopes is absent", () => {
    expect(
      resolveConsentSupportingCopy({
        isScopeUpgrade: true,
        scope: "vault.owner",
      })
    ).toBe("Full vault access");
  });
});

describe("resolveConsentSupportingCopy — humanizeConsentScope fallback (priority 6)", () => {
  it("returns the humanized scope label when no other field triggers an earlier branch", () => {
    expect(resolveConsentSupportingCopy({ scope: "pkm.read" })).toBe(
      "Personal Knowledge Model access"
    );
  });

  it("returns 'Consent request' from humanizeConsentScope when the input is entirely empty", () => {
    expect(resolveConsentSupportingCopy({})).toBe("Consent request");
  });
});

// ---------------------------------------------------------------------------
// resolveCompactConsentSummary — separate waterfall
// ---------------------------------------------------------------------------

describe("resolveCompactConsentSummary — kind === 'invite' (priority 1)", () => {
  it("returns the compact invite message when kind is 'invite'", () => {
    expect(resolveCompactConsentSummary({ kind: "invite" })).toBe(
      "Relationship request pending review."
    );
  });

  it("kind 'invite' takes precedence over isScopeUpgrade", () => {
    expect(
      resolveCompactConsentSummary({ kind: "invite", isScopeUpgrade: true })
    ).toBe("Relationship request pending review.");
  });
});

describe("resolveCompactConsentSummary — isScopeUpgrade (priority 2)", () => {
  it("returns the compact scope upgrade message when isScopeUpgrade is true", () => {
    // NOTE: unlike resolveConsentSupportingCopy, this branch does NOT require
    // existingGrantedScopes to be non-empty.
    expect(resolveCompactConsentSummary({ isScopeUpgrade: true })).toBe(
      "Additional access request pending review."
    );
  });

  it("returns the compact scope upgrade message even when existingGrantedScopes is empty", () => {
    expect(
      resolveCompactConsentSummary({ isScopeUpgrade: true, existingGrantedScopes: [] })
    ).toBe("Additional access request pending review.");
  });
});

describe("resolveCompactConsentSummary — humanizeConsentScope fallback", () => {
  it("falls through to humanizeConsentScope for a known literal scope", () => {
    expect(resolveCompactConsentSummary({ scope: "pkm.write" })).toBe(
      "Personal Knowledge Model updates"
    );
  });

  it("returns 'Consent request' when the input is entirely empty", () => {
    expect(resolveCompactConsentSummary({})).toBe("Consent request");
  });
});