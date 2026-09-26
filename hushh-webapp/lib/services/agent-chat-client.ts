import { ApiService } from "@/lib/services/api-service";
import { projectCustomConnectorTurnConfigurations, type CustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseConnectorReadReceipt, type ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";
import { HttpAgent, type AgentSubscriber, type Tool } from "@ag-ui/client";
import { applyPatch, type Operation } from "fast-json-patch";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { describeDirectiveForOwner } from "@/lib/agent/action-directive-summary";
import { parseMcpCallReview, type McpCallApproval, type McpCallReviewReference } from "@/lib/agent/mcp-call-review";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import {
  parseAgentActivityExperience,
  parseAgentToolResultExperience,
  type AgentStructuredExperience,
} from "@/lib/agent/agui-structured-experiences";

export type AgentChatMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  status: "complete" | "interrupted" | "error";
  content: string;
  model?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  metadata?: {
    kind?: string;
    display?: string;
    structuredExperience?: {
      activityType?: string;
      content?: unknown;
    } | null;
    structuredExperienceId?: string | null;
    structuredExperiences?: Array<{ id: string; activityType: string; content: unknown }>;
    connectorRead?: ConnectorReadExperience | null;
    /** Bound history descriptor for the turn's Activity rows (enums and opaque ids only). */
    turnActivity?: { activityType?: string; content?: unknown } | null;
  } | null;
};

export type AgentChatConversation = {
  id: string;
  title: string;
  status: string;
  model?: string | null;
  message_count: number;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
};

export type AgentChatToolEvent = {
  callId: string;
  directiveId: string | null;
  conversationId: string | null;
  contextRevision: string | null;
  expiresAt: string | null;
  actionId: string | null;
  label: string;
  execution: "frontend" | "blocked" | string;
  slots: Record<string, unknown>;
  message: string;
  reason?: string | null;
  status?: string;
  /** App-authored step tag such as "Read" or "Needs review". */
  tag?: string;
  requiresConfirmation: boolean;
  trustedActivationRequired: boolean;
  raw: Record<string, unknown>;
};

export type SpecialistDirectiveEvent = {
  delegateAgentId: string;
  directive: { kind: "action" | "prompt"; payload: Record<string, unknown> };
  message: string;
  stateChanged: boolean;
};

export type AgentSource = {
  agentId: string;
  label: string;
  reason: string;
};

export type AgentChatStreamHandlers = {
  /** Ephemeral native review: never append its references or receipt to history/debug events. */
  onMcpReview?: (review: {
    reference: McpCallReviewReference;
    conversationId: string;
    isCurrent: () => boolean;
    loadConfiguration?: () => Promise<CustomConnectorConfiguration | undefined>;
    resume: (approval: McpCallApproval | null, signal?: AbortSignal) => Promise<void>;
  }) => void;
  onStart?: (payload: { conversationId: string; model?: string }) => void;
  onToolStart?: (payload: AgentChatToolEvent) => void;
  onToolWaiting?: (payload: AgentChatToolEvent) => void;
  onToolResult?: (payload: AgentChatToolEvent) => void;
  /** Request ids a server tool reported as waiting on the owner; the workspace renders each as a pending-consent card. */
  onPendingConsentRequests?: (requestIds: string[]) => void;
  onToken?: (token: string) => void;
  /** Provider-authored thought summary only; never raw thoughts or continuation signatures. */
  onThinkingSummary?: (chunk: string) => void;
  onComplete?: (payload: { conversationId: string; model?: string }) => void;
  onInterrupt?: (payload: { conversationId: string }) => void;
  onError?: (message: string) => void;
  onSources?: (sources: AgentSource[]) => void;
  /** The optional id is the AG-UI activity/tool identity for transport dedupe. */
  onStructuredExperience?: (experience: AgentStructuredExperience, eventId?: string) => void;
  onSpecialistDirective?: (directive: SpecialistDirectiveEvent) => void;
  /**
   * The server's id for this turn's answer (the ADK event id), from the run's
   * closing messages snapshot. The live bubble is created under a browser id
   * before the server has one; a rating keyed by that browser id could never
   * be joined to the turn, or matched after a reload (history uses event ids).
   */
  onServerMessageId?: (serverMessageId: string) => void;
};

/** The last assistant message with content in a messages snapshot: this turn's answer. */
export function lastAssistantMessageId(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    const hasContent =
      (typeof content === "string" && content.trim().length > 0) ||
      (Array.isArray(content) && content.length > 0);
    const id = typeof message.id === "string" ? message.id.trim() : "";
    if (hasContent && id) return id;
  }
  return null;
}

// Reject legacy reasoning before the SDK stores it, including replay snapshots.
// Server continuation signatures remain server-owned and never enter this UI.
const publicOutputSubscriber: Pick<
  AgentSubscriber,
  "onEvent" | "onMessagesSnapshotEvent"
> = {
  onEvent: ({ event }) => {
    if (String(event.type).startsWith("REASONING_")) {
      return { stopPropagation: true };
    }
    return undefined;
  },
  onMessagesSnapshotEvent: ({ event, messages }) => {
    if (![...event.messages, ...messages].some((message) => message.role === "reasoning")) {
      return undefined; // Keep the SDK's normal replay semantics untouched.
    }
    const incoming = event.messages
      .filter((message) => message.role !== "reasoning")
      .map((message) => {
        if (message.subagentRunId !== null) return message;
        const normalized = { ...message };
        delete normalized.subagentRunId;
        return normalized;
      });
    const byId = new Map(incoming.map((message) => [message.id, message]));
    // Match SDK replay: retain existing activity when the snapshot omits it,
    // preserve existing ordering, then append newly observed messages.
    const preserveActivity = !incoming.some((message) => message.role === "activity");
    const merged = messages.flatMap((message) => {
      if (message.role === "reasoning") return [];
      if (preserveActivity && message.role === "activity") return [message];
      const replacement = byId.get(message.id);
      return replacement ? [replacement] : [];
    });
    const seen = new Set(merged.map((message) => message.id));
    return {
      messages: [...merged, ...incoming.filter((message) => !seen.has(message.id))],
      stopPropagation: true,
    };
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function unwrapParkedActionResult(value: unknown): Record<string, unknown> | null {
  const record = parseRecord(value);
  if (!record) return null;
  for (const key of ["result", "content", "data"] as const) {
    const nested = parseRecord(record[key]);
    if (nested?.status || nested?.directive || nested?.action_id) return nested;
  }
  return record;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

const GENERIC_AGENT_CHAT_ERROR =
  "One couldn't complete that response. Please try again.";

type ParkedAppActionDirective = {
  actionId: string;
  slots: Record<string, unknown>;
  needsConfirmation: boolean;
  trustedActivationRequired: boolean;
  message: string;
};

function parseStateActionDirective(
  path: string,
  value: unknown,
  threadId: string,
): AgentChatToolEvent | null {
  const record = asRecord(value);
  if (!record || record.kind !== "action") return null;
  const payload = asRecord(record.payload);
  const actionId = String(payload?.actionId || "").trim();
  const slots = asRecord(payload?.slots);
  const action = getKaiActionById(actionId);
  if (!actionId || !slots || !action) return null;

  const needsConfirmation =
    payload?.needsConfirmation === true || action.execution_policy === "confirm_required";
  const trustedActivationRequired =
    payload?.trustedActivationRequired === true ||
    action.activation_policy === "trusted_activation_required";
  const directiveId = path.slice("/".length);
  const callId = `${threadId}:state:${directiveId}`;
  return {
    callId,
    directiveId,
    conversationId: threadId,
    contextRevision: null,
    expiresAt: null,
    actionId,
    label: action.label,
    execution: "frontend",
    slots,
    message: describeDirectiveForOwner(actionId, action.label, slots, {
      requiresConfirmation: needsConfirmation || trustedActivationRequired,
    }),
    requiresConfirmation: needsConfirmation,
    trustedActivationRequired,
    raw: {
      protocol: "ag-ui",
      toolName: "pending_directive",
      args: {},
      parked: true,
      statePath: path,
      // The proposal has already completed server-side. There is no model
      // interrupt to resume; the browser's visible tap is the sole authority.
      resume: async () => undefined,
    },
  };
}

/** Reads the directive a run_app_action result carries when it parked an action for the browser. */
export function parseParkedAppActionDirective(content: unknown): ParkedAppActionDirective | null {
  const record = unwrapParkedActionResult(content);
  if (!record) return null;
  const status = String(record.status || "");
  const isProposalDirective = status === "proposal_ready";
  if (
    status !== "ready_to_run" &&
    status !== "confirm_pending" &&
    !isProposalDirective
  ) return null;
  const directive = asRecord(record.directive);
  const actionId = String(
    directive?.actionId || directive?.action_id || record.action_id || "",
  ).trim();
  if (!actionId || (isProposalDirective && actionId !== "consent.request")) return null;
  const slots = asRecord(directive?.slots || directive?.slot_values) || {};
  const needsConfirmation =
    directive?.needsConfirmation === true || directive?.needs_confirmation === true;
  if (isProposalDirective && !needsConfirmation) return null;
  return {
    actionId,
    slots,
    needsConfirmation:
      needsConfirmation || status === "confirm_pending",
    trustedActivationRequired:
      directive?.trustedActivationRequired === true ||
      directive?.trusted_activation_required === true,
    message: String(record.message || ""),
  };
}

/**
 * list_pending_information_requests answers with request ids only (labels
 * come from the owner's own pending lookup); the workspace turns each id into
 * the same card an FCM push would, so approving stays a tap on this device.
 */
export function parsePendingConsentRequestIds(toolName: string, content: unknown): string[] {
  if (toolName !== "list_pending_information_requests") return [];
  let result: unknown = content;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return [];
    }
  }
  const record = asRecord(result);
  if (!record || record.status !== "ok") return [];
  const ids = Array.isArray(record.pendingRequestIds) ? record.pendingRequestIds : [];
  return ids
    .map((value) => String(value ?? "").trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .slice(0, 20);
}

const SERVER_TOOL_PRESENTATION: Record<
  string,
  { label: string; message: string }
> = {
  discover_person_information: {
    label: "Available information",
    message: "Checking what this person makes available to request.",
  },
  list_pending_information_requests: {
    label: "Pending requests",
    message: "Checking what is waiting on you.",
  },
  propose_information_request: {
    label: "Information request",
    message: "Preparing an information request for your confirmation.",
  },
  list_my_connections: {
    label: "Connections",
    message: "Checking your current connections.",
  },
  inspect_selected_drive_files: {
    label: "Google Drive",
    message: "Checking selected file status.",
  },
  inspect_private_connectors: {
    label: "Connectors",
    message: "Checking your saved connectors.",
  },
  discover_workspace_tools: {
    label: "Connector access",
    message: "Checking which connected capabilities are available.",
  },
  read_workspace_tool: {
    label: "Connected app read",
    message: "Reading the selected connected capability.",
  },
  ask_email_agent: {
    label: "Gmail",
    message: "Checking your mail request.",
  },
  ask_documents_agent: {
    label: "Google Drive",
    message: "Searching your Drive for this answer.",
  },
  ask_connected_systems_agent: {
    label: "Connected systems",
    message: "Checking the connected-systems request.",
  },
  ask_consent_agent: {
    label: "Consent",
    message: "Checking the consent request.",
  },
  list_pending_connection_requests: {
    label: "Connection requests",
    message: "Checking your pending connection requests.",
  },
};

export const TURN_ACTIVITY_TYPE = "one.turn_activity.v1" as const;

/** A restored Activity row: the same app-authored fields the live panel renders. */
export type RestoredActivityStep = {
  id: string;
  label: string;
  message: string;
  status: "done" | "waiting" | "blocked";
  tag?: "Read" | "Needs review" | "Public";
  provider?: "gmail" | "drive" | "calendar";
  toolName: string;
  /** Opaque owner connector id; the workspace resolves its name from the owner's vault. */
  connectorId?: string;
};

/**
 * Rebuild a turn's Activity rows from the server's bound history descriptor.
 * Labels and sentences come from the same app-owned table as the live stream;
 * the descriptor only chooses among them. Unknown tools, statuses, or fields
 * drop the row rather than render provider text.
 */
export function parseRestoredTurnActivity(descriptor: unknown): RestoredActivityStep[] {
  const record = asRecord(descriptor);
  if (!record || record.activityType !== TURN_ACTIVITY_TYPE) return [];
  const steps = asRecord(record.content)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.slice(-10).flatMap((value): RestoredActivityStep[] => {
    const step = asRecord(value);
    const id = typeof step?.id === "string" ? step.id.trim().slice(0, 128) : "";
    const toolName = typeof step?.tool === "string" ? step.tool : "";
    const rawStatus = step?.status;
    if (!step || !id || !toolName) return [];
    const mcp = /^mcp_[0-9a-f]{40}$/.test(toolName);
    const presentation = SERVER_TOOL_PRESENTATION[toolName];
    if (!mcp && !presentation) return [];
    if (!["done", "waiting", "blocked", "interrupted"].includes(String(rawStatus))) return [];
    const status = rawStatus === "interrupted" ? "blocked" : rawStatus as "done" | "waiting" | "blocked";
    const provider = ["gmail", "drive", "calendar"].includes(String(step.provider))
      ? step.provider as "gmail" | "drive" | "calendar" : undefined;
    if (mcp) {
      const connectorId = typeof step.connectorId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(step.connectorId)
        ? step.connectorId : undefined;
      const tag = status === "waiting" && step.review === "required" ? "Needs review"
        : status === "done" && step.review === "read_only" ? "Read"
          : status === "done" && step.review === "no_credential" ? "Public" : undefined;
      return [{
        id, toolName, label: "Connected tool", status,
        message: rawStatus === "interrupted" ? "This step did not finish."
          : status === "done" ? "Connector call finished."
            : status === "waiting" ? "Waiting for your review." : "Connector call needs attention.",
        ...(tag ? { tag } : {}),
        ...(connectorId ? { connectorId } : {}),
      }];
    }
    if (!presentation) return [];
    let message = presentation.message;
    if (rawStatus === "interrupted") message = "This step did not finish.";
    else if (toolName === "discover_workspace_tools" || toolName === "read_workspace_tool") message = "Connector access checked.";
    else if (toolName === "inspect_private_connectors") message = "One checked your connectors.";
    else if (toolName === "ask_email_agent" || toolName === "ask_documents_agent" || toolName === "inspect_selected_drive_files") {
      const source = toolName === "ask_email_agent" ? "Mail" : "Drive";
      message = step.readStatus === "status_checked" ? "Drive status checked."
        : step.readStatus === "ok" ? `${source} read finished.`
          : step.readStatus === "input_required" ? `${source} needs more detail.`
            : `${source} could not complete that read.`;
    }
    return [{ id, toolName, label: presentation.label, message, status, ...(provider ? { provider } : {}) }];
  });
}

export function formatAgentChatErrorMessage(message: string, code?: string): string {
  if (code === "AGENT_RUNTIME_CREDENTIAL_MISSING") {
    return "One needs your Gemini key. Add it in Connections settings, or switch to Hussh managed Gemini.";
  }
  if (code === "AGENT_RUNTIME_CREDENTIAL_INVALID") {
    return "Your saved Gemini key could not be used. Update it in Connections settings, or switch to Hussh managed Gemini.";
  }
  if (code === "AGENT_RUNTIME_MANAGED_CREDENTIALS_UNAVAILABLE") {
    return "Hussh managed Gemini is not available in this environment.";
  }
  if (code === "AGENT_RUNTIME_MODEL_UNAVAILABLE") {
    return "One's configured Gemini model is not available for this runtime.";
  }
  if (code === "AGENT_RUNTIME_EMPTY_RESPONSE") {
    return "One did not receive a response from the configured model. Please try again.";
  }
  if (code === "DATABASE_UNAVAILABLE" || code === "DATABASE_EXECUTION_ERROR") {
    return "One's conversation history is temporarily unavailable. Please try again.";
  }
  // AG-UI may deliver provider failures as an untyped RunErrorEvent when the
  // ADK bridge cannot preserve the backend error code. Recognize only the
  // stable provider markers and keep the raw message out of the transcript.
  const normalizedMessage = message.toUpperCase();
  if (
    normalizedMessage.includes("RESOURCE_EXHAUSTED") ||
    normalizedMessage.includes("TOO MANY REQUESTS") ||
    /\b429\b/.test(normalizedMessage)
  ) {
    return "One is temporarily at capacity. Please try again in a moment.";
  }
  // AG-UI RunErrorEvent.message may be derived from str(exception). Database
  // drivers append SQL and bound values there, so unknown runtime text is
  // never consumer-safe. Only explicitly mapped codes cross this boundary.
  void message;
  return GENERIC_AGENT_CHAT_ERROR;
}

function resolveBrowserTimeZone(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as unknown;
  const record = asRecord(payload);
  const detailRecord = record ? asRecord(record.detail) : null;
  const code = detailRecord ? readString(detailRecord, "code") : record ? readString(record, "code") : "";
  const detail = detailRecord
    ? readString(detailRecord, "message")
    : record
      ? readString(record, "detail") || readString(record, "message")
      : "";
  return detail
    ? formatAgentChatErrorMessage(detail, code || undefined)
    : `Agent chat request failed (${response.status})`;
}

export async function streamAgentChat(input: {
  userId: string;
  message: string;
  conversationId?: string | null;
  vaultOwnerToken: string;
  loadConnectorConfigurations?: () => Promise<CustomConnectorConfiguration[]>;
  pkmContext?: string;
  personSelectionHandle?: string;
  /** Opaque owner-selected KYC workflow; Gmail content stays server-side. */
  gmailInformationRequestWorkflowId?: string;
  screenContext?: Record<string, unknown> | null;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{
  conversationId: string | null;
  model: string | null;
  text: string;
  interrupted: boolean;
}> {
  const timezone = resolveBrowserTimeZone();
  const threadId = input.conversationId || crypto.randomUUID();
  const handlers = input.handlers ?? {};
  const mcpOwner = snapshotValidatedAuthSessionOwner();
  const mcpVaultEpoch = snapshotVaultSessionEpoch();
  const mcpSessionCurrent = () => Boolean(
    mcpOwner && mcpOwner.userId === input.userId &&
    isValidatedAuthSessionOwnerCurrent(mcpOwner) &&
    isVaultSessionEpochCurrent(mcpVaultEpoch) && !input.signal?.aborted,
  );
  // Owner-authored names from the owner's own vault, keyed by opaque id. The
  // provider-authored tool name never labels a step: a server can write anything.
  const connectorNames = new Map<string, string>();
  const connectorProjection = async () => {
    if (!input.loadConnectorConfigurations) return {};
    if (!mcpSessionCurrent()) throw new Error("Your vault session changed. Unlock and try again.");
    const configurations = await input.loadConnectorConfigurations();
    if (!mcpSessionCurrent()) throw new Error("Your vault session changed. Unlock and try again.");
    const mcpConfigurations = projectCustomConnectorTurnConfigurations(configurations);
    connectorNames.clear();
    for (const item of mcpConfigurations) connectorNames.set(item.connectorId, item.displayName);
    return { mcpConfigurations };
  };
  const availableActionIds = (() => {
    const screen = input.screenContext || {};
    const nested = asRecord(screen.one_voice_context);
    const rawAvailable = nested?.available_action_ids ?? screen.available_action_ids;
    const rawExecutable = nested?.executable_action_ids ?? screen.executable_action_ids;
    return Array.from(
      new Set([
        ...(Array.isArray(rawAvailable)
          ? rawAvailable.filter((value): value is string => typeof value === "string")
          : []),
        ...(Array.isArray(rawExecutable)
          ? rawExecutable.filter((value): value is string => typeof value === "string")
          : []),
      ]),
    );
  })();
  const tools: Tool[] = availableActionIds.flatMap((actionId) => {
    const action = getKaiActionById(actionId);
    if (!action) return [];
    const encoded = btoa(unescape(encodeURIComponent(actionId)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/g, "");
    return [{
      name: `hussh_action_${encoded}`,
      description: `${action.label}: ${action.meaning}`,
      parameters: action.goal?.slot_schema || { type: "object", properties: {}, additionalProperties: false },
      metadata: { actionId },
    }];
  });
  const agent = new HttpAgent({
    url: "/api/one/agent-chat",
    threadId,
    headers: { Authorization: `Bearer ${input.vaultOwnerToken}` },
    initialMessages: [{ id: crypto.randomUUID(), role: "user", content: input.message }],
    fetch: (_url, init) => nativeStreamFetch("/api/one/agent-chat", init),
  });
  let text = "";
  let failure: Error | null = null;
  let interrupted = false;
  let intentionallyStoppedAtConfirmation = false;
  let settleTerminalRun: (() => void) | null = null;
  const terminalRun = new Promise<void>((resolve) => {
    settleTerminalRun = resolve;
  });
  const finishTerminalRun = () => {
    settleTerminalRun?.();
    settleTerminalRun = null;
  };
  const stopAfterConfirmation = () => {
    if (intentionallyStoppedAtConfirmation) return;
    intentionallyStoppedAtConfirmation = true;
    interrupted = true;
    // A parked directive has no AG-UI interrupt to resume. The visible card
    // owns the next step, so leaving the model run alive would let it repeat
    // the action or append a second answer while the owner is deciding.
    handlers.onInterrupt?.({ conversationId: threadId });
    finishTerminalRun();
    agent.abortRun();
  };
  const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, Record<string, unknown>>();
  const interruptsByToolCall = new Map<string, string>();
  const mcpReviews = new Map<string, McpCallReviewReference>();
  // The server streams each native confirmation's projected arguments. A
  // MESSAGES_SNAPSHOT can already hold the same call, and the AG-UI client then
  // appends the streamed delta onto the snapshot's copy, which no longer parses.
  // Parse the confirmation from its own streamed deltas instead.
  const confirmationArgs = new Map<string, string>();
  const publishedMcpReviews = new Set<string>();
  const emittedStateDirectivePaths = new Set<string>();
  const toolPayload = (callId: string, name: string, args: Record<string, unknown> = {}): AgentChatToolEvent => {
    const actionId = tools.find((tool) => tool.name === name)?.metadata?.actionId;
    const action = getKaiActionById(typeof actionId === "string" ? actionId : null);
    const serverPresentation = SERVER_TOOL_PRESENTATION[name];
    const resolvedActionId = typeof actionId === "string" ? actionId : null;
    // Native MCP identities are opaque digests. Never render their raw name or
    // provider-authored descriptions as app-owned activity labels.
    const label = action?.label || serverPresentation?.label ||
      (/^mcp_[0-9a-f]{40}$/.test(name) ? "Connected tool" : "Agent step");
    const requiresConfirmation = action?.execution_policy === "confirm_required";
    const trustedActivationRequired =
      action?.activation_policy === "trusted_activation_required";
    return {
      callId,
      directiveId: null,
      conversationId: threadId,
      contextRevision: null,
      expiresAt: null,
      actionId: resolvedActionId,
      label,
      execution: "frontend",
      slots: args,
      // The gateway's `meaning` is written for the model and names a category
      // of action, never this one. The owner confirms a sentence built from the
      // resolved slots instead. Only a directive that waits on the owner may
      // say so; most actions run directly and this sentence shows while they do.
      message: action
        ? describeDirectiveForOwner(resolvedActionId, label, args, {
            requiresConfirmation: requiresConfirmation || trustedActivationRequired,
          })
        : serverPresentation?.message ||
          (/^mcp_[0-9a-f]{40}$/.test(name) ? "Using a connected tool." : "Completing a step for your request."),
      requiresConfirmation,
      trustedActivationRequired,
      raw: {
        protocol: "ag-ui",
        toolName: name,
        args,
        resume: async (status: "resolved" | "cancelled", payload?: unknown) => {
          const interruptId = interruptsByToolCall.get(callId);
          if (!interruptId) throw new Error("This Agent One action is no longer resumable.");
          await agent.runAgent({
            tools,
            context: [],
            forwardedProps: {
              ...await connectorProjection(),
              timezone,
              pkmContext: input.pkmContext,
              personSelectionHandle: input.personSelectionHandle,
              gmailInformationRequestWorkflowId: input.gmailInformationRequestWorkflowId,
              screenContext: input.screenContext,
            },
            resume: [{ interruptId, status, payload }],
          }, subscriber);
        },
      },
    };
  };
  const subscriber: AgentSubscriber = {
    ...publicOutputSubscriber,
    onEvent: ({ event }) => {
      if (event.type === "REASONING_MESSAGE_CONTENT") {
        const delta = (event as { delta?: unknown }).delta;
        const metadata = (event as { metadata?: unknown }).metadata;
        if (asRecord(metadata)?.husshThoughtSummary === true &&
            typeof delta === "string" && delta.length > 0) {
          handlers.onThinkingSummary?.(delta.slice(0, 2048));
        }
      }
      return String(event.type).startsWith("REASONING_")
        ? { stopPropagation: true }
        : undefined;
    },
    onRunStartedEvent: () => handlers.onStart?.({ conversationId: threadId }),
    onMessagesSnapshotEvent: (snapshot) => {
      const { event } = snapshot;
      const serverMessageId = lastAssistantMessageId(event.messages);
      if (serverMessageId) handlers.onServerMessageId?.(serverMessageId);
      return publicOutputSubscriber.onMessagesSnapshotEvent?.(snapshot);
    },
    onTextMessageContentEvent: ({ event }) => {
      text += event.delta;
      handlers.onToken?.(event.delta);
    },
    onToolCallStartEvent: ({ event }) => {
      toolNames.set(event.toolCallId, event.toolCallName);
      if (event.toolCallName === "adk_request_confirmation") confirmationArgs.set(event.toolCallId, "");
      handlers.onToolStart?.(toolPayload(event.toolCallId, event.toolCallName));
    },
    onToolCallArgsEvent: ({ event }) => {
      const buffered = confirmationArgs.get(event.toolCallId);
      if (buffered === undefined) return;
      // Bounded like the server projection; an oversized review fails closed.
      const next = buffered + (event.delta ?? "");
      if (next.length > 64_000) confirmationArgs.delete(event.toolCallId);
      else confirmationArgs.set(event.toolCallId, next);
    },
    onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
      if (toolCallName === "adk_request_confirmation") {
        const streamed = confirmationArgs.get(event.toolCallId);
        confirmationArgs.delete(event.toolCallId);
        let nativeArgs: Record<string, unknown> = toolCallArgs;
        if (streamed) {
          try { nativeArgs = asRecord(JSON.parse(streamed)) ?? toolCallArgs; } catch { /* keep client args */ }
        }
        const review = parseMcpCallReview(nativeArgs);
        if (review) {
          mcpReviews.set(event.toolCallId, review);
          // Publish only after RUN_FINISHED supplies the native interrupt id.
          // Neither pending handles nor private review details enter generic diagnostics.
          return;
        }
        const original = asRecord(nativeArgs.originalFunctionCall);
        const confirmation = asRecord(nativeArgs.toolConfirmation);
        if ((typeof original?.name === "string" && original.name.startsWith("mcp_")) ||
            asRecord(confirmation?.payload)?.kind === "mcp_call_review") {
          handlers.onError?.("The connector review could not be verified. Please ask again.");
          return;
        }
      }
      const workspaceConnectorTool =
        toolCallName === "discover_workspace_tools" ||
        toolCallName === "read_workspace_tool";
      const safeArgs = workspaceConnectorTool
        ? { provider: toolCallArgs.provider }
        : toolCallName === "inspect_private_connectors"
          ? {}
        : toolCallName === "ask_email_agent" || toolCallName === "ask_documents_agent" || toolCallName === "inspect_selected_drive_files"
          ? {}
          : toolCallArgs;
      toolArgs.set(event.toolCallId, safeArgs);
      handlers.onToolWaiting?.(
        toolPayload(event.toolCallId, toolCallName, safeArgs),
      );
    },
    onToolCallResultEvent: ({ event }) => {
      const toolName = toolNames.get(event.toolCallId) || "";
      if (/^mcp_[0-9a-f]{40}$/.test(toolName)) {
        // Connector content belongs to owner presentation/history, never the
        // generic debug payload or model-authored app-action parser. Approval
        // references use the separate native interrupt/review contract.
        const payload = toolPayload(event.toolCallId, toolName);
        const result = parseRecord(event.content);
        const outcome = result?.status;
        const connectorId = result?.connectorId;
        const connectorName = typeof connectorId === "string" ? connectorNames.get(connectorId) : undefined;
        if (connectorName) payload.label = connectorName;
        // A blocked or failed connector call must not render as a completed step.
        payload.execution = outcome === "ok" || outcome === "review_required" ? "server" : "blocked";
        if (outcome === "review_required") {
          payload.status = "waiting";
          payload.tag = "Needs review";
        } else if (outcome === "ok" && result?.review === "read_only") {
          payload.tag = "Read";
        } else if (outcome === "ok" && result?.review === "no_credential") {
          // Ran unreviewed because no credential was used, not because it only
          // read: an unannotated tool on a public server may still change things.
          payload.tag = "Public";
        }
        payload.message = outcome === "ok"
          ? "Connector call finished."
          : outcome === "review_required"
            ? "Waiting for your review."
            : "Connector call needs attention.";
        payload.raw = { protocol: "ag-ui", toolName };
        handlers.onToolResult?.(payload);
        return;
      }
      const workspaceConnectorTool =
        toolName === "discover_workspace_tools" ||
        toolName === "read_workspace_tool" ||
        toolName === "inspect_private_connectors";
      // External-read receipts are display-only, even if an invalid result attempts to
      // smuggle a parked navigation/send directive alongside it.
      if (toolName === "ask_email_agent" || toolName === "ask_documents_agent" || toolName === "inspect_selected_drive_files") {
        const experience = parseAgentToolResultExperience(toolName, event.content);
        const readExperience = experience?.type === "one.connector_read.v1" ? experience : null;
        const payload = toolPayload(event.toolCallId, toolName);
        payload.execution = "server";
        const source = toolName === "ask_email_agent" ? "Mail" : "Drive";
        const statusChecked = toolName === "inspect_selected_drive_files" && parseRecord(event.content)?.status === "ok";
        payload.message = statusChecked
          ? "Drive status checked."
          : readExperience?.status === "ok"
            ? readExperience.connector === "drive" && readExperience.metadataOnly
              ? "Drive search finished."
              : `${source} read finished.`
            : readExperience?.status === "input_required"
              ? `${source} needs more detail.`
              : `${source} could not complete that read.`;
        payload.raw = { protocol: "ag-ui", toolName };
        handlers.onToolResult?.(payload);
        if (experience) {
          handlers.onStructuredExperience?.(experience, event.toolCallId);
        }
        return;
      }
      if (workspaceConnectorTool) {
        const safeArgs = toolArgs.get(event.toolCallId) || {};
        const experience = parseAgentToolResultExperience(
          toolName,
          event.content,
          safeArgs,
        );
        const payload = toolPayload(event.toolCallId, toolName, safeArgs);
        payload.execution = "server";
        payload.message = toolName === "inspect_private_connectors"
          ? "One checked your connectors."
          : "Connector access checked.";
        payload.raw = {
          protocol: "ag-ui",
          toolName,
          ...(toolName === "inspect_private_connectors" ? {} : { provider: safeArgs.provider }),
        };
        handlers.onToolResult?.(payload);
        if (experience) {
          handlers.onStructuredExperience?.(experience, event.toolCallId);
        }
        return;
      }
      const payload = toolPayload(
        event.toolCallId,
        toolName,
        toolArgs.get(event.toolCallId) || {},
      );
      payload.raw.result = event.content;
      handlers.onToolResult?.(payload);
      const pendingIds = parsePendingConsentRequestIds(toolName, event.content);
      if (pendingIds.length > 0) {
        handlers.onPendingConsentRequests?.(pendingIds);
      }
      // A server-side run_app_action parks a directive for the browser. The
      // text transport surfaces the directive as a frontend tool event, where
      // the workspace stages it or routes it through the governed executor.
      const parked = parseParkedAppActionDirective(event.content);
      if (parked) {
        const action = getKaiActionById(parked.actionId);
        const parkedLabel = action?.label || parked.actionId;
        const parkedRequiresConfirmation =
          parked.needsConfirmation || action?.execution_policy === "confirm_required";
        const parkedTrustedActivationRequired =
          parked.trustedActivationRequired ||
          action?.activation_policy === "trusted_activation_required";
        handlers.onToolWaiting?.({
          callId: `${event.toolCallId}:directive`,
          directiveId: event.toolCallId,
          conversationId: threadId,
          contextRevision: null,
          expiresAt: null,
          actionId: parked.actionId,
          label: parkedLabel,
          execution: "frontend",
          slots: parked.slots,
          // A parked directive that owes no confirmation runs at once in the
          // workspace, so the sentence may only promise a pause when one is owed.
          message: action
            ? describeDirectiveForOwner(parked.actionId, parkedLabel, parked.slots, {
                requiresConfirmation:
                  parkedRequiresConfirmation || parkedTrustedActivationRequired,
              })
            : parked.message || "One is ready to continue.",
          requiresConfirmation: parkedRequiresConfirmation,
          trustedActivationRequired: parkedTrustedActivationRequired,
          raw: {
            protocol: "ag-ui",
            toolName,
            args: {},
            parked: true,
            // The run does not pause for a parked directive; there is no
            // interrupt to resume. The workspace still needs a resume hook to
            // treat this like any other staged frontend action.
            resume: async () => undefined,
          },
        });
        if (parkedRequiresConfirmation || parkedTrustedActivationRequired) {
          stopAfterConfirmation();
        }
      }
      const experience = parseAgentToolResultExperience(
        toolName,
        event.content,
        toolArgs.get(event.toolCallId),
      );
      if (experience) {
        // Redelivery can assign a new transport message while retaining the
        // same invocation. One invocation owns one evolving card.
        const eventId = event.toolCallId.trim() ||
          (typeof event.messageId === "string" ? event.messageId.trim() : "") ||
          undefined;
        handlers.onStructuredExperience?.(experience, eventId);
      }
    },
    onActivitySnapshotEvent: ({ event }) => {
      const experience = parseAgentActivityExperience(
        event.activityType,
        event.content,
      );
      if (experience) {
        handlers.onStructuredExperience?.(experience, String(event.messageId || "").trim() || undefined);
      }
    },
    onActivityDeltaEvent: ({ event, activityMessage }) => {
      let content: unknown = activityMessage?.content;
      if (activityMessage && Array.isArray(event.patch)) {
        try {
          content = applyPatch(
            activityMessage.content ?? {},
            event.patch as Operation[],
            true,
            false,
          ).newDocument;
        } catch {
          // The AG-UI client will still apply the patch to its message store.
          // Do not emit a stale structured card when this delta is malformed.
          return;
        }
      }
      const experience = parseAgentActivityExperience(
        activityMessage?.activityType || event.activityType,
        content,
      );
      if (experience) {
        handlers.onStructuredExperience?.(experience, String(event.messageId || "").trim() || undefined);
      }
    },
    onStateDeltaEvent: ({ event }) => {
      const patches = Array.isArray(event.delta) ? event.delta : [];
      for (const patch of patches) {
        if (!patch || typeof patch !== "object") continue;
        const op = patch as { op?: string; path?: string; value?: unknown };
        if (
          (op.op === "add" || op.op === "replace") &&
          typeof op.path === "string" &&
          op.path.startsWith("/hussh:pending_directive:")
        ) {
          const val = op.value as Record<string, unknown> | null;
          if (
            val &&
            typeof val === "object" &&
            typeof val.delegateAgentId === "string"
          ) {
            const directivePayload = (val.payload || {}) as Record<string, unknown>;
            const directiveEvent: SpecialistDirectiveEvent = {
              delegateAgentId: val.delegateAgentId,
              directive: {
                kind: val.kind === "prompt" ? "prompt" : "action",
                payload: directivePayload,
              },
              message: String(directivePayload.summary || val.message || ""),
              stateChanged: true,
            };
            handlers.onSpecialistDirective?.(directiveEvent);
            continue;
          }
          if (emittedStateDirectivePaths.has(op.path)) continue;
          const actionEvent = parseStateActionDirective(op.path, op.value, threadId);
          if (actionEvent) {
            emittedStateDirectivePaths.add(op.path);
            handlers.onToolWaiting?.(actionEvent);
            if (
              actionEvent.requiresConfirmation ||
              actionEvent.trustedActivationRequired
            ) {
              stopAfterConfirmation();
            }
          }
        }
      }
    },
    onRunFinishedEvent: (params) => {
      if (params.outcome === "interrupt") {
        for (const interrupt of params.interrupts) {
          if (interrupt.toolCallId) interruptsByToolCall.set(interrupt.toolCallId, interrupt.id);
        }
        for (const [callId, reference] of mcpReviews) {
          const interruptId = interruptsByToolCall.get(callId);
          if (!interruptId || publishedMcpReviews.has(callId)) continue;
          publishedMcpReviews.add(callId);
          let attempted = false;
          handlers.onMcpReview?.({
            reference,
            conversationId: threadId,
            isCurrent: mcpSessionCurrent,
            loadConfiguration: input.loadConnectorConfigurations ? async () => {
              const projection = await connectorProjection();
              const configuration = projection.mcpConfigurations?.find(item => item.connectorId === reference.connectorId);
              if (reference.connectorId.startsWith("custom_") && !configuration) {
                throw new Error("This connector was removed. Prepare a new request.");
              }
              return configuration;
            } : undefined,
            resume: async (approval, signal) => {
              if (attempted || signal?.aborted || !mcpSessionCurrent() || Date.parse(reference.expiresAt) <= Date.now()) {
                throw new Error("This connector review expired or was already used.");
              }
              if (approval && (
                approval.directiveId !== reference.directiveId ||
                approval.connectorId !== reference.connectorId ||
                approval.toolName !== reference.toolName ||
                approval.pendingHandle !== reference.pendingHandle ||
                !/^[A-Za-z0-9_-]{32,128}$/.test(approval.receipt)
              )) throw new Error("This confirmation does not match the connector review.");
              // A lost acknowledgement must not cause an automatic second mutation.
              attempted = true;
              const abortResume = () => agent.abortRun();
              input.signal?.addEventListener("abort", abortResume, { once: true });
              signal?.addEventListener("abort", abortResume, { once: true });
              try {
                await agent.runAgent({
                  tools, context: [],
                  forwardedProps: {
                    ...await connectorProjection(),
                    timezone, pkmContext: input.pkmContext,
                    personSelectionHandle: input.personSelectionHandle,
                    gmailInformationRequestWorkflowId: input.gmailInformationRequestWorkflowId,
                    screenContext: input.screenContext,
                    ...(approval ? { mcpApproval: {
                      directiveId: approval.directiveId, connectorId: approval.connectorId,
                      toolName: approval.toolName, pendingHandle: approval.pendingHandle,
                      receipt: approval.receipt,
                    } } : {}),
                  },
                  resume: [{ interruptId, status: "resolved", payload: { confirmed: approval !== null } }],
                }, subscriber);
                if (signal?.aborted || !mcpSessionCurrent()) throw new Error("The connector session changed.");
                if (failure) throw failure;
              } finally {
                input.signal?.removeEventListener("abort", abortResume);
                signal?.removeEventListener("abort", abortResume);
              }
            },
          });
        }
        interrupted = true;
        handlers.onInterrupt?.({ conversationId: threadId });
        // The visible confirmation card owns the next step. The resumable
        // `agent` and subscriber stay alive through the directive's resume
        // closure, but the initial turn must settle so the workspace stops
        // showing an indefinite thinking state.
        finishTerminalRun();
        return;
      }
      handlers.onComplete?.({ conversationId: threadId });
      finishTerminalRun();
    },
    onRunErrorEvent: ({ event }) => {
      if (intentionallyStoppedAtConfirmation) {
        finishTerminalRun();
        return;
      }
      failure = new Error(formatAgentChatErrorMessage(event.message || ""));
      handlers.onError?.(failure.message);
      finishTerminalRun();
    },
    onRunFailed: ({ error }) => {
      if (intentionallyStoppedAtConfirmation) {
        finishTerminalRun();
        return;
      }
      failure = new Error(formatAgentChatErrorMessage(error.message || ""));
      handlers.onError?.(failure.message);
      finishTerminalRun();
    },
  };
  const abort = () => {
    agent.abortRun();
    finishTerminalRun();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await agent.runAgent({
      tools,
      context: [],
      forwardedProps: {
        ...await connectorProjection(),
        timezone,
        pkmContext: input.pkmContext,
        personSelectionHandle: input.personSelectionHandle,
        gmailInformationRequestWorkflowId: input.gmailInformationRequestWorkflowId,
        screenContext: input.screenContext,
      },
    }, subscriber);
    await terminalRun;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  if (failure) throw failure;
  return { conversationId: threadId, model: null, text, interrupted };
}

/**
 * Pre-vault informational/navigation-only agent turn.
 *
 * Calls the lower-privilege backend tier that never touches PKM/vault data and
 * is not persisted. Used by the single agent bar before the vault is unlocked,
 * including anonymous onboarding visitors.
 */
export async function streamAgentIntro(input: {
  message: string;
  screenContext?: Record<string, unknown> | null;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  const threadId = crypto.randomUUID();
  const handlers = input.handlers ?? {};
  const agent = new HttpAgent({
    url: "/api/one/agent-chat",
    threadId,
    initialMessages: [{ id: crypto.randomUUID(), role: "user", content: input.message }],
    fetch: (_url, init) => nativeStreamFetch("/api/one/agent-chat", init),
  });
  let text = "";
  let failure: Error | null = null;
  const subscriber: AgentSubscriber = {
    ...publicOutputSubscriber,
    onRunStartedEvent: () => handlers.onStart?.({ conversationId: threadId }),
    onMessagesSnapshotEvent: (snapshot) => {
      const { event } = snapshot;
      const serverMessageId = lastAssistantMessageId(event.messages);
      if (serverMessageId) handlers.onServerMessageId?.(serverMessageId);
      return publicOutputSubscriber.onMessagesSnapshotEvent?.(snapshot);
    },
    onTextMessageContentEvent: ({ event }) => {
      text += event.delta;
      handlers.onToken?.(event.delta);
    },
    onRunFinishedEvent: () => handlers.onComplete?.({ conversationId: threadId }),
    onRunErrorEvent: ({ event }) => {
      failure = new Error(formatAgentChatErrorMessage(event.message || ""));
      handlers.onError?.(failure.message);
    },
    onRunFailed: ({ error }) => {
      failure = new Error(formatAgentChatErrorMessage(error.message || ""));
      handlers.onError?.(failure.message);
    },
  };
  const abort = () => agent.abortRun();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await agent.runAgent({
      tools: [],
      context: [],
      forwardedProps: { screenContext: input.screenContext, timezone: resolveBrowserTimeZone() },
    }, subscriber);
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  if (failure) throw failure;
  return { conversationId: threadId, model: null, text };
}

export async function listAgentChatConversations(input: {
  userId: string;
  vaultOwnerToken: string;
  limit?: number;
}): Promise<AgentChatConversation[]> {
  const response = await ApiService.listAgentChatConversations(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = (await response.json()) as { conversations?: AgentChatConversation[] };
  return Array.isArray(payload.conversations) ? payload.conversations : [];
}

export async function getAgentChatHistory(input: {
  conversationId: string;
  vaultOwnerToken: string;
  limit?: number;
}): Promise<AgentChatMessage[]> {
  const response = await ApiService.getAgentChatHistory(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = (await response.json()) as {
    messages?: Array<Omit<AgentChatMessage, "metadata"> & {
      metadata?: {
        kind?: string;
        display?: string;
        structuredExperience?: {
          activityType?: string;
          content?: unknown;
        } | null;
        structuredExperienceId?: string | null;
        structuredExperiences?: Array<{ id: string; activityType: string; content: unknown }>;
        specialist_read?: unknown;
      } | null;
    }>;
  };
  if (!Array.isArray(payload.messages)) return [];
  return payload.messages
    .filter((message) => ["user", "assistant", "system", "tool"].includes(message.role))
    .map((message) => ({
      id: message.id,
      conversation_id: message.conversation_id,
      role: message.role,
      status: message.status,
      content: message.content,
      model: message.model,
      created_at: message.created_at,
      completed_at: message.completed_at,
      metadata: message.metadata
        ? {
            kind: message.metadata.kind,
            display: message.metadata.display,
            structuredExperience: message.metadata.structuredExperience,
        turnActivity?: { activityType?: string; content?: unknown } | null;
            structuredExperienceId: message.metadata.structuredExperienceId,
            structuredExperiences: message.metadata.structuredExperiences,
            connectorRead:
              message.role === "assistant"
                ? parseConnectorReadReceipt(message.metadata.specialist_read)
                : null,
          }
        : message.metadata,
    }));
}

/** Record only a request locator; the Chat owner derives the history card from its ledger. */
export async function recordAgentChatInformationRequest(input: {
  conversationId: string;
  sourceActivityId: string;
  bundleId: string;
  idempotencyKey: string;
  vaultOwnerToken: string;
}): Promise<AgentStructuredExperience> {
  const response = await ApiService.apiFetch(
    `/api/one/agent-chat/history/${encodeURIComponent(input.conversationId)}/information-requests`,
    {
            ...(message.role === "assistant" && message.metadata.turnActivity
              ? { turnActivity: message.metadata.turnActivity } : {}),
      method: "POST",
      headers: { Authorization: `Bearer ${input.vaultOwnerToken}` },
      body: JSON.stringify({
        source_activity_id: input.sourceActivityId,
        bundle_id: input.bundleId,
        idempotency_key: input.idempotencyKey,
      }),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  const payload = (await response.json()) as { descriptor?: { activityType?: string; content?: unknown } };
  const descriptor = payload.descriptor;
  const experience = descriptor?.activityType === "one.information_request_review.v1"
    ? parseAgentActivityExperience(descriptor.activityType, descriptor.content) : null;
  if (!experience || experience.type !== "one.information_request_review.v1"
    || experience.phase !== "submitted" || experience.bundleId !== input.bundleId) {
    throw new Error("The submitted request history could not be verified.");
  }
  return experience;
}

/**
 * Ratings this person has given in one conversation, keyed by message id.
 * Never throws: an opinion about a turn must not stop the turn from loading.
 */
export async function getAgentChatFeedback(input: {
  conversationId: string;
  vaultOwnerToken: string;
}): Promise<Record<string, "up" | "down">> {
  try {
    // Through the platform-aware transport like every sibling call: a bare
    // relative fetch resolves against the app's own static files in the
    // native shell, so ratings never reached the backend on the phones.
    const response = await ApiService.apiFetch(
      `/api/one/agent-chat/feedback?conversation_id=${encodeURIComponent(input.conversationId)}`,
      {
        headers: { Authorization: `Bearer ${input.vaultOwnerToken}` },
        cache: "no-store",
      },
    );
    if (!response.ok) return {};
    const payload = (await response.json()) as {
      ratings?: Record<string, "up" | "down">;
    };
    return payload.ratings ?? {};
  } catch {
    return {};
  }
}

export async function setAgentChatFeedback(input: {
  conversationId: string;
  messageId: string;
  rating: "up" | "down" | null;
  vaultOwnerToken: string;
}): Promise<void> {
  const response = await ApiService.apiFetch("/api/one/agent-chat/feedback", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${input.vaultOwnerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversation_id: input.conversationId,
      message_id: input.messageId,
      rating: input.rating,
    }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

export async function renameAgentChatConversation(input: {
  conversationId: string;
  title: string;
  vaultOwnerToken: string;
}): Promise<AgentChatConversation> {
  const response = await ApiService.renameAgentChatConversation(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as AgentChatConversation;
}

export async function deleteAgentChatConversation(input: {
  conversationId: string;
  vaultOwnerToken: string;
}): Promise<{ conversation_id: string; deleted: boolean }> {
  const response = await ApiService.deleteAgentChatConversation(input);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as { conversation_id: string; deleted: boolean };
}
