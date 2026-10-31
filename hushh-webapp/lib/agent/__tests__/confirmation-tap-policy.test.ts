import { describe, expect, it } from "vitest";

import { requiresHardTapConfirmation } from "@/lib/agent/confirmation-tap-policy";

describe("requiresHardTapConfirmation", () => {
  it("forces a real tap for trusted_activation_required regardless of the preference", () => {
    const action = {
      activation_policy: "trusted_activation_required" as const,
      execution_policy: "confirm_required" as const,
    };
    expect(requiresHardTapConfirmation(action, false)).toBe(true);
    expect(requiresHardTapConfirmation(action, true)).toBe(true);
  });

  it("forces a real tap for confirm_required only when the person opted in", () => {
    const action = {
      activation_policy: "none" as const,
      execution_policy: "confirm_required" as const,
    };
    expect(requiresHardTapConfirmation(action, true)).toBe(true);
    expect(requiresHardTapConfirmation(action, false)).toBe(false);
  });

  it("never forces a tap for allow_direct, whatever the preference says", () => {
    const action = {
      activation_policy: "none" as const,
      execution_policy: "allow_direct" as const,
    };
    expect(requiresHardTapConfirmation(action, true)).toBe(false);
    expect(requiresHardTapConfirmation(action, false)).toBe(false);
  });

  it("never forces a tap for manual_only, whatever the preference says", () => {
    // manual_only never reaches a confirmation card at all in practice, but
    // the function must not treat an unrecognised execution_policy as risky
    // by default -- only confirm_required opts in.
    const action = {
      activation_policy: "none" as const,
      execution_policy: "manual_only" as const,
    };
    expect(requiresHardTapConfirmation(action, true)).toBe(false);
  });

  it("fails safe (no tap requirement asserted) for a missing action", () => {
    // Matches _directive_flags' own fail-closed default on the backend for
    // an unknown entry -- but here "unknown" means the caller has nothing to
    // decide from, not that access should be denied; the browser has no
    // action to look up a tap requirement for.
    expect(requiresHardTapConfirmation(null, true)).toBe(false);
    expect(requiresHardTapConfirmation(undefined, true)).toBe(false);
  });
});
