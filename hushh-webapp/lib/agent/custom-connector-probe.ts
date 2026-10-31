/**
 * The chat card for "add this MCP server". Parsed from the server-side probe,
 * never from model prose. Server-authored strings (its name, tool names and
 * descriptions) are untrusted display text: bounded here, rendered as plain
 * React text, and never used to decide an action. Failure copy is authored in
 * this file and chosen by an enum; no server sentence is shown for it.
 */
export const CUSTOM_CONNECTOR_PROBE_EXPERIENCE_TYPE = "one.custom_connector_probe.v1" as const;
export const PROBE_TOOL_NAME = "probe_private_connector" as const;

export type ProbeFailureReason =
  | "blocked_address" | "unreachable" | "tls_error" | "timeout"
  | "redirect" | "not_mcp" | "legacy_sse" | "too_large";
export type ProbeToolAccess = "read" | "write";
export type ProbeAuth =
  | { kind: "none" }
  | { kind: "api_key" }
  | { kind: "oauth"; signIn: "ready" | "client_id_needed" | "unsupported"; issuerHost?: string };

export type CustomConnectorProbeExperience = {
  type: typeof CUSTOM_CONNECTOR_PROBE_EXPERIENCE_TYPE;
  status: "ready" | "auth_required" | "failed";
  /** The address Connect will save: validated public https, no query or userinfo. */
  endpoint: string;
  /** Present only when the probe verified a different address (a retired `/sse`). */
  requestedEndpoint?: string;
  host: string;
  serverName: string | null;
  tools: Array<{ name: string; description: string; access: ProbeToolAccess }>;
  toolCount: number;
  auth: ProbeAuth;
  failure?: ProbeFailureReason;
};

export const PROBE_FAILURE_COPY: Record<ProbeFailureReason, { title: string; next: string }> = {
  blocked_address: {
    title: "That address isn’t a public HTTPS server",
    next: "Use the server’s public https:// address, with nothing private in it.",
  },
  unreachable: { title: "One couldn’t reach that server", next: "Check the address and that the server is online." },
  tls_error: { title: "Its security certificate didn’t check out", next: "Ask the server’s owner to fix its HTTPS certificate." },
  timeout: { title: "The server took too long to answer", next: "Try again in a minute." },
  redirect: { title: "That address points somewhere else", next: "Use the final MCP address from the server’s docs." },
  not_mcp: { title: "That isn’t an MCP server", next: "Check its docs for the MCP address. It often ends in /mcp." },
  legacy_sse: { title: "This server only offers the older SSE connection", next: "Ask the provider for its current address. It usually ends in /mcp." },
  too_large: { title: "The server sent back too much", next: "Contact the server’s owner." },
};

const FAILURES = Object.keys(PROBE_FAILURE_COPY) as ProbeFailureReason[];
const MAX_TOOLS = 100;
// Controls and direction or width overrides can hide or reorder text.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
}

/** One bounded plain-text line. Applied again here: the browser trusts no transport. */
export function probeText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_TEXT, " ").split(/\s+/).filter(Boolean).join(" ");
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function safeEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search &&
      !url.hash && (url.port === "" || url.port === "443") && url.hostname.includes(".")
      ? value : null;
  } catch { return null; }
}

function parseAuth(value: unknown): ProbeAuth | null {
  const auth = record(value);
  if (auth?.kind === "none" || auth?.kind === "api_key") return { kind: auth.kind };
  if (auth?.kind !== "oauth" || !["ready", "client_id_needed", "unsupported"].includes(String(auth.signIn))) return null;
  const issuerHost = probeText(auth.issuerHost, 253);
  return { kind: "oauth", signIn: auth.signIn as "ready" | "client_id_needed" | "unsupported", ...(issuerHost ? { issuerHost } : {}) };
}

export function parseCustomConnectorProbe(toolName: string, value: unknown): CustomConnectorProbeExperience | null {
  if (toolName !== PROBE_TOOL_NAME) return null;
  const outer = parseRecord(value);
  const envelope = outer && (typeof outer.status === "string" ? outer
    : [outer.result, outer.content, outer.data].map(parseRecord).find(candidate => candidate?.status) ?? null);
  if (envelope?.status !== "ok" || envelope.provider !== "custom") return null;
  const probe = record(envelope.probe);
  const status = probe?.status;
  if (!probe || (status !== "ready" && status !== "auth_required" && status !== "failed")) return null;
  const auth = parseAuth(probe.auth);
  if (!auth) return null;
  if (status === "failed") {
    const reason = record(probe.failure)?.reason;
    if (!FAILURES.includes(reason as ProbeFailureReason)) return null;
    // A refused address is never echoed: it may carry a credential.
    const endpoint = reason === "blocked_address" ? "" : safeEndpoint(probe.endpoint) ?? "";
    return {
      type: CUSTOM_CONNECTOR_PROBE_EXPERIENCE_TYPE, status, endpoint,
      host: endpoint ? new URL(endpoint).hostname : "", serverName: null,
      tools: [], toolCount: 0, auth, failure: reason as ProbeFailureReason,
    };
  }
  const endpoint = safeEndpoint(probe.endpoint);
  if (!endpoint) return null;
  const requested = probe.requestedEndpoint === undefined ? undefined : safeEndpoint(probe.requestedEndpoint);
  if (requested === null || (requested && new URL(requested).origin !== new URL(endpoint).origin)) return null;
  const rawTools = Array.isArray(probe.tools) ? probe.tools.slice(0, MAX_TOOLS) : [];
  const tools = rawTools.flatMap(raw => {
    const tool = record(raw);
    const name = probeText(tool?.name, 64);
    if (!tool || !name) return [];
    return [{ name, description: probeText(tool.description, 240), access: tool.access === "read" ? "read" as const : "write" as const }];
  });
  const count = typeof probe.toolCount === "number" && Number.isInteger(probe.toolCount) && probe.toolCount >= tools.length
    ? Math.min(probe.toolCount, 10_000) : tools.length;
  const server = record(probe.server);
  return {
    type: CUSTOM_CONNECTOR_PROBE_EXPERIENCE_TYPE, status, endpoint,
    ...(requested ? { requestedEndpoint: requested } : {}),
    host: new URL(endpoint).hostname,
    serverName: probeText(server?.name, 80) || null,
    tools, toolCount: count, auth,
  };
}
