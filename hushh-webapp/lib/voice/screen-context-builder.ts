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
import type {
  OneVoiceTransition,
  OneVoiceUiState,
} from "@/lib/voice/voice-ui-state-machine";

export const STRUCTURED_CONTEXT_ARRAY_CAP = 10;
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
  "route.one_marketplace",
  "route.consents",
];
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
    nav_stack: string[];
  };
  ui: {
    visible_modules: string[];
    visible_control_ids: string[];
    active_section?: string | null;
    active_tab?: string | null;
    selected_entity_present: boolean;
    modal_state?: string | null;
    focused_widget?: string | null;
    interaction_layer?: StructuredVoiceInteractionLayer | null;
  };
  available_action_ids: string[];
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

function uniqueStrings(values: unknown[]): string[] {
  const out = new Set<string>();
  values.forEach((value) => {
    if (typeof value !== "string") return;
    const clean = value.trim();
    if (!clean) return;
    out.add(clean);
  });
  return enforceArrayDimensionCap(Array.from(out)).items;
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : [];
}

/**
 * Rank action ids by relevance BEFORE the 10-item context cap slices them, so
 * the tail that gets dropped is always the least useful part. Priority order:
 *   1. wired actions whose contract lists the current screen (in-place intent)
 *   2. other wired actions (mostly cross-screen route.* navigation)
 *   3. unwired/dead/unknown ids (guidance-only value)
 * Set-insertion order previously made the truncation nondeterministic; this
 * keeps the same cap but makes what survives it intentional.
 */
function prioritizeAvailableActionIds(
  candidateIds: string[],
  screen: string | null,
  includeGlobalNavigation = true,
): string[] {
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
    if (!action) return 2;
    if (action.execution_target.status !== "wired") return 2;
    if (screen && action.reachability.screens.includes(screen)) return 0;
    return 1;
  };
  const ranked = deduped
    .map((actionId, index) => ({ actionId, index, rank: rankOf(actionId) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.actionId);
  if (
    ranked.length > STRUCTURED_CONTEXT_ARRAY_CAP &&
    process.env.NODE_ENV !== "production"
  ) {
    console.debug(
      "[VOICE_CONTEXT] available_action_ids overflow: keeping",
      STRUCTURED_CONTEXT_ARRAY_CAP,
      "of",
      ranked.length,
      "for screen",
      screen,
    );
  }
  // Screen-ranked segment first (original cap), then the reserved global
  // navigation segment so cross-agent navigation is always proposable. The
  // combined list stays within AVAILABLE_ACTION_IDS_CAP, which the backend
  // accepts (Pydantic max_length is kept in sync).
  const screenSegment = enforceArrayDimensionCap(ranked).items;
  if (!includeGlobalNavigation) return screenSegment;
  const combined = [...screenSegment];
  for (const navId of GLOBAL_NAV_ACTION_IDS) {
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
  const publishedActionIds = uniqueStrings([
    ...(publishedSurface?.controls || [])
      .map((control) => control.actionId || null)
      .filter((actionId): actionId is string => Boolean(actionId)),
    ...(publishedSurface?.actions || [])
      .map((action) => action.actionId || action.id)
      .filter((actionId): actionId is string => Boolean(actionId)),
  ]);
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
    underlyingActionsAvailable,
  );
  const screenMetadata = {
    ...readObject(rawContext.screen_metadata),
    ...readObject(publishedSurface?.screenMetadata),
    available_action_ids: availableActionIds,
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
}): OneVoiceContextSnapshot {
  const structured =
    args.structuredContext ||
    buildStructuredScreenContext({
      appRuntimeState: args.appRuntimeState,
      voiceContext: args.voiceContext,
      surfaceMetadata: args.surfaceMetadata,
    });
  const app = args.appRuntimeState;
  const publishedAvailableActionIds = readStringArray(
    structured.screen_metadata.available_action_ids,
  );
  const vaultReady = Boolean(
    structured.vault.unlocked && structured.vault.token_valid,
  );
  const portfolioReady = Boolean(app?.portfolio.has_portfolio_data);
  const freshness = vaultReady
    ? portfolioReady || structured.ui.visible_modules.length > 0
      ? "fresh_or_stale_safe"
      : "missing"
    : "locked";
  const routeFamily = sanitizeRouteFamily(structured.route.pathname);
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
  const availableActionIds = interactionLayerAllowed
    ? publishedAvailableActionIds
    : [];
  const visibleControlIds = interactionLayerAllowed
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
      nav_stack: navStack,
    },
    ui: {
      visible_modules: structured.ui.visible_modules,
      visible_control_ids: visibleControlIds,
      active_section: structured.ui.active_section ?? null,
      active_tab: structured.ui.active_tab ?? null,
      selected_entity_present: Boolean(structured.ui.selected_entity),
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
