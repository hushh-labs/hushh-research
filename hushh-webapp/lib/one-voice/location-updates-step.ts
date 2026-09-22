/**
 * The device half of `resume_device_location_updates` /
 * `pause_device_location_updates`: a `set_location_updates` client step from
 * One Live Voice becomes a real run of the Location screen's own switch
 * handler (`location.resume_updates` / `location.pause_updates`).
 *
 * Pure: no React, no DOM, no timers of its own beyond `now()`. Every outside
 * dependency is a port so the whole decision table can be driven from a unit
 * test with plain fakes. The bridge (`location-updates-step-bridge.tsx`)
 * supplies the real ports.
 *
 * What it does, in order:
 *  1. Refuse anything but a typed request for exactly one of the two
 *     authored actions. The relay resolved the tool by exact name; this side
 *     resolves the action by exact id. No wording is inspected anywhere.
 *  2. Answer already_on / already_off from module-level truth, conservatively
 *     (see `decideIdempotent`), without navigating.
 *  3. Navigate to the action's authored destination only when its handler is
 *     not mounted, then wait for the registration, the route, and a paint.
 *  4. Prepare and execute through the normal action dispatcher with the
 *     step id as the operation id, so the page's own intent sequencing and
 *     prepared-binding checks apply exactly as they do for a tap.
 *  5. Report once, from what actually happened: the handler's typed reason
 *     and the switch's own derived state after the run. Never the summary
 *     text, never a binding, never a coordinate.
 *
 * Success words are earned on the relay, not here: this module reports an
 * outcome; the server settles it into the final result the model narrates.
 */

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import type { LocationOsPermissionReported } from "@/lib/location/account-settings";
import type { LocationBusStatus } from "@/lib/one-location/location-bus";
import {
  deriveLocationEnabled,
  type OneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { isSafeInternalHref } from "@/lib/one-voice/directives";
import type { NavigationJourney } from "@/lib/voice/navigation-journey";

export const SET_LOCATION_UPDATES_STEP = "set_location_updates" as const;
export const RESUME_UPDATES_ACTION_ID = "location.resume_updates" as const;
export const PAUSE_UPDATES_ACTION_ID = "location.pause_updates" as const;

/** The bounded provider's own budget for a route to mount its handler. */
export const HANDLER_WAIT_MS = 8_000;
/** How long to let the destination load its Location state before preparing. */
export const STATE_WAIT_MS = 3_000;
/** Report `timed_out` this much before the provider's own timer would. */
export const SELF_DEADLINE_MARGIN_MS = 1_000;
/**
 * The wrapper's fixed sentence when a prepared binding no longer matches
 * (`useLocalOnboardingActionHandler`). It is retried once, then reported as
 * the handler being unavailable -- never compared against anything else.
 */
const BINDING_CHANGED_SUMMARY =
  "The selected information changed. Review the action again.";

export type LocationUpdatesDesiredState = "on" | "off";
export type LocationUpdatesObservedState = "on" | "off" | "unknown";

export type LocationUpdatesOutcome =
  | "on"
  | "off"
  | "already_on"
  | "already_off"
  | "permission_denied"
  | "no_fix"
  | "superseded"
  | "handler_unavailable"
  | "timed_out"
  | "cancelled"
  | "nearby_checkout_failed"
  | "vault_locked"
  | "signed_out"
  | "failed";

/** Exactly what the relay's `LocationUpdatesStepPayload` accepts. */
export type LocationUpdatesStepReport = {
  gateway_action_id: string;
  desired_state: LocationUpdatesDesiredState;
  outcome: LocationUpdatesOutcome;
  observed_state: LocationUpdatesObservedState;
  reason_code: string | null;
  navigated: boolean;
  os_permission: LocationOsPermissionReported;
};

export type LocationUpdatesStepResult = {
  status: "ok" | "failed";
  payload: LocationUpdatesStepReport;
};

export type LocationUpdatesStepRequest = {
  stepId: string;
  payload: Record<string, unknown>;
  /** Server-advertised budget; the report goes out before it elapses. */
  timeoutS?: number | null;
};

export type ParsedLocationUpdatesStep = {
  desiredState: LocationUpdatesDesiredState;
  actionId: typeof RESUME_UPDATES_ACTION_ID | typeof PAUSE_UPDATES_ACTION_ID;
};

export type LocationUpdatesExecuteInput = {
  actionId: string;
  operationId: string;
  preparedBinding: Record<string, unknown>;
  goalId: string;
  expectedScreen: string;
  signal: AbortSignal;
};

export type LocationUpdatesStepPorts = {
  userId: string | null;
  readControlState: () => OneLocationControlState;
  /** The owner's grants from the loaded Location state, or null if unloaded. */
  readOwnerGrants: () => readonly { status: string }[] | null;
  readFixStatus: () => LocationBusStatus;
  readOsPermission: () => LocationOsPermissionReported;
  /** The runtime's current screen id, read at call time (never a closure). */
  readRoute: () => string | null;
  isHandlerMounted: (actionId: string) => boolean;
  resolveJourney: (actionId: string) => NavigationJourney | null;
  navigate: (href: string) => boolean;
  waitForHandler: (actionId: string, timeoutMs: number) => Promise<boolean>;
  /** Yield until the destination has painted; synchronous in tests. */
  afterPaint: () => Promise<void>;
  prepare: (actionId: string) => Promise<LocalActionPreparation | null>;
  execute: (
    input: LocationUpdatesExecuteInput,
  ) => Promise<AgentActionRuntimeResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Accept only a typed request for one of the two authored actions, with the
 * desired state and the action id agreeing. Anything else is refused before
 * any navigation.
 */
export function parseLocationUpdatesStep(
  payload: Record<string, unknown> | null | undefined,
): ParsedLocationUpdatesStep | null {
  const desired = payload?.desired_state;
  const actionId = payload?.gateway_action_id;
  if (desired === "on" && actionId === RESUME_UPDATES_ACTION_ID) {
    return { desiredState: "on", actionId: RESUME_UPDATES_ACTION_ID };
  }
  if (desired === "off" && actionId === PAUSE_UPDATES_ACTION_ID) {
    return { desiredState: "off", actionId: PAUSE_UPDATES_ACTION_ID };
  }
  return null;
}

/**
 * Whether the request is already satisfied, decided from module-level truth
 * before navigating anywhere.
 *
 * `already_off` is the switch's own first rule: the persisted pause. It holds
 * with the page unmounted and after a reload.
 *
 * `already_on` is deliberately stricter than the switch's rendered state:
 * it needs the self preview the switch's own handler enables AND a fix
 * measured this session. The switch also reads "on" for a grants-only
 * device -- but that device may be blocked, and "Location is already on"
 * would then be false. Being strict only ever costs a verifying run of the
 * real handler, which reports the truth either way.
 */
export function decideIdempotent(
  desired: LocationUpdatesDesiredState,
  control: OneLocationControlState,
  fixStatus: LocationBusStatus,
): "already_on" | "already_off" | null {
  if (desired === "off") return control.paused ? "already_off" : null;
  return !control.paused && control.selfPreviewEnabled && fixStatus === "ready"
    ? "already_on"
    : null;
}

export function observeLocationUpdates(
  ports: Pick<LocationUpdatesStepPorts, "readControlState" | "readOwnerGrants">,
): LocationUpdatesObservedState {
  const control = ports.readControlState();
  return deriveLocationEnabled(control, ports.readOwnerGrants() ?? [])
    ? "on"
    : "off";
}

function readReason(result: AgentActionRuntimeResult): string | null {
  const fromData = result.data?.reason;
  if (typeof fromData === "string" && fromData.trim()) return fromData.trim();
  return typeof result.reason === "string" && result.reason.trim()
    ? result.reason.trim()
    : null;
}

/** Map the dispatcher's result onto the typed outcome vocabulary. */
export function classifyHandlerResult(
  result: AgentActionRuntimeResult,
  desired: LocationUpdatesDesiredState,
  observed: LocationUpdatesObservedState,
): { outcome: LocationUpdatesOutcome; reasonCode: string | null } {
  const reason = readReason(result);
  if (result.status === "succeeded") {
    return observed === desired
      ? { outcome: desired, reasonCode: null }
      : { outcome: "superseded", reasonCode: "state_moved_on" };
  }
  switch (reason) {
    case "permission_denied":
    case "no_fix":
    case "superseded":
    case "vault_locked":
    case "nearby_checkout_failed":
    case "signed_out":
      return { outcome: reason, reasonCode: reason };
    case "local_handler_not_mounted":
    case "action_not_in_active_inventory":
    case "missing_action":
    case "runtime_unavailable":
      return { outcome: "handler_unavailable", reasonCode: reason };
    case "execution_aborted":
      return { outcome: "cancelled", reasonCode: reason };
    default:
      return { outcome: "failed", reasonCode: reason ?? result.status };
  }
}

function isBindingChanged(result: AgentActionRuntimeResult): boolean {
  return (
    result.status === "blocked" &&
    readReason(result) === null &&
    result.resultSummary === BINDING_CHANGED_SUMMARY
  );
}

type InFlight = {
  desiredState: LocationUpdatesDesiredState;
  promise: Promise<LocationUpdatesStepResult>;
};

/**
 * Same-state steps that overlap share one run: two quick "enable" requests
 * settle identically instead of the second superseding the first. Opposite
 * states are never coalesced -- the newer intent must win, which the page's
 * own intent sequencing guarantees.
 */
const inFlightByUser = new Map<string, InFlight>();

/** Test hook: forget any coalesced run. */
export function resetLocationUpdatesStepState(): void {
  inFlightByUser.clear();
}

export async function runLocationUpdatesStep(
  step: LocationUpdatesStepRequest,
  ports: LocationUpdatesStepPorts,
  signal: AbortSignal,
): Promise<LocationUpdatesStepResult> {
  const parsed = parseLocationUpdatesStep(step.payload);
  const base = (
    outcome: LocationUpdatesOutcome,
    reasonCode: string | null,
    navigated: boolean,
    observed: LocationUpdatesObservedState = "unknown",
  ): LocationUpdatesStepResult => ({
    status:
      outcome === "on" ||
      outcome === "off" ||
      outcome === "already_on" ||
      outcome === "already_off"
        ? "ok"
        : "failed",
    payload: {
      gateway_action_id: parsed?.actionId ?? String(step.payload?.gateway_action_id ?? ""),
      desired_state: parsed?.desiredState ?? (step.payload?.desired_state === "off" ? "off" : "on"),
      outcome,
      observed_state: observed,
      reason_code: reasonCode,
      navigated,
      os_permission: ports.readOsPermission(),
    },
  });

  if (!parsed) return base("failed", "invalid_step_payload", false);
  const userId = ports.userId;
  if (!userId) return base("signed_out", "signed_out", false);

  const coalesceKey = `${userId}:${parsed.desiredState}`;
  const existing = inFlightByUser.get(coalesceKey);
  if (existing && existing.desiredState === parsed.desiredState) {
    return existing.promise;
  }
  const run = runOnce(step, parsed, userId, ports, signal, base);
  inFlightByUser.set(coalesceKey, { desiredState: parsed.desiredState, promise: run });
  try {
    return await run;
  } finally {
    if (inFlightByUser.get(coalesceKey)?.promise === run) {
      inFlightByUser.delete(coalesceKey);
    }
  }
}

async function runOnce(
  step: LocationUpdatesStepRequest,
  parsed: ParsedLocationUpdatesStep,
  userId: string,
  ports: LocationUpdatesStepPorts,
  signal: AbortSignal,
  base: (
    outcome: LocationUpdatesOutcome,
    reasonCode: string | null,
    navigated: boolean,
    observed?: LocationUpdatesObservedState,
  ) => LocationUpdatesStepResult,
): Promise<LocationUpdatesStepResult> {
  const { desiredState, actionId } = parsed;
  const observe = () => observeLocationUpdates(ports);

  const journey = ports.resolveJourney(actionId);
  if (!journey || !isSafeInternalHref(journey.destinationRoute)) {
    return base("handler_unavailable", "journey_unresolved", false, observe());
  }

  const idempotent = decideIdempotent(
    desiredState,
    ports.readControlState(),
    ports.readFixStatus(),
  );
  if (idempotent) {
    return base(idempotent, null, false, desiredState);
  }
  if (signal.aborted) return base("cancelled", "execution_aborted", false, observe());

  const deadlineAt =
    typeof step.timeoutS === "number" && Number.isFinite(step.timeoutS) && step.timeoutS > 0
      ? ports.now() + step.timeoutS * 1000 - SELF_DEADLINE_MARGIN_MS
      : null;
  const timedOut = () => deadlineAt !== null && ports.now() >= deadlineAt;

  // -- navigate and continue -----------------------------------------------
  let navigated = false;
  if (!ports.isHandlerMounted(actionId)) {
    navigated = true;
    if (!ports.navigate(journey.destinationRoute)) {
      return base("handler_unavailable", "navigation_unavailable", navigated, observe());
    }
  }
  const mounted = await ports.waitForHandler(actionId, HANDLER_WAIT_MS);
  if (signal.aborted) return base("cancelled", "execution_aborted", navigated, observe());
  if (!mounted || ports.readRoute() !== journey.destinationScreen) {
    return base("handler_unavailable", "local_handler_not_mounted", navigated, observe());
  }
  await ports.afterPaint();
  if (timedOut()) return base("timed_out", "timed_out", navigated, observe());

  // The resume binding names the active grants; give the destination a
  // bounded moment to load its state so the binding is stable between
  // prepare and execute.
  const stateDeadline = ports.now() + STATE_WAIT_MS;
  while (ports.readOwnerGrants() === null && ports.now() < stateDeadline) {
    await ports.sleep(50);
    if (signal.aborted) return base("cancelled", "execution_aborted", navigated, observe());
  }

  // -- prepare + execute through the normal dispatcher --------------------
  const attempt = async (): Promise<AgentActionRuntimeResult | LocationUpdatesStepResult> => {
    const preparation = await ports.prepare(actionId);
    if (!preparation || preparation.status !== "ready") {
      return base("handler_unavailable", "not_ready", navigated, observe());
    }
    if (preparation.binding.owner !== userId) {
      return base("failed", "owner_mismatch", navigated, observe());
    }
    if (signal.aborted) return base("cancelled", "execution_aborted", navigated, observe());
    return ports.execute({
      actionId,
      operationId: step.stepId,
      preparedBinding: preparation.binding,
      goalId: journey.goalId,
      expectedScreen: journey.destinationScreen,
      signal,
    });
  };

  const race = async (): Promise<LocationUpdatesStepResult> => {
    let result = await attempt();
    if ("payload" in result) return result;
    if (isBindingChanged(result)) {
      // The grant list moved between prepare and execute (a share expired or
      // arrived). One re-prepare covers the ordinary case.
      result = await attempt();
      if ("payload" in result) return result;
      if (isBindingChanged(result)) {
        return base("handler_unavailable", "binding_changed", navigated, observe());
      }
    }
    const observed = observe();
    const { outcome, reasonCode } = classifyHandlerResult(result, desiredState, observed);
    return base(outcome, reasonCode, navigated, observed);
  };

  if (deadlineAt === null) return race();
  // Report before the provider's own timer would; the handler is allowed to
  // finish on its own (its effects are not rolled back by a report).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onDeadline = new Promise<LocationUpdatesStepResult>((resolve) => {
    const wait = Math.max(0, deadlineAt - ports.now());
    timer = setTimeout(
      () => resolve(base("timed_out", "timed_out", navigated, observe())),
      wait,
    );
  });
  try {
    return await Promise.race([race(), onDeadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
