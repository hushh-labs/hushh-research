import type { DeveloperRuntime } from "@/lib/developers/runtime";
import mcpPublicDocs from "@/lib/developers/public-docs.json";

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

export type McpHostExample = {
  id: string;
  title: string;
  whenToUse: string;
  secretNote: string;
  code: string;
  copyLabel: string;
};

type McpPublicDocs = typeof mcpPublicDocs;

const MCP_PUBLIC_DOCS = mcpPublicDocs as McpPublicDocs;

export const MCP_PUBLIC_LINKS = {
  npmPackageUrl: `https://www.npmjs.com/package/${MCP_PUBLIC_DOCS.packageName}`,
  technicalCompanionUrl:
    "https://github.com/hushh-labs/hushh-research/blob/main/consent-protocol/docs/mcp-setup.md",
  apiReferenceUrl:
    "https://github.com/hushh-labs/hushh-research/blob/main/consent-protocol/docs/reference/developer-api.md",
} as const;

function renderMcpTemplate(
  template: string,
  replacements: {
    remoteUrl: string;
    packageName: string;
    apiOrigin: string;
    tokenEnvVar: string;
    developerToken: string;
  }
) {
  return template
    .replaceAll("{{REMOTE_URL}}", replacements.remoteUrl)
    .replaceAll("{{PACKAGE_NAME}}", replacements.packageName)
    .replaceAll("{{API_ORIGIN}}", replacements.apiOrigin)
    .replaceAll("{{TOKEN_ENV_VAR}}", replacements.tokenEnvVar)
    .replaceAll("<developer-token>", replacements.developerToken);
}

function buildMcpHostExamples(developerToken = "<developer-token>"): McpHostExample[] {
  const remoteUrl = MCP_PUBLIC_DOCS.promotedEnvironment.remoteUrlTemplate.replace(
    "<developer-token>",
    developerToken
  );

  return MCP_PUBLIC_DOCS.hostExamples.map((example) => ({
    id: example.id,
    title: example.title,
    whenToUse: example.whenToUse,
    secretNote: renderMcpTemplate(example.secretNote, {
      remoteUrl,
      packageName: MCP_PUBLIC_DOCS.packageName,
      apiOrigin: MCP_PUBLIC_DOCS.promotedEnvironment.apiOrigin,
      tokenEnvVar: MCP_PUBLIC_DOCS.tokenEnvVar,
      developerToken,
    }),
    code: renderMcpTemplate(example.template, {
      remoteUrl,
      packageName: MCP_PUBLIC_DOCS.packageName,
      apiOrigin: MCP_PUBLIC_DOCS.promotedEnvironment.apiOrigin,
      tokenEnvVar: MCP_PUBLIC_DOCS.tokenEnvVar,
      developerToken,
    }),
    copyLabel: example.title,
  }));
}

export const DEVELOPER_SECTIONS: DeveloperSection[] = [
  {
    id: "start",
    label: "Quick Start",
    summary: "One copy-ready Remote MCP setup.",
  },
  {
    id: "mcp",
    label: "Remote MCP",
    summary: "Connect through streamable HTTP.",
  },
  {
    id: "access",
    label: "Developer Access",
    summary: "Manage an app token.",
  },
  {
    id: "overview",
    label: "Trust Model",
    summary: "Consent is separate from login.",
  },
  {
    id: "dynamic-scopes",
    label: "Dynamic Scopes",
    summary: "Discover scopes per person.",
  },
  {
    id: "consent-flow",
    label: "Consent Flow",
    summary: "Request and read approved scopes.",
  },
  {
    id: "modes",
    label: "Advanced",
    summary: "REST and npm alternatives.",
  },
  {
    id: "api",
    label: "REST API",
    summary: "Versioned endpoint reference.",
  },
  {
    id: "faq",
    label: "Troubleshooting",
    summary: "Answers from the current runtime contract.",
  },
];

export const PUBLIC_TOOL_NAMES = [...MCP_PUBLIC_DOCS.publicTools] as const;
export const MCP_PROTOCOL_REVISION = MCP_PUBLIC_DOCS.mcpProtocolRevision;
export const CORE_CONSENT_LIFECYCLE_TOOLS = [
  "search_user_scopes",
  "request_consent",
  "check_consent_status",
  "get_encrypted_scoped_export",
] as const;
export const STANDARD_CATALOG_COMPATIBILITY_TOOL = "prepare_campaign_context";
export const PUBLIC_RESOURCE_URIS = [...MCP_PUBLIC_DOCS.publicResources] as const;
export const PUBLIC_MCP_ENVIRONMENT = {
  label: MCP_PUBLIC_DOCS.promotedEnvironment.label,
  apiOrigin: MCP_PUBLIC_DOCS.promotedEnvironment.apiOrigin,
  remoteUrlTemplate: MCP_PUBLIC_DOCS.promotedEnvironment.remoteUrlTemplate,
} as const;

// Kept in sync with the live grammar returned by GET /api/v1/list-scopes
// (verified against api.uat.hushh.ai — v2, 2 scope entries), rather than a
// hand-maintained flat list that can drift from the actual API contract.
export const PUBLIC_SCOPE_PATTERNS = [
  "cap.one.invoke",
  "attr.{domain_slug}.{scope_slug}.*",
] as const;

export const CONSENT_FLOW_STEPS: ConsentFlowStep[] = [
  {
    title: "Discover",
    detail:
      "Call search_user_scopes with the caller-supplied user identifier to inspect the exact scopes available for this person right now.",
  },
  {
    title: "Request",
    detail:
      "Call request_consent with one returned scope and a plain-language purpose. Hosted connectors provide their X25519 public-key bundle here; local stdio manages its own keypair.",
  },
  {
    title: "Approve",
    detail:
      "The user reviews the request inside Kai, where your app display name and policy/support links are shown.",
  },
  {
    title: "Read",
    detail:
      "Use grant_ref with get_encrypted_scoped_export. Hosted MCP returns an encrypted-inline envelope and ciphertext for connector-side decryption; structuredContent is canonical and its text mirror keeps older MCP hosts compatible.",
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
    auth: "Optional Authorization: Bearer",
    purpose: "Current tool visibility for the public developer lane or a specific developer app.",
  },
  {
    method: "GET",
    path: "/api/v1/user-scopes/{user_id}",
    auth: "Authorization: Bearer required",
    purpose: "Discovered scope strings and available domains for a specific user.",
  },
  {
    method: "GET",
    path: "/api/v1/consent-status",
    auth: "Authorization: Bearer required",
    purpose: "Poll the latest status for a scope or request id.",
  },
  {
    method: "POST",
    path: "/api/v1/request-consent",
    auth: "Authorization: Bearer required",
    purpose: "Create or reuse a consent request for one discovered scope.",
  },
  {
    method: "POST",
    path: "/api/v1/public-profile-export",
    auth: "Authorization: Bearer required",
    purpose: "Publish or update an owner-controlled public-profile projection (separate from encrypted attr.* consent grants).",
  },
  {
    method: "POST",
    path: "/api/v1/scoped-export",
    auth: "Authorization: Bearer required",
    purpose: "Return ciphertext and wrapped-key metadata for one approved grant.",
  },
];

export const FAQ_ITEMS: DeveloperFaqItem[] = [
  {
    question: "Are scopes fixed?",
    answer:
      "No. Scopes are discovered per user from the indexed Personal Knowledge Model. Always discover first, then request one of the returned scope strings.",
  },
  {
    question: "Does developer login grant information access?",
    answer:
      "No. Login enables your developer workspace and app token. Personal information still requires a separate consent decision inside Kai.",
  },
  {
    question: "What is the one scalable read path?",
    answer:
      "Use get_encrypted_scoped_export after approval. Hussh returns ciphertext plus wrapped-key metadata, and your connector decrypts locally.",
  },
  {
    question: "What happens if I ask for a narrower scope while I already have a broader one?",
    answer:
      "Hussh reuses the existing broader active grant and returns it immediately, but the exported package remains the canonical broader encrypted export. Pass the narrower scope as expected_scope and narrow it locally after decrypting.",
  },
  {
    question: "What happens if I ask for a broader scope while I already have a narrower one?",
    answer:
      "That is a privilege increase, so it still requires fresh user approval in Kai. After approval, the broader token becomes canonical and the older narrower token is superseded in the audit trail.",
  },
  {
    question: "Where does consent approval happen?",
    answer:
      "Inside Kai. Your external agent requests consent, but the user approves or denies it in the Hussh product surface.",
  },
  {
    question: "When is a connector key required?",
    answer:
      "Hosted MCP and raw HTTP provide connector_public_key, connector_key_id, and connector_wrapping_alg on request_consent. The npm bridge manages its persistent X25519 keypair locally, so stdio callers do not provide private-key material to the model.",
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
  "A broader active grant can satisfy a narrower request, but a narrower active grant never auto-upgrades to a broader parent scope.",
];

export const DEVELOPER_SAMPLE_PAYLOADS: DeveloperSamplePayload[] = [
  {
    title: "Scope search result",
    description:
      "The supplied person identifier is resolved internally and never appears in the result.",
    code: `{
  "status": "success",
  "scopes": [{
    "scope": "attr.financial.portfolio.*",
    "domain": "financial",
    "label": "Portfolio",
    "description": "Approved portfolio holdings and allocation details."
  }],
  "next_cursor": null,
  "has_more": false
}`,
  },
  {
    title: "Pending consent",
    description:
      "Keep the opaque request_ref and poll only at the returned interval.",
    code: `{
  "status": "pending",
  "scope": "attr.financial.portfolio.*",
  "request_ref": "req_…",
  "poll_after_seconds": 5,
  "approval_timeout_at": 1760000000000,
  "expires_at": null
}`,
  },
];

export function buildIntegrationModes(_runtime: DeveloperRuntime): IntegrationMode[] {
  return [
    {
      id: "remote-mcp",
      title: "Remote/Streamable MCP",
      summary:
        `Point remote-capable hosts at ${MCP_PUBLIC_DOCS.promotedEnvironment.label} and use the trailing-slash /mcp/ endpoint with a Bearer token.`,
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
        `Use ${MCP_PUBLIC_DOCS.packageName} only when the host still expects a local stdio MCP process instead of streamable HTTP MCP.`,
    },
  ];
}

export function buildRestSnippets(runtime: DeveloperRuntime, developerToken = "<developer-token>") {
  // The developer API requires "Authorization: Bearer <token>"; it explicitly
  // rejects query-string ?token=... auth (verified live against
  // api.uat.hushh.ai/api/v1/user-scopes/{id}, which returns
  // QUERY_TOKEN_AUTH_UNSUPPORTED for a query param and DEVELOPER_TOKEN_REQUIRED
  // asking for the Bearer header when no auth is sent at all).
  const authHeader = `-H "Authorization: Bearer ${developerToken}"`;
  return {
    base: `curl -s ${runtime.apiBaseUrl}`,
    discover: `curl -s \\
  ${authHeader} \\
  "${runtime.apiBaseUrl}/user-scopes/user_123"`,
    requestConsent: `curl -s -X POST \\
  ${authHeader} \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "user_123",
    "scope": "attr.financial.*",
    "expiry_hours": 24,
    "approval_timeout_minutes": 60,
    "reason": "Show portfolio-aware insights inside the user's external agent",
    "connector_public_key": "<base64-encoded-x25519-public-key>",
    "connector_key_id": "connector-key-1",
    "connector_wrapping_alg": "X25519-AES256-GCM"
  }' \\
  "${runtime.apiBaseUrl}/request-consent"`,
    checkStatus: `curl -s \\
  ${authHeader} \\
  "${runtime.apiBaseUrl}/consent-status?user_id=user_123&scope=attr.financial.*"`,
    scopedExport: `curl -s -X POST \\
  ${authHeader} \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "user_123",
    "consent_token": "HCT:...",
    "expected_scope": "attr.financial.*"
  }' \\
  "${runtime.apiBaseUrl}/scoped-export"`,
  };
}

export function buildMcpSnippets(_runtime: DeveloperRuntime, developerToken = "<developer-token>") {
  const remoteUrl = MCP_PUBLIC_DOCS.promotedEnvironment.remoteUrlTemplate.replace(
    "<developer-token>",
    developerToken
  );
  const examples = buildMcpHostExamples(developerToken);
  const byId = new Map(examples.map((example) => [example.id, example]));

  return {
    rawUrl: remoteUrl,
    remote: byId.get("generic-remote")?.code || "",
    cursor: byId.get("cursor-vscode")?.code || "",
    npm: byId.get("npm-bridge")?.code || "",
    codexRemote: byId.get("codex-remote")?.code || "",
    codexStdio: byId.get("codex-stdio")?.code || "",
    claudeDesktop: byId.get("claude-desktop")?.code || "",
    primaryExamples: examples.filter(
      (example) => example.id === "generic-remote"
    ),
    hostExamples: examples.filter(
      (example) => example.id !== "generic-remote" && example.id !== "npm-bridge"
    ),
  };
}

export function buildWorkspaceSnippets(runtime: DeveloperRuntime, developerToken = "<developer-token>") {
  return {
    envVar: `HUSHH_DEVELOPER_TOKEN=${developerToken}`,
    remoteUrl: runtime.remoteMcpUrlTemplate,
    // REST and MCP both require "Authorization: Bearer <token>"; query-string
    // tokens are rejected by the live API.
    authHeader: `Authorization: Bearer ${developerToken}`,
  };
}
