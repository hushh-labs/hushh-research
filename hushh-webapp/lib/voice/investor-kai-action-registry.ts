import type { KaiCommandAction, KaiWorkspaceTab } from "@/lib/kai/kai-command-types";
import { ROUTES } from "@/lib/navigation/routes";
import {
  GMAIL_RECEIPTS_API_TEMPLATES,
  SUPPORT_API_TEMPLATES,
} from "@/lib/services/kai-profile-api-paths";
import type { VoiceToolCall } from "@/lib/voice/voice-types";

export type InvestorKaiTriggerType = "voice" | "tap" | "keyboard" | "programmatic";
export type InvestorKaiRiskLevel = "low" | "medium" | "high";
export type InvestorKaiExecutionPolicy = "allow_direct" | "confirm_required" | "manual_only";
export type InvestorKaiScreenScope =
  | "kai_market"
  | "kai_portfolio_dashboard"
  | "kai_investments"
  | "kai_analysis"
  | "kai_optimize"
  | "profile_account"
  | "profile_preferences"
  | "profile_privacy"
  | "profile_support_panel"
  | "profile_gmail_panel"
  | "profile_security_panel"
  | "profile_receipts"
  | "profile_pkm_agent_lab"
  | "consents";

export type InvestorKaiGuardId =
  | "auth_signed_in"
  | "vault_unlocked"
  | "portfolio_required"
  | "analysis_idle_required"
  | "active_analysis_required"
  | "explicit_user_confirmation"
  | "manual_user_execution"
  | "gmail_configured"
  | "gmail_connected";

export type InvestorKaiBackendEffect = {
  api: string;
  effect: string;
};

export type InvestorKaiActionWiring =
  | {
      status: "wired";
      handler: "executeKaiCommand" | "dispatchVoiceToolCall" | "router.push";
      binding:
        | {
            kind: "kai_command";
            command: KaiCommandAction;
            params?: {
              tab?: KaiWorkspaceTab;
              focus?: "active";
              requiresSymbol?: boolean;
            };
          }
        | {
            kind: "voice_tool";
            toolName: VoiceToolCall["tool_name"];
          }
        | {
            kind: "route";
            href: string;
          };
    }
  | {
      status: "unwired";
      reason: string;
      intendedHandler?: "executeKaiCommand" | "dispatchVoiceToolCall" | "router.push";
    }
  | {
      status: "dead";
      reason: string;
      legacyHandler?: "executeKaiCommand" | "dispatchVoiceToolCall";
    };

export type InvestorKaiActionDefinition = {
  id: string;
  label: string;
  meaning: string;
  scope: {
    routes: readonly string[];
    screens: readonly InvestorKaiScreenScope[];
    hiddenNavigable: boolean;
    navigationPrerequisites: readonly string[];
  };
  trigger: {
    primary: InvestorKaiTriggerType;
    supported: readonly InvestorKaiTriggerType[];
  };
  guards: ReadonlyArray<{
    id: InvestorKaiGuardId;
    description: string;
  }>;
  expectedEffects: {
    stateChanges: readonly string[];
    backendEffects: readonly InvestorKaiBackendEffect[];
  };
  risk: {
    level: InvestorKaiRiskLevel;
    executionPolicy: InvestorKaiExecutionPolicy;
  };
  wiring: InvestorKaiActionWiring;
  mapReferences: readonly string[];
};

const KNOWN_KAI_COMMANDS: readonly KaiCommandAction[] = [
  "analyze",
  "optimize",
  "import",
  "consent",
  "profile",
  "history",
  "dashboard",
  "home",
];

const KNOWN_VOICE_TOOLS: readonly VoiceToolCall["tool_name"][] = [
  "execute_kai_command",
  "navigate_back",
  "resume_active_analysis",
  "cancel_active_analysis",
  "clarify",
];

export const INVESTOR_KAI_ACTION_REGISTRY: readonly InvestorKaiActionDefinition[] = [
  {
    id: "nav.kai_home",
    label: "Open Market Home",
    meaning: "Navigates to the Investor Kai market home surface.",
    scope: {
      routes: [ROUTES.KAI_HOME, ROUTES.KAI_HOME.replace("/kai", "/kai/home")],
      screens: ["kai_market"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /kai"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "home",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#3"],
  },
  {
    id: "nav.kai_dashboard",
    label: "Open Portfolio Dashboard",
    meaning: "Navigates to portfolio dashboard for source/holdings context.",
    scope: {
      routes: [ROUTES.KAI_DASHBOARD, ROUTES.KAI_PORTFOLIO],
      screens: ["kai_portfolio_dashboard"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /kai/portfolio"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "dashboard",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#3"],
  },
  {
    id: "nav.kai_analysis",
    label: "Open Analysis Surface",
    meaning: "Navigates directly to the Kai analysis workspace and history route.",
    scope: {
      routes: [ROUTES.KAI_ANALYSIS],
      screens: ["kai_analysis"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /kai/analysis"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: ROUTES.KAI_ANALYSIS,
      },
    },
    mapReferences: ["app/kai/analysis/page.tsx"],
  },
  {
    id: "nav.analysis_history",
    label: "Open Analysis History",
    meaning: "Navigates to analysis page history context.",
    scope: {
      routes: [ROUTES.KAI_ANALYSIS, `${ROUTES.KAI_ANALYSIS}?tab=history`],
      screens: ["kai_analysis"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /kai/analysis", "history tab is selected when supported"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "history",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#3"],
  },
  {
    id: "analysis.start",
    label: "Start Stock Analysis",
    meaning: "Creates fresh analysis intent and opens the debate workspace.",
    scope: {
      routes: [ROUTES.KAI_ANALYSIS],
      screens: ["kai_analysis"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "programmatic"],
    },
    guards: [
      {
        id: "analysis_idle_required",
        description: "Starting a new run is blocked while another analysis run is active.",
      },
    ],
    expectedEffects: {
      stateChanges: [
        "analysisParams is set in kai-session-store",
        "current route becomes /kai/analysis",
      ],
      backendEffects: [],
    },
    risk: {
      level: "medium",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "analyze",
        params: {
          requiresSymbol: true,
        },
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#4"],
  },
  {
    id: "analysis.resume_active",
    label: "Resume Active Analysis Run",
    meaning: "Attaches to currently running debate task and opens focused analysis route.",
    scope: {
      routes: [ROUTES.KAI_ANALYSIS, `${ROUTES.KAI_ANALYSIS}?focus=active`],
      screens: ["kai_analysis"],
      hiddenNavigable: true,
      navigationPrerequisites: ["active debate run must exist for this user"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "programmatic"],
    },
    guards: [
      {
        id: "active_analysis_required",
        description: "No-op if no active analysis run exists.",
      },
      {
        id: "vault_unlocked",
        description: "Requires vault owner token for DebateRunManagerService.resumeActiveRun.",
      },
    ],
    expectedEffects: {
      stateChanges: ["active analysis task is hydrated/resumed in run manager", "route focuses active run"],
      backendEffects: [],
    },
    risk: {
      level: "medium",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "dispatchVoiceToolCall",
      binding: {
        kind: "voice_tool",
        toolName: "resume_active_analysis",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#4"],
  },
  {
    id: "analysis.cancel_active",
    label: "Cancel Active Analysis Run",
    meaning: "Cancels running debate task and returns to history view.",
    scope: {
      routes: [ROUTES.KAI_ANALYSIS],
      screens: ["kai_analysis"],
      hiddenNavigable: true,
      navigationPrerequisites: ["active debate run must exist for this user"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "programmatic"],
    },
    guards: [
      {
        id: "active_analysis_required",
        description: "No-op when no active analysis run exists.",
      },
      {
        id: "explicit_user_confirmation",
        description: "Current dispatcher requires confirm=true payload.",
      },
      {
        id: "manual_user_execution",
        description: "Investor policy prefers user-owned destructive execution.",
      },
    ],
    expectedEffects: {
      stateChanges: [
        "active run is cancelled in DebateRunManagerService",
        "analysisParams is cleared in kai-session-store",
        "route moves to /kai/analysis?tab=history",
      ],
      backendEffects: [],
    },
    risk: {
      level: "high",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "wired",
      handler: "dispatchVoiceToolCall",
      binding: {
        kind: "voice_tool",
        toolName: "cancel_active_analysis",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#4"],
  },
  {
    id: "nav.kai_import",
    label: "Open Portfolio Import",
    meaning: "Navigates to import flow for statement upload / portfolio bootstrap.",
    scope: {
      routes: [ROUTES.KAI_IMPORT],
      screens: ["kai_portfolio_dashboard"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /kai/import"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "import",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#3"],
  },
  {
    id: "nav.kai_investments",
    label: "Open Investments Surface",
    meaning: "Navigates to investments workspace from hidden or non-visible surface.",
    scope: {
      routes: [ROUTES.KAI_INVESTMENTS],
      screens: ["kai_investments"],
      hiddenNavigable: true,
      navigationPrerequisites: ["user must be signed in"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [
      {
        id: "auth_signed_in",
        description: "Investments route requires authenticated session.",
      },
    ],
    expectedEffects: {
      stateChanges: ["current route becomes /kai/investments"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: ROUTES.KAI_INVESTMENTS,
      },
    },
    mapReferences: ["components/kai/views/dashboard-master-view.tsx"],
  },
  {
    id: "nav.kai_optimize",
    label: "Open Optimize Surface",
    meaning: "Navigates to optimize workspace route directly.",
    scope: {
      routes: [ROUTES.KAI_OPTIMIZE],
      screens: ["kai_optimize"],
      hiddenNavigable: true,
      navigationPrerequisites: ["optimization context should be prepared from portfolio source"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /kai/optimize"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: ROUTES.KAI_OPTIMIZE,
      },
    },
    mapReferences: ["app/kai/optimize/page.tsx"],
  },
  {
    id: "nav.consents",
    label: "Open Consent Center",
    meaning: "Navigates to consents route.",
    scope: {
      routes: [ROUTES.CONSENTS],
      screens: ["consents"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /consents"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "consent",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#3"],
  },
  {
    id: "nav.profile",
    label: "Open Profile",
    meaning: "Navigates to profile landing route.",
    scope: {
      routes: [ROUTES.PROFILE],
      screens: ["profile_account", "profile_preferences", "profile_privacy"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /profile"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "executeKaiCommand",
      binding: {
        kind: "kai_command",
        command: "profile",
      },
    },
    mapReferences: ["docs/voice-navigation-architecture-plan.md#3"],
  },
  {
    id: "nav.profile_receipts",
    label: "Open Receipts Page",
    meaning: "Navigates directly to receipts page from any investor surface.",
    scope: {
      routes: [ROUTES.PROFILE_RECEIPTS],
      screens: ["profile_receipts"],
      hiddenNavigable: true,
      navigationPrerequisites: ["navigate to profile surface if route is currently outside profile scope"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /profile/receipts"],
      backendEffects: [
        {
          api: `GET ${GMAIL_RECEIPTS_API_TEMPLATES.status} (proxied)`,
          effect: "Reads Gmail connector status on mount.",
        },
        {
          api: `GET ${GMAIL_RECEIPTS_API_TEMPLATES.receipts} (proxied)`,
          effect: "Reads paginated receipt items.",
        },
      ],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: ROUTES.PROFILE_RECEIPTS,
      },
    },
    mapReferences: ["app/profile/receipts/page.tsx"],
  },
  {
    id: "nav.profile_gmail_panel",
    label: "Open Gmail Connector Panel",
    meaning: "Navigates to hidden Gmail detail panel in Profile > Account.",
    scope: {
      routes: [`${ROUTES.PROFILE}?panel=gmail`],
      screens: ["profile_gmail_panel"],
      hiddenNavigable: true,
      navigationPrerequisites: ["profile route must be active", "query param panel=gmail"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["profile tab resolves to account", "gmail SettingsDetailPanel opens"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: `${ROUTES.PROFILE}?panel=gmail`,
      },
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "nav.profile_support_panel",
    label: "Open Support Panel",
    meaning: "Navigates to hidden support panel in Profile > Account.",
    scope: {
      routes: [`${ROUTES.PROFILE}?tab=account&panel=support`],
      screens: ["profile_support_panel"],
      hiddenNavigable: true,
      navigationPrerequisites: ["profile route must be active", "query params tab=account & panel=support"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["profile tab resolves to account", "support SettingsDetailPanel opens"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: `${ROUTES.PROFILE}?tab=account&panel=support`,
      },
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "nav.profile_security_panel",
    label: "Open Vault Security Panel",
    meaning: "Navigates to hidden security panel in Profile > Privacy.",
    scope: {
      routes: [`${ROUTES.PROFILE}?tab=privacy&panel=security`],
      screens: ["profile_security_panel"],
      hiddenNavigable: true,
      navigationPrerequisites: ["profile route must be active", "query params tab=privacy & panel=security"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["profile tab resolves to privacy", "security SettingsDetailPanel opens"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: `${ROUTES.PROFILE}?tab=privacy&panel=security`,
      },
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "nav.profile_pkm_agent_lab",
    label: "Open PKM Agent Lab",
    meaning: "Navigates to the PKM Agent Lab privacy workspace.",
    scope: {
      routes: [ROUTES.PROFILE_PKM_AGENT_LAB],
      screens: ["profile_pkm_agent_lab"],
      hiddenNavigable: true,
      navigationPrerequisites: ["localhost developer access to PKM Agent Lab must be enabled"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "tap", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["current route becomes /profile/pkm-agent-lab"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "router.push",
      binding: {
        kind: "route",
        href: ROUTES.PROFILE_PKM_AGENT_LAB,
      },
    },
    mapReferences: ["app/profile/pkm-agent-lab/page-client.tsx"],
  },
  {
    id: "nav.back",
    label: "Go Back",
    meaning: "Navigates back to the previous Kai or profile surface in browser history.",
    scope: {
      routes: [ROUTES.KAI_HOME, ROUTES.KAI_ANALYSIS, ROUTES.PROFILE],
      screens: ["kai_market", "kai_analysis", "profile_account"],
      hiddenNavigable: true,
      navigationPrerequisites: [
        "client browser history must have a previous entry",
        "current route must already be inside a signed-in Kai or profile surface",
      ],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "keyboard", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["browser history moves back one entry when available"],
      backendEffects: [],
    },
    risk: {
      level: "low",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "wired",
      handler: "dispatchVoiceToolCall",
      binding: {
        kind: "voice_tool",
        toolName: "navigate_back",
      },
    },
    mapReferences: ["hushh-webapp/lib/voice/voice-action-dispatcher.ts"],
  },
  {
    id: "profile.gmail.connect",
    label: "Connect Gmail",
    meaning: "Starts OAuth flow for Gmail receipts connector.",
    scope: {
      routes: [ROUTES.PROFILE, `${ROUTES.PROFILE}?panel=gmail`],
      screens: ["profile_gmail_panel"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "gmail_configured",
        description: "Connector must be configured by environment vars and backend setup.",
      },
    ],
    expectedEffects: {
      stateChanges: ["gmail connector UI enters connecting state", "browser redirects to Google OAuth consent"],
      backendEffects: [
        {
          api: `POST ${GMAIL_RECEIPTS_API_TEMPLATES.connectStart} (proxied)`,
          effect: "Generates OAuth authorize URL and state nonce.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "confirm_required",
    },
    wiring: {
      status: "unwired",
      reason: "Only local component handler exists (handleConnectGmail in ProfilePage).",
      intendedHandler: "router.push",
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "profile.gmail.sync_now",
    label: "Sync Gmail Receipts Now",
    meaning: "Queues and polls Gmail receipt sync run.",
    scope: {
      routes: [ROUTES.PROFILE_RECEIPTS, `${ROUTES.PROFILE}?panel=gmail`],
      screens: ["profile_receipts", "profile_gmail_panel"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "gmail_connected",
        description: "Requires connected Gmail account state.",
      },
    ],
    expectedEffects: {
      stateChanges: ["gmail sync run transitions queued/running/completed", "receipts list refreshes after completion"],
      backendEffects: [
        {
          api: `POST ${GMAIL_RECEIPTS_API_TEMPLATES.sync} (proxied)`,
          effect: "Queues sync job.",
        },
        {
          api: `GET ${GMAIL_RECEIPTS_API_TEMPLATES.syncRun} (proxied)`,
          effect: "Polls sync run status.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "confirm_required",
    },
    wiring: {
      status: "unwired",
      reason: "Implemented only in local page handlers; no shared voice/action adapter yet.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/page.tsx", "app/profile/receipts/page.tsx"],
  },
  {
    id: "profile.receipts_memory.preview",
    label: "Build receipts memory preview",
    meaning: "Builds the receipts-to-PKM preview from stored Gmail receipts.",
    scope: {
      routes: [ROUTES.PROFILE_RECEIPTS],
      screens: ["profile_receipts"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: [
        "receipt memory preview loads or refreshes",
        "preview summary reflects merchants, patterns, highlights, and signals",
      ],
      backendEffects: [
        {
          api: "POST /api/kai/gmail/receipts-memory/preview (proxied)",
          effect: "Builds or refreshes the receipts memory artifact preview.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "unwired",
      reason: "Implemented only in local receipts-page handlers; no shared voice/action adapter yet.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/receipts/page.tsx"],
  },
  {
    id: "profile.receipts_memory.save",
    label: "Save receipts memory to PKM",
    meaning: "Persists the current receipts-memory preview into shopping.receipts_memory.",
    scope: {
      routes: [ROUTES.PROFILE_RECEIPTS],
      screens: ["profile_receipts"],
      hiddenNavigable: false,
      navigationPrerequisites: ["receipt memory preview must exist before save"],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "vault_unlocked",
        description: "Requires an unlocked vault and owner token for encrypted PKM save.",
      },
      {
        id: "manual_user_execution",
        description: "Saving new durable memory remains user-owned in the current receipts flow.",
      },
    ],
    expectedEffects: {
      stateChanges: ["shopping.receipts_memory is refreshed in PKM", "receipt memory save status updates"],
      backendEffects: [
        {
          api: "POST /api/pkm/store-domain/validate",
          effect: "Validates the prepared shopping domain payload before store.",
        },
        {
          api: "POST /api/pkm/store-domain",
          effect: "Persists the updated shopping PKM domain after encryption.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "unwired",
      reason: "Save to PKM is currently implemented only inside the receipts page.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/receipts/page.tsx"],
  },
  {
    id: "profile.gmail.disconnect",
    label: "Disconnect Gmail",
    meaning: "Disconnects Gmail OAuth credentials for future syncs.",
    scope: {
      routes: [`${ROUTES.PROFILE}?panel=gmail`],
      screens: ["profile_gmail_panel"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "gmail_connected",
        description: "Only available after connector is connected.",
      },
      {
        id: "manual_user_execution",
        description: "Disconnect is user-owned destructive preference change.",
      },
    ],
    expectedEffects: {
      stateChanges: ["gmail status becomes disconnected", "future syncs are disabled"],
      backendEffects: [
        {
          api: `POST ${GMAIL_RECEIPTS_API_TEMPLATES.disconnect} (proxied)`,
          effect: "Revokes connector state in backend.",
        },
      ],
    },
    risk: {
      level: "high",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "unwired",
      reason: "No global action dispatcher for Gmail disconnect yet.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "profile.pkm.preview_capture",
    label: "Generate PKM capture preview",
    meaning: "Builds the current PKM Agent Lab capture preview without saving it.",
    scope: {
      routes: [ROUTES.PROFILE_PKM_AGENT_LAB],
      screens: ["profile_pkm_agent_lab"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "vault_unlocked",
        description: "Agent Lab preview requires vault-backed PKM access for the current account.",
      },
    ],
    expectedEffects: {
      stateChanges: ["capture preview cards refresh", "raw PKM agent response payload updates"],
      backendEffects: [
        {
          api: "POST /api/pkm/agent-lab/structure",
          effect: "Builds a PKM capture preview and manifest draft.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "allow_direct",
    },
    wiring: {
      status: "unwired",
      reason: "Generate preview is currently handled only by local PKM Agent Lab state.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/pkm-agent-lab/page-client.tsx"],
  },
  {
    id: "profile.pkm.save_capture",
    label: "Save PKM capture",
    meaning: "Persists the current PKM Agent Lab capture into encrypted PKM storage.",
    scope: {
      routes: [ROUTES.PROFILE_PKM_AGENT_LAB],
      screens: ["profile_pkm_agent_lab"],
      hiddenNavigable: false,
      navigationPrerequisites: ["a saveable PKM capture preview must already exist"],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "vault_unlocked",
        description: "Requires an unlocked vault before saving encrypted PKM data.",
      },
      {
        id: "manual_user_execution",
        description: "Agent Lab save remains user-owned until a shared dispatcher exists.",
      },
    ],
    expectedEffects: {
      stateChanges: ["preview cards are saved into PKM", "natural/explorer views refresh after save"],
      backendEffects: [
        {
          api: "POST /api/pkm/store-domain",
          effect: "Persists the encrypted PKM write prepared by Agent Lab.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "unwired",
      reason: "Save encrypted capture is currently handled only inside PKM Agent Lab.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/pkm-agent-lab/page-client.tsx"],
  },
  {
    id: "profile.support.submit_message",
    label: "Submit Support Message",
    meaning: "Sends support/bug/developer feedback email via support service.",
    scope: {
      routes: [`${ROUTES.PROFILE}?tab=account&panel=support`],
      screens: ["profile_support_panel"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "auth_signed_in",
        description: "Requires signed-in user and id token for support API.",
      },
    ],
    expectedEffects: {
      stateChanges: ["support dialog closes on success", "toast confirmation rendered"],
      backendEffects: [
        {
          api: `POST ${SUPPORT_API_TEMPLATES.message} (proxied)`,
          effect: "Routes support payload to support_email_service.",
        },
      ],
    },
    risk: {
      level: "medium",
      executionPolicy: "confirm_required",
    },
    wiring: {
      status: "unwired",
      reason: "submitSupportMessage is local to ProfilePage and not exported to global executor.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "profile.marketplace_visibility.toggle",
    label: "Toggle Marketplace Visibility",
    meaning: "Opts investor persona in/out of RIA marketplace discoverability.",
    scope: {
      routes: [`${ROUTES.PROFILE}?tab=privacy`],
      screens: ["profile_privacy"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "auth_signed_in",
        description: "Requires id token and investor persona.",
      },
      {
        id: "manual_user_execution",
        description: "Privacy preference should be user-confirmed in UI.",
      },
    ],
    expectedEffects: {
      stateChanges: ["marketplaceOptIn toggles in profile state", "persona cache invalidates and refreshes"],
      backendEffects: [
        {
          api: "POST /api/iam/marketplace/opt-in",
          effect: "Persists investor marketplace visibility preference.",
        },
      ],
    },
    risk: {
      level: "high",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "unwired",
      reason: "Only handled by local Switch in ProfilePage.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "profile.sign_out",
    label: "Sign Out",
    meaning: "Ends current session and redirects to home route.",
    scope: {
      routes: [ROUTES.PROFILE],
      screens: ["profile_account"],
      hiddenNavigable: false,
      navigationPrerequisites: [],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "manual_user_execution",
        description: "Session termination is user-owned and should remain explicit.",
      },
    ],
    expectedEffects: {
      stateChanges: ["auth session cleared", "route navigates to home"],
      backendEffects: [],
    },
    risk: {
      level: "high",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "unwired",
      reason: "handleSignOut exists only in ProfilePage and is not bound to voice/global executor.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "profile.delete_account",
    label: "Delete Account",
    meaning: "Deletes investor/ria persona or full account depending on selected target.",
    scope: {
      routes: [ROUTES.PROFILE],
      screens: ["profile_account"],
      hiddenNavigable: false,
      navigationPrerequisites: ["vault unlock may be required before delete confirmation"],
    },
    trigger: {
      primary: "tap",
      supported: ["tap", "voice", "programmatic"],
    },
    guards: [
      {
        id: "explicit_user_confirmation",
        description: "Delete flow must pass AlertDialog confirmation and target selection.",
      },
      {
        id: "manual_user_execution",
        description: "Destructive account operations are intentionally user-owned.",
      },
    ],
    expectedEffects: {
      stateChanges: ["persona/account data removed", "possible sign-out and redirect"],
      backendEffects: [
        {
          api: "POST /api/account/delete",
          effect: "Deletes account or persona according to selected target.",
        },
      ],
    },
    risk: {
      level: "high",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "unwired",
      reason: "Delete flow is intentionally local + guarded by dialogs and vault unlock.",
      intendedHandler: "dispatchVoiceToolCall",
    },
    mapReferences: ["app/profile/page.tsx"],
  },
  {
    id: "analysis.open_transcript_tab_legacy",
    label: "Legacy Transcript Tab Route",
    meaning: "Legacy tab token accepted by parser but no transcript tab is rendered in current analysis UI.",
    scope: {
      routes: [`${ROUTES.KAI_ANALYSIS}?tab=transcript`],
      screens: ["kai_analysis"],
      hiddenNavigable: true,
      navigationPrerequisites: ["analysis route must be loaded"],
    },
    trigger: {
      primary: "voice",
      supported: ["voice", "programmatic"],
    },
    guards: [],
    expectedEffects: {
      stateChanges: ["query param may be normalized away by analysis page effect"],
      backendEffects: [],
    },
    risk: {
      level: "medium",
      executionPolicy: "manual_only",
    },
    wiring: {
      status: "dead",
      reason: "No transcript tab trigger/content exists in app/kai/analysis/page.tsx.",
    },
    mapReferences: ["lib/voice/voice-json-validator.ts", "app/kai/analysis/page.tsx"],
  },
] as const satisfies readonly InvestorKaiActionDefinition[];

export type InvestorKaiActionId = (typeof INVESTOR_KAI_ACTION_REGISTRY)[number]["id"];

const ACTIONS_BY_ID = new Map(
  INVESTOR_KAI_ACTION_REGISTRY.map((action) => [action.id, action] as const)
);

const ACTIONS_BY_KAI_COMMAND = new Map<KaiCommandAction, InvestorKaiActionDefinition>(
  INVESTOR_KAI_ACTION_REGISTRY.flatMap((action) => {
    if (action.wiring.status !== "wired" || action.wiring.binding.kind !== "kai_command") {
      return [];
    }
    return [[action.wiring.binding.command, action] as const];
  })
);

export function getInvestorKaiActionById(
  id: InvestorKaiActionId | string
): InvestorKaiActionDefinition | null {
  return ACTIONS_BY_ID.get(id) || null;
}

export function getInvestorKaiActionByKaiCommand(
  command: KaiCommandAction
): InvestorKaiActionDefinition | null {
  return ACTIONS_BY_KAI_COMMAND.get(command) || null;
}

export function getInvestorKaiActionByVoiceToolCall(
  toolCall: VoiceToolCall
): InvestorKaiActionDefinition | null {
  if (toolCall.tool_name === "execute_kai_command") {
    return getInvestorKaiActionByKaiCommand(toolCall.args.command);
  }
  for (const action of INVESTOR_KAI_ACTION_REGISTRY) {
    if (action.wiring.status !== "wired") continue;
    if (action.wiring.binding.kind !== "voice_tool") continue;
    if (action.wiring.binding.toolName === toolCall.tool_name) {
      return action;
    }
  }
  return null;
}

export function resolveInvestorKaiActionWiring(action: InvestorKaiActionDefinition): {
  resolvable: boolean;
  reason: string;
} {
  if (action.wiring.status !== "wired") {
    return {
      resolvable: false,
      reason: action.wiring.reason,
    };
  }

  const binding = action.wiring.binding;
  if (binding.kind === "kai_command") {
    return {
      resolvable: KNOWN_KAI_COMMANDS.includes(binding.command),
      reason: KNOWN_KAI_COMMANDS.includes(binding.command)
        ? "resolved via executeKaiCommand"
        : "unknown kai command binding",
    };
  }

  if (binding.kind === "voice_tool") {
    return {
      resolvable: KNOWN_VOICE_TOOLS.includes(binding.toolName),
      reason: KNOWN_VOICE_TOOLS.includes(binding.toolName)
        ? "resolved via dispatchVoiceToolCall"
        : "unknown voice tool binding",
    };
  }

  return {
    resolvable: binding.href.startsWith("/"),
    reason: binding.href.startsWith("/") ? "resolved via router.push" : "invalid route href",
  };
}

function normalizeRouteHref(value: string | null | undefined): string {
  return String(value || "").trim();
}

function stripQuery(value: string | null | undefined): string {
  const normalized = normalizeRouteHref(value);
  if (!normalized) return "";
  const queryIndex = normalized.indexOf("?");
  return queryIndex >= 0 ? normalized.slice(0, queryIndex) : normalized;
}

function routeMatchesSurface(
  routeHref: string,
  surfaceHref: string,
  surfacePathname: string
): boolean {
  const normalizedRoute = normalizeRouteHref(routeHref);
  if (!normalizedRoute) return false;
  if (normalizedRoute.includes("?")) {
    return Boolean(surfaceHref) && normalizedRoute === surfaceHref;
  }
  if (surfaceHref && normalizedRoute === surfaceHref) {
    return true;
  }
  return stripQuery(normalizedRoute) === surfacePathname;
}

export function listInvestorKaiActionsForSurface(input: {
  screen?: string | null;
  href?: string | null;
  pathname?: string | null;
}): readonly InvestorKaiActionDefinition[] {
  const screen = String(input.screen || "").trim();
  const href = normalizeRouteHref(input.href);
  const pathname = stripQuery(input.pathname || href);

  return INVESTOR_KAI_ACTION_REGISTRY.filter((action) => {
    if (screen && action.scope.screens.includes(screen as InvestorKaiScreenScope)) {
      return true;
    }
    return action.scope.routes.some((routeHref) =>
      routeMatchesSurface(routeHref, href, pathname)
    );
  });
}

export function listInvestorKaiActions(): readonly InvestorKaiActionDefinition[] {
  return INVESTOR_KAI_ACTION_REGISTRY;
}
