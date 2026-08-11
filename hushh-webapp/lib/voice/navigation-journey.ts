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
export function navigationActionForRoute(route: string): string | null {
  const cleanRoute = route.trim();
  if (!cleanRoute) return null;
  const candidates = listKaiActions()
    .filter((action) => {
      const target = action.execution_target;
      // Narrow off the unwired arm before reading a wired-only field.
      if (target.status !== "wired") return false;
      // Any action that navigates to this route can walk someone there,
      // whatever it is named. Requiring the `route.` name prefix here made
      // whole destinations look unreachable: /one/setup/finance is opened by
      // `setup.open_finance`, and /one/connect only by `route.one_connect`.
      return (
        target.path === "route" &&
        String(target.target || "").trim() === cleanRoute
      );
    })
    .map((action) => action.action_id)
    // Prefer a `route.*` escort when the destination has one, matching
    // `_navigation_action_for_route` in action_tools.py. Plain alphabetical
    // order picked `location.open_now` over `route.one_location` and -- worse
    // -- `location.add_connections` to escort a CONNECT journey, purely
    // because "location" sorts before "route". Both navigate correctly, but
    // only the `route.*` ones are in GLOBAL_NAV_ACTION_IDS, so they are the
    // ones guaranteed to be offered from any screen. Alphabetical still breaks
    // ties within each group, so the choice stays deterministic.
    .sort((left, right) => {
      const leftIsRoute = left.startsWith("route.");
      const rightIsRoute = right.startsWith("route.");
      if (leftIsRoute !== rightIsRoute) return leftIsRoute ? -1 : 1;
      return left.localeCompare(right);
    });
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
  if (
    definition.execution_target.status === "wired" &&
    definition.execution_target.path === "route"
  ) {
    // The `route.` prefix above was only ever a proxy for this: an action that
    // executes BY navigating is its own navigation, whatever it is named. The
    // Location surface authors its tabs and flows as `location.*` route
    // actions, and without this check the one whose target matches a wired
    // `route.*` action exactly resolves to a journey that navigates to where
    // it already goes and then runs itself on arrival.
    return null;
  }
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

/**
 * The plan for a goal, found from the goal id alone.
 *
 * The relay's first directive for a journey is its NAVIGATION step, so the
 * directive arrives carrying `goal.analysis.start_debate` with an action id of
 * `route.kai_analysis`. Resolving the plan from that action id returns nothing
 * -- a route action is never a journey in its own right -- so the card fell
 * back to showing one step. The goal is the thing that identifies the journey;
 * the step is just where it currently is.
 */
export function resolveJourneyPlanForGoal(goalId: string): JourneyPlan | null {
  const cleanGoalId = String(goalId || "").trim();
  if (!cleanGoalId) return null;
  for (const action of listKaiActions()) {
    const journey = resolveNavigationJourney(action.action_id, action);
    if (journey?.goalId === cleanGoalId) {
      return resolveJourneyPlan(action.action_id);
    }
  }
  return null;
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
