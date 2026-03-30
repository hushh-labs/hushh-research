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
  "get_encrypted_scoped_export",
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
      "Send one discovered scope at a time to POST /api/v1/request-consent?token=... with your developer token and connector public-key bundle so Hushh can wrap the export key for client-side decryption.",
  },
  {
    title: "Approve",
    detail:
      "The user reviews the request inside Kai, where your app display name and policy/support links are shown.",
  },
  {
    title: "Read",
    detail:
      "After approval, fetch the encrypted export with get_encrypted_scoped_export or POST /api/v1/scoped-export and pass the original requested scope as expected_scope so your connector can narrow a reused broader grant locally after decrypting.",
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
  {
    method: "POST",
    path: "/api/v1/scoped-export",
    auth: "Developer token required",
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
    question: "Does developer login grant data access?",
    answer:
      "No. Login enables your developer workspace and app token. User data still requires a separate consent decision inside Kai.",
  },
  {
    question: "What is the one scalable read path?",
    answer:
      "Use get_encrypted_scoped_export after approval. Hushh returns ciphertext plus wrapped-key metadata, and your connector decrypts locally.",
  },
  {
    question: "What happens if I ask for a narrower scope while I already have a broader one?",
    answer:
      "Hushh reuses the existing broader active grant and returns it immediately, but the exported package remains the canonical broader encrypted export. Pass the narrower scope as expected_scope and narrow it locally after decrypting.",
  },
  {
    question: "What happens if I ask for a broader scope while I already have a narrower one?",
    answer:
      "That is a privilege increase, so it still requires fresh user approval in Kai. After approval, the broader token becomes canonical and the older narrower token is superseded in the audit trail.",
  },
  {
    question: "Where does consent approval happen?",
    answer:
      "Inside Kai. Your external agent requests consent, but the user approves or denies it in the Hushh product surface.",
  },
  {
    question: "Do raw REST callers need to send a connector key?",
    answer:
      "Yes. Raw HTTP and MCP callers both provide connector_public_key, connector_key_id, and connector_wrapping_alg. Hushh wraps the export key to your public key and never manages your private key.",
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
  "The /developers surface stays technical. A separate consumer-facing PKM transparency view now lives in PKM Agent Lab.",
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
      "Illustrative encrypted export shape for an approved `attr.financial.*` grant. The connector unwraps the export key and decrypts locally.",
    code: `{
  "status": "success",
  "user_id": "kai_test_user",
  "granted_scope": "attr.financial.*",
  "expected_scope": "attr.financial.*",
  "coverage_kind": "exact",
  "encrypted_data": "<base64-ciphertext>",
  "iv": "<base64-iv>",
  "tag": "<base64-tag>",
  "wrapped_key_bundle": {
    "wrapped_export_key": "<base64-ciphertext>",
    "wrapped_key_iv": "<base64-iv>",
    "wrapped_key_tag": "<base64-tag>",
    "sender_public_key": "<base64-x25519-public-key>",
    "wrapping_alg": "X25519-AES256-GCM",
    "connector_key_id": "connector-key-1"
  },
  "export_revision": 3,
  "export_refresh_status": "current",
  "zero_knowledge": true
}`,
  },
  {
    title: "Sample reused broader grant",
    description:
      "If the app already holds a broader active grant and asks for a narrower branch, the request is reused immediately and the response tells you which broader scope is covering the ask.",
    code: `{
  "status": "already_granted",
  "scope": "attr.financial.analytics.quality_metrics",
  "requested_scope": "attr.financial.analytics.quality_metrics",
  "granted_scope": "attr.financial.analytics.*",
  "coverage_kind": "superset",
  "covered_by_existing_grant": true,
  "consent_token": "HCT:...",
  "expires_at": 1760000000000
}`,
  },
  {
    title: "Generate connector keypair locally",
    description:
      "Create the X25519 connector keypair on your own client or runtime. Only the base64 public key is shared with Hushh.",
    code: `const keyPair = await crypto.subtle.generateKey(
  { name: "X25519" },
  true,
  ["deriveBits"]
);

const connectorPublicKey = btoa(
  String.fromCharCode(
    ...new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  )
);`,
  },
  {
    title: "Unwrap and decrypt locally",
    description:
      "After POST /api/v1/scoped-export returns ciphertext and a wrapped key bundle, unwrap the export key and decrypt on your side.",
    code: `const sharedSecret = await crypto.subtle.deriveBits(
  { name: "X25519", public: senderPublicKey },
  connectorPrivateKey,
  256
);
const wrappingKeyBytes = new Uint8Array(
  await crypto.subtle.digest("SHA-256", sharedSecret)
);
const wrappingKey = await crypto.subtle.importKey(
  "raw",
  wrappingKeyBytes,
  { name: "AES-GCM", length: 256 },
  false,
  ["decrypt"]
);

const rawExportKey = await crypto.subtle.decrypt(
  { name: "AES-GCM", iv: wrappedKeyIvBytes },
  wrappingKey,
  concatBytes(wrappedExportKeyBytes, wrappedKeyTagBytes)
);

const exportKey = await crypto.subtle.importKey(
  "raw",
  rawExportKey,
  { name: "AES-GCM", length: 256 },
  false,
  ["decrypt"]
);`,
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
    "approval_timeout_minutes": 60,
    "reason": "Show portfolio-aware insights inside the user's external agent",
    "connector_public_key": "<base64-encoded-x25519-public-key>",
    "connector_key_id": "connector-key-1",
    "connector_wrapping_alg": "X25519-AES256-GCM"
  }' \\
  "${runtime.apiBaseUrl}/request-consent?token=${developerToken}"`,
    checkStatus: `curl -s \\
  "${runtime.apiBaseUrl}/consent-status?user_id=user_123&scope=attr.financial.*&token=${developerToken}"`,
    scopedExport: `curl -s -X POST \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "user_123",
    "consent_token": "HCT:...",
    "expected_scope": "attr.financial.*"
  }' \\
  "${runtime.apiBaseUrl}/scoped-export?token=${developerToken}"`,
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
