import { beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_ID_SCREEN_SEGMENT_CAP,
  ARRAY_DIMENSION_CAP_ERROR,
  AVAILABLE_ACTION_IDS_CAP,
  GLOBAL_NAV_ACTION_IDS,
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

function makeRuntimeState(
  pathname: string,
  screen: string,
  subview: string | null = null,
): AppRuntimeState {
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
      subview,
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

describe("the action-id cap invariant this file's own comments document", () => {
  it("never lets the screen segment alone exceed the combined cap", () => {
    // prioritizeAvailableActionIds only re-checks AVAILABLE_ACTION_IDS_CAP
    // while appending the GLOBAL_NAV_ACTION_IDS segment on top of the
    // already-built screen segment -- it never re-truncates the screen
    // segment itself. If ACTION_ID_SCREEN_SEGMENT_CAP were ever raised past
    // this bound, the combined array could exceed AVAILABLE_ACTION_IDS_CAP
    // even though nothing here would report an error.
    expect(ACTION_ID_SCREEN_SEGMENT_CAP).toBeLessThanOrEqual(AVAILABLE_ACTION_IDS_CAP);
  });

  it("matches the backend's Pydantic max_length for available_action_ids", () => {
    // consent-protocol/hushh_mcp/agents/onboarding/agent.py's
    // OnboardingJourneyContext.available_action_ids has max_length=18 --
    // see tests/test_onboarding_goal_agent.py's matching parity test on
    // that side. There is no automated cross-language sync for this; both
    // sides must be changed together, in the same commit.
    expect(AVAILABLE_ACTION_IDS_CAP).toBe(18);
  });

  it("documents that a crowded screen already trades away some global-nav slots", () => {
    // Not a bound that must hold -- the opposite: 14 + 8 already exceeds 18
    // today, so the append loop in prioritizeAvailableActionIds already
    // silently drops some GLOBAL_NAV_ACTION_IDS entries once a screen's own
    // segment is full. Asserted here so a future reader sees this is known
    // and accepted, not undiscovered.
    expect(ACTION_ID_SCREEN_SEGMENT_CAP + GLOBAL_NAV_ACTION_IDS.length).toBeGreaterThan(
      AVAILABLE_ACTION_IDS_CAP,
    );
  });
});

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

  it("defaults voice_settings to today's exact behavior when none is provided", () => {
    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/kai", "kai"),
    });

    expect(snapshot.voice_settings).toEqual({
      voice_enabled: true,
      require_tap_confirmation: false,
      disabled_domains: [],
    });
  });

  it("carries the person's own voice restrictions into the live snapshot", () => {
    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/kai", "kai"),
      voiceSettings: {
        voiceEnabled: false,
        requireTapConfirmation: true,
        disabledDomains: ["location", "location", "kyc"],
      },
    });

    expect(snapshot.voice_settings).toEqual({
      voice_enabled: false,
      require_tap_confirmation: true,
      disabled_domains: ["location", "kyc"],
    });
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

describe("a surface that declares more controls than the context can carry", () => {
  beforeEach(() => {
    clearVoiceSurfaceMetadata();
  });

  it("keeps the actions that DO something when the openers outnumber the cap", () => {
    // Location's real shape: 18 controls whose first ten all open a tab, with
    // every acting handler declared last. `publishedActionIds` was capped at
    // 10 BEFORE ranking, so the ranking written to protect local handlers was
    // handed a list they had already been cut from -- and its "what was lost"
    // warning could never fire, because the list arrived pre-truncated.
    //
    // The model was therefore told this screen offers ten ways to open a tab
    // and nothing that acts. Every acting request came back
    // `action_unavailable`, which reads as a broken feature rather than as a
    // full array. Existing fixtures all publish 2-3 controls, so nothing here
    // ever exercised the cap.
    window.history.pushState({}, "", "/one/location");
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "one_location",
      controls: [
        ...[
          "location.open_share",
          "location.open_map",
          "location.open_active_shares",
          "location.open_shared_with_me",
          "location.open_needs_review",
          "location.open_settings",
          "location.open_check_in",
          "location.open_sos",
          "location.open_ask",
          "location.open_invite",
          "location.open_create_circle",
          "location.open_join_circle",
        ].map((actionId) => ({ id: actionId, actionId, label: actionId })),
        // Declared last, exactly as the surface declares them.
        {
          id: "one-location-updates-toggle",
          actionId: "location.pause_updates",
          label: "Location updates",
        },
        {
          id: "one-location-confirm-share",
          actionId: "location.share_selected",
          label: "Start sharing",
        },
        {
          id: "one-location-share-recipient-search",
          actionId: "location.select_share_recipient",
          label: "Search trusted people",
        },
      ],
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/location", "one_location"),
    });

    // The whole point of the surface. Sharing is what someone asks Location
    // for out loud; being unable to offer it is the feature not existing.
    expect(snapshot.available_action_ids).toContain("location.share_selected");
    expect(snapshot.available_action_ids).toContain(
      "location.select_share_recipient",
    );
    expect(snapshot.available_action_ids).toContain("location.pause_updates");
    // Still bounded -- this fixes an ordering bug, it does not lift the cap.
    expect(snapshot.available_action_ids.length).toBeLessThanOrEqual(
      ACTION_ID_SCREEN_SEGMENT_CAP,
    );
    // And the openers are what yields, since navigation is admitted from any
    // screen whether or not this surface submitted it.
    expect(snapshot.available_action_ids).not.toContain(
      "location.open_join_circle",
    );
  });

  it("fits every one of Location's real local handlers, not just three of them", () => {
    // The scenario above used 3 local handlers as a stand-in. Location's
    // actual published contract has grown to 12 (add_to_circle and
    // remove_from_circle are the newest), which is more than the generic
    // STRUCTURED_CONTEXT_ARRAY_CAP (10) even after ranking puts every local
    // handler ahead of every route opener. Two of the twelve fell off the
    // end and came back `action_unavailable` -- indistinguishable from a
    // broken feature -- for as long as the segment cap stayed at 10.
    window.history.pushState({}, "", "/one/location");
    const openers = [
      "location.open_now",
      "location.open_people",
      "location.open_links",
      "location.open_share",
      "location.open_ask",
      "location.open_invite",
      "location.open_create_circle",
      "location.open_join_circle",
      "location.open_temporary_link",
      "location.open_check_in",
      "location.open_sos",
      "location.open_sms_contacts",
      "location.open_settings",
      "location.open_active_shares",
      "location.open_shared_with_me",
      "location.open_needs_review",
      "location.add_connections",
      "location.open_map",
    ];
    const localHandlers = [
      "location.refresh",
      "location.pause_updates",
      "location.select_share_recipient",
      "location.share_selected",
      "location.stop_sos",
      "location.set_auto_share",
      "location.add_emergency_contact",
      "location.remove_emergency_contact",
      "location.resume_updates",
      "location.create_circle",
      "location.add_to_circle",
      "location.remove_from_circle",
    ];
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "one_location",
      controls: [...openers, ...localHandlers].map((actionId) => ({
        id: actionId,
        actionId,
        label: actionId,
      })),
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState("/one/location", "one_location"),
    });

    for (const actionId of localHandlers) {
      expect(snapshot.available_action_ids).toContain(actionId);
    }
    expect(snapshot.available_action_ids.length).toBeLessThanOrEqual(
      ACTION_ID_SCREEN_SEGMENT_CAP,
    );
  });

  it("surfaces the circle actions someone is looking at when the local handlers outgrow even the ranked cap", () => {
    // Location has grown again: 28 real screen-owned local handlers now, not
    // the 12 above. Even with every route opener yielding first, that alone
    // exceeds ACTION_ID_SCREEN_SEGMENT_CAP (14) -- an across-the-board
    // ranking tie has to drop 14 of these 28 no matter what. Which 14 matters:
    // on the People tab (subview "people"), it must be the circle-membership
    // actions, not whichever eight happened to be declared first.
    window.history.pushState({}, "", "/one/location?view=people");
    const localHandlers = [
      "location.accept_circle_invite",
      "location.add_emergency_contact",
      "location.add_to_circle",
      "location.approve_request",
      "location.change_share_duration",
      "location.create_circle",
      "location.decline_circle_invite",
      "location.decline_request",
      "location.delete_circle",
      "location.delete_saved_location",
      "location.leave_circle",
      "location.pause_updates",
      "location.refresh",
      "location.remove_emergency_contact",
      "location.remove_from_circle",
      "location.rename_circle",
      "location.resume_updates",
      "location.save_current_location",
      "location.select_ask_recipient",
      "location.select_share_recipient",
      "location.send_check_in",
      "location.send_request",
      "location.set_auto_share",
      "location.share_selected",
      "location.stop_share",
      "location.stop_sos",
      "location.trigger_sos",
    ];
    publishVoiceSurfaceMetadata("test_surface", {
      screenId: "one_location",
      controls: localHandlers.map((actionId) => ({
        id: actionId,
        actionId,
        label: actionId,
      })),
    });

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: makeRuntimeState(
        "/one/location?view=people",
        "one_location",
        "people",
      ),
    });

    // What the People tab is for: managing circle membership.
    const peopleTabActions = [
      "location.add_to_circle",
      "location.remove_from_circle",
      "location.rename_circle",
      "location.leave_circle",
      "location.delete_circle",
      "location.accept_circle_invite",
      "location.decline_circle_invite",
    ];
    for (const actionId of peopleTabActions) {
      expect(snapshot.available_action_ids).toContain(actionId);
    }
    expect(snapshot.available_action_ids.length).toBeLessThanOrEqual(
      ACTION_ID_SCREEN_SEGMENT_CAP,
    );
  });
});
