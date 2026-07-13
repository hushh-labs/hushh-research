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

import { useEffect, useRef, useSyncExternalStore } from "react";

export type LocalOnboardingActionResult = {
  status: "started" | "succeeded" | "blocked" | "failed";
  summary: string;
  /** Authored navigation target, settled by the shared voice runtime. */
  routeAfter?: string | null;
  screenAfter?: string | null;
  data?: Record<string, unknown>;
};

/**
 * Execution-only gateway context. This is deliberately separate from
 * model-resolved slots: it carries correlation metadata, never owner
 * information or provider credentials.
 */
export type LocalOnboardingActionContext = {
  directiveId?: string | null;
};

export type LocalOnboardingActionHandler = (
  slots: Record<string, unknown>,
  context?: LocalOnboardingActionContext,
) => LocalOnboardingActionResult | Promise<LocalOnboardingActionResult>;

type MountedLocalActionHandler = {
  ownerId: string;
  sequence: number;
  handler: LocalOnboardingActionHandler;
};

const handlers = new Map<string, Map<string, MountedLocalActionHandler>>();
const legacyOwnerIds = new WeakMap<LocalOnboardingActionHandler, string>();
let registrationSequence = 0;
let handlerRevision = 0;
const handlerListeners = new Set<() => void>();

function emitHandlerChange() {
  handlerRevision += 1;
  handlerListeners.forEach((listener) => listener());
}

function legacyOwnerId(handler: LocalOnboardingActionHandler): string {
  const existing = legacyOwnerIds.get(handler);
  if (existing) return existing;
  const ownerId = `legacy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  legacyOwnerIds.set(handler, ownerId);
  return ownerId;
}

/** Register a mounted handler without allowing an older owner to steal it. */
export function registerMountedLocalActionHandler(
  actionId: string,
  ownerId: string,
  handler: LocalOnboardingActionHandler,
) {
  const owners =
    handlers.get(actionId) ?? new Map<string, MountedLocalActionHandler>();
  registrationSequence += 1;
  owners.set(ownerId, { ownerId, sequence: registrationSequence, handler });
  handlers.set(actionId, owners);
  emitHandlerChange();
}

/** Remove only the registration owned by the caller. */
export function unregisterMountedLocalActionHandler(
  actionId: string,
  ownerId: string,
) {
  const owners = handlers.get(actionId);
  if (!owners) return;
  owners.delete(ownerId);
  if (owners.size === 0) handlers.delete(actionId);
  emitHandlerChange();
}

/** Register a handler for a governed `action_id`. Last registration wins. */
export function registerLocalOnboardingHandler(
  actionId: string,
  handler: LocalOnboardingActionHandler,
) {
  registerMountedLocalActionHandler(actionId, legacyOwnerId(handler), handler);
}

/** Remove a handler only if it is still the one that registered it. */
export function unregisterLocalOnboardingHandler(
  actionId: string,
  handler: LocalOnboardingActionHandler,
) {
  unregisterMountedLocalActionHandler(actionId, legacyOwnerId(handler));
}

export function resolveLocalOnboardingHandler(
  actionId: string,
): LocalOnboardingActionHandler | null {
  const owners = handlers.get(actionId);
  if (!owners || owners.size === 0) return null;
  return (
    Array.from(owners.values()).sort(
      (left, right) => right.sequence - left.sequence,
    )[0]?.handler ?? null
  );
}

export function hasMountedLocalOnboardingHandler(actionId: string): boolean {
  return resolveLocalOnboardingHandler(actionId) !== null;
}

/** Monotonic existing-registry revision used by the shared AX snapshot. */
export function useLocalOnboardingHandlerRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      handlerListeners.add(listener);
      return () => handlerListeners.delete(listener);
    },
    () => handlerRevision,
    () => handlerRevision,
  );
}

/**
 * A Live directive can arrive in the small window between route paint and a
 * component's effect registration. Wait briefly for that route-local handler
 * instead of falsely reporting that a visible control is unavailable.
 */
export async function waitForLocalOnboardingHandler(
  actionId: string,
  timeoutMs = 750,
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
  handler: LocalOnboardingActionHandler,
  options: { enabled?: boolean } = {},
) {
  const ownerIdRef = useRef(
    `local_action_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const handlerRef = useRef(handler);
  // Refs must not be written during render (react-hooks/refs); keep the ref
  // fresh in an effect instead so the registered handler below never closes
  // over a stale `handler` without needing `handler` itself in the
  // registration effect's dependency array.
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (options.enabled === false) return;
    const stableHandler: LocalOnboardingActionHandler = (slots, context) =>
      handlerRef.current(slots, context);
    const ownerId = ownerIdRef.current;
    registerMountedLocalActionHandler(actionId, ownerId, stableHandler);
    return () => {
      unregisterMountedLocalActionHandler(actionId, ownerId);
    };
  }, [actionId, options.enabled]);
}
