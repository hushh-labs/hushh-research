import {
  getKaiActionById,
  listKaiActions,
  type KaiActionDefinition,
} from "./kai-action-gateway";
import {
  extractSpokenEntity,
  parseLocalDuration,
} from "./local-entity-resolvers";
import {
  rankerResultToResolution,
  type OneVoiceIntentRanker,
} from "./local-intent-ranker";

export type LocalIntentDisposition =
  | "action"
  | "read_answer"
  | "clarify"
  | "unsupported";

export type OneVoiceIntentContext = {
  contextRevision: string;
  catalogVersion: string;
  route?: { pathname?: string | null; screen?: string | null };
  availableActionIds: readonly string[];
  executableActionIds?: readonly string[];
  redactedState?: {
    circleCount?: number | null;
    signedIn?: boolean;
    vaultReady?: boolean;
    permissionState?: "unknown" | "granted" | "denied" | "restricted";
    currentLocationState?: "unknown" | "available" | "unavailable";
    shareState?: "unknown" | "sharing" | "paused";
  };
};

export type IntentResolution = {
  disposition: LocalIntentDisposition;
  agentNamespace: string;
  actionId?: string;
  slots: Record<string, string | number | boolean>;
  confidence: number;
  contextRevision: string;
  catalogVersion: string;
  missingSlots?: string[];
  readCapability?: string;
  reason?:
    | "ambiguous"
    | "action_unavailable"
    | "sos_send_blocked"
    | "unsupported_language"
    | "empty_request"
    | "local_model_unavailable";
};

type ScoredCandidate = {
  action: KaiActionDefinition;
  score: number;
  explicit: boolean;
};

export type LocalIntentCandidate = {
  actionId: string;
  agentNamespace: string;
  slots: Record<string, string | number | boolean>;
  text: string;
  lexicalScore: number;
  explicit: boolean;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "me",
  "my",
  "of",
  "on",
  "the",
  "to",
  "with",
  "please",
  "can",
  "you",
]);

const LOCATION_AGENT = "agent_location";
const LOCATION_ACTION_PREFIX = "location.";
const CIRCLE_READ_CAPABILITY = "list_my_location_circles";
const LOCATION_STATUS_READ_CAPABILITY = "read_location_status";
const LOCATION_PERMISSION_READ_CAPABILITY = "read_location_permission";
const CURRENT_LOCATION_READ_CAPABILITY = "read_current_location_status";
const CATALOG_ACTIONS = listKaiActions();

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function containsAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

function actionText(action: KaiActionDefinition): string {
  return [action.action_id, action.label, action.meaning, ...action.aliases, ...action.search_keywords]
    .join(" ")
    .toLocaleLowerCase();
}

function scoreCandidate(query: string, action: KaiActionDefinition): ScoredCandidate {
  const normalizedQuery = normalizeText(query);
  const queryTokens = new Set(tokens(normalizedQuery));
  const searchable = actionText(action);
  const actionId = action.action_id.toLocaleLowerCase();
  let score = 0;
  let explicit = false;

  if (normalizedQuery === actionId || normalizedQuery === action.label.toLocaleLowerCase()) {
    score += 100;
    explicit = true;
  }
  for (const alias of action.aliases) {
    const normalizedAlias = normalizeText(alias);
    if (normalizedQuery === normalizedAlias) {
      score += 85;
      explicit = true;
    } else if (normalizedQuery.includes(normalizedAlias)) {
      score += 44;
      explicit = true;
    }
  }
  for (const token of queryTokens) {
    if (searchable.includes(token)) score += 4;
  }
  if (action.action_id.startsWith(LOCATION_ACTION_PREFIX) && queryTokens.has("location")) {
    score += 3;
  }
  if (
    action.action_id === "location.add_to_circle" &&
    /\b(?:add|invite|put)\b/.test(normalizedQuery) &&
    /\b(?:to|into|in)\b/.test(normalizedQuery)
  ) {
    score += 8;
    explicit = true;
  }
  if (
    action.action_id === "location.remove_from_circle" &&
    /\b(?:remove|kick)\b/.test(normalizedQuery) &&
    /\b(?:from|out of)\b/.test(normalizedQuery)
  ) {
    score += 8;
    explicit = true;
  }
  return { action, score, explicit };
}

function isAllowed(actionId: string, context: OneVoiceIntentContext): boolean {
  // `availableActionIds` is a discovery projection. Only the server-filtered
  // executable inventory may cross the proposal boundary. The fallback keeps
  // older callers safe when they have not yet received a separate executable
  // projection; an explicit empty array remains an intentional denial.
  const executable = new Set(
    context.executableActionIds ?? context.availableActionIds,
  );
  return executable.has(actionId);
}

function isLocallyExecutable(action: KaiActionDefinition): boolean {
  return (
    action.execution_target.status === "wired" &&
    action.execution_policy !== "manual_only"
  );
}

function resultBase(
  context: OneVoiceIntentContext,
  disposition: LocalIntentDisposition,
): IntentResolution {
  return {
    disposition,
    agentNamespace: LOCATION_AGENT,
    slots: {},
    confidence: 0,
    contextRevision: context.contextRevision,
    catalogVersion: context.catalogVersion,
  };
}

function agentNamespaceForAction(action: KaiActionDefinition): string {
  switch (action.delegate_agent_id) {
    case "agent_location":
      return "agent_location";
    case "agent_email":
      return "agent_email";
    case "agent_connections":
      return "agent_connections";
    case "agent_connected_systems":
      return "agent_connected_systems";
    case "agent_nav":
      return "agent_nav";
    case "agent_kyc":
      return "agent_kyc";
    case "kai":
      return "agent_kai";
    case "nav":
      return "agent_nav";
    default:
      return "agent_one";
  }
}

function extractCircleName(query: string): string | null {
  const normalized = normalizeText(query);
  const marker = normalized.match(/\b(?:called|named|name it|call it)\s+([a-z0-9][a-z0-9 -]{0,63})$/i);
  if (marker?.[1]) {
    const name = marker[1].replace(/\b(?:please|now)\b$/i, "").trim();
    return name ? name[0]!.toLocaleUpperCase() + name.slice(1) : null;
  }
  if (/\bfor my family\b/i.test(normalized)) return "Family";
  return null;
}

function resolveLocationSpecialCase(
  query: string,
  context: OneVoiceIntentContext,
): IntentResolution | null {
  const normalized = normalizeText(query);
  if (!normalized) {
    return { ...resultBase(context, "unsupported"), reason: "empty_request" };
  }

  if (
    containsAny(normalized, [
      "send an sos",
      "send sos",
      "trigger sos",
      "send an emergency alert",
      "send help",
    ])
  ) {
    return {
      ...resultBase(context, "unsupported"),
      confidence: 1,
      reason: "sos_send_blocked",
    };
  }
  const isReviewOnlySosRequest =
    !containsAny(normalized, [
      "who gets my sos",
      "emergency contacts",
      "sms contacts",
    ]) &&
    containsAny(normalized, [
      "sos",
      "emergency",
      "panic",
      "help",
      "save me",
      "in danger",
    ]);
  if (isReviewOnlySosRequest) {
    const action = getKaiActionById("location.open_sos");
    if (!action || !isAllowed(action.action_id, context) || !isLocallyExecutable(action)) {
      return {
        ...resultBase(context, "unsupported"),
        confidence: 0.98,
        reason: "action_unavailable",
      };
    }
    return {
      ...resultBase(context, "action"),
      actionId: action.action_id,
      confidence: 0.99,
    };
  }
  if (containsAny(normalized, ["how many circles", "number of circles", "count my circles", "count of circles"])) {
    const result: IntentResolution = {
      ...resultBase(context, "read_answer"),
      confidence: 0.98,
      readCapability: CIRCLE_READ_CAPABILITY,
    };
    if (typeof context.redactedState?.circleCount === "number") {
      result.slots.count = context.redactedState.circleCount;
    }
    return result;
  }
  if (
    context.redactedState?.shareState !== undefined &&
    context.redactedState.shareState !== "unknown" &&
    containsAny(normalized, [
      "am i sharing my location",
      "is my location sharing on",
      "is location sharing on",
      "is my location enabled",
      "is location enabled",
      "what am i sharing",
    ])
  ) {
    return {
      ...resultBase(context, "read_answer"),
      confidence: 0.96,
      readCapability: LOCATION_STATUS_READ_CAPABILITY,
      slots: { enabled: context.redactedState.shareState === "sharing" },
    };
  }
  if (
    context.redactedState?.permissionState !== undefined &&
    context.redactedState.permissionState !== "unknown" &&
    containsAny(normalized, [
      "do i have location permission",
      "does location have permission",
      "is location permission granted",
      "can this app use my location",
    ])
  ) {
    return {
      ...resultBase(context, "read_answer"),
      confidence: 0.96,
      readCapability: LOCATION_PERMISSION_READ_CAPABILITY,
      slots: { permission: context.redactedState.permissionState },
    };
  }
  if (
    context.redactedState?.currentLocationState !== undefined &&
    context.redactedState.currentLocationState !== "unknown" &&
    containsAny(normalized, [
      "is my current location available",
      "is my location available",
      "do you have my current location",
      "can you see my current location",
    ])
  ) {
    return {
      ...resultBase(context, "read_answer"),
      confidence: 0.94,
      readCapability: CURRENT_LOCATION_READ_CAPABILITY,
      slots: {
        available: context.redactedState.currentLocationState === "available",
      },
    };
  }
  if (containsAny(normalized, ["handle my location", "manage my location", "do something with my location"])) {
    return {
      ...resultBase(context, "clarify"),
      confidence: 0.97,
      reason: "ambiguous",
    };
  }

  const circleRequest =
    containsAny(normalized, ["circle", "group"]) &&
    containsAny(normalized, ["create", "make", "start", "new", "set up", "setup"]);
  if (circleRequest) {
    const action = getKaiActionById("location.create_circle");
    if (!action || !isAllowed(action.action_id, context)) {
      return {
        ...resultBase(context, "unsupported"),
        confidence: 0.96,
        reason: "action_unavailable",
      };
    }
    if (!isLocallyExecutable(action)) {
      return {
        ...resultBase(context, "unsupported"),
        confidence: 0.96,
        reason: "action_unavailable",
      };
    }
    const name = extractCircleName(normalized);
    if (!name) {
      return {
        ...resultBase(context, "clarify"),
        actionId: action.action_id,
        confidence: 0.94,
        missingSlots: ["name"],
      };
    }
    return {
      ...resultBase(context, "action"),
      actionId: action.action_id,
      slots: { name },
      confidence: 0.98,
    };
  }

  const resumeOrPause =
    containsAny(normalized, ["location", "sharing", "updates"]) &&
    (containsAny(normalized, ["enable", "turn on", "resume", "start sharing", "show my location"]) ||
      /\bturn(?:\s+[a-z]+){0,3}\s+on\b/.test(normalized) ||
      containsAny(normalized, ["disable", "turn off", "pause", "stop sharing", "hide my location"]) ||
      /\bturn(?:\s+[a-z]+){0,3}\s+off\b/.test(normalized));
  if (resumeOrPause) {
    const wantsPause =
      containsAny(normalized, ["disable", "turn off", "pause", "stop sharing", "hide my location"]) ||
      /\bturn(?:\s+[a-z]+){0,3}\s+off\b/.test(normalized);
    const actionId = wantsPause ? "location.pause_updates" : "location.resume_updates";
    const action = getKaiActionById(actionId);
    if (!action || !isAllowed(actionId, context)) {
      return {
        ...resultBase(context, "unsupported"),
        confidence: 0.9,
        reason: "action_unavailable",
      };
    }
    return {
      ...resultBase(context, "action"),
      actionId,
      confidence: 0.91,
    };
  }
  return null;
}

function candidateFromResolution(
  resolution: IntentResolution,
  action: KaiActionDefinition,
): LocalIntentCandidate {
  return {
    actionId: action.action_id,
    agentNamespace: agentNamespaceForAction(action),
    slots: resolution.slots,
    text: actionText(action),
    lexicalScore: resolution.confidence,
    explicit: true,
  };
}

/**
 * Generate only bounded candidates from the authored gateway. This is the
 * input to a semantic ranker; it is not an execution or authorization path.
 */
export function generateLocalIntentCandidates(
  utterance: string,
  context: OneVoiceIntentContext,
): LocalIntentCandidate[] {
  const special = resolveLocationSpecialCase(utterance, context);
  if (special?.disposition === "action" && special.actionId) {
    const action = getKaiActionById(special.actionId);
    return action ? [candidateFromResolution(special, action)] : [];
  }
  const query = normalizeText(utterance);
  return CATALOG_ACTIONS.map((action) => scoreCandidate(query, action))
    .filter(
      (candidate) =>
        candidate.score > 0 &&
        isAllowed(candidate.action.action_id, context) &&
        isLocallyExecutable(candidate.action),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.action.action_id.localeCompare(right.action.action_id),
    )
    .slice(0, 12)
    .map((candidate) => ({
      actionId: candidate.action.action_id,
      agentNamespace: agentNamespaceForAction(candidate.action),
      slots: extractGeneratedSlots(candidate.action, utterance),
      text: actionText(candidate.action),
      lexicalScore: candidate.score,
      explicit: candidate.explicit,
    }));
}

export function extractGeneratedSlots(
  action: KaiActionDefinition,
  query: string,
): Record<string, string | number | boolean> {
  const slots: Record<string, string | number | boolean> = {};
  const normalizedQuery = normalizeText(query);
  for (const input of action.goal.required_inputs) {
    const slot = input.slot || input.name;
    const resolver = input.resolver || "";
    if (resolver === "location_share_duration") {
      const duration = parseLocalDuration(normalizedQuery, {
        allowedMinutes: [15, 30, 60, 120, 240, 480, 1440],
      });
      if (duration) slots[slot] = duration.minutes / 60;
      continue;
    }
    if (resolver === "nearby_check_in_duration_minutes") {
      const duration = parseLocalDuration(normalizedQuery, {
        allowedMinutes: [15, 30, 60, 120, 240, 480, 1440],
      });
      if (duration) slots[slot] = duration.minutes;
      continue;
    }
    if (resolver === "on_or_off") {
      if (containsAny(normalizedQuery, ["on", "enable", "enabled", "true"])) {
        slots[slot] = true;
      } else if (containsAny(normalizedQuery, ["off", "disable", "disabled", "false"])) {
        slots[slot] = false;
      }
      continue;
    }
    if (
      resolver === "spoken_circle_name" ||
      resolver === "spoken_place_name" ||
      resolver === "spoken_person_name" ||
      resolver === "spoken_person_name_list"
    ) {
      const value = extractGeneratedSlotValue(action.action_id, slot, query);
      if (value) slots[slot] = value;
    }
  }
  return slots;
}

function extractGeneratedSlotValue(
  actionId: string,
  slot: string,
  query: string,
): string | null {
  // Keep extraction bounded and authored by the generated slot resolver. The
  // value is still only a spoken candidate; the mounted Location handler or
  // backend service resolves it against governed application data.
  if (actionId === "location.add_to_circle" && slot === "person") {
    const match = query.match(
      /\b(?:add|invite|put)\s+(.+?)\s+(?:to|into|in)\s+(?:the\s+)?(?:circle\s+)?[^\s].*$/i,
    );
    if (match?.[1]) return match[1].trim().slice(0, 128);
  }
  if (
    (actionId === "location.add_to_circle" ||
      actionId === "location.remove_from_circle") &&
    slot === "circle"
  ) {
    const match = query.match(
      /\b(?:to|into|in|from)\s+(?:the\s+)?(?:circle\s+)?(.+?)(?:\s+circle)?$/i,
    );
    if (match?.[1]) return match[1].trim().slice(0, 128);
  }
  if (actionId === "location.rename_circle") {
    const match = query.match(
      /\brename\s+(?:the\s+)?circle\s+(.+?)\s+to\s+(.+)$/i,
    );
    if (match?.[1] && slot === "circle") return match[1].trim().slice(0, 128);
    if (match?.[2] && slot === "name") return match[2].trim().slice(0, 128);
  }
  if (slot === "person") {
    const match = query.match(
      /\b(?:with|from|for|to)\s+(.+?)(?=\s+for\s+(?:\d|one|two|three|four|five|ten|fifteen|thirty|sixty)|$)/i,
    );
    if (match?.[1]) return match[1].trim().slice(0, 128);
  }
  if (slot === "circle") {
    const match = query.match(
      /\b(?:circle|group)\s+(?:called|named)?\s*(.+?)(?:\s+circle)?$/i,
    );
    if (match?.[1]) return match[1].trim().slice(0, 128);
  }
  if (slot === "name" && actionId === "location.rename_circle") {
    const value = extractSpokenEntity(query, ["to"]);
    if (value) return value;
  }
  return extractSpokenEntity(query, ["called", "named", "call it"]);
}

/**
 * Resolve language into a bounded generated-catalog proposal. This function
 * only generates/ranks candidates; executeAgentGatewayAction remains the
 * execution authority and applies the live inventory, consent and ledger.
 */
export function resolveLocalIntent(
  utterance: string,
  context: OneVoiceIntentContext,
): IntentResolution {
  const special = resolveLocationSpecialCase(utterance, context);
  if (special) return special;

  const query = normalizeText(utterance);
  const candidates = CATALOG_ACTIONS.map((action) => scoreCandidate(query, action))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.action.action_id.localeCompare(right.action.action_id));
  const top = candidates[0];
  if (!top || top.score < 8) {
    return { ...resultBase(context, "unsupported"), reason: "unsupported_language" };
  }
  if (!isAllowed(top.action.action_id, context)) {
    return {
      ...resultBase(context, "unsupported"),
      confidence: Math.min(0.9, top.score / 100),
      reason: "action_unavailable",
    };
  }
  if (!isLocallyExecutable(top.action)) {
    return {
      ...resultBase(context, "unsupported"),
      confidence: Math.min(0.9, top.score / 100),
      reason: "action_unavailable",
    };
  }
  const second = candidates[1];
  if (second && second.score >= top.score - 2 && !top.explicit && !second.explicit) {
    return {
      ...resultBase(context, "clarify"),
      confidence: 0.5,
      reason: "ambiguous",
    };
  }
  const slots = extractGeneratedSlots(top.action, utterance);
  const missingSlots = top.action.goal.required_inputs
    .filter((input) => input.required !== false)
    .map((input) => input.slot || input.name)
    .filter((slot) => slots[slot] === undefined)
    .slice(0, 1);
  if (missingSlots.length > 0) {
    return {
      ...resultBase(context, "clarify"),
      agentNamespace: agentNamespaceForAction(top.action),
      actionId: top.action.action_id,
      slots,
      missingSlots,
      confidence: Math.min(0.94, Math.max(0.55, top.score / 100)),
    };
  }
  return {
    ...resultBase(context, "action"),
    agentNamespace: agentNamespaceForAction(top.action),
    actionId: top.action.action_id,
    slots,
    confidence: Math.min(0.96, Math.max(0.55, top.score / 100)),
  };
}

export type LocalIntentResolverInput = {
  utterance: string;
  context: OneVoiceIntentContext;
  catalogVersion: string;
};

export interface OneVoiceIntentResolver {
  resolve(input: LocalIntentResolverInput): Promise<IntentResolution>;
  dispose?: () => void;
}

export class CatalogBoundOneVoiceIntentResolver implements OneVoiceIntentResolver {
  constructor(
    private readonly options: {
      ranker?: OneVoiceIntentRanker | null;
      minimumConfidence?: number;
      minimumMargin?: number;
    } = {},
  ) {}

  dispose(): void {
    this.options.ranker?.dispose?.();
  }

  async resolve(input: LocalIntentResolverInput): Promise<IntentResolution> {
    const baseline = resolveLocalIntent(input.utterance, input.context);
    // Read answers and explicit safety outcomes are terminal policy results.
    // A semantic ranker may not turn them into a mutation merely because the
    // utterance shares words with an executable action.
    if (
      baseline.disposition === "read_answer" ||
      baseline.reason === "empty_request" ||
      baseline.reason === "ambiguous" ||
      baseline.reason === "sos_send_blocked" ||
      baseline.reason === "action_unavailable"
    ) {
      return baseline;
    }
    const candidates = generateLocalIntentCandidates(
      input.utterance,
      input.context,
    );
    if (!this.options.ranker || candidates.length === 0) return baseline;
    try {
      const ranked = await this.options.ranker.rank({
        utterance: input.utterance,
        context: input.context,
        candidates,
      });
      if (!ranked) {
        return { ...baseline, disposition: "clarify", reason: "ambiguous" };
      }
      if (
        ranked.confidence < (this.options.minimumConfidence ?? 0.78) ||
        ranked.margin < (this.options.minimumMargin ?? 0.12)
      ) {
        return { ...baseline, disposition: "clarify", reason: "ambiguous" };
      }
      return rankerResultToResolution(ranked, candidates, input.context) ?? {
        ...resultBase(input.context, "unsupported"),
        disposition: "unsupported",
        reason: "local_model_unavailable",
      };
    } catch {
      // A local model failure is a provider-selection event, not permission
      // to broaden the candidate set. The generated-catalog fallback keeps
      // already-supported deterministic commands usable while the caller may
      // explicitly choose its hybrid provider path.
      return baseline;
    }
  }
}

export function resolveLocalIntentAsync(
  input: LocalIntentResolverInput,
  options?: ConstructorParameters<typeof CatalogBoundOneVoiceIntentResolver>[0],
): Promise<IntentResolution> {
  return new CatalogBoundOneVoiceIntentResolver(options).resolve(input);
}
