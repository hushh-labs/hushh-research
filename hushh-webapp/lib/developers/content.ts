import type { DeveloperRuntime } from "@/lib/developers/runtime";

export type DeveloperSection = {
  id: string;
  label: string;
  summary: string;
};

export type IntegrationModeId = "rest" | "remote-mcp" | "npm";

export type IntegrationMode = {
  id: IntegrationModeId;
  title: string;
  summary: string;
};

export type ConsentFlowStep = {
  title: string;
  detail: string;
};

export type RestEndpoint = {
  method: "GET" | "POST";
  path: string;
  auth: string;
  purpose: string;
};

export type DeveloperFaqItem = {
  question: string;
  answer: string;
};

export type DeveloperSamplePayload = {
  title: string;
  description: string;
  code: string;
};

export const DEVELOPER_SECTIONS: DeveloperSection[] = [
  {
    id: "start",
    label: "Start Here",
    summary: "Intro, environment URLs, and the quickest path into the contract.",
  },
  {
    id: "overview",
    label: "Overview",
    summary: "Trust model, environment URLs, and the one scalable developer story.",
  },
  {
    id: "modes",
    label: "Choose Mode",
    summary: "Pick remote MCP, the REST API, or the npm bridge based on your host.",
  },
  {
    id: "dynamic-scopes",
    label: "Dynamic Scopes",
    summary: "Scopes come from the user’s indexed Personal Knowledge Model, not a hardcoded list.",
  },
  {
    id: "consent-flow",
    label: "Consent Flow",
    summary: "Discover, request, approve in Kai, then read approved scoped data.",
  },
  {
    id: "mcp",
    label: "MCP",
    summary: "Remote MCP and npm launcher guidance for external agents.",
  },
  {
    id: "api",
    label: "REST API",
    summary: "Versioned HTTP endpoints for discovery, consent, and status checks.",
  },
  {
    id: "access",
    label: "Developer Access",
    summary: "Sign in, enable access, rotate tokens, and update your app identity.",
  },
  {
    id: "faq",
    label: "Troubleshooting",
    summary: "Answers to the common integration and trust-model questions.",
  },
];

export const PUBLIC_TOOL_NAMES = [
  "discover_user_domains",
  "request_consent",
  "check_consent_status",
  "get_scoped_data",
  "validate_token",
  "list_scopes",
] as const;

export const PUBLIC_SCOPE_PATTERNS = [
  "pkm.read",
  "pkm.write",
  "attr.{domain}.*",
  "attr.{domain}.{subintent}.*",
  "attr.{domain}.{path}",
] as const;

export const CONSENT_FLOW_STEPS: ConsentFlowStep[] = [
  {
    title: "Discover",
    detail:
      "Call discover_user_domains or GET /api/v1/user-scopes/{user_id} to inspect the exact scopes available for this user right now.",
  },
  {
    title: "Request",
    detail:
      "Send one discovered scope at a time to POST /api/v1/request-consent?token=... with your developer token.",
  },
  {
    title: "Approve",
    detail:
      "The user reviews the request inside Kai, where your app display name and policy/support links are shown.",
  },
  {
    title: "Read",
    detail:
      "After approval, use get_scoped_data or the consent token-aware flow to read only the granted slice.",
  },
];

export const REST_ENDPOINTS: RestEndpoint[] = [
  {
    method: "GET",
    path: "/api/v1",
    auth: "Public when the developer API is enabled",
    purpose: "Top-level versioned contract summary and portal entry points.",
  },
  {
    method: "GET",
    path: "/api/v1/list-scopes",
    auth: "Public when the developer API is enabled",
    purpose: "Canonical dynamic scope grammar and discovery guidance.",
  },
  {
    method: "GET",
    path: "/api/v1/tool-catalog",
    auth: "Optional ?token=...",
    purpose: "Current tool visibility for public beta or a specific developer app.",
  },
  {
    method: "GET",
    path: "/api/v1/user-scopes/{user_id}",
    auth: "Developer token required",
    purpose: "Discovered scope strings and available domains for a specific user.",
  },
  {
    method: "GET",
    path: "/api/v1/consent-status",
    auth: "Developer token required",
    purpose: "Poll the latest status for a scope or request id.",
  },
  {
    method: "POST",
    path: "/api/v1/request-consent",
    auth: "Developer token required",
    purpose: "Create or reuse a consent request for one discovered scope.",
  },
];

export const FAQ_ITEMS: DeveloperFaqItem[] = [
  {
    question: "Are scopes fixed?",
    answer:
      "No. Scopes are discovered per user from the indexed Personal Knowledge Model. Always discover first, then request one of the returned scope strings.",
  },
  {
    question: "Does developer login grant data access?",
    answer:
      "No. Login enables your developer workspace and app token. User data still requires a separate consent decision inside Kai.",
  },
  {
    question: "What is the one scalable read path?",
    answer:
      "Use get_scoped_data after approval. The public developer contract does not expose named data getter variants.",
  },
  {
    question: "Where does consent approval happen?",
    answer:
      "Inside Kai. Your external agent requests consent, but the user approves or denies it in the Hushh product surface.",
  },
  {
    question: "When should I use remote MCP versus npm?",
    answer:
      "Use remote MCP when your host supports HTTP MCP directly. Use the npm bridge for hosts that still require a local stdio process.",
  },
];

export const DEVELOPER_ACCESS_NOTES = [
  "One developer app is created per signed-in Kai account.",
  "One active developer token is kept at a time. Rotate it whenever you need a fresh credential.",
  "Consent prompts show your app identity, not a raw token or opaque agent id.",
];

export const DEVELOPER_SCOPE_NOTES = [
  "Scopes are still evolving as Kai adds richer PKM coverage and tighter domain metadata.",
  "Discover available scopes per user at runtime instead of hardcoding a fixed universal list.",
  "The current Kai test-user shape is mostly financial, so early community integrations should expect financial-first examples.",
];

export const DEVELOPER_SAMPLE_PAYLOADS: DeveloperSamplePayload[] = [
  {
    title: "Sample discovery response",
    description:
      "Sanitized example based on the current Kai-style test user. Right now the discovered surface is primarily financial.",
    code: `{
  "user_id": "kai_test_user",
  "available_domains": ["financial"],
  "scopes": [
    "pkm.read",
    "attr.financial.*",
    "attr.financial.portfolio.*",
    "attr.financial.profile.*",
    "attr.financial.documents.*",
    "attr.financial.analysis_history.*",
    "attr.financial.runtime.*",
    "attr.financial.analysis.decisions.*"
  ],
  "source": "pkm_index_v2 + manifest-backed scope discovery"
}`,
  },
  {
    title: "Sample scoped data response",
    description:
      "Illustrative `get_scoped_data` shape for an approved `attr.financial.*` grant, using the current financial summary fields we have now.",
    code: `{
  "status": "success",
  "user_id": "kai_test_user",
  "scope": "attr.financial.*",
  "consent_verified": true,
  "data": {
    "financial": {
      "intent_map": [
        "portfolio",
        "profile",
        "documents",
        "analysis_history",
        "runtime",
        "analysis.decisions"
      ],
      "item_count": 19,
      "risk_score": 4,
      "risk_bucket": "aggressive",
      "risk_profile": "balanced",
      "active_source": "statement",
      "holdings_count": 19,
      "documents_count": 1,
      "profile_completed": true,
      "portfolio_risk_bucket": "aggressive",
      "investable_positions_count": 19,
      "last_statement_total_value": 6951964.54,
      "domain_contract_version": 1
    }
  },
  "top_level_keys": ["financial"],
  "zero_knowledge": true
}`,
  },
];

export function buildIntegrationModes(_runtime: DeveloperRuntime): IntegrationMode[] {
  return [
    {
      id: "remote-mcp",
      title: "Remote MCP",
      summary:
        "Point remote-capable hosts at the MCP endpoint and append ?token=<developer-token> to the URL.",
    },
    {
      id: "rest",
      title: "REST API",
      summary:
        "Use the versioned developer API for dynamic scope discovery, consent requests, and status polling.",
    },
    {
      id: "npm",
      title: "npm Bridge",
      summary:
        "Use the npm launcher when the host still expects a local stdio MCP process instead of HTTP MCP.",
    },
  ];
}

export function buildRestSnippets(runtime: DeveloperRuntime, developerToken = "<developer-token>") {
  return {
    base: `curl -s ${runtime.apiBaseUrl}`,
    discover: `curl -s \\
  "${runtime.apiBaseUrl}/user-scopes/user_123?token=${developerToken}"`,
    requestConsent: `curl -s -X POST \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "user_123",
    "scope": "attr.financial.*",
    "expiry_hours": 24,
    "reason": "Show portfolio-aware insights inside the user's external agent"
  }' \\
  "${runtime.apiBaseUrl}/request-consent?token=${developerToken}"`,
    checkStatus: `curl -s \\
  "${runtime.apiBaseUrl}/consent-status?user_id=user_123&scope=attr.financial.*&token=${developerToken}"`,
  };
}

export function buildMcpSnippets(runtime: DeveloperRuntime, developerToken = "<developer-token>") {
  return {
    remote: `{
  "mcpServers": {
    "hushh-consent-remote": {
      "url": "${runtime.mcpUrl}?token=${developerToken}"
    }
  }
}`,
    npm: `{
  "mcpServers": {
    "hushh-consent": {
      "command": "npx",
      "args": ["-y", "${runtime.npmPackage}"],
      "env": {
        "CONSENT_API_URL": "${runtime.apiOrigin}",
        "HUSHH_DEVELOPER_TOKEN": "${developerToken}"
      }
    }
  }
}`,
  };
}

export function buildWorkspaceSnippets(runtime: DeveloperRuntime, developerToken = "<developer-token>") {
  return {
    envVar: `HUSHH_DEVELOPER_TOKEN=${developerToken}`,
    remoteUrl: `${runtime.mcpUrl}?token=${developerToken}`,
    restQuery: `?token=${developerToken}`,
  };
}
