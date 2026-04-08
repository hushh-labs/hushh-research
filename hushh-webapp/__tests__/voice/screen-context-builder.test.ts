import { beforeEach, describe, expect, it } from "vitest";

import { buildStructuredScreenContext } from "@/lib/voice/screen-context-builder";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import {
  clearVoiceSurfaceMetadata,
  publishVoiceSurfaceMetadata,
} from "@/lib/voice/voice-surface-metadata";

function makeRuntimeState(pathname: string, screen: string): AppRuntimeState {
  return {
    auth: {
      signed_in: true,
      user_id: "user_1",
    },
    vault: {
      unlocked: true,
      token_available: true,
      token_valid: true,
    },
    route: {
      pathname,
      screen,
      subview: null,
    },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: {
      has_portfolio_data: true,
    },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
  };
}

describe("buildStructuredScreenContext", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.pushState({}, "", "/");
    clearVoiceSurfaceMetadata("test_surface");
  });

  it("derives route-aware tab/section context across transitions", () => {
    window.history.pushState({}, "", "/kai/portfolio?tab=overview&section=allocation");
    document.body.innerHTML = "<h1>Portfolio</h1>";
    const dashboardContext = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai/portfolio", "dashboard"),
      voiceContext: {
        active_tab: "overview",
        selected_entity: "AAPL",
      },
    });

    expect(dashboardContext.route.pathname).toBe("/kai/portfolio");
    expect(dashboardContext.route.screen).toBe("dashboard");
    expect(dashboardContext.ui.active_tab).toBe("overview");
    expect(dashboardContext.ui.active_section).toBe("allocation");
    expect(dashboardContext.ui.selected_entity).toBe("AAPL");

    window.history.pushState({}, "", "/kai/analysis?tab=history&section=history");
    document.body.innerHTML = "<h1>Analysis</h1>";
    const analysisContext = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai/analysis", "analysis"),
      voiceContext: {},
    });

    expect(analysisContext.route.pathname).toBe("/kai/analysis");
    expect(analysisContext.route.screen).toBe("analysis");
    expect(analysisContext.ui.active_tab).toBe("history");
    expect(analysisContext.ui.active_section).toBe("history");
  });

  it("collects visible modules from DOM attributes", () => {
    window.history.pushState({}, "", "/profile?tab=account");
    document.body.innerHTML = `
      <h1>Profile Settings</h1>
      <section data-voice-module="Support Panel"></section>
      <div data-card-name="Gmail Connector"></div>
      <div role="region" aria-label="Session Controls"></div>
    `;

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/profile", "profile"),
      voiceContext: {},
    });

    expect(context.route.page_title).toBe("Profile Settings");
    expect(context.ui.visible_modules).toEqual(
      expect.arrayContaining(["Support Panel", "Gmail Connector", "Session Controls"])
    );
  });

  it("prefers explicit published surface metadata and exposes available actions", () => {
    window.history.pushState({}, "", "/profile/receipts");
    publishVoiceSurfaceMetadata("test_surface", {
      surfaceDefinition: {
        screenId: "profile_receipts",
        title: "Gmail receipts",
        purpose: "This page manages Gmail receipt sync and receipt memory import.",
        sections: [
          {
            id: "receipt_memory",
            title: "Receipt memory",
            purpose: "This section previews receipt memory before saving it to PKM.",
          },
        ],
        actions: [
          {
            id: "profile.receipts_memory.preview",
            label: "Refresh receipt memory",
            purpose: "Refreshes the current receipt memory preview.",
            voiceAliases: ["refresh receipt memory"],
          },
        ],
        controls: [
          {
            id: "save_receipts_memory",
            label: "Save receipts memory to PKM",
            purpose: "Saves the current receipt memory preview into PKM.",
            actionId: "profile.receipts_memory.save",
            role: "button",
            voiceAliases: ["save receipts memory"],
          },
        ],
        concepts: [
          {
            id: "pkm",
            label: "PKM",
            explanation: "PKM is your encrypted personal memory layer.",
            aliases: ["pkm", "personal knowledge model"],
          },
        ],
      },
      activeSection: "Receipt memory preview",
      visibleModules: ["Connector status", "Receipt memory preview"],
      availableActions: ["Refresh receipt memory", "Save receipts memory to PKM"],
      busyOperations: ["receipt_memory_preview"],
      activeControlId: "save_receipts_memory",
      lastInteractedControlId: "save_receipts_memory",
      screenMetadata: {
        connector_state: "connected",
        receipt_count: 12,
      },
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/profile/receipts", "profile_receipts"),
      voiceContext: {},
    });

    expect(context.ui.active_section).toBe("Receipt memory preview");
    expect(context.ui.visible_modules).toEqual(
      expect.arrayContaining(["Connector status", "Receipt memory preview"])
    );
    expect(context.ui.available_actions).toEqual(
      expect.arrayContaining(["Refresh receipt memory", "Save receipts memory to PKM"])
    );
    expect(context.runtime.busy_operations).toContain("receipt_memory_preview");
    expect(context.surface.title).toBe("Gmail receipts");
    expect(context.surface.purpose).toContain("receipt memory import");
    expect(context.surface.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "receipt_memory",
          title: "Receipt memory",
        }),
      ])
    );
    expect(context.surface.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "save_receipts_memory",
          action_id: "profile.receipts_memory.save",
        }),
      ])
    );
    expect(context.surface.active_control_id).toBe("save_receipts_memory");
    expect(context.surface.last_interacted_control_id).toBe("save_receipts_memory");
    expect(context.screen_metadata).toMatchObject({
      connector_state: "connected",
      receipt_count: 12,
    });
  });

  it("merges the reusable top-level surface contract into structured context", () => {
    window.history.pushState({}, "", "/profile/receipts");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "profile_receipts",
      title: "Receipts",
      purpose: "Review receipt sync status and build a compact PKM memory snapshot.",
      sections: [
        {
          id: "connector-status",
          title: "Connector status",
          summary: "Shows the Gmail connection state and last sync health.",
        },
        {
          id: "receipt-memory-preview",
          title: "Receipt memory preview",
          purpose: "Preview the derived shopping memory before saving it to PKM.",
        },
      ],
      actions: [
        {
          id: "refresh-preview",
          label: "Refresh receipt memory",
          description: "Rebuild the receipt memory preview.",
        },
      ],
      controls: [
        {
          id: "add-to-memory",
          label: "Add receipts to memory",
          type: "button",
          state: "idle",
          description: "Build the receipt memory preview.",
        },
      ],
      concepts: ["receipt memory", "shopping memory"],
      activeControlId: "add-to-memory",
      lastInteractedControlId: "refresh-preview",
      screenMetadata: {
        connector_state: "connected",
      },
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/profile/receipts", "profile_receipts"),
      voiceContext: {},
    });

    expect(context.route.page_title).toBe("Receipts");
    expect(context.surface).toMatchObject({
      screen_id: "profile_receipts",
      title: "Receipts",
      purpose: "Review receipt sync status and build a compact PKM memory snapshot.",
      active_control_id: "add-to-memory",
      last_interacted_control_id: "refresh-preview",
    });
    expect(context.surface.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "connector-status",
          title: "Connector status",
          summary: "Shows the Gmail connection state and last sync health.",
        }),
        expect.objectContaining({
          id: "receipt-memory-preview",
          title: "Receipt memory preview",
        }),
      ])
    );
    expect(context.surface.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "refresh-preview",
          label: "Refresh receipt memory",
          description: "Rebuild the receipt memory preview.",
        }),
      ])
    );
    expect(context.surface.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "add-to-memory",
          label: "Add receipts to memory",
          type: "button",
          state: "idle",
        }),
      ])
    );
    expect(context.surface.concepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "receipt memory" }),
        expect.objectContaining({ label: "shopping memory" }),
      ])
    );
    expect(context.ui.visible_modules).toEqual(
      expect.arrayContaining(["Connector status", "Receipt memory preview"])
    );
    expect(context.ui.available_actions).toEqual(
      expect.arrayContaining(["Refresh receipt memory"])
    );
  });

  it("keeps legacy surfaceDefinition publishers backward-compatible when top-level overrides are present", () => {
    window.history.pushState({}, "", "/profile/pkm-agent-lab");
    publishVoiceSurfaceMetadata("test_surface", {
      surfaceDefinition: {
        screenId: "profile_pkm_agent_lab",
        title: "Legacy PKM Agent Lab",
        purpose: "Legacy metadata for the PKM lab.",
        sections: [
          {
            id: "preview",
            title: "Preview cards",
            purpose: "Review proposed structured PKM updates.",
          },
        ],
        actions: [
          {
            id: "save-capture",
            label: "Save capture to PKM",
            purpose: "Store the selected capture in PKM.",
          },
        ],
      },
      title: "PKM Agent Lab",
      purpose: "Preview and save structured PKM captures.",
      controls: [
        {
          id: "prompt-input",
          label: "Prompt input",
          type: "textbox",
          description: "Enter freeform text for PKM capture.",
        },
      ],
      concepts: [
        {
          id: "capture",
          label: "capture",
          description: "A candidate PKM write preview.",
        },
      ],
      activeControlId: "prompt-input",
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/profile/pkm-agent-lab", "profile_pkm_agent_lab"),
      voiceContext: {},
    });

    expect(context.surface).toMatchObject({
      screen_id: "profile_pkm_agent_lab",
      title: "PKM Agent Lab",
      purpose: "Preview and save structured PKM captures.",
      active_control_id: "prompt-input",
    });
    expect(context.surface.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preview",
          title: "Preview cards",
        }),
      ])
    );
    expect(context.surface.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "prompt-input",
          type: "textbox",
        }),
      ])
    );
    expect(context.ui.available_actions).toEqual(
      expect.arrayContaining(["Save capture to PKM"])
    );
  });

  it("carries profile control focus metadata through the structured surface context", () => {
    window.history.pushState({}, "", "/profile?tab=account");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "profile_account",
      title: "Profile",
      purpose: "This page gives you account settings, Gmail receipts access, support, and PKM access.",
      sections: [
        {
          id: "account",
          title: "Account",
          purpose: "This section covers your signed-in account and profile-level entry points.",
        },
      ],
      controls: [
        {
          id: "pkm_agent_lab",
          label: "PKM Agent Lab",
          role: "card",
          purpose: "opens the workspace for previewing and saving encrypted PKM captures.",
          actionId: "nav.profile_pkm_agent_lab",
          voiceAliases: ["pkm agent lab", "memory lab"],
        },
        {
          id: "gmail_receipts",
          label: "Gmail receipts",
          role: "card",
          purpose: "opens Gmail receipt sync and receipt-memory import.",
          actionId: "nav.profile_receipts",
        },
      ],
      activeSection: "Account",
      activeControlId: "pkm_agent_lab",
      lastInteractedControlId: "gmail_receipts",
      focusedWidget: "PKM Agent Lab",
      availableActions: ["Open PKM Agent Lab", "Open Gmail"],
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/profile", "profile_account"),
      voiceContext: {},
    });

    expect(context.surface).toMatchObject({
      screen_id: "profile_account",
      title: "Profile",
      active_control_id: "pkm_agent_lab",
      last_interacted_control_id: "gmail_receipts",
    });
    expect(context.surface.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pkm_agent_lab",
          action_id: "nav.profile_pkm_agent_lab",
        }),
        expect.objectContaining({
          id: "gmail_receipts",
          action_id: "nav.profile_receipts",
        }),
      ])
    );
    expect(context.ui.focused_widget).toBe("PKM Agent Lab");
    expect(context.ui.available_actions).toEqual(
      expect.arrayContaining(["Open PKM Agent Lab", "Open Gmail"])
    );
  });

  it("merges published market surface metadata for the Kai home route", () => {
    window.history.pushState({}, "", "/kai");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "kai_market",
      title: "Market",
      purpose: "This screen is the market overview workspace for live tape, advisor signals, and discovery.",
      sections: [
        {
          id: "market_overview",
          title: "Market overview",
          purpose: "Summarizes the live market tape and breadth.",
        },
        {
          id: "signals",
          title: "Signals worth noting",
          purpose: "Highlights the strongest current market reads.",
        },
      ],
      controls: [
        {
          id: "refresh_market_home",
          label: "Refresh",
          role: "button",
          purpose: "Refreshes the current market surface.",
          actionId: "kai.market.refresh",
        },
      ],
      activeSection: "Signals worth noting",
      visibleModules: ["Market overview", "Signals worth noting"],
      busyOperations: ["market_refresh"],
      screenMetadata: {
        market_mode: "baseline",
        signal_count: 3,
      },
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai", "kai_market"),
      voiceContext: {},
    });

    expect(context.route.screen).toBe("kai_market");
    expect(context.surface).toMatchObject({
      screen_id: "kai_market",
      title: "Market",
    });
    expect(context.ui.active_section).toBe("Signals worth noting");
    expect(context.runtime.busy_operations).toContain("market_refresh");
    expect(context.screen_metadata).toMatchObject({
      market_mode: "baseline",
      signal_count: 3,
    });
  });

  it("merges published consent surface metadata with filters and selection context", () => {
    window.history.pushState({}, "", "/consents?tab=active");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "consents",
      title: "Consents",
      purpose: "This screen is where sharing requests are reviewed and managed.",
      sections: [
        {
          id: "active",
          title: "Active",
          purpose: "Shows current active grants.",
        },
      ],
      controls: [
        {
          id: "consent_revoke",
          label: "Revoke",
          role: "button",
          purpose: "Revokes the selected consent entry.",
          actionId: "consent.revoke",
        },
      ],
      activeSection: "Active",
      activeFilters: ["manager_view"],
      selectedEntity: "Household cashflow sharing",
      visibleModules: ["Consent details"],
      screenMetadata: {
        pending_count: 2,
        active_count: 4,
        selected_status: "active",
      },
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/consents", "consents"),
      voiceContext: {},
    });

    expect(context.route.screen).toBe("consents");
    expect(context.surface).toMatchObject({
      screen_id: "consents",
      title: "Consents",
    });
    expect(context.ui.active_section).toBe("Active");
    expect(context.ui.active_filters).toEqual(expect.arrayContaining(["manager_view"]));
    expect(context.ui.selected_entity).toBe("Household cashflow sharing");
    expect(context.screen_metadata).toMatchObject({
      pending_count: 2,
      active_count: 4,
      selected_status: "active",
    });
  });
});
