import { beforeEach, describe, expect, it } from "vitest";

import {
  ARRAY_DIMENSION_CAP_ERROR,
  INVALID_ARRAY_TYPE_ERROR,
  STRUCTURED_CONTEXT_ARRAY_CAP,
  buildOneVoiceContextSnapshot,
  buildOneVoiceStructuredScreenContext,
  buildStructuredScreenContext,
  enforceArrayDimensionCap,
} from "@/lib/voice/screen-context-builder";
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

// ── enforceArrayDimensionCap unit tests ───────────────────────────────────────

describe("enforceArrayDimensionCap — structured input array bounds", () => {

  // ── Non-array input rejection ────────────────────────────────────────────

  it("rejects null and signals INVALID_ARRAY_TYPE_ERROR", () => {
    const result = enforceArrayDimensionCap(null);
    expect(result.isValidAllocation).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.errorLabel).toBe(INVALID_ARRAY_TYPE_ERROR);
  });

  it("rejects undefined and signals INVALID_ARRAY_TYPE_ERROR", () => {
    const result = enforceArrayDimensionCap(undefined);
    expect(result.isValidAllocation).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.errorLabel).toBe(INVALID_ARRAY_TYPE_ERROR);
  });

  it("rejects a plain object (non-array) and signals INVALID_ARRAY_TYPE_ERROR", () => {
    const result = enforceArrayDimensionCap({ 0: "a", length: 1 } as never);
    expect(result.isValidAllocation).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.errorLabel).toBe(INVALID_ARRAY_TYPE_ERROR);
  });

  // ── Valid allocation — below or at cap ───────────────────────────────────

  it("accepts an empty array as a valid zero-item allocation", () => {
    const result = enforceArrayDimensionCap([]);
    expect(result.isValidAllocation).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.errorLabel).toBeNull();
  });

  it("accepts a single-item array well within the cap", () => {
    const result = enforceArrayDimensionCap(["only"]);
    expect(result.isValidAllocation).toBe(true);
    expect(result.items).toEqual(["only"]);
    expect(result.errorLabel).toBeNull();
  });

  it("accepts an array whose length equals the default cap exactly", () => {
    const atCap = Array.from({ length: STRUCTURED_CONTEXT_ARRAY_CAP }, (_, i) => i);
    const result = enforceArrayDimensionCap(atCap);
    expect(result.isValidAllocation).toBe(true);
    expect(result.items).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
    expect(result.errorLabel).toBeNull();
  });

  // ── Clamping — oversized inputs ──────────────────────────────────────────

  it("clamps an array one item over the cap and flags ARRAY_DIMENSION_CAP_ERROR", () => {
    const overByOne = Array.from(
      { length: STRUCTURED_CONTEXT_ARRAY_CAP + 1 },
      (_, i) => `item_${i}`,
    );
    const result = enforceArrayDimensionCap(overByOne);
    expect(result.isValidAllocation).toBe(false);
    expect(result.items).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
    expect(result.errorLabel).toBe(ARRAY_DIMENSION_CAP_ERROR);
  });

  it("preserves input order — first N items are kept, tail is dropped", () => {
    // 11 items with default cap 10: the last entry must be absent from result.
    const ordered = [
      "alpha","beta","gamma","delta","epsilon",
      "zeta","eta","theta","iota","kappa","lambda",
    ];
    const result = enforceArrayDimensionCap(ordered);
    expect(result.items[0]).toBe("alpha");
    expect(result.items[STRUCTURED_CONTEXT_ARRAY_CAP - 1]).toBe("kappa");
    expect(result.items).not.toContain("lambda");
  });

  it("clamps a severely oversized array (100 items) to the default cap", () => {
    const huge = Array.from({ length: 100 }, (_, i) => `action_${i}`);
    const result = enforceArrayDimensionCap(huge);
    expect(result.isValidAllocation).toBe(false);
    expect(result.items).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
    expect(result.items[0]).toBe("action_0");
  });

  // ── Custom cap parameter ─────────────────────────────────────────────────

  it("respects a custom cap smaller than the default", () => {
    const result = enforceArrayDimensionCap(["a","b","c","d","e"], 3);
    expect(result.isValidAllocation).toBe(false);
    expect(result.items).toEqual(["a","b","c"]);
    expect(result.errorLabel).toBe(ARRAY_DIMENSION_CAP_ERROR);
  });

  it("respects a custom cap larger than the default — all items pass through", () => {
    const data = Array.from({ length: 15 }, (_, i) => `item_${i}`);
    const result = enforceArrayDimensionCap(data, 20);
    expect(result.isValidAllocation).toBe(true);
    expect(result.items).toHaveLength(15);
    expect(result.errorLabel).toBeNull();
  });
});

// ── End enforceArrayDimensionCap unit tests ───────────────────────────────────

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

  it("publishes the root claim control as the generated action available on one_intro", () => {
    window.history.pushState({}, "", "/");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "one_intro",
      title: "Claim your One",
      purpose: "Continue to sign in and begin setting up One.",
      actions: [
        {
          id: "onboarding_claim_one",
          actionId: "onboarding.claim_one",
          label: "Claim your One",
        },
      ],
      controls: [
        {
          id: "onboarding_claim_one",
          actionId: "onboarding.claim_one",
          label: "Claim your One",
          type: "button",
        },
      ],
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/", "one_intro"),
    });

    expect(snapshot.route.screen).toBe("one_intro");
    expect(snapshot.available_action_ids).toContain("onboarding.claim_one");
    expect(snapshot.available_action_ids).not.toContain("onboarding_claim_one");
  });

  it("admits only the Login actions whose authored controls are currently visible", () => {
    window.history.pushState({}, "", "/login");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "login",
      controls: [
        {
          id: "auth_terms",
          actionId: "auth.open_terms",
          label: "Terms",
        },
        {
          id: "auth_privacy",
          actionId: "auth.open_privacy",
          label: "Privacy Policy",
        },
      ],
    });

    const closedDialog = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/login", "login"),
    });
    expect(closedDialog.available_action_ids).toEqual(
      expect.arrayContaining(["auth.open_terms", "auth.open_privacy"]),
    );
    expect(closedDialog.available_action_ids).not.toContain("auth.close_legal");

    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "login",
      controls: [
        {
          id: "auth_close_legal",
          actionId: "auth.close_legal",
          label: "Close legal document",
        },
      ],
      modalState: "legal_terms",
    });
    const openDialog = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/login", "login"),
    });
    expect(openDialog.available_action_ids).toContain("auth.close_legal");
    expect(openDialog.available_action_ids).not.toContain("auth.open_terms");
  });

  it("collects visible modules from DOM attributes", () => {
    window.history.pushState({}, "", "/one/profile?tab=account");
    document.body.innerHTML = `
      <h1>Profile Settings</h1>
      <section data-voice-module="Support Panel"></section>
      <div data-card-name="Gmail Connector"></div>
      <div role="region" aria-label="Session Controls"></div>
    `;

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/one/profile", "profile"),
      voiceContext: {},
    });

    expect(context.route.page_title).toBe("Profile Settings");
    expect(context.ui.visible_modules).toEqual(
      expect.arrayContaining(["Support Panel", "Gmail Connector", "Session Controls"])
    );
  });

  it("always includes global navigation contracts regardless of screen", () => {
    // Regression: "go to profile" from the Connect tab failed because
    // route.profile was screen-filtered out of available_action_ids, so the
    // model was never told the contract existed.
    window.history.pushState({}, "", "/marketplace");
    document.body.innerHTML = "<h1>Connect</h1>";

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/marketplace", "marketplace"),
      voiceContext: {},
    });

    const availableIds = (
      context.screen_metadata as { available_action_ids: string[] }
    ).available_action_ids;
    expect(availableIds).toEqual(
      expect.arrayContaining([
        "route.profile",
        "route.kai_home",
        "route.ria_home",
        "route.profile_connected_systems",
      ])
    );
  });

  it("caps multi-source context arrays before they enter the voice planner payload", () => {
    const oversizedActions = Array.from({ length: 12 }, (_, index) => ({
      id: `action_${index}`,
      label: `Action ${index}`,
    }));
    const capResult = enforceArrayDimensionCap(oversizedActions);

    expect(capResult.isValidAllocation).toBe(false);
    expect(capResult.errorLabel).toBe(ARRAY_DIMENSION_CAP_ERROR);
    expect(capResult.items).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);

    publishVoiceSurfaceMetadata("test_surface", {
      actions: oversizedActions,
      availableActions: Array.from(
        { length: 12 },
        (_, index) => `Surface action ${index}`
      ),
      visibleModules: Array.from(
        { length: 12 },
        (_, index) => `Surface module ${index}`
      ),
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai", "kai_home"),
      voiceContext: {
        available_actions: Array.from(
          { length: 12 },
          (_, index) => `Raw action ${index}`
        ),
        visible_modules: Array.from(
          { length: 12 },
          (_, index) => `Raw module ${index}`
        ),
      },
    });

    expect(context.surface.actions).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
    expect(context.ui.available_actions.length).toBeLessThanOrEqual(
      STRUCTURED_CONTEXT_ARRAY_CAP
    );
    expect(context.ui.visible_modules.length).toBeLessThanOrEqual(
      STRUCTURED_CONTEXT_ARRAY_CAP
    );
  });

  it("prefers explicit published surface metadata and exposes available actions", () => {
    window.history.pushState({}, "", "/one/profile/receipts");
    publishVoiceSurfaceMetadata("test_surface", {
      surfaceDefinition: {
        screenId: "profile_receipts",
        title: "Gmail receipts",
        purpose: "This page syncs receipts and saves a private shopping summary automatically.",
        sections: [
          {
            id: "receipt_memory",
            title: "Shopping summary",
            purpose: "This section shows the summary saved automatically to PKM.",
          },
        ],
        actions: [
          {
            id: "profile.gmail.sync_now",
            label: "Sync receipts",
            purpose: "Syncs Gmail receipts and refreshes the shopping summary.",
            voiceAliases: ["sync receipts"],
          },
        ],
        controls: [
          {
            id: "sync_gmail_receipts",
            label: "Sync receipts",
            purpose: "Syncs Gmail receipts.",
            actionId: "profile.gmail.sync_now",
            role: "button",
            voiceAliases: ["sync receipts"],
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
      activeSection: "Shopping summary",
      visibleModules: ["Connector status", "Shopping summary"],
      availableActions: ["Sync receipts"],
      busyOperations: [],
      activeControlId: "sync_gmail_receipts",
      lastInteractedControlId: "sync_gmail_receipts",
      screenMetadata: {
        connector_state: "connected",
        receipt_count: 12,
      },
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/one/profile/receipts", "profile_receipts"),
      voiceContext: {},
    });

    expect(context.ui.active_section).toBe("Shopping summary");
    expect(context.ui.visible_modules).toEqual(
      expect.arrayContaining(["Connector status", "Shopping summary"])
    );
    expect(context.ui.available_actions).toEqual(["Sync receipts"]);
    expect(context.runtime.busy_operations).toEqual([]);
    expect(context.surface.title).toBe("Gmail receipts");
    expect(context.surface.purpose).toContain("saves a private shopping summary");
    expect(context.surface.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "receipt_memory",
          title: "Shopping summary",
        }),
      ])
    );
    expect(context.surface.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sync_gmail_receipts",
          action_id: "profile.gmail.sync_now",
        }),
      ])
    );
    expect(context.surface.active_control_id).toBe("sync_gmail_receipts");
    expect(context.surface.last_interacted_control_id).toBe("sync_gmail_receipts");
    expect(context.screen_metadata).toMatchObject({
      connector_state: "connected",
      receipt_count: 12,
    });
  });

  it("keeps local-only preference controls visible but not executable", () => {
    window.history.pushState({}, "", "/one/profile/preferences");
    publishVoiceSurfaceMetadata("test_surface", {
      surfaceDefinition: {
        screenId: "profile_preferences",
        title: "Preferences",
        purpose: "Manage local appearance and device voice settings.",
        sections: [
          {
            id: "preferences",
            title: "Preferences",
            purpose: "Shell, theme, and device preferences.",
          },
        ],
        actions: [],
        controls: [
          {
            id: "profile_theme",
            label: "Appearance",
            type: "segmented_control",
            purpose: "Local theme selector.",
          },
          {
            id: "profile_agent_voice",
            label: "Agent voice",
            type: "select",
            state: "Sulafat",
            purpose: "Gemini-compatible local voice selector.",
          },
          {
            id: "profile_vault",
            label: "Vault",
            actionId: "route.profile_security_panel",
            purpose: "Generated route action for vault security.",
          },
        ],
        concepts: [],
      },
      activeSection: "preferences",
      availableActions: [],
      screenMetadata: {
        profile_panel: "preferences",
        preference_voice_actions_available: false,
      },
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/one/profile/preferences", "profile_preferences"),
      voiceContext: {},
    });

    expect(context.surface.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "profile_theme",
          action_id: null,
        }),
        expect.objectContaining({
          id: "profile_agent_voice",
          action_id: null,
          state: "Sulafat",
        }),
        expect.objectContaining({
          id: "profile_vault",
          action_id: "route.profile_security_panel",
        }),
      ]),
    );
    expect(context.screen_metadata.available_action_ids).toEqual(
      expect.arrayContaining(["route.profile_security_panel"]),
    );
    expect(context.screen_metadata.available_action_ids).not.toContain("profile_theme");
    expect(context.screen_metadata.available_action_ids).not.toContain(
      "profile_agent_voice",
    );
    expect(context.screen_metadata.preference_voice_actions_available).toBe(false);
  });

  it("merges the reusable top-level surface contract into structured context", () => {
    window.history.pushState({}, "", "/one/profile/receipts");
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
      appRuntimeState: makeRuntimeState("/one/profile/receipts", "profile_receipts"),
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
    window.history.pushState({}, "", "/one/profile/pkm-agent-lab");
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
      appRuntimeState: makeRuntimeState("/one/profile/pkm-agent-lab", "profile_pkm_agent_lab"),
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
    window.history.pushState({}, "", "/one/profile?tab=account");
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
          actionId: "route.profile_pkm_agent_lab",
          voiceAliases: ["pkm agent lab", "memory lab"],
        },
        {
          id: "gmail_receipts",
          label: "Gmail receipts",
          role: "card",
          purpose: "opens Gmail receipt sync and receipt-memory import.",
          actionId: "route.profile_receipts",
        },
      ],
      activeSection: "Account",
      activeControlId: "pkm_agent_lab",
      lastInteractedControlId: "gmail_receipts",
      focusedWidget: "PKM Agent Lab",
      availableActions: ["Open PKM Agent Lab", "Open Gmail"],
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/one/profile", "profile_account"),
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
          action_id: "route.profile_pkm_agent_lab",
        }),
        expect.objectContaining({
          id: "gmail_receipts",
          action_id: "route.profile_receipts",
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

  // ── Array bounds coverage added below the existing suite ─────────────────

  it("clamps oversized voice_aliases on control definitions", () => {
    publishVoiceSurfaceMetadata("test_surface", {
      controls: [
        {
          id: "oversized-control",
          label: "Oversized Control",
          voiceAliases: Array.from({ length: 15 }, (_, i) => `alias_${i}`),
        },
      ],
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai", "kai_home"),
      voiceContext: {},
    });

    const control = context.surface.controls.find((c) => c.id === "oversized-control");
    expect(control).toBeDefined();
    expect(control?.voice_aliases).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
  });

  it("clamps oversized concept aliases in nested concept definitions", () => {
    publishVoiceSurfaceMetadata("test_surface", {
      concepts: [
        {
          id: "big-concept",
          label: "Big Concept",
          aliases: Array.from({ length: 20 }, (_, i) => `alias_${i}`),
        },
      ],
    });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai", "kai_home"),
      voiceContext: {},
    });

    const concept = context.surface.concepts.find((c) => c.label === "Big Concept");
    expect(concept).toBeDefined();
    expect(concept?.aliases).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
  });

  it("preserves item order at the sections cap boundary — first N items retained", () => {
    const overCap = Array.from(
      { length: STRUCTURED_CONTEXT_ARRAY_CAP + 3 },
      (_, i) => ({ id: `section_${i}`, title: `Section ${i}` }),
    );

    publishVoiceSurfaceMetadata("test_surface", { sections: overCap });

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai", "kai_home"),
      voiceContext: {},
    });

    expect(context.surface.sections).toHaveLength(STRUCTURED_CONTEXT_ARRAY_CAP);
    expect(context.surface.sections[0]).toMatchObject({ id: "section_0" });
    expect(context.surface.sections[STRUCTURED_CONTEXT_ARRAY_CAP - 1]).toMatchObject({
      id: `section_${STRUCTURED_CONTEXT_ARRAY_CAP - 1}`,
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

  it("builds a redacted One Voice snapshot with action ids and cache posture", () => {
    window.history.pushState({}, "", "/ria/workspace?clientId=abc123&tab=access");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "ria_client_workspace",
      title: "Client workspace",
      visibleModules: ["Access review"],
      controls: [
        {
          id: "request-access",
          label: "Request access",
          actionId: "ria.client_workspace.request_access",
        },
      ],
      screenMetadata: {
        raw_cache_key: "portfolio_data_user_1",
      },
    });

    const appRuntimeState = makeRuntimeState(
      "/ria/workspace?clientId=abc123&tab=access",
      "ria_client_workspace"
    );
    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState,
      state: "understanding",
      lastTransition: {
        from: "listening",
        to: "understanding",
        atMs: 10,
        transitionSeq: 7,
        sessionId: "session_safe",
        sourceId: "gemini",
        ariaLive: "polite",
        label: "One is understanding",
      },
    });

    expect(snapshot.schema_version).toBe("one_voice_context.v1");
    expect(snapshot.snapshot_id).toMatch(/^ctx_/);
    expect(snapshot.revisions).toMatchObject({
      voice: 7,
    });
    expect(snapshot.route.route_family).toBe("/ria/workspace");
    expect(snapshot.ui.selected_entity_present).toBe(false);
    expect(snapshot.available_action_ids).toContain(
      "ria.client_workspace.request_access"
    );
    expect(snapshot.cache).toMatchObject({
      vault_ready: true,
      portfolio_ready: true,
      freshness: "fresh_or_stale_safe",
    });
    expect(snapshot.voice.state).toBe("understanding");
    expect(snapshot.voice.transition_seq).toBe(7);
    expect(snapshot.voice.session_id).toBe("session_safe");
    expect(snapshot.privacy.redacted).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("user_1");
    expect(JSON.stringify(snapshot)).not.toContain("portfolio_data_user_1");
  });

  it("does not report the vault ready when its owner token is unavailable", () => {
    const appRuntimeState = makeRuntimeState("/one/kai", "kai");
    appRuntimeState.vault.token_available = false;

    const snapshot = buildOneVoiceContextSnapshot({ appRuntimeState });

    expect(snapshot.cache.vault_ready).toBe(false);
    expect(snapshot.cache.freshness).toBe("locked");
  });

  it("carries only bounded onboarding progress into the live snapshot", () => {
    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/setup/kai", "one_setup"),
      onboarding: {
        phase: "capability_setup",
        activeCapability: "finance",
        rootResolved: false,
        returnRoute: "/one/setup?unsafe=ignored",
        phoneVerified: true,
        callbackState: "succeeded",
        setupCapabilityIds: ["finance", "finance"],
      },
    });

    expect(snapshot.onboarding).toEqual({
      phase: "capability_setup",
      active_capability: "finance",
      root_resolved: false,
      return_route: "/one/setup",
      phone_verified: true,
      callback_state: "succeeded",
      setup_capability_ids: ["finance"],
    });
    expect(JSON.stringify(snapshot.onboarding)).not.toContain("unsafe");
  });

  it("carries a screen's dead end into the snapshot One reads", () => {
    window.history.pushState({}, "", "/one/location");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "one_location",
      deadEnd: {
        reason: "There is no one to add as an emergency contact yet.",
        remedyActionId: "location.add_connections",
      },
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/location", "one_location"),
    });

    expect(snapshot.ui.dead_end).toEqual({
      reason: "There is no one to add as an emergency contact yet.",
      remedy_action_id: "location.add_connections",
    });
  });

  it("drops a half-filled dead end rather than naming a problem with no way out", () => {
    window.history.pushState({}, "", "/one/location");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "one_location",
      // A reason with no remedy would tell One something is wrong and leave it
      // to guess the way out -- exactly the guessing this removes.
      deadEnd: { reason: "Stuck.", remedyActionId: "" },
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/location", "one_location"),
    });

    expect(snapshot.ui.dead_end).toBeNull();
  });

  it("keeps structured context shape while attaching One Voice metadata", () => {
    const context = buildOneVoiceStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/one", "one_agents"),
      state: "listening",
    });

    expect(context.route.screen).toBe("one_agents");
    expect(context.one_voice_context).toMatchObject({
      schema_version: "one_voice_context.v1",
      voice: {
        state: "listening",
      },
    });
  });
});
