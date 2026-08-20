import type { KaiActionDefinition } from "@/lib/voice/kai-action-gateway";

/**
 * Whether a confirmation must be settled by an actual tap, never by a
 * spoken yes alone.
 *
 * Two independent reasons land on the same UI path (agent-bar.tsx keeps the
 * pending confirmation open and waits for a real tap instead of settling it
 * immediately):
 *
 * - `trusted_activation_required` is a platform fact: a browser popup can
 *   only be opened during a fresh physical gesture, so a spoken "yes" can
 *   authorize the ledger but cannot open the popup itself.
 * - `confirm_required` + the person's own `require_tap_confirmation`
 *   preference (Voice settings) is a chosen fact: they turned off spoken
 *   "yes" for these actions specifically. Without this branch, a spoken yes
 *   would fully settle a directive the person explicitly asked never to
 *   accept a spoken yes for -- the setting would raise a card but not
 *   enforce anything.
 *
 * `allow_direct` actions are never affected by either reason: the tap
 * preference only ever adds a confirmation to actions the contract already
 * calls risky, never to hands-free ones.
 */
export function requiresHardTapConfirmation(
  action:
    | Pick<KaiActionDefinition, "activation_policy" | "execution_policy">
    | null
    | undefined,
  requireTapConfirmation: boolean,
): boolean {
  if (!action) return false;
  if (action.activation_policy === "trusted_activation_required") return true;
  return action.execution_policy === "confirm_required" && requireTapConfirmation === true;
}
