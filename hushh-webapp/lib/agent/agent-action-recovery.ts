import type { AgentActionEffectState } from "@/lib/agent/agent-action-runtime";

export type AgentRecoveryRisk =
  | "read_only"
  | "state_change"
  | "irreversible";

export type AgentRecoveryDisposition =
  | "not_needed"
  | "propose"
  | "stop";

export type AgentRecoveryPolicyReason =
  | "effect_completed"
  | "effect_started"
  | "effect_unknown"
  | "no_deterministic_recovery"
  | "irreversible_action"
  | "safe_recovery_available";

export type EvaluateAgentActionRecoveryInput = {
  effectState: AgentActionEffectState;
  hasDeterministicRecovery: boolean;
  risk?: AgentRecoveryRisk;
  recoveryChangesAction?: boolean;
};

export type AgentRecoveryPolicyDecision = {
  disposition: AgentRecoveryDisposition;
  reason: AgentRecoveryPolicyReason;

  /**
   * Recovery is never executed as an automatic retry.
   * A safe result only allows One to propose the next action.
   */
  mayAutoRetry: false;

  /**
   * True when the proposed recovery introduces a new action or side effect.
   */
  requiresFreshConsent: boolean;
};

/**
 * Evaluates whether One may propose a governed recovery after an action result.
 *
 * This policy is intentionally fail-closed:
 *
 * - completed: no recovery is necessary
 * - started: stop because an effect may already be in progress
 * - unknown: stop because duplicate execution cannot be ruled out
 * - not_started: a deterministic recovery may be proposed
 *
 * This function never authorizes automatic retries.
 */
export function evaluateAgentActionRecovery(
  input: EvaluateAgentActionRecoveryInput,
): AgentRecoveryPolicyDecision {
  if (input.effectState === "completed") {
    return {
      disposition: "not_needed",
      reason: "effect_completed",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    };
  }

  if (input.effectState === "started") {
    return {
      disposition: "stop",
      reason: "effect_started",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    };
  }

  if (input.effectState === "unknown") {
    return {
      disposition: "stop",
      reason: "effect_unknown",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    };
  }

  const risk = input.risk ?? "state_change";

  if (risk === "irreversible") {
    return {
      disposition: "stop",
      reason: "irreversible_action",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    };
  }

  if (!input.hasDeterministicRecovery) {
    return {
      disposition: "stop",
      reason: "no_deterministic_recovery",
      mayAutoRetry: false,
      requiresFreshConsent: false,
    };
  }

  return {
    disposition: "propose",
    reason: "safe_recovery_available",
    mayAutoRetry: false,
    requiresFreshConsent:
      risk === "state_change" || input.recoveryChangesAction !== false,
  };
}
