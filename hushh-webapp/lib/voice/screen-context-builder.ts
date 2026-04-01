"use client";

import type { AppRuntimeState } from "@/lib/voice/voice-types";

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

export function buildStructuredScreenContext(args: {
  appRuntimeState?: AppRuntimeState;
  voiceContext?: Record<string, unknown>;
}): StructuredScreenContext {
  const app = args.appRuntimeState;
  const rawContext = args.voiceContext || {};

  const pathname = app?.route.pathname || String(rawContext.route || "").trim() || "";
  const screen = app?.route.screen || "unknown";
  const subview = app?.route.subview || null;

  const pageTitle = domSafeQueryText("h1") || domSafeQueryText("title");
  const activeSection =
    (typeof rawContext.active_section === "string" && rawContext.active_section.trim()) ||
    readUrlSearchParam("section") ||
    null;
  const activeTab =
    (typeof rawContext.active_tab === "string" && rawContext.active_tab.trim()) ||
    readUrlSearchParam("tab") ||
    null;
  const selectedEntity =
    (typeof rawContext.selected_entity === "string" && rawContext.selected_entity.trim()) ||
    (typeof rawContext.current_ticker === "string" && rawContext.current_ticker.trim()) ||
    app?.runtime.analysis_ticker ||
    null;

  const navStack = uniqueStrings(
    pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => `/${segment}`)
  );

  const busyOps = Array.isArray(app?.runtime.busy_operations)
    ? app?.runtime.busy_operations
    : [];

  const selectedObjects = uniqueStrings(
    Array.isArray(rawContext.selected_objects) ? rawContext.selected_objects : []
  );

  const activeFilters = uniqueStrings(
    Array.isArray(rawContext.active_filters) ? rawContext.active_filters : []
  );

  return {
    route: {
      pathname,
      screen,
      subview,
      page_title: pageTitle,
      nav_stack: navStack,
    },
    ui: {
      active_section: activeSection,
      visible_modules: collectVisibleModules(),
      selected_entity: selectedEntity,
      active_tab: activeTab,
      modal_state:
        (typeof rawContext.modal_state === "string" && rawContext.modal_state.trim()) || null,
      focused_widget:
        (typeof rawContext.focused_widget === "string" && rawContext.focused_widget.trim()) ||
        null,
      active_filters: activeFilters,
      search_query:
        (typeof rawContext.search_query === "string" && rawContext.search_query.trim()) || null,
      selected_objects: selectedObjects,
    },
    runtime: {
      busy_operations: [...busyOps],
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
  };
}
