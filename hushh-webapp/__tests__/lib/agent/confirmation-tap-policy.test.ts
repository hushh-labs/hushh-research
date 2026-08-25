import { describe, expect, it } from "vitest";

import { requiresHardTapConfirmation } from "@/lib/agent/confirmation-tap-policy";

describe("requiresHardTapConfirmation", () => {
  it("is always true for trusted_activation_required, regardless of the tap setting", () => {
    const action = {
      activation_policy: "trusted_activation_required" as const,
      execution_policy: "confirm_required" as const,
    };
    expect(requiresHardTapConfirmation(action, false)).toBe(true);
    expect(requiresHardTapConfirmation(action, true)).toBe(true);
  });

  it("is true for confirm_required only when the person turned on require_tap_confirmation", () => {
    const action = {
      activation_policy: "none" as const,
      execution_policy: "confirm_required" as const,
    };
    expect(requiresHardTapConfirmation(action, true)).toBe(true);
    expect(requiresHardTapConfirmation(action, false)).toBe(false);
  });

  it("is never true for allow_direct, even with the setting on", () => {
    // The tap preference only ever adds a confirmation to actions the
    // contract already calls risky -- it must never turn a hands-free action
    // into one that silently waits for a tap nobody was told to expect.
    const action = {
      activation_policy: "none" as const,
      execution_policy: "allow_direct" as const,
    };
    expect(requiresHardTapConfirmation(action, true)).toBe(false);
    expect(requiresHardTapConfirmation(action, false)).toBe(false);
  });

  it("is false when there is no pending action at all", () => {
    expect(requiresHardTapConfirmation(null, true)).toBe(false);
    expect(requiresHardTapConfirmation(undefined, true)).toBe(false);
  });
});
