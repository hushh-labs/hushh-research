/**
 * Local-handler registry for governed actions whose `execution_target.path`
 * is `"local_handler"`.
 *
 * The generated action gateway supports `"route"` (router.push) and
 * `"kai_command"` (dispatch into `executeKaiCommand`) out of the box, but
 * neither fits an in-place UI state change on a mounted component that has
 * no route or Kai-command equivalent - for example answering an onboarding
 * wizard question, tapping the setup hub's master Skip/Continue, or
 * submitting a phone/OTP field. Those surfaces register a small handler here
 * on mount (mirroring `usePublishVoiceSurfaceMetadata`'s publish/clear
 * lifecycle in `voice-surface-metadata.ts`), and
 * `executeAgentGatewayAction` (`agent-action-runtime.ts`) looks the handler
 * up by `action_id` and invokes it with the action's resolved slots.
 *
 * A handler must be idempotent-safe to call from voice (no silent retries)
 * and should return a short result summary string for the agent to relay.
 */

import { useEffect, useRef } from "react";

export type LocalOnboardingActionResult = {
  status: "started" | "succeeded" | "blocked" | "failed";
  summary: string;
  data?: Record<string, unknown>;
};

export type LocalOnboardingActionHandler = (
  slots: Record<string, unknown>
) => LocalOnboardingActionResult | Promise<LocalOnboardingActionResult>;

const handlers = new Map<string, LocalOnboardingActionHandler>();

/** Register a handler for a governed `action_id`. Last registration wins. */
export function registerLocalOnboardingHandler(
  actionId: string,
  handler: LocalOnboardingActionHandler
) {
  handlers.set(actionId, handler);
}

/** Remove a handler only if it is still the one that registered it. */
export function unregisterLocalOnboardingHandler(
  actionId: string,
  handler: LocalOnboardingActionHandler
) {
  if (handlers.get(actionId) === handler) {
    handlers.delete(actionId);
  }
}

export function resolveLocalOnboardingHandler(
  actionId: string
): LocalOnboardingActionHandler | null {
  return handlers.get(actionId) ?? null;
}

/**
 * A Live directive can arrive in the small window between route paint and a
 * component's effect registration. Wait briefly for that route-local handler
 * instead of falsely reporting that a visible control is unavailable.
 */
export async function waitForLocalOnboardingHandler(
  actionId: string,
  timeoutMs = 750
): Promise<LocalOnboardingActionHandler | null> {
  const immediate = resolveLocalOnboardingHandler(actionId);
  if (immediate) return immediate;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    const handler = resolveLocalOnboardingHandler(actionId);
    if (handler) return handler;
  }
  return null;
}

/**
 * Register a local onboarding handler for the lifetime of the calling
 * component. Re-registers whenever `handler` changes identity so callers
 * can close over fresh component state without stale closures.
 */
export function useLocalOnboardingActionHandler(
  actionId: string,
  handler: LocalOnboardingActionHandler
) {
  const handlerRef = useRef(handler);
  // Refs must not be written during render (react-hooks/refs); keep the ref
  // fresh in an effect instead so the registered handler below never closes
  // over a stale `handler` without needing `handler` itself in the
  // registration effect's dependency array.
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const stableHandler: LocalOnboardingActionHandler = (slots) =>
      handlerRef.current(slots);
    registerLocalOnboardingHandler(actionId, stableHandler);
    return () => {
      unregisterLocalOnboardingHandler(actionId, stableHandler);
    };
  }, [actionId]);
}
