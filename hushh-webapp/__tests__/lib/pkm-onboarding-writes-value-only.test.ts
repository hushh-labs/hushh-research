import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { isInternalManifestPath } from "@/lib/pkm/internal-path-keys";

/**
 * What the onboarding flow actually leaves behind, and what a person may be
 * asked for afterwards.
 *
 * This blob is not invented. It is the shape `kai-profile-service` and
 * `kai-history-service` write into the `financial` domain, reproduced from
 * their own type declarations (kai-profile-service.ts:31-50, :181-196) and
 * confirmed against a live UAT catalogue that offered 24 rows for one person,
 * of which roughly five were information about anybody.
 *
 * The question this file answers is the founder's, in their words: *why would
 * someone want to know if a person skipped a part of the app.* They would not.
 * So the test is not "does the filter run" -- it is "after onboarding, is
 * everything requestable actually about the person".
 */

/** The financial domain exactly as onboarding leaves it. */
const ONBOARDED_FINANCIAL_BLOB = {
  profile: {
    preferences: {
      // Real answers a person gave.
      risk_profile: "balanced",
      risk_score: 62,
      investment_horizon: "5-10 years",
      drawdown_response: "hold",
      volatility_preference: "moderate",
      // Timestamps OF those answers, written beside them.
      risk_profile_selected_at: "2026-09-01T10:00:00Z",
      investment_horizon_selected_at: "2026-09-01T10:00:04Z",
      investment_horizon_anchor_at: "2026-09-01T10:00:04Z",
      drawdown_response_selected_at: "2026-09-01T10:00:09Z",
      volatility_preference_selected_at: "2026-09-01T10:00:12Z",
    },
    // Pure wizard progress.
    setup: {
      completed: true,
      completed_at: "2026-09-01T10:00:20Z",
      skipped_preferences: false,
      nav_completed_at: "2026-09-01T10:00:21Z",
      // Initialised to null and never set: the step did not happen.
      nav_skipped_at: null,
    },
    // Router telemetry.
    domain_intent: { primary: "financial", secondary: "analysis", source: "onboarding" },
  },
  analysis: {
    domain_intent: { primary: "financial", secondary: null, source: "kai_history" },
  },
  // Ordinary holdings, which must survive untouched.
  portfolio: {
    holdings: { equities: "60%", bonds: "30%", cash: "10%" },
  },
} as const;

function requestablePaths(blob: unknown): string[] {
  const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
    domain: "financial",
    domainData: blob as Record<string, unknown>,
  });
  return (manifest.paths || [])
    .filter((descriptor) => descriptor.exposure_eligibility)
    .map((descriptor) => descriptor.json_path);
}

describe("what onboarding leaves requestable", () => {
  const paths = requestablePaths(ONBOARDED_FINANCIAL_BLOB);

  it("keeps every real answer the person gave", () => {
    // The half that matters most. A filter that eats the signal is worse than
    // no filter, so this runs first.
    for (const kept of [
      "profile.preferences.risk_profile",
      "profile.preferences.risk_score",
      "profile.preferences.investment_horizon",
      "profile.preferences.drawdown_response",
      "profile.preferences.volatility_preference",
      "portfolio.holdings.equities",
      "portfolio.holdings.bonds",
      "portfolio.holdings.cash",
    ]) {
      expect(paths, `${kept} is information about the person`).toContain(kept);
    }
  });

  it("never offers whether someone finished or skipped a step in the app", () => {
    // The founder's question, as an assertion.
    for (const path of paths) {
      expect(path, `${path} describes the app, not the person`).not.toMatch(
        /(^|\.)setup(\.|$)/,
      );
    }
  });

  it("never offers router telemetry, however deeply it is nested", () => {
    // The exact near-miss: the catalogue filter knew `domain_intent` was
    // structural and only ever compared a depth-1 segment, so
    // `profile.domain_intent.primary` published while `domain_intent` did not.
    for (const path of paths) {
      expect(path, `${path} is routing telemetry`).not.toContain("domain_intent");
    }
  });

  it("does not list the timestamp of an answer beside the answer", () => {
    // Three rows for one fact is what read to the founder as duplicates:
    // Investment Horizon, Investment Horizon Selected At, Investment Horizon
    // Anchor At.
    for (const path of paths) {
      expect(path).not.toMatch(/_(selected|anchor)_at$/);
    }
  });

  it("does not offer a field that was never set", () => {
    // `nav_skipped_at: null` is a step that did not happen. It reached the
    // catalogue because the walker returned early only on `undefined`.
    expect(paths).not.toContain("profile.setup.nav_skipped_at");
  });

  it("turns 24 stored leaves into 8 things worth asking for", () => {
    // Measured, not estimated. This blob produces 24 leaves -- the exact count
    // the founder's live capture showed for one person's financial domain --
    // and 8 survive: three holdings and the five preferences they actually
    // answered. The other 16 are six domain_intent rows, five answer
    // timestamps, and five setup checkpoints.
    //
    // Pinned as numbers because a ratio alone would still pass if the signal
    // disappeared alongside the noise.
    const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: ONBOARDED_FINANCIAL_BLOB as unknown as Record<string, unknown>,
    });
    const leaves = (manifest.paths || []).filter((d) => d.path_type === "leaf");
    expect(leaves.length).toBe(24);
    expect(paths.length).toBe(8);
  });

  it("leaves a catalogue that is mostly signal", () => {
    // The measured baseline was ~5 useful rows out of 24, and a later capture
    // of the same person's financial domain showed 50. A ratio, not a count,
    // so this keeps meaning something as real records grow.
    const useful = paths.filter((path) => !isInternalManifestPath(path));
    expect(paths.length).toBeGreaterThan(0);
    expect(useful.length / paths.length).toBe(1);
  });
});
