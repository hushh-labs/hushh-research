"use client";

import type {
  AppRuntimeState,
  VoiceSurfaceActionDefinition,
  VoiceSurfaceConceptDefinition,
  VoiceSurfaceControlDefinition,
  VoiceSurfaceSectionDefinition,
} from "@/lib/voice/voice-types";
import {
  getKaiActionById,
  getKaiActionsForControlId,
} from "@/lib/voice/kai-action-gateway";
import { listInvestorKaiActionsForSurface } from "@/lib/voice/investor-kai-action-registry";
import {
  getVoiceSurfaceMetadata,
  type VoiceInteractionLayerV1,
  type VoiceSurfaceMetadata,
} from "@/lib/voice/voice-surface-metadata";
import { resolveAppRouteLayout } from "@/lib/navigation/app-route-layout";
import { hasMountedLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import type {
  OneVoiceTransition,
  OneVoiceUiState,
} from "@/lib/voice/voice-ui-state-machine";

export const STRUCTURED_CONTEXT_ARRAY_CAP = 10;
/**
 * The screen-owned segment of available_action_ids specifically, separate
 * from STRUCTURED_CONTEXT_ARRAY_CAP because that constant is also the default
 * bound for arrays with their own, independent backend limit (visible_modules
 * and visible_control_ids are both truncated server-side at 10 regardless of
 * what this file sends) -- widening it there would not add capacity, only
 * hide where the real truncation happens.
 *
 * This has been wrong repeatedly at the generic 10: Location outgrew it at
 * 19 published controls, then again as its own actions grew past 21 to 30,
 * and again once its real local-handler count reached 28 -- comfortably past
 * what any flat number here can hold. Each time, new local handlers
 * (`add_to_circle`, `remove_from_circle`, ...) fell off the end of a list
 * already full of route openers, and every one of them returned
 * action_unavailable, indistinguishable from a broken feature.
 *
 * 14 is deliberately NOT sized to fit every screen-owned handler at once --
 * that stopped being possible once Location passed ~14 of its own. Instead,
 * SUBVIEW_ACTION_BOOST ranks whichever handlers match the person's current
 * subview (which circle dialog is open, which tab, ...) into the surviving
 * slots first, so a crowded screen loses the actions nobody is looking at
 * right now rather than whichever happened to be declared last.
 * AVAILABLE_ACTION_IDS_CAP (18) still bounds the total, so a crowded screen
 * trades a few of the 8 GLOBAL_NAV_ACTION_IDS slots for commands that
 * actually do something on it.
 */
export const ACTION_ID_SCREEN_SEGMENT_CAP = 14;
// A surface's own declared inventory before ranking. Deliberately far above
// what any surface declares today (Location, the largest, publishes 30), so it
// bounds a runaway publisher without ever deciding which actions the model is
// allowed to see. That decision belongs to prioritizeAvailableActionIds and the
// two caps applied after it.
export const PUBLISHED_ACTION_IDS_CAP = 64;
/**
 * available_action_ids carries the screen-ranked list PLUS a reserved global
 * navigation segment, so it gets a wider cap than other context arrays. The
 * backend mirrors this value (Pydantic max_length + persona sanitize limit);
 * keep all three in sync.
 */
export const AVAILABLE_ACTION_IDS_CAP = 18;
/**
 * Cross-screen navigation contracts that must ALWAYS be visible to the model,
 * regardless of the current screen. Without this reserved segment, strict
 * screen filtering plus the context cap made "go to profile" undiscoverable
 * from any non-profile tab: the model was never told route.profile existed.
 * One id per top-level agent surface.
 */
export const GLOBAL_NAV_ACTION_IDS: readonly string[] = [
  "route.one_agents",
  "route.kai_home",
  "route.ria_home",
  "route.profile",
  "route.one_location",
  "route.one_pkm",
  "route.consents",
  "route.profile_connected_systems",
];

const RIA_ROUTE_NAV_ACTION_IDS: readonly string[] = [
  "route.ria_profile",
  "route.ria_clients",
  "route.ria_picks",
];

const SCREEN_FAMILY_NAV_ACTION_IDS: Record<string, readonly string[]> = {
  profile_regulatory: RIA_ROUTE_NAV_ACTION_IDS,
  ria_clients: RIA_ROUTE_NAV_ACTION_IDS,
  ria_picks: RIA_ROUTE_NAV_ACTION_IDS,
};

function isScreenFamilyNavigationAction(
  screen: string | null,
  actionId: string,
): boolean {
  return Boolean(
    screen && SCREEN_FAMILY_NAV_ACTION_IDS[screen]?.includes(actionId),
  );
}
export const ARRAY_DIMENSION_CAP_ERROR =
  "CONSTRAINT_VIOLATION_DIMENSION_OVERFLOW";
export const INVALID_ARRAY_TYPE_ERROR = "INVALID_ARRAY_TYPE";

export type ArrayDimensionCapResult<T> = {
  isValidAllocation: boolean;
  items: T[];
  errorLabel: string | null;
};

export function enforceArrayDimensionCap<T>(
  incomingDataList: readonly T[] | null | undefined,
  maximumDimensionCap = STRUCTURED_CONTEXT_ARRAY_CAP,
): ArrayDimensionCapResult<T> {
  if (!Array.isArray(incomingDataList)) {
    return {
      isValidAllocation: false,
      items: [],
      errorLabel: INVALID_ARRAY_TYPE_ERROR,
    };
  }

  if (incomingDataList.length > maximumDimensionCap) {
    return {
      isValidAllocation: false,
      items: incomingDataList.slice(0, maximumDimensionCap),
      errorLabel: ARRAY_DIMENSION_CAP_ERROR,
    };
  }

  return {
    isValidAllocation: true,
    items: [...incomingDataList],
    errorLabel: null,
  };
}

export type StructuredScreenContext = {
  route: {
    pathname: string;
    screen: string;
    subview?: string | null;
    page_title?: string | null;
    nav_stack: string[];
  };
  ui: {
    active_section?: string | null;
    visible_modules: string[];
    selected_entity?: string | null;
    /** Opt-in, safe-to-speak subject of the screen (e.g. a ticker). */
    spoken_subject?: string | null;
    /** Present only while the screen cannot proceed without leaving it. */
    dead_end?: { reason: string; remedy_action_id: string } | null;
    active_tab?: string | null;
    modal_state?: string | null;
    focused_widget?: string | null;
    active_filters: string[];
    search_query?: string | null;
    selected_objects: string[];
    available_actions: string[];
  };
  runtime: {
    busy_operations: string[];
    analysis_active: boolean;
    analysis_ticker?: string | null;
    analysis_run_id?: string | null;
    import_active: boolean;
    import_run_id?: string | null;
  };
  auth: {
    signed_in: boolean;
    user_id?: string | null;
  };
  persona: {
    active: string;
    primary_nav: string;
    available: string[];
    transition_target?: string | null;
    ria_switch_available: boolean;
    ria_setup_available: boolean;
  };
  vault: {
    unlocked: boolean;
    token_available: boolean;
    token_valid: boolean;
  };
  surface: {
    screen_id?: string | null;
    title?: string | null;
    purpose?: string | null;
    primary_entity?: string | null;
    sections: Array<{
      id: string;
      title: string;
      purpose?: string | null;
      summary?: string | null;
    }>;
    actions: Array<{
      id: string;
      action_id?: string | null;
      label: string;
      purpose?: string | null;
      description?: string | null;
      voice_aliases?: string[];
    }>;
    controls: Array<{
      id: string;
      label: string;
      type?: string | null;
      state?: string | null;
      purpose?: string | null;
      description?: string | null;
      action_id?: string | null;
      role?: string | null;
      voice_aliases?: string[];
    }>;
    concepts: Array<{
      id?: string | null;
      label: string;
      description?: string | null;
      explanation?: string | null;
      aliases?: string[];
    }>;
    active_control_id?: string | null;
    last_interacted_control_id?: string | null;
    interaction_layer?: StructuredVoiceInteractionLayer | null;
  };
  one_voice_context?: OneVoiceContextSnapshot;
  screen_metadata: Record<string, unknown>;
};

export type OneVoiceInteractionLayerSnapshot = {
  layer_id: string;
  kind: string;
  modality: VoiceInteractionLayerV1["modality"];
  lifecycle_state: VoiceInteractionLayerV1["lifecycle"];
  dismissible: boolean;
  dismiss_action_id?: string | null;
  visible_action_ids: string[];
  visible_control_ids: string[];
  options: Array<{
    id: string;
    label: string;
    action_id?: string | null;
    description?: string | null;
  }>;
  underlying_actions_available: boolean;
  agent_continuity: VoiceInteractionLayerV1["agentContinuity"];
};

export type StructuredVoiceInteractionLayer = OneVoiceInteractionLayerSnapshot;

export type OneVoiceContextSnapshot = {
  schema_version: "one_voice_context.v1";
  snapshot_id: string;
  revisions: {
    route: string;
    ui: string;
    cache: string;
    persona: string;
    voice: number;
  };
  route: {
    screen: string;
    playbook_id: string;
    subview?: string | null;
    route_family: string;
    /** Sorted, allowlisted structural query that selects among same-path screens. */
    route_query: string;
    nav_stack: string[];
  };
  ui: {
    visible_modules: string[];
    visible_control_ids: string[];
    active_section?: string | null;
    active_tab?: string | null;
    selected_entity_present: boolean;
    /** Opt-in and speakable; selected_entity itself stays redacted. */
    spoken_subject?: string | null;
    /** Present only while the screen cannot proceed without leaving it. */
    dead_end?: { reason: string; remedy_action_id: string } | null;
    modal_state?: string | null;
    focused_widget?: string | null;
    interaction_layer?: StructuredVoiceInteractionLayer | null;
  };
  available_action_ids: string[];
  /** Redacted admission bit only; never an account identifier. */
  auth?: {
    signed_in: boolean;
  };
  pending_settlement: boolean;
  cache: {
    vault_ready: boolean;
    portfolio_ready: boolean;
    busy_operations: string[];
    freshness: "fresh_or_stale_safe" | "locked" | "missing";
  };
  persona: {
    active: string;
    primary_nav: string;
    available: string[];
  };
  onboarding: {
    phase:
      | "anonymous_auth"
      | "phone_required"
      | "setup_hub"
      | "capability_setup"
      | "external_connector"
      | "root_completion";
    active_capability?: string | null;
    root_resolved: boolean;
    return_route: string;
    phone_verified?: boolean | null;
    callback_state: "none" | "pending" | "succeeded" | "cancelled" | "failed";
    setup_capability_ids: string[];
  };
  /** The person's own restrictions on their already-authorized voice agent. */
  voice_settings: {
    voice_enabled: boolean;
    require_tap_confirmation: boolean;
    disabled_domains: string[];
  };
  voice: {
    state: OneVoiceUiState;
    transition_seq: number;
    session_id?: string | null;
    source_id?: string | null;
    last_transition?: OneVoiceTransition | null;
  };
  world_model: {
    summary_available: boolean;
    mode: "redacted_summary_only";
  };
  privacy: {
    redacted: true;
    excludes: string[];
  };
};

function mapInteractionLayer(
  layer: VoiceInteractionLayerV1 | null | undefined,
): OneVoiceInteractionLayerSnapshot | null {
  if (!layer) return null;
  return {
    layer_id: layer.id,
    kind: layer.kind,
    modality: layer.modality,
    lifecycle_state: layer.lifecycle,
    dismissible: layer.dismissible,
    dismiss_action_id: layer.dismissActionId || null,
    visible_action_ids: enforceArrayDimensionCap(layer.visibleActionIds).items,
    visible_control_ids: enforceArrayDimensionCap(layer.visibleControlIds)
      .items,
    options: enforceArrayDimensionCap(
      layer.options.map((option) => ({
        id: option.id,
        label: option.label,
        action_id: option.actionId || null,
        description: option.description || null,
      })),
    ).items,
    underlying_actions_available: !layer.blocksUnderlyingActions,
    agent_continuity: layer.agentContinuity,
  };
}

function domSafeQueryText(selector: string): string | null {
  if (typeof document === "undefined") return null;
  const node = document.querySelector(selector);
  const value = node?.textContent?.trim();
  return value || null;
}

function collectVisibleModules(): string[] {
  if (typeof document === "undefined") return [];
  const selectors = [
    "[data-voice-module]",
    "[data-module-name]",
    "[data-card-name]",
    "section[aria-label]",
    "[role='region'][aria-label]",
  ];
  const values = new Set<string>();
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      const el = node as HTMLElement;
      const label =
        el.getAttribute("data-voice-module") ||
        el.getAttribute("data-module-name") ||
        el.getAttribute("data-card-name") ||
        el.getAttribute("aria-label") ||
        "";
      const clean = label.trim();
      if (clean) values.add(clean.slice(0, 64));
    });
  });
  return enforceArrayDimensionCap(Array.from(values)).items;
}

function readUrlSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(name);
  const clean = value?.trim();
  return clean || null;
}

function uniqueStrings(
  values: unknown[],
  maximumDimensionCap = STRUCTURED_CONTEXT_ARRAY_CAP,
): string[] {
  const out = new Set<string>();
  values.forEach((value) => {
    if (typeof value !== "string") return;
    const clean = value.trim();
    if (!clean) return;
    out.add(clean);
  });
  return enforceArrayDimensionCap(Array.from(out), maximumDimensionCap).items;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeRouteFamily(pathname: string): string {
  const path = pathname.split("?")[0] || "/";
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        decoded = ":id";
      }
      if (
        decoded.length > 40 ||
        /^[0-9a-f]{8,}$/i.test(decoded) ||
        /^[0-9]+$/.test(decoded) ||
        decoded.includes("@")
      ) {
        return ":id";
      }
      return decoded.toLowerCase();
    });
  return segments.length ? `/${segments.join("/")}` : "/";
}

/**
 * Query parameters that select WHICH screen a shared path is showing.
 *
 * Deliberately an allowlist, not a passthrough: route_family redacts
 * identifiers, so sending a raw query alongside it would reopen exactly the
 * leak that redaction closes. Every key here is structural navigation state
 * declared by the generated contracts (tab/view/focus/source/category);
 * identifier-bearing params such as clientId are excluded on purpose.
 */
const STRUCTURAL_ROUTE_QUERY_KEYS = [
  "tab",
  "view",
  "focus",
  "source",
  "category",
] as const;

/**
 * Sorted `key=value` pairs for the structural params present in `pathname`.
 *
 * Sorted so the value is stable across navigations that differ only in
 * parameter order; the relay matches on pairs, never on the literal string.
 */
function sanitizeRouteQuery(pathname: string): string {
  const rawQuery = pathname.split("?")[1];
  if (!rawQuery) return "";
  const params = new URLSearchParams(rawQuery);
  const pairs: string[] = [];
  for (const key of STRUCTURAL_ROUTE_QUERY_KEYS) {
    const value = params.get(key);
    if (!value) continue;
    const clean = value.trim().slice(0, 40);
    if (clean) pairs.push(`${key}=${clean}`);
  }
  return pairs.sort().join("&");
}

function readStringArray(
  value: unknown,
  maximumDimensionCap = STRUCTURED_CONTEXT_ARRAY_CAP,
): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value, maximumDimensionCap)
    : [];
}

/**
 * Local-handler actions relevant to a specific subview (the `action` or
 * `view` query param a screen's own route derivation already resolves --
 * see route-screen-derivation.ts). Keyed by `${screen}:${subview}`, with
 * `${screen}:` (empty subview) as the default set for that screen's bare
 * route. Only screens whose local-handler count has actually outgrown
 * ACTION_ID_SCREEN_SEGMENT_CAP need an entry here -- as of writing, that is
 * Location alone (28 screen-owned local handlers competing for 14 slots).
 *
 * This boosts matches to the top rank in `rankOf` below; it never demotes
 * anything. An action absent from the current subview's list still competes
 * at the ordinary screen-owned tier, so an incomplete or stale mapping can
 * only fail to help -- it cannot make today's insertion-order tiebreak worse.
 */
const SUBVIEW_ACTION_BOOST: Readonly<Record<string, readonly string[]>> = {
  // Bare /one/location, no open flow: what someone is most likely to ask for
  // without having drilled into a specific circle or share first.
  "one_location:": [
    "location.pause_updates",
    "location.resume_updates",
    "location.stop_share",
    "location.approve_request",
    "location.decline_request",
  ],
  "one_location:create-circle": ["location.create_circle"],
  "one_location:share": [
    "location.select_share_recipient",
    "location.share_selected",
    "location.change_share_duration",
    "location.set_auto_share",
  ],
  "one_location:ask": ["location.select_ask_recipient", "location.send_request"],
  "one_location:active-shares": [
    "location.stop_share",
    "location.change_share_duration",
  ],
  "one_location:needs-review": [
    "location.approve_request",
    "location.decline_request",
  ],
  "one_location:shared-with-me": ["location.change_share_duration"],
  "one_location:settings": [
    "location.pause_updates",
    "location.resume_updates",
    "location.set_auto_share",
    "location.add_emergency_contact",
    "location.remove_emergency_contact",
  ],
  "one_location:sos": ["location.trigger_sos", "location.stop_sos"],
  // The People tab is where circle membership is actually managed.
  "one_location:people": [
    "location.add_to_circle",
    "location.remove_from_circle",
    "location.rename_circle",
    "location.leave_circle",
    "location.delete_circle",
    "location.accept_circle_invite",
    "location.decline_circle_invite",
  ],
};

/**
 * Rank action ids by relevance BEFORE the 10-item context cap slices them, so
 * the tail that gets dropped is always the least useful part. Priority order:
 *   1. wired, screen-owned local handlers matching the current subview
 *      (SUBVIEW_ACTION_BOOST) -- what the person is actually looking at
 *   2. other wired actions whose contract lists the current screen
 *      (in-place intent, just not tied to the active subview)
 *   3. other wired actions (mostly cross-screen route.* navigation)
 *   4. unwired/dead/unknown ids (guidance-only value)
 * Set-insertion order previously made the truncation nondeterministic; this
 * keeps the same cap but makes what survives it intentional.
 */
function prioritizeAvailableActionIds(
  candidateIds: string[],
  screen: string | null,
  includeGlobalNavigation = true,
  subview: string | null = null,
): string[] {
  const boosted = new Set(
    SUBVIEW_ACTION_BOOST[`${screen || ""}:${subview || ""}`] || [],
  );
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidateIds) {
    if (typeof raw !== "string") continue;
    const clean = raw.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    deduped.push(clean);
  }
  const rankOf = (actionId: string): number => {
    const action = getKaiActionById(actionId);
    if (!action || action.execution_target.status !== "wired") {
      // An id the generated gateway does not know (or an unwired one) ranks
      // last and can silently fall off the cap. Surface it in dev so
      // contract drift is caught before it reads as "action not detected".
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[VOICE_CONTEXT] published action id is",
          action ? "unwired" : "unknown to the generated gateway",
          ":",
          actionId,
        );
      }
      return 4;
    }
    if (isScreenFamilyNavigationAction(screen, actionId)) {
      return action.execution_target.path === "route" ? 0 : 1;
    }
    if (screen && action.reachability.screens.includes(screen)) {
      // Among the actions this screen owns, the ones that cannot be reached
      // any other way come first, and within those, the ones tied to
      // whatever subview is actually open right now come first of all --
      // see SUBVIEW_ACTION_BOOST. A screen with more local handlers than the
      // cap can hold should lose the ones the person is not looking at, not
      // whichever happened to be declared first.
      //
      // A route action that loses its slot is still reachable: the relay
      // admits navigation from any screen whether or not it was submitted
      // here. A local handler that loses its slot is simply gone, and comes
      // back from the relay as `action_unavailable` -- which reads as a
      // broken feature rather than as a full context array.
      //
      // Without this, a surface with more actions than the cap drops
      // whichever happen to be declared last. On Location that was every
      // action that DOES something, while nineteen ways to open a tab kept
      // their slots.
      if (action.execution_target.path === "route") return 2;
      return boosted.has(actionId) ? 0 : 1;
    }
    return 3;
  };
  const ranked = deduped
    .map((actionId, index) => ({ actionId, index, rank: rankOf(actionId) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.actionId);
  if (
    ranked.length > ACTION_ID_SCREEN_SEGMENT_CAP &&
    process.env.NODE_ENV !== "production"
  ) {
    // Loud, and it names what was lost. This was a console.debug, and the
    // truncation it describes is invisible in the product: a dropped id comes
    // back from the relay as `action_unavailable`, which reads as "this
    // feature is broken" rather than "this screen declared more than the
    // context can carry". Location growing to 19 actions is what found it.
    //
    // Route-executing actions survive the cut in practice, because the relay
    // admits navigation from any screen whether or not it was submitted here.
    // So the ids that genuinely go missing are the local handlers, which is
    // what naming them makes obvious.
    const dropped = ranked.slice(ACTION_ID_SCREEN_SEGMENT_CAP);
    console.warn(
      `[VOICE_CONTEXT] ${screen || "unknown screen"} declared ${ranked.length} ` +
        `action ids but only ${ACTION_ID_SCREEN_SEGMENT_CAP} fit. ` +
        `Dropped: ${dropped.join(", ")}`,
    );
  }
  // Screen-ranked segment first (own cap, wider than the generic array
  // default -- see ACTION_ID_SCREEN_SEGMENT_CAP), then the reserved global
  // navigation segment so cross-agent navigation is always proposable. The
  // combined list stays within AVAILABLE_ACTION_IDS_CAP, which the backend
  // accepts (Pydantic max_length is kept in sync).
  const screenSegment = enforceArrayDimensionCap(
    ranked,
    ACTION_ID_SCREEN_SEGMENT_CAP,
  ).items;
  if (!includeGlobalNavigation) return screenSegment;
  const combined = [...screenSegment];
  for (const navId of [
    ...(screen ? SCREEN_FAMILY_NAV_ACTION_IDS[screen] || [] : []),
    ...GLOBAL_NAV_ACTION_IDS,
  ]) {
    if (combined.length >= AVAILABLE_ACTION_IDS_CAP) break;
    if (combined.includes(navId)) continue;
    if (!getKaiActionById(navId)) continue;
    combined.push(navId);
  }
  return combined;
}

function stableRevision(values: unknown[]): string {
  const encoded = JSON.stringify(values);
  let hash = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    hash = (hash * 31 + encoded.charCodeAt(index)) | 0;
  }
  return `r${(hash >>> 0).toString(36)}`;
}

function mapSections(sections: VoiceSurfaceSectionDefinition[] | undefined) {
  return Array.isArray(sections)
    ? enforceArrayDimensionCap(
        sections.map((section) => ({
          id: section.id,
          title: section.title,
          purpose: section.purpose || null,
          summary: section.summary || null,
        })),
      ).items
    : [];
}

function mapActions(actions: VoiceSurfaceActionDefinition[] | undefined) {
  return Array.isArray(actions)
    ? enforceArrayDimensionCap(
        actions.map((action) => ({
          id: action.id,
          action_id: action.actionId || null,
          label: action.label,
          purpose: action.purpose || null,
          description: action.description || null,
          voice_aliases: Array.isArray(action.voiceAliases)
            ? enforceArrayDimensionCap(action.voiceAliases).items
            : undefined,
        })),
      ).items
    : [];
}

function mapControls(controls: VoiceSurfaceControlDefinition[] | undefined) {
  return Array.isArray(controls)
    ? enforceArrayDimensionCap(
        controls.map((control) => ({
          id: control.id,
          label: control.label,
          type: control.type || null,
          state: control.state || null,
          purpose: control.purpose || null,
          description: control.description || null,
          action_id:
            control.actionId ||
            getKaiActionsForControlId(control.id)[0]?.action_id ||
            null,
          role: control.role || null,
          voice_aliases: Array.isArray(control.voiceAliases)
            ? enforceArrayDimensionCap(control.voiceAliases).items
            : undefined,
        })),
      ).items
    : [];
}

function mapConcepts(
  concepts: Array<VoiceSurfaceConceptDefinition | string> | undefined,
) {
  return Array.isArray(concepts)
    ? enforceArrayDimensionCap(
        concepts.map((concept) =>
          typeof concept === "string"
            ? {
                id: null,
                label: concept,
                description: null,
                explanation: null,
                aliases: undefined,
              }
            : {
                id: concept.id || null,
                label: concept.label,
                description: concept.description || null,
                explanation: concept.explanation || null,
                aliases: Array.isArray(concept.aliases)
                  ? enforceArrayDimensionCap(concept.aliases).items
                  : undefined,
              },
        ),
      ).items
    : [];
}

export function buildStructuredScreenContext(args: {
  appRuntimeState?: AppRuntimeState;
  voiceContext?: Record<string, unknown>;
  /** The subscribed page-owned inventory when running inside React. */
  surfaceMetadata?: VoiceSurfaceMetadata | null;
}): StructuredScreenContext {
  const app = args.appRuntimeState;
  const rawContext = args.voiceContext || {};
  const publishedSurface = args.surfaceMetadata ?? getVoiceSurfaceMetadata();

  const pathname =
    app?.route.pathname || String(rawContext.route || "").trim() || "";
  const screen = app?.route.screen || "unknown";
  const subview = app?.route.subview || null;

  const pageTitle = domSafeQueryText("h1") || domSafeQueryText("title");
  const explicitPageTitle = publishedSurface?.title || null;
  const activeSection =
    publishedSurface?.activeSection ||
    (typeof rawContext.active_section === "string" &&
      rawContext.active_section.trim()) ||
    readUrlSearchParam("section") ||
    null;
  const activeTab =
    publishedSurface?.activeTab ||
    (typeof rawContext.active_tab === "string" &&
      rawContext.active_tab.trim()) ||
    readUrlSearchParam("tab") ||
    null;
  const selectedEntity =
    publishedSurface?.selectedEntity ||
    (typeof rawContext.selected_entity === "string" &&
      rawContext.selected_entity.trim()) ||
    (typeof rawContext.current_ticker === "string" &&
      rawContext.current_ticker.trim()) ||
    app?.runtime.analysis_ticker ||
    null;
  const explicitVisibleModules = uniqueStrings([
    ...(publishedSurface?.visibleModules || []),
    ...(publishedSurface?.sections || []).map((section) => section.title),
    ...(Array.isArray(rawContext.visible_modules)
      ? rawContext.visible_modules
      : []),
  ]);
  const visibleModules = uniqueStrings([
    ...explicitVisibleModules,
    ...collectVisibleModules(),
  ]);
  const activeFilters = uniqueStrings([
    ...(publishedSurface?.activeFilters || []),
    ...(Array.isArray(rawContext.active_filters)
      ? rawContext.active_filters
      : []),
  ]);
  const selectedObjects = uniqueStrings([
    ...(publishedSurface?.selectedObjects || []),
    ...(Array.isArray(rawContext.selected_objects)
      ? rawContext.selected_objects
      : []),
  ]);
  const surfaceBusyOperations = uniqueStrings([
    ...(publishedSurface?.busyOperations || []),
    ...(Array.isArray(rawContext.busy_operations)
      ? rawContext.busy_operations
      : []),
  ]);

  const navStack = uniqueStrings(
    pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => `/${segment}`),
  );

  const busyOps = Array.isArray(app?.runtime.busy_operations)
    ? app?.runtime.busy_operations
    : [];
  const routeActions = listInvestorKaiActionsForSurface({
    screen,
    href: pathname,
    pathname,
  });
  const activeInteractionLayer = publishedSurface?.interactionLayer || null;
  const underlyingActionsAvailable =
    !activeInteractionLayer || !activeInteractionLayer.blocksUnderlyingActions;
  // Deduplicated, and bounded only against a runaway surface -- never tightly
  // enough to decide WHICH actions the model sees. Ranking owns that, and the
  // real limits (10 for the screen segment, AVAILABLE_ACTION_IDS_CAP overall)
  // are applied after it.
  //
  // This has been wrong twice, the same way. The generic 10-wide cap applied
  // here first, so ranking written to protect local handlers was handed a list
  // they had already been cut from -- on Location the model was told the screen
  // offers ten ways to open a tab and nothing that acts. Re-capping at 18 then
  // fixed share_selected and select_share_recipient but still lost
  // `location.resume_updates`, because the surface's 18 controls fill the bound
  // before its `actions` array is even reached. A pre-cap that can silently
  // drop a wired handler is the bug, whatever its number.
  const publishedActionIds = uniqueStrings(
    [
      ...(publishedSurface?.controls || [])
        .map((control) => control.actionId || null)
        .filter((actionId): actionId is string => Boolean(actionId)),
      ...(publishedSurface?.actions || [])
        .map((action) => action.actionId || action.id)
        .filter((actionId): actionId is string => Boolean(actionId)),
    ],
    PUBLISHED_ACTION_IDS_CAP,
  );
  // A mounted surface with a declared inventory is authoritative for what is
  // executable now. Route contracts are the fallback only for pages that do
  // not publish their own controls. This keeps modal-only actions unavailable
  // until their matching control is actually visible.
  const currentRouteActionIds = publishedActionIds.length
    ? []
    : routeActions.map((action) => action.id);
  const derivedControlActionIds = uniqueStrings([
    ...getKaiActionsForControlId(publishedSurface?.activeControlId).map(
      (action) => action.action_id,
    ),
    ...getKaiActionsForControlId(publishedSurface?.lastInteractedControlId).map(
      (action) => action.action_id,
    ),
  ]);
  const availableActions = uniqueStrings([
    ...(underlyingActionsAvailable
      ? routeActions.map((action) => action.label)
      : []),
    ...(publishedSurface?.actions || []).map((action) => action.label),
    ...(publishedSurface?.availableActions || []),
    ...(Array.isArray(rawContext.available_actions)
      ? rawContext.available_actions
      : []),
  ]);
  const availableActionIds = prioritizeAvailableActionIds(
    [
      ...currentRouteActionIds,
      ...derivedControlActionIds,
      ...publishedActionIds,
    ],
    screen,
    // A mounted authored inventory is the current interaction authority.
    // Do not append global navigation behind an active setup terminal, dialog,
    // or other visible control; that would let a voice turn escape the page.
    underlyingActionsAvailable && publishedActionIds.length === 0,
    subview,
  );
  const screenMetadata = {
    ...readObject(rawContext.screen_metadata),
    ...readObject(publishedSurface?.screenMetadata),
    available_action_ids: availableActionIds,
    auth: {
      signed_in: args.appRuntimeState?.auth.signed_in === true,
    },
  };

  return {
    route: {
      pathname,
      screen,
      subview,
      page_title: explicitPageTitle || pageTitle,
      nav_stack: navStack,
    },
    ui: {
      active_section: activeSection,
      visible_modules: visibleModules,
      selected_entity: selectedEntity,
      // Opt-in and safe to say aloud, unlike selected_entity/primary_entity
      // which several surfaces fill with an investor name or email.
      spoken_subject: publishedSurface?.spokenSubject || null,
      // Normalized here rather than trusted as published: a half-filled dead
      // end (a reason with no remedy, or the reverse) would tell One something
      // is wrong while giving it nowhere to send the person.
      dead_end:
        publishedSurface?.deadEnd?.reason &&
        publishedSurface?.deadEnd?.remedyActionId
          ? {
              reason: publishedSurface.deadEnd.reason,
              remedy_action_id: publishedSurface.deadEnd.remedyActionId,
            }
          : null,
      active_tab: activeTab,
      modal_state:
        publishedSurface?.modalState ||
        (typeof rawContext.modal_state === "string" &&
          rawContext.modal_state.trim()) ||
        null,
      focused_widget:
        publishedSurface?.focusedWidget ||
        (typeof rawContext.focused_widget === "string" &&
          rawContext.focused_widget.trim()) ||
        null,
      active_filters: activeFilters,
      search_query:
        publishedSurface?.searchQuery ||
        (typeof rawContext.search_query === "string" &&
          rawContext.search_query.trim()) ||
        null,
      selected_objects: selectedObjects,
      available_actions: availableActions,
    },
    runtime: {
      busy_operations: uniqueStrings([...busyOps, ...surfaceBusyOperations]),
      analysis_active: Boolean(app?.runtime.analysis_active),
      analysis_ticker: app?.runtime.analysis_ticker || null,
      analysis_run_id: app?.runtime.analysis_run_id || null,
      import_active: Boolean(app?.runtime.import_active),
      import_run_id: app?.runtime.import_run_id || null,
    },
    auth: {
      signed_in: Boolean(app?.auth.signed_in),
      user_id: app?.auth.user_id || null,
    },
    persona: {
      active: app?.persona?.active || "investor",
      primary_nav:
        app?.persona?.primary_nav || app?.persona?.active || "investor",
      available: Array.isArray(app?.persona?.available)
        ? [...app.persona.available]
        : ["investor"],
      transition_target: app?.persona?.transition_target || null,
      ria_switch_available: Boolean(app?.persona?.ria_switch_available),
      ria_setup_available: Boolean(app?.persona?.ria_setup_available),
    },
    vault: {
      unlocked: Boolean(app?.vault.unlocked),
      token_available: Boolean(app?.vault.token_available),
      token_valid: Boolean(app?.vault.token_valid),
    },
    surface: {
      screen_id: publishedSurface?.screenId || screen || null,
      title: publishedSurface?.title || pageTitle,
      purpose: publishedSurface?.purpose || null,
      primary_entity: publishedSurface?.primaryEntity || selectedEntity,
      sections: mapSections(publishedSurface?.sections),
      actions: mapActions(publishedSurface?.actions),
      controls: mapControls(publishedSurface?.controls),
      concepts: mapConcepts(publishedSurface?.concepts),
      active_control_id: publishedSurface?.activeControlId || null,
      last_interacted_control_id:
        publishedSurface?.lastInteractedControlId || null,
      interaction_layer: mapInteractionLayer(activeInteractionLayer),
    },
    screen_metadata: screenMetadata,
  };
}

export function buildOneVoiceContextSnapshot(args: {
  appRuntimeState?: AppRuntimeState;
  voiceContext?: Record<string, unknown>;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  structuredContext?: StructuredScreenContext;
  state?: OneVoiceUiState;
  lastTransition?: OneVoiceTransition | null;
  onboarding?: {
    phase: OneVoiceContextSnapshot["onboarding"]["phase"];
    activeCapability?: string | null;
    rootResolved?: boolean;
    returnRoute?: string | null;
    phoneVerified?: boolean | null;
    callbackState?: OneVoiceContextSnapshot["onboarding"]["callback_state"];
    setupCapabilityIds?: readonly string[];
  };
  voiceSettings?: {
    voiceEnabled?: boolean;
    requireTapConfirmation?: boolean;
    disabledDomains?: readonly string[];
  };
  requireMountedLocalHandlers?: boolean;
}): OneVoiceContextSnapshot {
  const publishedSurface =
    args.surfaceMetadata ?? getVoiceSurfaceMetadata();
  const structured =
    args.structuredContext ||
    buildStructuredScreenContext({
      appRuntimeState: args.appRuntimeState,
      voiceContext: args.voiceContext,
      surfaceMetadata: publishedSurface,
    });
  const app = args.appRuntimeState;
  // available_action_ids already comes out of buildStructuredScreenContext
  // ranked and bounded at AVAILABLE_ACTION_IDS_CAP (18), not the generic
  // 10-item default -- re-reading it through the default here silently
  // re-truncated an already-correct 14-item screen segment back down to 10,
  // in plain Set-insertion order rather than by rank, and cost the two
  // lowest-index local handlers (add_to_circle, remove_from_circle) their
  // slot a second time even after the ranking-side cap was fixed.
  const publishedAvailableActionIds = readStringArray(
    structured.screen_metadata.available_action_ids,
    AVAILABLE_ACTION_IDS_CAP,
  );
  const vaultReady = Boolean(
    structured.vault.unlocked &&
      structured.vault.token_available &&
      structured.vault.token_valid,
  );
  const portfolioReady = Boolean(app?.portfolio.has_portfolio_data);
  const freshness = vaultReady
    ? portfolioReady || structured.ui.visible_modules.length > 0
      ? "fresh_or_stale_safe"
      : "missing"
    : "locked";
  const routePathname =
    args.appRuntimeState?.route.pathname || structured.route.pathname;
  const routeFamily = sanitizeRouteFamily(routePathname);
  const routeQuery = sanitizeRouteQuery(routePathname);
  const routeLayout = resolveAppRouteLayout(routeFamily);
  const routePlaybook = routeLayout.voicePlaybook;
  const publishedInteractionLayer =
    structured.surface.interaction_layer ?? null;
  const interactionLayerAllowed = Boolean(
    !publishedInteractionLayer ||
    routeLayout.interactionLayerPolicy.allowedFamilies.includes(
      publishedInteractionLayer.kind,
    ),
  );
  const activeInteractionLayer = interactionLayerAllowed
    ? publishedInteractionLayer
    : null;
  // An unapproved layer fails closed: its controls cannot become executable
  // merely because a component published them on the wrong route.
  const publisherRouteFamily = publishedSurface?.publisherRouteKey
    ? sanitizeRouteFamily(publishedSurface.publisherRouteKey)
    : null;
  const routeSurfaceCoherent =
    publisherRouteFamily === null || publisherRouteFamily === routeFamily;
  const availableBeforeHandlerCheck =
    interactionLayerAllowed && routeSurfaceCoherent
    ? publishedAvailableActionIds
    : [];
      const availableActionIds = args.requireMountedLocalHandlers
    ? availableBeforeHandlerCheck.filter((actionId) => {
        const action = getKaiActionById(actionId);
        if (!action || action.execution_target.status !== "wired") {
          return false;
        }
        return (
          action.execution_target.path !== "local_handler" ||
          hasMountedLocalOnboardingHandler(actionId)
        );
      })
    : availableBeforeHandlerCheck;
  const visibleControlIds = interactionLayerAllowed && routeSurfaceCoherent
    ? uniqueStrings(
        structured.surface.controls.map((control) => control.id || ""),
      )
    : [];
  const navStack = uniqueStrings(
    structured.route.nav_stack.map(sanitizeRouteFamily),
  );
  const transitionSeq = args.lastTransition?.transitionSeq ?? 0;
  const routeRevision = stableRevision([
    routeFamily,
    // The structural query is part of route identity, not decoration: two tabs
    // on one path are different screens. Including it here is what makes a tab
    // change -- by a voice action OR by the person tapping the tab themselves --
    // produce a new revision, which is the signal that republishes context.
    // Without it, a query-only navigation left the relay on a stale screen.
    routeQuery,
    structured.route.screen,
    structured.route.subview ?? null,
    navStack,
    routePlaybook.playbookId,
  ]);
  const uiRevision = stableRevision([
    structured.ui.visible_modules,
    structured.ui.active_section ?? null,
    structured.ui.active_tab ?? null,
    Boolean(structured.ui.selected_entity),
    // The value, not its presence: moving from QCOM to AAPL is a different
    // screen to a person, and presence-only left the revision unchanged so
    // nothing republished and One kept describing the previous stock.
    structured.ui.spoken_subject ?? null,
    // A dead end appearing or clearing changes what One should say next, so it
    // has to move the revision or the guidance would arrive a screen late.
    structured.ui.dead_end?.remedy_action_id ?? null,
    structured.ui.dead_end?.reason ?? null,
    structured.ui.modal_state ?? null,
    structured.ui.focused_widget ?? null,
    availableActionIds,
    visibleControlIds,
    activeInteractionLayer,
  ]);
  const cacheRevision = stableRevision([
    vaultReady,
    portfolioReady,
    freshness,
    structured.runtime.busy_operations,
  ]);
  const personaRevision = stableRevision([
    structured.persona.active,
    structured.persona.primary_nav,
    structured.persona.available,
  ]);
  const voiceRevision = transitionSeq;
  const onboarding = {
    phase: args.onboarding?.phase ?? "anonymous_auth",
    active_capability: args.onboarding?.activeCapability ?? null,
    root_resolved: args.onboarding?.rootResolved === true,
    return_route: sanitizeRouteFamily(
      args.onboarding?.returnRoute || "/one/setup",
    ),
    phone_verified: args.onboarding?.phoneVerified ?? null,
    callback_state: args.onboarding?.callbackState ?? "none",
    setup_capability_ids: uniqueStrings([
      ...(args.onboarding?.setupCapabilityIds || []),
    ]),
  };

  return {
    schema_version: "one_voice_context.v1",
    snapshot_id: `ctx_${stableRevision([
      routeRevision,
      uiRevision,
      cacheRevision,
      personaRevision,
      voiceRevision,
      onboarding,
    ])}`,
    revisions: {
      route: routeRevision,
      ui: uiRevision,
      cache: cacheRevision,
      persona: personaRevision,
      voice: voiceRevision,
    },
    route: {
      screen: structured.route.screen,
      playbook_id: routePlaybook.playbookId,
      subview: structured.route.subview ?? null,
      route_family: routeFamily,
      route_query: routeQuery,
      nav_stack: navStack,
    },
    ui: {
      visible_modules: structured.ui.visible_modules,
      visible_control_ids: visibleControlIds,
      active_section: structured.ui.active_section ?? null,
      active_tab: structured.ui.active_tab ?? null,
      selected_entity_present: Boolean(structured.ui.selected_entity),
      spoken_subject: structured.ui.spoken_subject ?? null,
      dead_end: structured.ui.dead_end ?? null,
      modal_state: structured.ui.modal_state ?? null,
      focused_widget: structured.ui.focused_widget ?? null,
      interaction_layer: activeInteractionLayer,
    },
    available_action_ids: availableActionIds,
    pending_settlement:
      args.state === "acting" || args.state === "navigation_settling",
    cache: {
      vault_ready: vaultReady,
      portfolio_ready: portfolioReady,
      busy_operations: structured.runtime.busy_operations,
      freshness,
    },
    persona: {
      active: structured.persona.active,
      primary_nav: structured.persona.primary_nav,
      available: structured.persona.available,
    },
    onboarding,
    voice_settings: {
      voice_enabled: args.voiceSettings?.voiceEnabled ?? true,
      require_tap_confirmation: args.voiceSettings?.requireTapConfirmation ?? false,
      disabled_domains: uniqueStrings([
        ...(args.voiceSettings?.disabledDomains || []),
      ]),
    },
    voice: {
      state: args.state ?? "idle",
      transition_seq: transitionSeq,
      session_id: args.lastTransition?.sessionId ?? null,
      source_id: args.lastTransition?.sourceId ?? null,
      last_transition: args.lastTransition ?? null,
    },
    world_model: {
      summary_available: vaultReady,
      mode: "redacted_summary_only",
    },
    privacy: {
      redacted: true,
      excludes: [
        "user_id",
        "vault_owner_token",
        "vault_key",
        "raw_pkm",
        "transcript_history",
        "private_documents",
        "raw_cache_keys",
      ],
    },
  };
}

export function buildOneVoiceStructuredScreenContext(args: {
  appRuntimeState?: AppRuntimeState;
  voiceContext?: Record<string, unknown>;
  state?: OneVoiceUiState;
  lastTransition?: OneVoiceTransition | null;
}): StructuredScreenContext {
  const structuredContext = buildStructuredScreenContext({
    appRuntimeState: args.appRuntimeState,
    voiceContext: args.voiceContext,
  });
  return {
    ...structuredContext,
    one_voice_context: buildOneVoiceContextSnapshot({
      appRuntimeState: args.appRuntimeState,
      voiceContext: args.voiceContext,
      structuredContext,
      state: args.state,
      lastTransition: args.lastTransition,
    }),
  };
}
