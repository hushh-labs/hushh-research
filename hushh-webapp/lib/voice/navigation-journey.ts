import {
  getKaiActionById,
  listKaiActions,
  type KaiActionDefinition,
} from "@/lib/voice/kai-action-gateway";

/**
 * An authored cross-screen journey: navigate to a declared destination, then
 * run the action there.
 *
 * The browser mirror of the relay's `_navigation_journey_definition`. Both
 * read the same generated contract, so the two halves of a journey cannot
 * drift into disagreeing about where it goes or what it is called.
 */
export type NavigationJourney = {
  goalId: string;
  destinationRoute: string;
  destinationScreen: string;
  navigationActionId: string;
  label: string;
};

const JOURNEY_SLOT_MAX_CHARS = 64;

/**
 * The wired `route.*` action that opens `route`, if one exists.
 *
 * Resolved from the gateway rather than named in code, so adding a journey
 * never means editing this file. Sorted for a deterministic choice when a
 * route has more than one navigation action.
 */
function navigationActionForRoute(route: string): string | null {
  const cleanRoute = route.trim();
  if (!cleanRoute) return null;
  const candidates = listKaiActions()
    .filter((action) => {
      if (!action.action_id.startsWith("route.")) return false;
      const target = action.execution_target;
      // Narrow off the unwired arm before reading a wired-only field.
      if (target.status !== "wired") return false;
      return (
        target.path === "route" &&
        String(target.target || "").trim() === cleanRoute
      );
    })
    .map((action) => action.action_id)
    .sort();
  return candidates[0] ?? null;
}

/**
 * Resolve the authored navigate-then-execute journey for `actionId`, or null.
 *
 * The shape is a single `action` workflow step naming itself plus the
 * `settlement_target` it must be standing on. An action whose destination has
 * no wired navigation action is deliberately not a journey: One would have no
 * generated way to walk it and would strand the person mid-goal.
 */
export function resolveNavigationJourney(
  actionId: string,
  action?: KaiActionDefinition | null,
): NavigationJourney | null {
  const cleanId = String(actionId || "").trim();
  if (!cleanId || cleanId.startsWith("route.")) {
    // Navigation actions already ARE the navigation.
    return null;
  }
  const definition = action ?? getKaiActionById(cleanId);
  if (!definition) return null;
  const goalId = String(definition.goal?.goal_id || "").trim();
  const steps = definition.goal?.workflow_steps;
  if (!goalId || !Array.isArray(steps) || steps.length !== 1) return null;
  const step = steps[0];
  if (!step || step.type !== "action" || step.action_id !== cleanId) return null;
  const route = String(step.settlement_target?.route || "").trim();
  const screen = String(step.settlement_target?.screen || "").trim();
  if (!route || !screen) return null;
  const navigationActionId = navigationActionForRoute(route);
  if (!navigationActionId) return null;
  return {
    goalId,
    destinationRoute: route,
    destinationScreen: screen,
    navigationActionId,
    label: String(step.label || "").trim(),
  };
}

/**
 * Slot values a journey may carry, per the action's own goal contract.
 *
 * Only declared slots survive, so a journey can never carry arbitrary
 * caller-authored state across a navigation. Declared defaults fill an
 * omitted slot, and normalization follows the resolver the contract names.
 */
export function resolveJourneySlots(
  action: KaiActionDefinition,
  slots: Record<string, unknown>,
): Record<string, string> {
  const schema = new Map<string, string>();
  Object.entries(action.goal?.slot_schema || {}).forEach(([key, value]) => {
    schema.set(String(key), String(value ?? ""));
  });
  const defaults = new Map<string, string>();
  (action.goal?.required_inputs || []).forEach((spec) => {
    const slotName = String(spec.slot || spec.name || "").trim();
    if (!slotName) return;
    if (!schema.has(slotName)) schema.set(slotName, String(spec.resolver || ""));
    const fallback = String(spec.default_value ?? "").trim();
    if (fallback) defaults.set(slotName, fallback);
  });

  const resolved: Record<string, string> = {};
  schema.forEach((resolver, slotName) => {
    const raw = String(slots?.[slotName] ?? "").trim() || defaults.get(slotName) || "";
    if (!raw) return;
    const value = raw.slice(0, JOURNEY_SLOT_MAX_CHARS);
    resolved[slotName] = resolver === "ticker_symbol" ? value.toUpperCase() : value;
  });
  return resolved;
}

/** One step of a journey, as it will be shown to the person for approval. */
export type JourneyPlanStep = {
  actionId: string;
  label: string;
  meaning: string;
  /** False when this step must be approved on its own, at the moment it runs. */
  batchable: boolean;
};

export type JourneyPlan = {
  goalId: string;
  destinationScreen: string;
  steps: JourneyPlanStep[];
  /** Action ids one approval may cover. Never includes a non-batchable step. */
  batchableActionIds: string[];
};

/**
 * A step may be approved in advance only when nothing about it needs the
 * person present at the moment it runs.
 *
 * `confirm_required` exists precisely to make someone look at that action, so
 * batching it would delete the consent it was created to collect.
 * `trusted_activation_required` is not a policy choice at all: those actions
 * open a real provider window and the browser checks for a fresh gesture, so
 * a promise made earlier cannot satisfy it.
 */
function isBatchable(action: KaiActionDefinition): boolean {
  return (
    action.execution_policy === "allow_direct" &&
    action.activation_policy !== "trusted_activation_required"
  );
}

function planStep(actionId: string): JourneyPlanStep | null {
  const action = getKaiActionById(actionId);
  if (!action) return null;
  return {
    actionId,
    label: action.label,
    meaning: action.meaning,
    batchable: isBatchable(action),
  };
}

/**
 * The full, ordered set of steps a journey will take, known before it starts.
 *
 * This is what makes one approval honest rather than a blank cheque: every
 * step is enumerated from the contract up front, so the person is agreeing to
 * a named list instead of to a window of time. A step the contract marks as
 * needing its own confirmation stays in the plan -- so the list is complete --
 * but is excluded from what the approval covers.
 */
export function resolveJourneyPlan(actionId: string): JourneyPlan | null {
  const journey = resolveNavigationJourney(actionId);
  if (!journey) return null;
  const steps = [journey.navigationActionId, actionId]
    .map(planStep)
    .filter((step): step is JourneyPlanStep => step !== null);
  if (steps.length === 0) return null;
  return {
    goalId: journey.goalId,
    destinationScreen: journey.destinationScreen,
    steps,
    batchableActionIds: steps
      .filter((step) => step.batchable)
      .map((step) => step.actionId),
  };
}

/** The first required slot the contract declares and `slots` does not fill. */
export function firstMissingRequiredSlot(
  action: KaiActionDefinition,
  slots: Record<string, unknown>,
): { slot: string; prompt: string } | null {
  for (const spec of action.goal?.required_inputs || []) {
    if (!spec.required) continue;
    const slotName = String(spec.slot || spec.name || "").trim();
    if (!slotName) continue;
    if (String(slots?.[slotName] ?? "").trim()) continue;
    if (String(spec.default_value ?? "").trim()) continue;
    return {
      slot: slotName,
      prompt: String(spec.prompt || `What should ${slotName} be?`),
    };
  }
  return null;
}
