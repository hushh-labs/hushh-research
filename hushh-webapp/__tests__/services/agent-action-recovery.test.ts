import { describe, expect, it } from "vitest";

import { evaluateAgentActionRecovery } from "@/lib/agent/agent-action-recovery";

describe("evaluateAgentActionRecovery", () => {
  it("does not recover when the original effect completed", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "completed",
        hasDeterministicRecovery: true,
      }),
    ).toEqual({
      disposition: "not_needed",
      reason: "effect_completed",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    });
  });

  it("fails closed when execution already started", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "started",
        hasDeterministicRecovery: true,
      }),
    ).toEqual({
      disposition: "stop",
      reason: "effect_started",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    });
  });

  it("fails closed when the effect is unknown", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "unknown",
        hasDeterministicRecovery: true,
      }),
    ).toEqual({
      disposition: "stop",
      reason: "effect_unknown",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    });
  });

  it("stops when no deterministic recovery exists", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "not_started",
        hasDeterministicRecovery: false,
      }),
    ).toEqual({
      disposition: "stop",
      reason: "no_deterministic_recovery",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    });
  });

  it("does not propose recovery for irreversible actions", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "not_started",
        hasDeterministicRecovery: true,
        risk: "irreversible",
      }),
    ).toEqual({
      disposition: "stop",
      reason: "irreversible_action",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    });
  });

  it("proposes deterministic state-changing recovery with fresh consent", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "not_started",
        hasDeterministicRecovery: true,
        risk: "state_change",
        recoveryChangesAction: true,
      }),
    ).toEqual({
      disposition: "propose",
      reason: "safe_recovery_available",
      mayAutoRetry: false,
      requiresFreshConsent: true,
    });
  });

  it("can keep existing consent for a same-action read-only recovery", () => {
    expect(
      evaluateAgentActionRecovery({
        effectState: "not_started",
        hasDeterministicRecovery: true,
        risk: "read_only",
        recoveryChangesAction: false,
      }),
    ).toEqual({
      disposition: "propose",
      reason: "safe_recovery_available",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    });
  });
});
