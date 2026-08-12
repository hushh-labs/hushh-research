import fs from "node:fs";

/**
 * Signed-in UI interaction flows shared by Playwright route verification
 * and native iOS UI interaction audit.
 *
 * Step types:
 * - ensure_persona: { persona: "ria" | "investor" }
 * - ensure_ria_workspace: {}
 * - click_bottom_nav: { label: "One" | "Connect" | "Search" }
 * - click_top_tab: { label: string }
 * - click_shell_action: { ariaLabel: string }
 * - click_button: { name: string, regex?: boolean }  // case-insensitive exact match unless regex=true
 * - click_voice_control: { controlId: string }
 * - click_testid: { testId: string }
 * - open_command_palette: { timeoutMs?: number }
 * - navigate_route: { route: string }
 * - clear_import_background: {}
 * - upload_test_asset: { assetPath: string, fileName: string, mimeType: string }
 * - wait_button: { name: string, regex?: boolean, timeoutMs?: number }
 * - assert_text: { value: string, regex?: boolean }
 * - assert_no_text: { value: string, regex?: boolean, timeoutMs?: number }
 * - assert_no_persona_mismatch_prompt: { timeoutMs?: number }
 * - assert_voice_control_visible: { controlId: string, timeoutMs?: number }
 * - wait_voice_mode: { modes: string[] | string, timeoutMs?: number, allowPermissionFallback?: boolean }
 * - end_voice_if_active: { timeoutMs?: number }
 * - wait_beacon: { routeIds: string[], dataStates?: string[] }
 * - assert_url_includes: { value: string }
 * - assert_visible_testid: { testId: string }
 * - assert_not_visible_testid: { testId: string }
 * - assert_viewport_visible_testid: { testId: string }
 * - assert_ria_workspace_admission: accepts either an activated RIA workspace
 *   or the canonical reviewer’s RIA onboarding admission state.
 * - open_ria_workspace: {}
 *
 * `requiresRiaWorkspace` flows are not executable for the canonical shared
 * reviewer while its RIA application is pending. The native runner records an
 * explicit `onboarding_admission` conditional skip in that case; it never
 * treats an onboarding screen as a successful workspace interaction.
 */

export const TERMINAL_DATA_STATES = [
  "loaded",
  "empty-valid",
  "unavailable-valid",
  "redirect-valid",
  "error",
];

const KAI_MARKET_ROUTE = "/one/kai";
const KAI_PORTFOLIO_ROUTE = `${KAI_MARKET_ROUTE}?tab=portfolio`;
const KAI_ANALYSIS_ROUTE = `${KAI_MARKET_ROUTE}?tab=analysis`;
const locationOnboardingContract = JSON.parse(
  fs.readFileSync(
    new URL("../../lib/onboarding/one-location-onboarding.contract.json", import.meta.url),
    "utf8",
  ),
);
const LOCATION_ONBOARDING_CHECKPOINTS = locationOnboardingContract.screens.map(
  (screen) => screen.testId,
);

export const UI_FLOWS = [
  {
    id: "native-reviewer-location-intro-fresh-session",
    route: "/one/setup/location",
    description: "Location setup traverses every screen once without mutating reviewer capability state",
    watchdog: {
      checkpoints: LOCATION_ONBOARDING_CHECKPOINTS,
      maxCheckpointRegressions: 0,
      maxNoProgressMs: 20_000,
    },
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "navigate_route", route: "/one/setup/location" },
      { type: "assert_visible_testid", testId: LOCATION_ONBOARDING_CHECKPOINTS[0] },
      { type: "click_button", name: "Get started" },
      { type: "assert_visible_testid", testId: LOCATION_ONBOARDING_CHECKPOINTS[1] },
      { type: "click_button", name: "Share my code" },
      { type: "assert_visible_testid", testId: LOCATION_ONBOARDING_CHECKPOINTS[2] },
      // Stop here rather than pressing the final CTA. It settles the reviewer's
      // Location capability, and this flow's contract is to traverse every
      // screen once *without* mutating capability state.
      { type: "wait_button", name: "Finish" },
    ],
  },
  {
    id: "shell-investor-kai-analysis",
    route: KAI_ANALYSIS_ROUTE,
    description: "Investor shell: Market -> Analysis",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_top_tab", label: "Analysis" },
      { type: "assert_url_includes", value: "tab=analysis" },
      { type: "wait_beacon", routeIds: [KAI_MARKET_ROUTE] },
      { type: "assert_viewport_visible_testid", testId: "top-app-bar-tabs" },
      { type: "assert_visible_testid", testId: "kai-analysis-primary" },
    ],
  },
  {
    id: "native-investor-kai-debate-preview-start",
    route: `${KAI_ANALYSIS_ROUTE}&ticker=AAPL&pick_source=default`,
    description:
      "Investor analysis preview: select list source and start debate without active-run loop",
    stepTimeoutMs: 60000,
    steps: [
      { type: "ensure_persona", persona: "investor" },
      {
        type: "navigate_route",
        route: `${KAI_ANALYSIS_ROUTE}&ticker=AAPL&pick_source=default`,
      },
      {
        type: "wait_beacon",
        routeIds: [KAI_MARKET_ROUTE],
        dataStates: ["loaded"],
        timeoutMs: 60000,
      },
      { type: "wait_button", name: "Start debate", timeoutMs: 60000 },
      { type: "click_button", name: "Start debate" },
      {
        type: "assert_visible_testid",
        testId: "kai-analysis-active-run",
        timeoutMs: 60000,
      },
    ],
  },
  {
    id: "shell-investor-kai-portfolio",
    route: KAI_PORTFOLIO_ROUTE,
    description: "Investor shell: Portfolio tab",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_top_tab", label: "Portfolio" },
      { type: "assert_url_includes", value: "tab=portfolio" },
      { type: "wait_beacon", routeIds: [KAI_MARKET_ROUTE] },
    ],
  },
  {
    id: "shell-investor-kai-import",
    route: "/one/kai/import",
    description: "Investor shell: Portfolio -> import route",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_top_tab", label: "Portfolio" },
      { type: "assert_url_includes", value: "tab=portfolio" },
      { type: "wait_beacon", routeIds: [KAI_MARKET_ROUTE] },
      { type: "navigate_route", route: "/one/kai/import" },
      { type: "wait_beacon", routeIds: ["/one/kai/import"] },
    ],
  },
  {
    id: "shell-ria-home",
    route: "/ria",
    description: "RIA shell: Home tab",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "click_top_tab", label: "Home" },
      { type: "wait_beacon", routeIds: ["/ria"] },
      { type: "assert_visible_testid", testId: "ria-home-primary" },
    ],
  },
  {
    id: "shell-ria-clients",
    route: "/ria/clients",
    description: "RIA shell: Clients tab",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "click_top_tab", label: "Clients" },
      { type: "wait_beacon", routeIds: ["/ria/clients"] },
    ],
  },
  {
    id: "shell-ria-picks",
    route: "/ria/picks",
    description: "RIA shell: Picks tab",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "click_top_tab", label: "Picks" },
      { type: "wait_beacon", routeIds: ["/ria/picks"] },
    ],
  },
  {
    id: "shell-marketplace",
    route: "/marketplace",
    description: "RIA shell: Connect / marketplace",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "click_bottom_nav", label: "Connect" },
      { type: "wait_beacon", routeIds: ["/marketplace"] },
    ],
  },
  {
    id: "shell-profile",
    route: "/one/profile",
    description: "Profile tab from shell",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_shell_action", ariaLabel: "Open Profile" },
      { type: "wait_beacon", routeIds: ["/one/profile"] },
      { type: "assert_visible_testid", testId: "profile-primary" },
    ],
  },
  {
    id: "shell-consents",
    route: "/one/consent",
    description: "One shell: Consent tab",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "navigate_route", route: "/one/consent" },
      { type: "wait_beacon", routeIds: ["/one/consent"] },
      { type: "assert_visible_testid", testId: "consent-manager-primary" },
    ],
  },
  {
    id: "ria-workspace-admission",
    route: "/ria",
    description: "RIA workspace resolves to fixed tabs or the verified onboarding admission state",
    steps: [
      { type: "ensure_persona", persona: "ria" },
      { type: "assert_ria_workspace_admission" },
    ],
  },
  {
    id: "ria-workspace-account-detail",
    route: "/ria/clients/[userId]/accounts/[accountId]",
    description: "RIA workspace -> taxable brokerage account",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "open_ria_workspace", timeoutMs: 120000 },
      {
        type: "wait_button",
        name: "^taxable brokerage",
        regex: true,
        timeoutMs: 60000,
      },
      { type: "click_button", name: "^taxable brokerage", regex: true },
      {
        type: "wait_beacon",
        routeIds: ["/ria/clients/[userId]/accounts/[accountId]"],
      },
    ],
  },
  {
    id: "ria-workspace-access-panel",
    route: "/ria/clients/[userId]",
    description: "RIA workspace sharing/access panel",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "open_ria_workspace", timeoutMs: 120000 },
      { type: "click_button", name: "^(sharing|access)$", regex: true },
      { type: "assert_visible_testid", testId: "ria-client-workspace-access" },
    ],
  },
  {
    id: "marketplace-workspace-card",
    route: "/marketplace",
    description: "Marketplace open workspace card when present",
    optional: true,
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "click_bottom_nav", label: "Connect" },
      { type: "wait_beacon", routeIds: ["/marketplace"] },
      {
        type: "click_button",
        name: "open workspace",
        optional: true,
      },
      {
        type: "wait_beacon",
        routeIds: ["/ria/clients/[userId]"],
        optional: true,
      },
    ],
  },
];

export const KAI_IMPORT_E2E_FLOW_ID = "native-investor-kai-import-e2e";
export const KAI_IMPORT_E2E_ASSET_PATH =
  "/native-test-assets/kai-import-e2e.pdf";
export const ONE_VOICE_NATIVE_CONTROL_FLOW_ID =
  "native-one-voice-control-smoke";

export const KAI_IMPORT_E2E_FLOW = {
  id: KAI_IMPORT_E2E_FLOW_ID,
  route: "/one/kai/import",
  description:
    "Investor import E2E: upload bundled statement, stream parse, review, save",
  steps: [
    { type: "ensure_persona", persona: "investor" },
    { type: "assert_no_persona_mismatch_prompt", timeoutMs: 15000 },
    { type: "click_top_tab", label: "Portfolio" },
    { type: "assert_url_includes", value: "tab=portfolio" },
    { type: "wait_beacon", routeIds: [KAI_MARKET_ROUTE] },
    {
      type: "click_button",
      name: "^(upload statement|import statement|import portfolio|connect portfolio)$",
      regex: true,
    },
    { type: "wait_beacon", routeIds: ["/one/kai/import"] },
    { type: "clear_import_background" },
    {
      type: "upload_test_asset",
      assetPath: KAI_IMPORT_E2E_ASSET_PATH,
      fileName: "kai-import-e2e.pdf",
      mimeType: "application/pdf",
    },
    { type: "wait_button", name: "Continue", timeoutMs: 30000 },
    { type: "click_button", name: "Continue" },
    {
      type: "wait_button",
      name: "Review Extracted Portfolio",
      timeoutMs: 600000,
    },
    { type: "click_button", name: "Review Extracted Portfolio" },
    {
      type: "assert_text",
      value: "Review Portfolio",
      timeoutMs: 60000,
    },
    {
      type: "assert_text",
      value: "Holdings \\([1-9][0-9]*\\)",
      regex: true,
      timeoutMs: 60000,
    },
    {
      type: "click_button",
      name: "^(Save to Vault|Create Vault)$",
      regex: true,
      timeoutMs: 120000,
    },
    {
      type: "wait_beacon",
      routeIds: [KAI_MARKET_ROUTE],
      dataStates: ["loaded"],
      timeoutMs: 180000,
    },
    {
      type: "assert_text",
      value: "Holdings|Portfolio Value|Assets|Positions",
      regex: true,
      timeoutMs: 60000,
    },
  ],
};

export const ONE_VOICE_NATIVE_CONTROL_FLOW = {
  id: ONE_VOICE_NATIVE_CONTROL_FLOW_ID,
  route: "/one/kai",
  description:
    "One Voice native control smoke: start realtime voice, observe state, and recover/end",
  stepTimeoutMs: 90000,
  steps: [
    { type: "ensure_persona", persona: "investor" },
    { type: "assert_no_persona_mismatch_prompt", timeoutMs: 15000 },
    { type: "navigate_route", route: "/one/kai" },
    {
      type: "wait_beacon",
      routeIds: ["/one/kai"],
      dataStates: TERMINAL_DATA_STATES,
      timeoutMs: 60000,
    },
    {
      type: "assert_voice_control_visible",
      controlId: "one_voice_agent_bar_start",
      timeoutMs: 30000,
    },
    {
      type: "click_voice_control",
      controlId: "one_voice_agent_bar_start",
    },
    {
      type: "wait_voice_mode",
      modes: ["opening", "listening", "understanding", "speaking", "error"],
      timeoutMs: 90000,
      allowPermissionFallback: true,
    },
    { type: "end_voice_if_active", timeoutMs: 2000 },
    {
      type: "wait_voice_mode",
      modes: ["idle", "error"],
      timeoutMs: 30000,
      allowPermissionFallback: true,
    },
  ],
};

export function filterUiFlows({ flowFilter = "", routeFilter = "" } = {}) {
  const normalizedFlow = flowFilter.trim();
  const normalizedRoute = routeFilter.trim();
  if (normalizedFlow === KAI_IMPORT_E2E_FLOW_ID) {
    return [KAI_IMPORT_E2E_FLOW];
  }
  if (normalizedFlow === ONE_VOICE_NATIVE_CONTROL_FLOW_ID) {
    return [ONE_VOICE_NATIVE_CONTROL_FLOW];
  }
  return UI_FLOWS.filter((flow) => {
    if (normalizedFlow && flow.id !== normalizedFlow) return false;
    if (normalizedRoute && flow.route !== normalizedRoute) return false;
    return true;
  });
}
