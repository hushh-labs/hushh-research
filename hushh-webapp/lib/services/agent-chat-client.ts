import { ApiService } from "@/lib/services/api-service";
import { HttpAgent, type AgentSubscriber, type Tool } from "@ag-ui/client";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
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
  metadata?: { kind?: string; display?: string } | null;
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
  onStart?: (payload: { conversationId: string; model?: string }) => void;
  onToolStart?: (payload: AgentChatToolEvent) => void;
  onToolWaiting?: (payload: AgentChatToolEvent) => void;
  onToolResult?: (payload: AgentChatToolEvent) => void;
  /** Request ids a server tool reported as waiting on the owner; the workspace renders each as a pending-consent card. */
  onPendingConsentRequests?: (requestIds: string[]) => void;
  onToken?: (token: string) => void;
  onComplete?: (payload: { conversationId: string; model?: string }) => void;
  onInterrupt?: (payload: { conversationId: string }) => void;
  onError?: (message: string) => void;
  onThought?: (text: string) => void;
  onSources?: (sources: AgentSource[]) => void;
  onStructuredExperience?: (experience: AgentStructuredExperience) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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

/** Reads the directive a run_app_action result carries when it parked an action for the browser. */
export function parseParkedAppActionDirective(content: unknown): ParkedAppActionDirective | null {
  let result: unknown = content;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }
  const record = asRecord(result);
  if (!record) return null;
  const status = String(record.status || "");
  if (status !== "ready_to_run" && status !== "confirm_pending") return null;
  const directive = asRecord(record.directive);
  const actionId = String(directive?.actionId || record.action_id || "").trim();
  if (!actionId) return null;
  const slots = asRecord(directive?.slots) || {};
  return {
    actionId,
    slots,
    needsConfirmation: directive?.needsConfirmation === true || status === "confirm_pending",
    trustedActivationRequired: directive?.trustedActivationRequired === true,
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
  list_pending_connection_requests: {
    label: "Connection requests",
    message: "Checking your pending connection requests.",
  },
};

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
  pkmContext?: string;
  screenContext?: Record<string, unknown> | null;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
}): Promise<{ conversationId: string | null; model: string | null; text: string }> {
  const timezone = resolveBrowserTimeZone();
  const threadId = input.conversationId || crypto.randomUUID();
  const handlers = input.handlers ?? {};
  const availableActionIds = (() => {
    const screen = input.screenContext || {};
    const nested = asRecord(screen.one_voice_context);
    const raw = nested?.available_action_ids ?? screen.available_action_ids;
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
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
    fetch: (_url, init) => ApiService.apiFetchStream("/api/one/agent-chat", init),
  });
  let text = "";
  let failure: Error | null = null;
  let settleTerminalRun: (() => void) | null = null;
  const terminalRun = new Promise<void>((resolve) => {
    settleTerminalRun = resolve;
  });
  const finishTerminalRun = () => {
    settleTerminalRun?.();
    settleTerminalRun = null;
  };
  const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, Record<string, unknown>>();
  const interruptsByToolCall = new Map<string, string>();
  const toolPayload = (callId: string, name: string, args: Record<string, unknown> = {}): AgentChatToolEvent => {
    const actionId = tools.find((tool) => tool.name === name)?.metadata?.actionId;
    const action = getKaiActionById(typeof actionId === "string" ? actionId : null);
    const serverPresentation = SERVER_TOOL_PRESENTATION[name];
    return {
      callId,
      directiveId: null,
      conversationId: threadId,
      contextRevision: null,
      expiresAt: null,
      actionId: typeof actionId === "string" ? actionId : null,
      label: action?.label || serverPresentation?.label || "One task",
      execution: "frontend",
      slots: args,
      message:
        action?.meaning ||
        serverPresentation?.message ||
        "One is working on your request.",
      requiresConfirmation: action?.execution_policy === "confirm_required",
      trustedActivationRequired: action?.activation_policy === "trusted_activation_required",
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
              timezone,
              pkmContext: input.pkmContext,
              screenContext: input.screenContext,
            },
            resume: [{ interruptId, status, payload }],
          }, subscriber);
        },
      },
    };
  };
  const subscriber: AgentSubscriber = {
    onRunStartedEvent: () => handlers.onStart?.({ conversationId: threadId }),
    onTextMessageContentEvent: ({ event }) => {
      text += event.delta;
      handlers.onToken?.(event.delta);
    },
    onReasoningMessageContentEvent: ({ event }) => handlers.onThought?.(event.delta),
    onToolCallStartEvent: ({ event }) => {
      toolNames.set(event.toolCallId, event.toolCallName);
      handlers.onToolStart?.(toolPayload(event.toolCallId, event.toolCallName));
    },
    onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
      toolArgs.set(event.toolCallId, toolCallArgs);
      handlers.onToolWaiting?.(
        toolPayload(event.toolCallId, toolCallName, toolCallArgs),
      );
    },
    onToolCallResultEvent: ({ event }) => {
      const toolName = toolNames.get(event.toolCallId) || "";
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
      // Live relay delivers parked directives through session state; this
      // text transport has no such relay, so the parked action is surfaced
      // here as a frontend tool event and staged (or run) by the workspace.
      const parked = parseParkedAppActionDirective(event.content);
      if (parked) {
        const action = getKaiActionById(parked.actionId);
        handlers.onToolWaiting?.({
          callId: `${event.toolCallId}:directive`,
          directiveId: event.toolCallId,
          conversationId: threadId,
          contextRevision: null,
          expiresAt: null,
          actionId: parked.actionId,
          label: action?.label || parked.actionId,
          execution: "frontend",
          slots: parked.slots,
          message: action?.meaning || parked.message || "One is ready to continue.",
          requiresConfirmation:
            parked.needsConfirmation || action?.execution_policy === "confirm_required",
          trustedActivationRequired:
            parked.trustedActivationRequired ||
            action?.activation_policy === "trusted_activation_required",
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
      }
      const experience = parseAgentToolResultExperience(toolName, event.content);
      if (experience) handlers.onStructuredExperience?.(experience);
    },
    onActivitySnapshotEvent: ({ event }) => {
      const experience = parseAgentActivityExperience(
        event.activityType,
        event.content,
      );
      if (experience) handlers.onStructuredExperience?.(experience);
    },
    onActivityDeltaEvent: ({ event, activityMessage }) => {
      const experience = parseAgentActivityExperience(
        activityMessage?.activityType || event.activityType,
        activityMessage?.content,
      );
      if (experience) handlers.onStructuredExperience?.(experience);
    },
    onRunFinishedEvent: (params) => {
      if (params.outcome === "interrupt") {
        for (const interrupt of params.interrupts) {
          if (interrupt.toolCallId) interruptsByToolCall.set(interrupt.toolCallId, interrupt.id);
        }
        handlers.onInterrupt?.({ conversationId: threadId });
        return;
      }
      handlers.onComplete?.({ conversationId: threadId });
      finishTerminalRun();
    },
    onRunErrorEvent: ({ event }) => {
      failure = new Error(formatAgentChatErrorMessage(event.message || ""));
      handlers.onError?.(failure.message);
      finishTerminalRun();
    },
    onRunFailed: ({ error }) => {
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
        timezone,
        pkmContext: input.pkmContext,
        screenContext: input.screenContext,
      },
    }, subscriber);
    await terminalRun;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  if (failure) throw failure;
  return { conversationId: threadId, model: null, text };
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
    fetch: (_url, init) => ApiService.apiFetchStream("/api/one/agent-chat", init),
  });
  let text = "";
  let failure: Error | null = null;
  const subscriber: AgentSubscriber = {
    onRunStartedEvent: () => handlers.onStart?.({ conversationId: threadId }),
    onTextMessageContentEvent: ({ event }) => {
      text += event.delta;
      handlers.onToken?.(event.delta);
    },
    onReasoningMessageContentEvent: ({ event }) => handlers.onThought?.(event.delta),
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
  const payload = (await response.json()) as { messages?: AgentChatMessage[] };
  return Array.isArray(payload.messages) ? payload.messages : [];
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

/**
 * Where a turn is answered: the shared hub, or the person's own pod.
 *
 * Returned alongside the answer so the UI can SAY which cell replied. The north star
 * requires the person to be able to tell whose compute served them; a silent switch
 * would make "your own private agent" an unverifiable claim.
 */
export type TurnCell = "hub" | "pod";

/** How long a turn waits for the pod address before the hub answers instead.
 *
 * Short enough that a person with no agent never notices, long enough to cover a
 * status read that is merely in flight (measured on dev: ~330ms). */
export const POD_VERDICT_WAIT_MS = 1_500;

async function waitForPodVerdict(input: {
  podResolved?: boolean;
  podHushhId?: string | null;
  podState?: string | null;
  readPodAddress?: () => { hushhId: string | null; state: string | null; resolved: boolean };
}): Promise<void> {
  const read = input.readPodAddress;
  if (!read) return; // the caller cannot re-read; answer with what we have
  const deadline = Date.now() + POD_VERDICT_WAIT_MS;
  while (Date.now() < deadline) {
    const latest = read();
    if (latest.resolved) {
      input.podHushhId = latest.hushhId;
      input.podState = latest.state;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type AgentTurnResult = {
  conversationId: string | null;
  model: string | null;
  text: string;
  cell: TurnCell;
  /** Present only for a pod turn: DERIVED by the pod, never asserted by the client. */
  grounded?: boolean;
};

/**
 * Run one Agent Chat turn on whichever cell belongs to this person.
 *
 * WHY THIS EXISTS RATHER THAN A BRANCH IN THE COMPONENT
 * `ApiService.runPodTurn` was complete and had ZERO callers, so every turn went to the
 * shared hub even for someone whose pod was live -- the north star's central claim
 * ("their complete agent ecosystem runs in their pod") was unreachable from the product.
 *
 * The two cells do not answer the same SHAPE. The hub streams SSE; the pod returns one
 * complete response. Branching inside the chat component would have put that difference
 * in a 4,600-line file at two separate call sites. It lives here instead, so the
 * component asks one question -- "run this turn" -- and the shape difference is owned in
 * one place.
 *
 * HONEST STREAMING, NOT FAKE STREAMING
 * A pod turn is delivered as ONE `onToken` call with the whole answer. It would have
 * been easy to slice the text and emit it character by character so the UI looked
 * identical, and that would be a lie about where the latency went: the person would see
 * a typing animation for text that had already fully arrived. The rail shows real
 * progress or it shows none.
 */
export async function runAgentChatTurn(input: {
  userId: string;
  message: string;
  conversationId?: string | null;
  vaultOwnerToken: string;
  pkmContext?: string;
  screenContext?: Record<string, unknown> | null;
  runtimeCredential?: string | null;
  runtimeCredentialMode?: string | null;
  runtimeCredentialTransport?: "developer_api" | "vertex_api_key" | null;
  runtimeVertexProject?: string | null;
  runtimeVertexLocation?: string | null;
  /** The visible transcript, oldest first; a pod turn is stateless without it. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  delegateAgentId?: string | null;
  delegateResult?: Record<string, unknown>;
  signal?: AbortSignal;
  handlers?: AgentChatStreamHandlers;
  /** The person's pod address, when they have one. Absent means "no pod": use the hub. */
  podHushhId?: string | null;
  /** Whether the pod status has been read at least once. `false` means unknown. */
  podResolved?: boolean;
  /** Re-read the caller's latest pod address; supplied by the surface that polls. */
  readPodAddress?: () => { hushhId: string | null; state: string | null; resolved: boolean };
  /** Their pod's lifecycle state. Only `active` is answerable. */
  podState?: string | null;
}): Promise<AgentTurnResult> {
  // WAIT rather than assume. `podState === null` is "we have not looked yet" AND
  // "this person has no agent"; treating it as the second sent a fast typer's
  // opening message to the shared hub while their own pod sat idle, and nothing on
  // screen said so. `podResolved` distinguishes them: until the status endpoint has
  // answered once, hold the turn briefly instead of routing it away from the pod.
  // Bounded, because a person with no agent must still be able to talk: past the
  // ceiling the hub answers, which is the correct destination for them.
  if (input.podResolved === false) {
    await waitForPodVerdict(input);
  }
  const podIsAnswerable = Boolean(input.podHushhId) && input.podState === "active";
  if (!podIsAnswerable) {
    const streamed = await streamAgentChat(input);
    return { ...streamed, cell: "hub" };
  }

  const handlers = input.handlers ?? {};
  const conversationId = input.conversationId || "";
  try {
    const turn = await ApiService.runPodTurn({
      hushhId: String(input.podHushhId),
      message: input.message,
      conversationId: input.conversationId || undefined,
      timezone: resolveBrowserTimeZone(),
      runtimeCredential: input.runtimeCredential,
      runtimeCredentialTransport: input.runtimeCredentialTransport || undefined,
      vertexProject: input.runtimeVertexProject,
      vertexLocation: input.runtimeVertexLocation,
      // The owner's own consented projection, decrypted on their device. This is what
      // makes a pod turn grounded WITHOUT the pod holding PKM or reaching a database.
      pkmContext: input.pkmContext,
      history: input.history,
      signal: input.signal,
    });

    handlers.onStart?.({ conversationId, model: turn.model });
    if (turn.text) handlers.onToken?.(turn.text);
    handlers.onComplete?.({ conversationId, model: turn.model });
    return {
      conversationId: input.conversationId ?? null,
      model: turn.model,
      text: turn.text,
      cell: "pod",
      grounded: turn.grounded,
    };
  } catch (error) {
    // The three typed failures `runPodTurn` raises are about THIS person's pod, and
    // each has a different remedy. Falling back to the hub would answer them anyway and
    // hide the fault -- the person would believe their pod served a turn it never saw,
    // which is the "200 on an empty page" failure this codebase argues against
    // everywhere else. Surface it and let the caller decide.
    const message = error instanceof Error ? error.message : "AGENT_UNREACHABLE";
    handlers.onError?.(message);
    throw error;
  }
}
