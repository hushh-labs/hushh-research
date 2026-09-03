import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  type KaiActionDefinition,
} from "@/lib/voice/kai-action-gateway";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

/**
 * contracts/kai/capability-guard-coverage.v1.json is the registry of every
 * valid guard_id -- generate-kai-action-gateway.mjs already fails the build
 * if a contract uses a guard_id that isn't a key in it. What that registry
 * does NOT prove is that a "kind": "projection" guard (client-checkable) is
 * actually checked anywhere. #6437 found two that were registered, used on
 * real allow_direct/confirm_required RIA actions, and enforced nowhere --
 * evaluateKaiActionAvailability's guard loop had no branch for either
 * string, so the action just evaluated as available.
 *
 * This test proves each "projection" guard genuinely blocks by exercising
 * evaluateKaiActionAvailability's real behavior, not by inspecting source
 * text -- a guard could be present as a string in the function without ever
 * being reachable, and that would still pass a source-text check.
 */

const coveragePath = resolve(
  process.cwd(),
  "contracts/kai/capability-guard-coverage.v1.json",
);
const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as {
  guards: Record<string, { kind: string; predicate?: string; validator?: string }>;
};

const projectionGuardIds = Object.entries(coverage.guards)
  .filter(([, entry]) => entry.kind === "projection")
  .map(([guardId]) => guardId)
  .sort();

// A real, currently-unguarded, single-persona, wired allow_direct action --
// cloned per test with only guard_ids replaced, so every other field stays
// exactly as authored instead of a hand-built fixture drifting from the
// real contract shape.
const BASE_ACTION = getKaiActionById("route.kai_analysis");

function withGuard(guardId: string): KaiActionDefinition {
  if (!BASE_ACTION) {
    throw new Error(
      "route.kai_analysis is missing from the generated gateway -- fixture base no longer valid",
    );
  }
  return { ...BASE_ACTION, guard_ids: [guardId] };
}

// Every condition satisfied -- signed in, vault unlocked, portfolio present,
// no analysis running, both personas available, Gmail connected+configured.
// Each test below flips exactly the one field its guard is documented to
// gate, so a failure isolates to that guard rather than a shared fixture bug.
const PASSING_STATE: AppRuntimeState = {
  auth: { signed_in: true, user_id: "test-user" },
  vault: { unlocked: true, token_available: true, token_valid: true },
  route: { pathname: "/one/kai", screen: "kai_analysis" },
  runtime: {
    analysis_active: false,
    import_active: false,
    busy_operations: [],
  },
  portfolio: { has_portfolio_data: true },
  persona: {
    active: "investor",
    primary_nav: "investor",
    available: ["investor", "ria"],
    ria_switch_available: true,
    ria_setup_available: true,
  },
  voice: { available: true, tts_playing: false },
};

const PASSING_SURFACE_METADATA: VoiceSurfaceMetadata = {
  screenMetadata: { gmail_connected: true, gmail_configured: true },
};

// One targeted failing override per confirmed-implemented guard, plus a
// `passingOverride` only where PASSING_STATE's own default doesn't already
// satisfy that guard (active_analysis_required needs analysis_active: true
// to be satisfied, but analysis_idle_required needs the opposite -- they
// can't share one default). A guard with no entry here has no known way to
// make it block -- see the .todo block below instead of silently skipping.
const FAILING_OVERRIDE: Record<
  string,
  {
    state?: Partial<AppRuntimeState>;
    surfaceMetadata?: VoiceSurfaceMetadata;
    passingOverride?: Partial<AppRuntimeState>;
  }
> = {
  auth_signed_in: { state: { auth: { signed_in: false, user_id: null } } },
  auth_required: { state: { auth: { signed_in: false, user_id: null } } },
  vault_unlocked: {
    state: { vault: { unlocked: false, token_available: false, token_valid: false } },
  },
  portfolio_required: { state: { portfolio: { has_portfolio_data: false } } },
  analysis_idle_required: {
    state: {
      runtime: { analysis_active: true, import_active: false, busy_operations: [] },
    },
  },
  active_analysis_required: {
    state: {
      runtime: { analysis_active: false, import_active: false, busy_operations: [] },
    },
    passingOverride: {
      runtime: { analysis_active: true, import_active: false, busy_operations: [] },
    },
  },
  gmail_connected: {
    surfaceMetadata: { screenMetadata: { gmail_connected: false, gmail_configured: true } },
  },
  gmail_configured: {
    surfaceMetadata: { screenMetadata: { gmail_connected: true, gmail_configured: false } },
  },
  ria_persona_available: {
    state: {
      persona: {
        active: "investor",
        primary_nav: "investor",
        available: ["investor"],
        ria_switch_available: false,
        ria_setup_available: false,
      },
    },
  },
};

// Registered as "projection" (client-checkable) but with no known way to
// make them block today -- see #6437. Kept as .todo rather than omitted so
// the gap stays visible in test output instead of silently disappearing,
// and so fixing #6437 has an exact test to un-skip.
const KNOWN_UNENFORCED_PROJECTION_GUARDS = new Set([
  "consent_center_available",
  "ria_onboarding_complete",
]);

// Registered as "projection" but confirmed, separately from #6437, to be
// either unused by any live action today (active_persona_investor/_ria --
// no action currently declares them, so there is nothing to regress) or
// structurally redundant (vault_owner_token is a required parameter on the
// underlying backend calls regardless of any named guard check, so its
// absence here does not open a bypass). Not bugs -- just not testable the
// same way as a guard something actually depends on.
const KNOWN_UNUSED_OR_REDUNDANT_PROJECTION_GUARDS = new Set([
  "active_persona_investor",
  "active_persona_ria",
  "vault_owner_token",
]);

describe("capability-guard-coverage: every registered projection guard actually blocks", () => {
  it("found a non-trivial set of projection guards to check (sanity)", () => {
    expect(projectionGuardIds.length).toBeGreaterThan(5);
  });

  it("route.kai_analysis fixture base resolved from the generated gateway", () => {
    expect(BASE_ACTION).not.toBeNull();
  });

  for (const guardId of projectionGuardIds) {
    if (KNOWN_UNENFORCED_PROJECTION_GUARDS.has(guardId)) {
      it.todo(`"${guardId}" is registered as projection but never enforced -- see #6437`);
      continue;
    }
    if (KNOWN_UNUSED_OR_REDUNDANT_PROJECTION_GUARDS.has(guardId)) {
      continue;
    }

    const override = FAILING_OVERRIDE[guardId];
    if (!override) {
      // A new "projection" guard landed in the coverage registry with no
      // corresponding entry here. Fail loudly instead of silently passing --
      // either add its failing-state override above, or if it's a known
      // gap like the two above, add it to KNOWN_UNENFORCED_PROJECTION_GUARDS
      // with a linked issue, but never let a new guard go unverified by
      // default.
      it(`"${guardId}" has a known failing-state override to test against`, () => {
        expect(
          override,
          `"${guardId}" is a new "projection" guard with no test coverage in this file. ` +
            `Add a FAILING_OVERRIDE entry (preferred) or add it to ` +
            `KNOWN_UNENFORCED_PROJECTION_GUARDS with a linked issue if it's a known gap.`,
        ).toBeDefined();
      });
      continue;
    }

    it(`"${guardId}" blocks when its documented condition is unmet`, () => {
      const result = evaluateKaiActionAvailability({
        action: withGuard(guardId),
        appRuntimeState: { ...PASSING_STATE, ...override.state },
        surfaceMetadata: override.surfaceMetadata ?? PASSING_SURFACE_METADATA,
      });
      expect(
        result.status,
        `guard "${guardId}" is registered as client-enforceable in ` +
          `capability-guard-coverage.v1.json but evaluateKaiActionAvailability ` +
          `returned "${result.status}" instead of blocking it`,
      ).not.toBe("available");
    });

    it(`"${guardId}" allows the same action when its condition is satisfied`, () => {
      const result = evaluateKaiActionAvailability({
        action: withGuard(guardId),
        appRuntimeState: { ...PASSING_STATE, ...override.passingOverride },
        surfaceMetadata: PASSING_SURFACE_METADATA,
      });
      expect(
        result.status,
        `guard "${guardId}" blocked a fully-passing state -- either the ` +
          `guard or this test's PASSING_STATE fixture is wrong`,
      ).toBe("available");
    });
  }
});
