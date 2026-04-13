"use client";

import type {
  AppRuntimeState,
  VoiceSurfaceActionDefinition,
  VoiceSurfaceConceptDefinition,
  VoiceSurfaceControlDefinition,
  VoiceSurfaceSectionDefinition,
} from "@/lib/voice/voice-types";
import { listInvestorKaiActionsForSurface } from "@/lib/voice/investor-kai-action-registry";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

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
  };
  screen_metadata: Record<string, unknown>;
};

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
  return Array.from(values).slice(0, 16);
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
  return Array.from(out);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapSections(sections: VoiceSurfaceSectionDefinition[] | undefined) {
  return Array.isArray(sections)
    ? sections.map((section) => ({
        id: section.id,
        title: section.title,
        purpose: section.purpose || null,
        summary: section.summary || null,
      }))
    : [];
}

function mapActions(actions: VoiceSurfaceActionDefinition[] | undefined) {
  return Array.isArray(actions)
    ? actions.map((action) => ({
        id: action.id,
        label: action.label,
        purpose: action.purpose || null,
        description: action.description || null,
        voice_aliases: Array.isArray(action.voiceAliases) ? [...action.voiceAliases] : undefined,
      }))
    : [];
}

function mapControls(controls: VoiceSurfaceControlDefinition[] | undefined) {
  return Array.isArray(controls)
    ? controls.map((control) => ({
        id: control.id,
        label: control.label,
        type: control.type || null,
        state: control.state || null,
        purpose: control.purpose || null,
        description: control.description || null,
        action_id: control.actionId || null,
        role: control.role || null,
        voice_aliases: Array.isArray(control.voiceAliases) ? [...control.voiceAliases] : undefined,
      }))
    : [];
}

function mapConcepts(concepts: Array<VoiceSurfaceConceptDefinition | string> | undefined) {
  return Array.isArray(concepts)
    ? concepts.map((concept) =>
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
              aliases: Array.isArray(concept.aliases) ? [...concept.aliases] : undefined,
            }
      )
    : [];
}

export function buildStructuredScreenContext(args: {
  appRuntimeState?: AppRuntimeState;
  voiceContext?: Record<string, unknown>;
}): StructuredScreenContext {
  const app = args.appRuntimeState;
  const rawContext = args.voiceContext || {};
  const publishedSurface = getVoiceSurfaceMetadata();

  const pathname = app?.route.pathname || String(rawContext.route || "").trim() || "";
  const screen = app?.route.screen || "unknown";
  const subview = app?.route.subview || null;

  const pageTitle = domSafeQueryText("h1") || domSafeQueryText("title");
  const explicitPageTitle = publishedSurface?.title || null;
  const activeSection =
    publishedSurface?.activeSection ||
    (typeof rawContext.active_section === "string" && rawContext.active_section.trim()) ||
    readUrlSearchParam("section") ||
    null;
  const activeTab =
    publishedSurface?.activeTab ||
    (typeof rawContext.active_tab === "string" && rawContext.active_tab.trim()) ||
    readUrlSearchParam("tab") ||
    null;
  const selectedEntity =
    publishedSurface?.selectedEntity ||
    (typeof rawContext.selected_entity === "string" && rawContext.selected_entity.trim()) ||
    (typeof rawContext.current_ticker === "string" && rawContext.current_ticker.trim()) ||
    app?.runtime.analysis_ticker ||
    null;
  const explicitVisibleModules = uniqueStrings([
    ...(publishedSurface?.visibleModules || []),
    ...((publishedSurface?.sections || []).map((section) => section.title)),
    ...(Array.isArray(rawContext.visible_modules) ? rawContext.visible_modules : []),
  ]);
  const visibleModules = uniqueStrings([
    ...explicitVisibleModules,
    ...collectVisibleModules(),
  ]).slice(0, 16);
  const activeFilters = uniqueStrings([
    ...(publishedSurface?.activeFilters || []),
    ...(Array.isArray(rawContext.active_filters) ? rawContext.active_filters : []),
  ]);
  const selectedObjects = uniqueStrings([
    ...(publishedSurface?.selectedObjects || []),
    ...(Array.isArray(rawContext.selected_objects) ? rawContext.selected_objects : []),
  ]);
  const surfaceBusyOperations = uniqueStrings([
    ...(publishedSurface?.busyOperations || []),
    ...(Array.isArray(rawContext.busy_operations) ? rawContext.busy_operations : []),
  ]);

  const navStack = uniqueStrings(
    pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => `/${segment}`)
  );

  const busyOps = Array.isArray(app?.runtime.busy_operations)
    ? app?.runtime.busy_operations
    : [];
  const availableActions = uniqueStrings([
    ...listInvestorKaiActionsForSurface({
      screen,
      href: pathname,
      pathname,
    }).map((action) => action.label),
    ...((publishedSurface?.actions || []).map((action) => action.label)),
    ...(publishedSurface?.availableActions || []),
    ...(Array.isArray(rawContext.available_actions) ? rawContext.available_actions : []),
  ]);
  const screenMetadata = {
    ...readObject(rawContext.screen_metadata),
    ...readObject(publishedSurface?.screenMetadata),
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
        (typeof rawContext.modal_state === "string" && rawContext.modal_state.trim()) || null,
      focused_widget:
        publishedSurface?.focusedWidget ||
        (typeof rawContext.focused_widget === "string" && rawContext.focused_widget.trim()) ||
        null,
      active_filters: activeFilters,
      search_query:
        publishedSurface?.searchQuery ||
        (typeof rawContext.search_query === "string" && rawContext.search_query.trim()) || null,
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
      last_interacted_control_id: publishedSurface?.lastInteractedControlId || null,
    },
    screen_metadata: screenMetadata,
  };
}
