import { ApiService } from "@/lib/services/api-service";
import { projectCustomConnectorTurnConfigurations, type CustomConnectorConfiguration } from "@/lib/connections/custom-connector-schema";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseConnectorReadReceipt, type ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";
import {
  parseDriveBatchProgressActivity,
  type DriveBatchProgress,
} from "@/lib/agent/drive-batch-progress";
import { HttpAgent, type AgentSubscriber, type Tool } from "@ag-ui/client";
import { Capacitor } from "@capacitor/core";
import { applyPatch, type Operation } from "fast-json-patch";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { describeDirectiveForOwner } from "@/lib/agent/action-directive-summary";
import { parseMcpCallReview, type McpCallApproval, type McpCallReviewReference } from "@/lib/agent/mcp-call-review";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { resolveTurnLocation } from "@/lib/agent/turn-location";
import {
  ChatKeyUnavailableError,
  chatKeyRefusalCode,
  noteChatKeyAccepted,
  oneChatKeyHeaders,
  routeChatKeyRefusal,
} from "@/lib/vault/one-chat-key";
import {
  AGENT_TURN_DETACH_REASON,
  registerAttachedAgentTurn,
  watchDetachedAgentTurn,
} from "@/lib/agent/agent-chat-turn-watch";
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
  /** App-authored present-tense phrase for the chat header while this call runs. */
  activity?: string;
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
    /** Derived chat key header value; the review reads this owner's sealed conversation. */
    chatKey: string;
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
  /** Owner-only count progress from a server AG-UI activity; never inferred from time. */
  onDriveBatchProgress?: (progress: DriveBatchProgress, eventId?: string) => void;
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

/**
 * App-owned presentation for every tool on One's roster: the Activity row's
 * label and sentence, and the present-tense phrase the chat header shows while
 * the call runs. Keyed by the server's own tool identity, never by provider
 * text. A roster tool missing here rendered as a generic "Agent step" row live
 * and vanished from restored history, so the backend history allowlist
 * (`_ACTIVITY_TOOLS` in consent-protocol/api/routes/one/agent_chat.py) mirrors
 * these keys and a backend test holds both to the roster.
 */
const SERVER_TOOL_PRESENTATION: Record<
  string,
  { label: string; message: string; activity: string }
> = {
  discover_person_information: {
    label: "Available information",
    message: "Checking what this person makes available to request.",
    activity: "Checking what they share",
  },
  list_pending_information_requests: {
    label: "Pending requests",
    message: "Checking what is waiting on you.",
    activity: "Checking pending requests",
  },
  propose_information_request: {
    label: "Information request",
    message: "Preparing an information request for your confirmation.",
    activity: "Preparing a request",
  },
  list_my_connections: {
    label: "Connections",
    message: "Checking your current connections.",
    activity: "Checking your connections",
  },
  inspect_selected_drive_files: {
    label: "Google Drive",
    message: "Checking selected file status.",
    activity: "Checking Drive files",
  },
  inspect_private_connectors: {
    label: "Connectors",
    message: "Checking your saved connectors.",
    activity: "Checking your connectors",
  },
  discover_workspace_tools: {
    label: "Connector access",
    message: "Checking which connected capabilities are available.",
    activity: "Checking connector access",
  },
  read_workspace_tool: {
    label: "Connected app read",
    message: "Reading the selected connected capability.",
    activity: "Reading a connected app",
  },
  read_selected_drive_search_result: {
    label: "Google Drive",
    message: "Checking the selected file.",
    activity: "Checking a Drive file",
  },
  ask_email_agent: {
    label: "Gmail",
    message: "Checking your mail request.",
    activity: "Checking your Gmail",
  },
  ask_documents_agent: {
    label: "Google Drive",
    message: "Searching your Drive for this answer.",
    activity: "Searching your Drive",
  },
  ask_connected_systems_agent: {
    label: "Connected systems",
    message: "Checking the connected-systems request.",
    activity: "Checking connected systems",
  },
  ask_consent_agent: {
    label: "Consent",
    message: "Checking the consent request.",
    activity: "Checking consent",
  },
  list_pending_connection_requests: {
    label: "Connection requests",
    message: "Checking your pending connection requests.",
    activity: "Checking connection requests",
  },
  google_search: {
    label: "Web search",
    message: "Searching the public web.",
    activity: "Searching the web",
  },
  finance: {
    label: "Finance",
    message: "Asking the finance specialist.",
    activity: "Checking your finances",
  },
  wallet: {
    label: "Wallet",
    message: "Checking your wallet.",
    activity: "Checking your wallet",
  },
  ask_memory_agent: {
    label: "Your memory",
    message: "Checking what One remembers.",
    activity: "Checking your memory",
  },
  read_my_pkm_domain_summary: {
    label: "Your memory",
    message: "Reading your memory summary.",
    activity: "Reading your memory",
  },
  add_to_pkm: {
    label: "Memory",
    message: "Saving this to your memory.",
    activity: "Saving to your memory",
  },
  read_my_profile_status: {
    label: "Profile",
    message: "Checking your profile.",
    activity: "Checking your profile",
  },
  ask_location_agent: {
    label: "Location",
    message: "Checking the location request.",
    activity: "Checking location",
  },
  list_my_location_circles: {
    label: "Location circles",
    message: "Checking your circles.",
    activity: "Checking your circles",
  },
  get_location_circle_members: {
    label: "Location circles",
    message: "Checking circle members.",
    activity: "Checking circle members",
  },
  list_my_location_shares: {
    label: "Location sharing",
    message: "Checking who sees your location.",
    activity: "Checking location sharing",
  },
  list_location_shared_with_me: {
    label: "Location sharing",
    message: "Checking locations shared with you.",
    activity: "Checking shared locations",
  },
  list_pending_location_requests: {
    label: "Location requests",
    message: "Checking location requests waiting on you.",
    activity: "Checking location requests",
  },
  list_my_outgoing_location_requests: {
    label: "Location requests",
    message: "Checking location requests you sent.",
    activity: "Checking sent location requests",
  },
  list_information_shared_with_me: {
    label: "Shared with you",
    message: "Checking information shared with you.",
    activity: "Checking what is shared with you",
  },
  list_active_grants: {
    label: "Access grants",
    message: "Checking who has access.",
    activity: "Checking access grants",
  },
  list_my_outgoing_information_requests: {
    label: "Sent requests",
    message: "Checking requests you sent.",
    activity: "Checking sent requests",
  },
  propose_document_request: {
    label: "Document request",
    message: "Preparing a document request for your confirmation.",
    activity: "Preparing a document request",
  },
  list_available_models: {
    label: "Models",
    message: "Checking available models.",
    activity: "Checking models",
  },
  set_preferred_model: {
    label: "Models",
    message: "Updating your preferred model.",
    activity: "Updating your model",
  },
  calendar_summary: {
    label: "Google Calendar",
    message: "Summarizing your calendar.",
    activity: "Checking your Calendar",
  },
  calendar_events: {
    label: "Google Calendar",
    message: "Reading your calendar events.",
    activity: "Reading your Calendar",
  },
  calendar_availability: {
    label: "Google Calendar",
    message: "Checking your availability.",
    activity: "Checking availability",
  },
  calendar_free_slots: {
    label: "Google Calendar",
    message: "Finding free time on your calendar.",
    activity: "Finding free time",
  },
  propose_calendar_event: {
    label: "Google Calendar",
    message: "Preparing an event for your confirmation.",
    activity: "Preparing an event",
  },
  propose_calendar_reschedule: {
    label: "Google Calendar",
    message: "Preparing a reschedule for your confirmation.",
    activity: "Preparing a reschedule",
  },
  propose_calendar_cancellation: {
    label: "Google Calendar",
    message: "Preparing a cancellation for your confirmation.",
    activity: "Preparing a cancellation",
  },
  open_gmail_email_draft: {
    label: "Gmail",
    message: "Opening an email draft.",
    activity: "Drafting an email",
  },
  open_gmail_information_request_reply: {
    label: "Gmail",
    message: "Opening a reply draft.",
    activity: "Drafting a reply",
  },
  propose_gmail_mailbox_change: {
    label: "Gmail",
    message: "Preparing a mailbox change for your confirmation.",
    activity: "Preparing a mailbox change",
  },
  propose_drive_share: {
    label: "Google Drive",
    message: "Preparing a Drive share for your confirmation.",
    activity: "Preparing a Drive share",
  },
  propose_drive_file_share: {
    label: "Google Drive",
    message: "Preparing a Drive share for your confirmation.",
    activity: "Preparing a Drive share",
  },
  propose_drive_file_trash: {
    label: "Google Drive",
    message: "Preparing a Drive removal for your confirmation.",
    activity: "Preparing a Drive removal",
  },
  create_drive_file: {
    label: "Google Drive",
    message: "Creating a Drive file.",
    activity: "Creating a Drive file",
  },
  copy_drive_file: {
    label: "Google Drive",
    message: "Copying a Drive file.",
    activity: "Copying a Drive file",
  },
  move_drive_file: {
    label: "Google Drive",
    message: "Moving a Drive file.",
    activity: "Moving a Drive file",
  },
  comment_on_drive_file: {
    label: "Google Drive",
    message: "Adding a Drive comment.",
    activity: "Commenting in Drive",
  },
  open_screen: {
    label: "App navigation",
    message: "Opening a screen in the app.",
    activity: "Opening a screen",
  },
  run_app_action: {
    label: "App action",
    message: "Running an action in the app.",
    activity: "Working in the app",
  },
  propose_app_action: {
    label: "App action",
    message: "Preparing an action for your confirmation.",
    activity: "Preparing an action",
  },
  report_no_app_action: {
    label: "App action",
    message: "No app action was needed.",
    activity: "Choosing the next step",
  },
  list_app_actions: {
    label: "App actions",
    message: "Looking up what One can do here.",
    activity: "Looking up actions",
  },
  start_app_goal: {
    label: "App task",
    message: "Starting a task in the app.",
    activity: "Starting a task",
  },
  continue_app_goal: {
    label: "App task",
    message: "Continuing the task in the app.",
    activity: "Continuing the task",
  },
  resolve_onboarding_goal: {
    label: "Setup",
    message: "Checking your setup goal.",
    activity: "Checking your setup",
  },
  get_current_time: {
    label: "Time",
    message: "Checking the current time.",
    activity: "Checking the time",
  },
  get_my_location: {
    label: "Location",
    message: "Using your approximate location for this answer.",
    activity: "Checking your location",
  },
  // ADK's own confirmation step for a reviewed connector call. Live only:
  // history restores the reviewed call's row, never this envelope.
  adk_request_confirmation: {
    label: "Your review",
    message: "Waiting for your review.",
    activity: "Waiting for your review",
  },
};

const WORKSPACE_PROVIDER_NAMES: Record<string, string> = {
  gmail: "Gmail",
  drive: "Google Drive",
  calendar: "Google Calendar",
};

/**
 * Connector setup and reads name the Google product once the call's provider
 * is known, so "lets connect to Google Drive" reads "Google Drive · Checking
 * Google Drive access" rather than a generic connector row. Only the fixed
 * enum above ever labels a step; any other provider value keeps the generic
 * presentation.
 */
function workspaceToolPresentation(
  toolName: string,
  provider: unknown,
): { label: string; message: string; activity: string } | null {
  const name = typeof provider === "string" ? WORKSPACE_PROVIDER_NAMES[provider] : undefined;
  if (!name) return null;
  if (toolName === "discover_workspace_tools") {
    return { label: name, message: `Checking ${name} access.`, activity: `Checking ${name} access` };
  }
  if (toolName === "read_workspace_tool") {
    return { label: name, message: `Reading ${name}.`, activity: `Reading ${name}` };
  }
  return null;
}

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
    const presentation = workspaceToolPresentation(toolName, step.provider) ??
      SERVER_TOOL_PRESENTATION[toolName];
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
    else if (toolName === "read_selected_drive_search_result") {
      message = step.readStatus === "ok" ? "Drive file checked."
        : step.readStatus === "input_required" ? "Choose the file again."
          : "Drive file could not be checked.";
    }
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

const CHAT_KEY_REFUSAL_MESSAGES: Record<string, string> = {
  CHAT_KEY_REQUIRED: "Unlock your vault, then try again. If this keeps happening, update or refresh the app.",
  CHAT_KEY_INVALID: "Unlock your vault, then try again. If this keeps happening, update or refresh the app.",
  CHAT_KEY_MISMATCH: "Your chat history did not open with this vault. Unlock your vault again, then try again.",
  CHAT_CONVERSATION_RETIRED: "This conversation is no longer available. Start a new chat.",
};

export function formatAgentChatErrorMessage(message: string, code?: string): string {
  // Chat history is sealed with a key derived from the vault. These refusals are
  // recoverable, so say how; the raw server text is never shown.
  const chatKeyCode = code && code in CHAT_KEY_REFUSAL_MESSAGES
    ? code
    : Object.keys(CHAT_KEY_REFUSAL_MESSAGES).find((candidate) => message.includes(candidate));
  const chatKeyRefusal = chatKeyCode ? CHAT_KEY_REFUSAL_MESSAGES[chatKeyCode] : undefined;
  if (chatKeyRefusal) return chatKeyRefusal;
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

/**
 * Send one keyed chat-history request. A missing local key or a CHAT_KEY_*
 * refusal becomes a routed `ChatKeyRefusalError` (chat is treated as locked and
 * the person is asked to unlock) instead of an error the caller might retry.
 */
async function sendWithChatKey(send: () => Promise<Response>): Promise<Response> {
  const vaultEpoch = snapshotVaultSessionEpoch();
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (error instanceof ChatKeyUnavailableError) {
      throw routeChatKeyRefusal("CHAT_KEY_REQUIRED", vaultEpoch);
    }
    throw error;
  }
  if (response.ok) {
    noteChatKeyAccepted();
    return response;
  }
  const code = chatKeyRefusalCode(await response.clone().json().catch(() => null));
  if (code) throw routeChatKeyRefusal(code, vaultEpoch);
  return response;
}

export type AgentChatConsentContinuation = {
  bundleId: string;
  outcome: "granted" | "denied" | "expired";
  sharedInformation?: string;
};

/**
 * The person's unsent mail draft as it is on screen, so a follow-up turn can
 * revise it. It grants nothing: One can only open a replacement review card,
 * and sending still needs the person's Send click on that card.
 */
export type PendingEmailDraftContext = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  driveFileId?: string;
  /** A reply to the selected Gmail request; its envelope stays server-derived. */
  sourceBound: boolean;
};

export async function streamAgentChat(input: {
  userId: string;
  message: string;
  conversationId?: string | null;
  vaultOwnerToken: string;
  /** Unlocked vault key. Only the chat key derived from it is sent. */
  vaultKey: string;
  loadConnectorConfigurations?: () => Promise<CustomConnectorConfiguration[]>;
  pkmContext?: string;
  personSelectionHandle?: string;
  /** Opaque owner-selected KYC workflow; Gmail content stays server-side. */
  gmailInformationRequestWorkflowId?: string;
  /**
   * The follow-up turn after another person answered this person's request.
   * `sharedInformation` is what this device decrypted from the approved export;
   * the server admits it only for an approved grant and keeps it for this turn.
   */
  consentContinuation?: AgentChatConsentContinuation;
  /** One saved Drive result, checked against the current owner and live Drive before use. */
  driveSearchSelection?: { jobId: string; position: number };
  pendingEmailDraft?: PendingEmailDraftContext | null;
  screenContext?: Record<string, unknown> | null;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{
  conversationId: string | null;
  model: string | null;
  text: string;
  interrupted: boolean;
  /**
   * The app stopped reading while the server kept the turn running. The answer
   * is sealed into history when it settles; the turn watch reattaches to it.
   */
  detached: boolean;
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
  // Chat history is sealed with a key derived from the vault key; the server
  // refuses the turn without it and holds it for this request only.
  // The coarse position is resolved beside the key so it adds no serial wait.
  let chatKeyHeaders: Record<string, string>;
  let turnLocation: Awaited<ReturnType<typeof resolveTurnLocation>>;
  try {
    [chatKeyHeaders, turnLocation] = await Promise.all([
      oneChatKeyHeaders(input.vaultKey),
      resolveTurnLocation(),
    ]);
  } catch (error) {
    // A vault-owner token without a vault key is not an unlocked chat. Nothing
    // is sent; the person is routed to unlock.
    if (error instanceof ChatKeyUnavailableError) {
      throw routeChatKeyRefusal("CHAT_KEY_REQUIRED", mcpVaultEpoch);
    }
    throw error;
  }
  const chatKey = Object.values(chatKeyHeaders)[0] ?? "";
  const agent = new HttpAgent({
    url: "/api/one/agent-chat",
    threadId,
    headers: { Authorization: `Bearer ${input.vaultOwnerToken}`, ...chatKeyHeaders },
    initialMessages: [{ id: crypto.randomUUID(), role: "user", content: input.message }],
    fetch: (_url, init) => nativeStreamFetch("/api/one/agent-chat", init),
  });
  let text = "";
  let failure: Error | null = null;
  let interrupted = false;
  let intentionallyStoppedAtConfirmation = false;
  // Server events seen, and whether one was terminal. The bridge starts the
  // turn's own task only after RUN_STARTED, so a second event proves a turn is
  // running server-side and will outlive this stream.
  let serverEvents = 0;
  let serverTerminal = false;
  let detached = false;
  const startedAtMs = Date.now();
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
    const serverPresentation = workspaceToolPresentation(name, args.provider) ??
      SERVER_TOOL_PRESENTATION[name];
    const resolvedActionId = typeof actionId === "string" ? actionId : null;
    // Native MCP identities are opaque digests. Never render their raw name or
    // provider-authored descriptions as app-owned activity labels.
    const mcpTool = /^mcp_[0-9a-f]{40}$/.test(name);
    const label = action?.label || serverPresentation?.label ||
      (mcpTool ? "Connected tool" : "Agent step");
    const activity = action?.label || serverPresentation?.activity ||
      (mcpTool ? "Using a connected tool" : "Working on your request");
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
      activity,
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
          (mcpTool ? "Using a connected tool." : "Completing a step for your request."),
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
              turnLocation,
              pkmContext: input.pkmContext,
              personSelectionHandle: input.personSelectionHandle,
              gmailInformationRequestWorkflowId: input.gmailInformationRequestWorkflowId,
              ...(input.driveSearchSelection ? { driveSearchSelection: input.driveSearchSelection } : {}),
              ...(input.pendingEmailDraft ? { pendingEmailDraft: input.pendingEmailDraft } : {}),
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
      serverEvents += 1;
      if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") serverTerminal = true;
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
    onRunStartedEvent: () => {
      noteChatKeyAccepted();
      handlers.onStart?.({ conversationId: threadId });
    },
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
        : toolCallName === "ask_email_agent" || toolCallName === "ask_documents_agent" || toolCallName === "inspect_selected_drive_files" || toolCallName === "read_selected_drive_search_result"
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
      if (toolName === "read_selected_drive_search_result") {
        const result = unwrapParkedActionResult(event.content);
        const payload = toolPayload(event.toolCallId, toolName);
        payload.execution = "server";
        payload.message = result?.status === "ok" ? "Drive file checked."
          : result?.status === "input_required" ? "Choose the file again."
            : "Drive file could not be checked.";
        payload.raw = { protocol: "ag-ui", toolName };
        handlers.onToolResult?.(payload);
        return;
      }
      // External-read receipts are display-only, even if an invalid result attempts to
      // smuggle a parked navigation/send directive alongside it.
      if (toolName === "ask_email_agent" || toolName === "ask_documents_agent" || toolName === "inspect_selected_drive_files") {
        const experience = parseAgentToolResultExperience(toolName, event.content);
        const readExperience = experience?.type === "one.connector_read.v1" ? experience : null;
        const payload = toolPayload(event.toolCallId, toolName);
        payload.execution = "server";
        const source = toolName === "ask_email_agent" ? "Mail" : "Drive";
        const isStatusCheck = toolName === "inspect_selected_drive_files";
        payload.message = isStatusCheck
          ? parseRecord(event.content)?.status === "ok"
            ? "Drive status checked."
            : "Drive status could not be checked."
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
        payload.message = experience?.type === "one.connector_read.v1"
          ? experience.status === "ok"
            ? experience.metadataOnly ? "Drive search finished." : "Drive read finished."
            : experience.status === "input_required" ? "Drive needs more detail." : "Drive could not complete that read."
          : toolName === "inspect_private_connectors"
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
      const progress = parseDriveBatchProgressActivity(event.activityType, event.content);
      if (progress) {
        handlers.onDriveBatchProgress?.(progress, String(event.messageId || "").trim() || undefined);
      }
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
      const progress = parseDriveBatchProgressActivity(
        activityMessage?.activityType || event.activityType,
        content,
      );
      if (progress) {
        handlers.onDriveBatchProgress?.(progress, String(event.messageId || "").trim() || undefined);
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
            chatKey,
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
                    timezone, turnLocation, pkmContext: input.pkmContext,
                    personSelectionHandle: input.personSelectionHandle,
                    gmailInformationRequestWorkflowId: input.gmailInformationRequestWorkflowId,
                    ...(input.driveSearchSelection ? { driveSearchSelection: input.driveSearchSelection } : {}),
                    ...(input.pendingEmailDraft ? { pendingEmailDraft: input.pendingEmailDraft } : {}),
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
      const refusal = chatKeyRefusalCode(event.code || "");
      failure = refusal
        ? routeChatKeyRefusal(refusal, mcpVaultEpoch)
        : new Error(formatAgentChatErrorMessage(event.message || "", event.code || undefined));
      handlers.onError?.(failure.message);
      finishTerminalRun();
    },
    onRunFailed: ({ error }) => {
      // Our own abort of a detached stream is not a failure of the turn, which
      // is still running server-side.
      if (intentionallyStoppedAtConfirmation || detached) {
        finishTerminalRun();
        return;
      }
      const refusal = chatKeyRefusalCode((error as Error & { payload?: unknown }).payload)
        ?? chatKeyRefusalCode(error.message || "");
      failure = refusal
        ? routeChatKeyRefusal(refusal, mcpVaultEpoch)
        : new Error(formatAgentChatErrorMessage(error.message || ""));
      handlers.onError?.(failure.message);
      finishTerminalRun();
    },
  };
  const abort = () => {
    // A detach reason means the caller stopped reading (it left the chat); the
    // server keeps the turn. Any other abort is the caller cancelling.
    if (input.signal?.reason === AGENT_TURN_DETACH_REASON) detached = true;
    agent.abortRun();
    finishTerminalRun();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  const unregisterAttached = registerAttachedAgentTurn({
    ownerId: input.userId,
    conversationId: threadId,
    detach: () => {
      detached = true;
      agent.abortRun();
      finishTerminalRun();
    },
  });
  try {
    await agent.runAgent({
      tools,
      context: [],
      forwardedProps: {
        ...await connectorProjection(),
        timezone,
        turnLocation,
        pkmContext: input.pkmContext,
        personSelectionHandle: input.personSelectionHandle,
        gmailInformationRequestWorkflowId: input.gmailInformationRequestWorkflowId,
        ...(input.driveSearchSelection ? { driveSearchSelection: input.driveSearchSelection } : {}),
        ...(input.pendingEmailDraft ? { pendingEmailDraft: input.pendingEmailDraft } : {}),
        screenContext: input.screenContext,
        ...(input.consentContinuation ? { consentContinuation: input.consentContinuation } : {}),
        // Only the native app asks the server for a "One replied" push when it
        // stops reading; a web tab's closed stream must not wake a phone.
        notifyOnDetach: Capacitor.isNativePlatform(),
      },
    }, subscriber);
    await terminalRun;
  } catch (error) {
    // AG-UI reports a failed request to the subscriber, then rejects with the
    // raw "HTTP 403: {...}" error. The typed, owner-safe failure wins (thrown
    // below). Aborting our own read of a detached turn may also reject the run;
    // the turn itself is still running server-side and is reported as detached.
    if (!failure && !detached) throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unregisterAttached();
  }
  const leftTurn = detached && !serverTerminal && !intentionallyStoppedAtConfirmation;
  // Watch only a turn the server had started (more than RUN_STARTED seen); a
  // detach before that has nothing to reattach to.
  if (leftTurn && serverEvents > 1) {
    watchDetachedAgentTurn({ ownerId: input.userId, conversationId: threadId, startedAtMs });
  }
  if (failure && !leftTurn) throw failure;
  return { conversationId: threadId, model: null, text, interrupted, detached: leftTurn };
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
      failure = new Error(formatAgentChatErrorMessage(event.message || "", event.code || undefined));
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
  vaultKey: string;
  limit?: number;
}): Promise<AgentChatConversation[]> {
  const response = await sendWithChatKey(() => ApiService.listAgentChatConversations(input));
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = (await response.json()) as { conversations?: AgentChatConversation[] };
  return Array.isArray(payload.conversations) ? payload.conversations : [];
}

export async function getAgentChatHistory(input: {
  conversationId: string;
  vaultOwnerToken: string;
  vaultKey: string;
  limit?: number;
}): Promise<AgentChatMessage[]> {
  const response = await sendWithChatKey(() => ApiService.getAgentChatHistory(input));
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
        turnActivity?: { activityType?: string; content?: unknown } | null;
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
            structuredExperienceId: message.metadata.structuredExperienceId,
            structuredExperiences: message.metadata.structuredExperiences,
            ...(message.role === "assistant" && message.metadata.turnActivity
              ? { turnActivity: message.metadata.turnActivity } : {}),
            connectorRead:
              message.role === "assistant"
                ? parseConnectorReadReceipt(message.metadata.specialist_read)
                : null,
          }
        : message.metadata,
    }));
}

/**
 * Where a turn the app stopped reading stands. The server keeps it running and
 * writes its answer into history; ``pending`` stays true until it settles.
 * Returns only these two flags, so no message text leaves this function.
 */
export async function getAgentChatTurnState(input: {
  conversationId: string;
  vaultOwnerToken: string;
  vaultKey: string;
}): Promise<{ pending: boolean; answered: boolean }> {
  const response = await ApiService.getAgentChatHistory({ ...input, limit: 1 });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = (await response.json()) as {
    messages?: Array<{ role?: unknown }>;
    turn?: { pending?: unknown };
  };
  const pending = payload.turn?.pending === true;
  const last = Array.isArray(payload.messages) ? payload.messages[payload.messages.length - 1] : undefined;
  return { pending, answered: !pending && last?.role === "assistant" };
}

/**
 * Requests this conversation already continued after their answer, keyed by
 * bundle id. Identifiers and outcome words only; no message text is read.
 */
export async function getAgentChatConsentOutcomes(input: {
  conversationId: string;
  vaultOwnerToken: string;
  vaultKey: string;
}): Promise<Record<string, string>> {
  const response = await sendWithChatKey(() => ApiService.getAgentChatHistory({ ...input, limit: 1 }));
  if (!response.ok) throw new Error(await readError(response));
  const payload = (await response.json()) as { consentOutcomes?: unknown };
  const outcomes = payload.consentOutcomes;
  if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)) return {};
  return Object.fromEntries(
    Object.entries(outcomes as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** The person's own conversation that sent this request (sealed history, after unlock). */
export async function findInformationRequestConversation(input: {
  bundleId: string;
  vaultOwnerToken: string;
  vaultKey: string;
}): Promise<string | null> {
  const response = await sendWithChatKey(async () => ApiService.apiFetch(
    `/api/one/agent-chat/information-requests/${encodeURIComponent(input.bundleId)}/conversation`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.vaultOwnerToken}`,
        ...(await oneChatKeyHeaders(input.vaultKey)),
      },
    },
  ));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await readError(response));
  const payload = (await response.json()) as { conversationId?: unknown };
  return typeof payload.conversationId === "string" ? payload.conversationId : null;
}

/** Record only a request locator; the Chat owner derives the history card from its ledger. */
export async function recordAgentChatInformationRequest(input: {
  conversationId: string;
  sourceActivityId: string;
  bundleId: string;
  idempotencyKey: string;
  vaultOwnerToken: string;
  vaultKey: string;
}): Promise<AgentStructuredExperience> {
  const response = await sendWithChatKey(async () => ApiService.apiFetch(
    `/api/one/agent-chat/history/${encodeURIComponent(input.conversationId)}/information-requests`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.vaultOwnerToken}`,
        ...(await oneChatKeyHeaders(input.vaultKey)),
      },
      body: JSON.stringify({
        source_activity_id: input.sourceActivityId,
        bundle_id: input.bundleId,
        idempotency_key: input.idempotencyKey,
      }),
    },
  ));
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
  vaultKey: string;
}): Promise<AgentChatConversation> {
  const response = await sendWithChatKey(() => ApiService.renameAgentChatConversation(input));
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
