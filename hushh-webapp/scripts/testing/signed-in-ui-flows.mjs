/**
 * Signed-in UI interaction flows shared by Playwright route verification
 * and native iOS UI interaction audit.
 *
 * Step types:
 * - ensure_persona: { persona: "ria" | "investor" }
 * - click_bottom_nav: { label: string }
 * - click_button: { name: string }  // case-insensitive exact match
 * - click_voice_control: { controlId: string }
 * - click_testid: { testId: string }
 * - clear_import_background: {}
 * - upload_test_asset: { assetPath: string, fileName: string, mimeType: string }
 * - wait_button: { name: string, regex?: boolean, timeoutMs?: number }
 * - assert_text: { value: string, regex?: boolean }
 * - assert_no_persona_mismatch_prompt: { timeoutMs?: number }
 * - wait_beacon: { routeIds: string[], dataStates?: string[] }
 * - assert_url_includes: { value: string }
 * - assert_visible_testid: { testId: string }
 * - open_ria_workspace: {}
 */

export const TERMINAL_DATA_STATES = [
  "loaded",
  "empty-valid",
  "unavailable-valid",
  "redirect-valid",
  "error",
];

export const UI_FLOWS = [
  {
    id: "shell-investor-kai-analysis",
    route: "/kai/analysis",
    description: "Investor shell: Market -> Analysis",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_bottom_nav", label: "Market" },
      { type: "wait_beacon", routeIds: ["/kai"] },
      { type: "click_bottom_nav", label: "Analysis" },
      { type: "wait_beacon", routeIds: ["/kai/analysis"] },
      { type: "assert_visible_testid", testId: "kai-analysis-primary" },
    ],
  },
  {
    id: "shell-investor-kai-portfolio",
    route: "/kai/portfolio",
    description: "Investor shell: Portfolio tab",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_bottom_nav", label: "Portfolio" },
      { type: "wait_beacon", routeIds: ["/kai/portfolio"] },
    ],
  },
  {
    id: "shell-investor-kai-import",
    route: "/kai/import",
    description: "Investor shell: Portfolio -> import CTA",
    steps: [
      { type: "ensure_persona", persona: "investor" },
      { type: "click_bottom_nav", label: "Portfolio" },
      { type: "wait_beacon", routeIds: ["/kai/portfolio"] },
      {
        type: "click_button",
        name: "^(upload statement|import statement|import portfolio|connect portfolio)$",
        regex: true,
      },
      { type: "wait_beacon", routeIds: ["/kai/import"] },
    ],
  },
  {
    id: "shell-ria-home",
    route: "/ria",
    description: "RIA shell: Home tab",
    steps: [
      { type: "ensure_persona", persona: "ria" },
      { type: "click_bottom_nav", label: "Home" },
      { type: "wait_beacon", routeIds: ["/ria"] },
    ],
  },
  {
    id: "shell-ria-clients",
    route: "/ria/clients",
    description: "RIA shell: Clients tab",
    steps: [
      { type: "ensure_persona", persona: "ria" },
      { type: "click_bottom_nav", label: "Clients" },
      { type: "wait_beacon", routeIds: ["/ria/clients"] },
    ],
  },
  {
    id: "shell-ria-picks",
    route: "/ria/picks",
    description: "RIA shell: Picks tab",
    steps: [
      { type: "ensure_persona", persona: "ria" },
      { type: "click_bottom_nav", label: "Picks" },
      { type: "wait_beacon", routeIds: ["/ria/picks"] },
      { type: "assert_visible_testid", testId: "ria-picks-primary" },
    ],
  },
  {
    id: "shell-marketplace",
    route: "/marketplace",
    description: "RIA shell: Connect / marketplace",
    steps: [
      { type: "ensure_persona", persona: "ria" },
      { type: "click_bottom_nav", label: "Connect" },
      { type: "wait_beacon", routeIds: ["/marketplace"] },
    ],
  },
  {
    id: "shell-profile",
    route: "/profile",
    description: "Profile tab from shell",
    steps: [
      { type: "click_bottom_nav", label: "Profile" },
      { type: "wait_beacon", routeIds: ["/profile"] },
      { type: "assert_visible_testid", testId: "profile-primary" },
    ],
  },
  {
    id: "shell-consents",
    route: "/consents",
    description: "Profile -> Access & sharing -> Consent center",
    steps: [
      { type: "click_bottom_nav", label: "Profile" },
      { type: "wait_beacon", routeIds: ["/profile"] },
      { type: "click_button", name: "access & sharing" },
      { type: "click_button", name: "consent center" },
      { type: "wait_beacon", routeIds: ["/consents"] },
    ],
  },
  {
    id: "ria-picks-source-category-tabs",
    route: "/ria/picks",
    description: "RIA picks source + category segmented controls",
    steps: [
      { type: "ensure_persona", persona: "ria" },
      { type: "click_bottom_nav", label: "Picks" },
      { type: "wait_beacon", routeIds: ["/ria/picks"] },
      { type: "click_button", name: "kai list" },
      { type: "assert_url_includes", value: "source=kai" },
      { type: "click_button", name: "my list" },
      { type: "assert_url_includes", value: "source=my" },
      { type: "click_button", name: "top picks" },
      { type: "assert_url_includes", value: "category=top-picks" },
      { type: "click_button", name: "avoid" },
      { type: "assert_url_includes", value: "category=avoid" },
      { type: "click_button", name: "screening" },
      { type: "assert_url_includes", value: "category=screening" },
    ],
  },
  {
    id: "ria-workspace-account-detail",
    route: "/ria/clients/[userId]/accounts/[accountId]",
    description: "RIA workspace -> taxable brokerage account",
    steps: [
      { type: "open_ria_workspace" },
      { type: "click_button", name: "taxable brokerage" },
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
    steps: [
      { type: "open_ria_workspace" },
      { type: "click_button", name: "^(sharing|access)$", regex: true },
      { type: "assert_visible_testid", testId: "ria-client-workspace-access" },
    ],
  },
  {
    id: "marketplace-workspace-card",
    route: "/marketplace",
    description: "Marketplace open workspace card when present",
    optional: true,
    steps: [
      { type: "ensure_persona", persona: "ria" },
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
export const KAI_IMPORT_E2E_ASSET_PATH = "/native-test-assets/kai-import-e2e.pdf";

export const KAI_IMPORT_E2E_FLOW = {
  id: KAI_IMPORT_E2E_FLOW_ID,
  route: "/kai/import",
  description: "Investor import E2E: upload bundled statement, stream parse, review, save",
  steps: [
    { type: "ensure_persona", persona: "investor" },
    { type: "assert_no_persona_mismatch_prompt", timeoutMs: 15000 },
    { type: "click_bottom_nav", label: "Portfolio" },
    { type: "wait_beacon", routeIds: ["/kai/portfolio"] },
    {
      type: "click_button",
      name: "^(upload statement|import statement|import portfolio|connect portfolio)$",
      regex: true,
    },
    { type: "wait_beacon", routeIds: ["/kai/import"] },
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
      routeIds: ["/kai/portfolio"],
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

export function filterUiFlows({ flowFilter = "", routeFilter = "" } = {}) {
  const normalizedFlow = flowFilter.trim();
  const normalizedRoute = routeFilter.trim();
  if (normalizedFlow === KAI_IMPORT_E2E_FLOW_ID) {
    return [KAI_IMPORT_E2E_FLOW];
  }
  return UI_FLOWS.filter((flow) => {
    if (normalizedFlow && flow.id !== normalizedFlow) return false;
    if (normalizedRoute && flow.route !== normalizedRoute) return false;
    return true;
  });
}
