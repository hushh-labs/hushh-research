/**
 * Characterization tests — resolveConsentRequesterLabel identity resolution
 *
 * Implementation boundary:
 *   lib/consent/consent-display.ts — resolveConsentRequesterLabel
 *
 * Private helper — isTechnicalRequesterIdentity(value):
 *   Returns true when ANY of these hold:
 *   a) normalized starts with "ria:" (case-insensitive)
 *   b) value matches UUID v1–v5 pattern
 *   c) value has no "@", no space, and length >= 20
 *
 * resolveConsentRequesterLabel — three-stage resolution:
 *
 *   STAGE 1 — Friendly label scan
 *     Filter [requesterLabel, counterpartLabel, developer,
 *             counterpartEmail, counterpartSecondaryLabel]
 *     removing any value where isTechnicalRequesterIdentity is true.
 *     Return the first non-empty string from the filtered list.
 *
 *   STAGE 2 — Connected advisor guard (runs only if stage 1 returns null)
 *     if agentId.toLowerCase().startsWith("ria:")
 *       OR isTechnicalRequesterIdentity(counterpartId)  → "Connected advisor"
 *
 *   STAGE 3 — Last-resort
 *     firstNonEmptyLabel([counterpartId, agentId]) || "Requester"
 *
 * Pure string→string; no IO, no state.
 */

import { describe, it, expect } from "vitest";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";

// ---------------------------------------------------------------------------
// Stage 1 — friendly label returned directly
// ---------------------------------------------------------------------------

describe("resolveConsentRequesterLabel — friendly label (stage 1)", () => {
  it("returns requesterLabel directly when it is a short friendly string", () => {
    expect(resolveConsentRequesterLabel({ requesterLabel: "Acme Corp" })).toBe("Acme Corp");
  });

  it("returns counterpartLabel when requesterLabel is absent", () => {
    expect(resolveConsentRequesterLabel({ counterpartLabel: "Friendly Corp" })).toBe(
      "Friendly Corp"
    );
  });

  it("returns developer when requesterLabel and counterpartLabel are absent", () => {
    expect(resolveConsentRequesterLabel({ developer: "My App" })).toBe("My App");
  });

  it("returns counterpartEmail when it is the first non-empty friendly field present", () => {
    expect(resolveConsentRequesterLabel({ counterpartEmail: "advisor@bank.com" })).toBe(
      "advisor@bank.com"
    );
  });

  it("requesterLabel takes priority over counterpartLabel", () => {
    expect(
      resolveConsentRequesterLabel({ requesterLabel: "Alpha", counterpartLabel: "Beta" })
    ).toBe("Alpha");
  });

  it("counterpartLabel takes priority over developer", () => {
    expect(
      resolveConsentRequesterLabel({ counterpartLabel: "Second", developer: "Third" })
    ).toBe("Second");
  });
});

// ---------------------------------------------------------------------------
// Stage 1 — technical identity filtering
// ---------------------------------------------------------------------------

describe("resolveConsentRequesterLabel — technical identity filtering in stage 1", () => {
  it("filters out a UUID requesterLabel and falls through to counterpartLabel", () => {
    expect(
      resolveConsentRequesterLabel({
        requesterLabel: "550e8400-e29b-41d4-a716-446655440000",
        counterpartLabel: "Friendly Corp",
      })
    ).toBe("Friendly Corp");
  });

  it("filters out a 'ria:'-prefixed requesterLabel and falls through to counterpartLabel", () => {
    expect(
      resolveConsentRequesterLabel({
        requesterLabel: "ria:advisor-abc",
        counterpartLabel: "My Advisor",
      })
    ).toBe("My Advisor");
  });

  it("filters out an opaque string (≥20 chars, no @ or space) and falls through to developer", () => {
    // "abcdefghijklmnopqrstu" = 21 chars, no @ or space → isTechnicalRequesterIdentity = true
    expect(
      resolveConsentRequesterLabel({
        counterpartLabel: "abcdefghijklmnopqrstu",
        developer: "Good App",
      })
    ).toBe("Good App");
  });

  it("does NOT filter out an email address even when it is long (@ makes it friendly)", () => {
    expect(
      resolveConsentRequesterLabel({
        counterpartEmail: "verylongadvisorname@institution.com",
      })
    ).toBe("verylongadvisorname@institution.com");
  });

  it("does NOT filter out a string that contains a space, even if it is long", () => {
    expect(
      resolveConsentRequesterLabel({
        requesterLabel: "This is a very long label with spaces",
      })
    ).toBe("This is a very long label with spaces");
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — "Connected advisor" branch
// ---------------------------------------------------------------------------

describe("resolveConsentRequesterLabel — Connected advisor (stage 2)", () => {
  it("returns 'Connected advisor' when agentId starts with 'ria:'", () => {
    expect(resolveConsentRequesterLabel({ agentId: "ria:partner-xyz" })).toBe(
      "Connected advisor"
    );
  });

  it("returns 'Connected advisor' when counterpartId is a UUID", () => {
    expect(
      resolveConsentRequesterLabel({
        counterpartId: "550e8400-e29b-41d4-a716-446655440000",
      })
    ).toBe("Connected advisor");
  });

  it("returns 'Connected advisor' when counterpartId is a long opaque string (≥20 chars, no @ or space)", () => {
    // "opaqueinternalid12345678" = 24 chars, no @ or space
    expect(
      resolveConsentRequesterLabel({ counterpartId: "opaqueinternalid12345678" })
    ).toBe("Connected advisor");
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — last-resort fallback
// ---------------------------------------------------------------------------

describe("resolveConsentRequesterLabel — last-resort fallback (stage 3)", () => {
  it("returns counterpartId when it is a short non-technical string and no stage-1 labels are set", () => {
    // "advisor" = 7 chars, no @ or space → NOT technical → stage 3 returns it
    expect(resolveConsentRequesterLabel({ counterpartId: "advisor" })).toBe("advisor");
  });

  it("returns agentId when counterpartId is absent and agentId is a short non-ria string", () => {
    expect(resolveConsentRequesterLabel({ agentId: "agent-007" })).toBe("agent-007");
  });

  it("returns 'Requester' when all input fields are absent", () => {
    expect(resolveConsentRequesterLabel({})).toBe("Requester");
  });

  it("returns 'Requester' when all fields are explicitly null", () => {
    expect(
      resolveConsentRequesterLabel({
        requesterLabel: null,
        counterpartLabel: null,
        developer: null,
        counterpartEmail: null,
        counterpartSecondaryLabel: null,
        counterpartId: null,
        agentId: null,
      })
    ).toBe("Requester");
  });
});