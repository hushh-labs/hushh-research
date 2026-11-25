import { legacyCalendarProposalPayload } from "@/lib/agent/calendar-proposal-review";
import type { MeetingSelection } from "@/lib/services/calendar-insights-service";
import type { AgentPkmCaptureStatus } from "@/lib/agent/agent-pkm-capture-runtime";
import type {
  EmailDeliveryHistoryItem,
} from "@/components/agent/email-delivery-history-card";
import { parseEmailDraftToolResult, type GmailSendReadiness } from "@/lib/agent/email-draft-tool-result";
import {
  scopeItemFromPendingConsent,
  type ConsentScopeItem,
} from "@/lib/consent/consent-scope-items";
import {
  normalizePendingConsentCardStatus,
  type OneStreamEventItem,
  type OneStreamEventKind,
  type OneStreamEventStatus,
  type PendingConsentCardStatus,
  type SpecialistConsentActionItem,
  type SpecialistPendingConsentRequestItem,
} from "@/components/agent/specialist-directive-card";
import {
  connectorBrandForTool,
  agentActivityIconForTool,
  isRoutineReadinessTool,
  type AgentVisibleStreamEvent,
  type AgentVisibleStreamStatus,
} from "@/components/agent/agent-turn-stream-panel";
import type { DriveCompilationUiState } from "@/lib/agent/drive-batch-progress";
import { foldSubmittedRequestReceipts } from "@/lib/agent/consent-continuation";
import { wireOutcomeForSentLabel } from "@/lib/consent/open-granted-person-information";
import { parseChatTimestamp } from "@/lib/agent/chat-time-separators";
import { parseAgentActivityExperience, type AgentStructuredExperience, type AgentStructuredExperienceWithPresentation } from "@/lib/agent/agui-structured-experiences";
import type { AgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import { parseStoredTextAttachments, type AgentTextAttachment } from "@/lib/agent/large-text-attachment";
import type { QueuedAgentPrompt } from "@/lib/agent/agent-chat-prompt-queue";
import type { AgentMessageReaction } from "@/lib/agent/agent-message-reaction";
import type { McpReviewActivityOutcome } from "@/components/agent/mcp-call-review-card";
import type { PendingConsent } from "@/lib/consent/use-consent-actions";
import { ConsentCenterService, type PendingConsentLookupItem } from "@/lib/services/consent-center-service";
import { trackEvent } from "@/lib/observability/client";
import { getAgentThoughtSummary } from "@/lib/agent/agent-thought-summary-store";
import { OwnerPodError } from "@/lib/services/owner-pod-crypto";
import {
  AGENT_CHAT_STREAM_LOST_ERROR,
  AgentChatStreamLostError,
  getLostAgentTurnOutcome,
  parseRestoredTurnActivity,
  type AgentChatConsentAccess,
  type AgentChatMessage as StoredAgentChatMessage,
  type AgentChatToolEvent,
  type AgentSource,
  type PendingEmailDraftContext,
  type SpecialistDirectiveEvent,
} from "@/lib/services/agent-chat-client";
import type { EmailDraft } from "@/lib/services/email-delivery-service";
import type { WalletCardSecrets, WalletCardSummary } from "@/lib/services/wallet-service";
import type { KeptSecretRef } from "@/components/secrets/secret-capture-card";

// Every memory capture job ends. Automatic and explicit captures both use
// semantic preparation; an explicit owner save may pause and resume.
export const AGENT_PKM_CAPTURE_DEADLINE_MS = 4 * 60_000;
export const AGENT_PKM_EXPLICIT_SAVE_DEADLINE_MS = 8 * 60_000;

export type AgentMessage = {
  id: string;
  calendarMeeting?: MeetingSelection;
  presentation?: "calendar";
  liveFinancePreview?: boolean;
  /**
   * The server's id for this answer (ADK event id), set when the run's closing
   * snapshot arrives. Ratings key on this, so a thumbs given during the live
   * turn matches the same reply after a reload and joins to its turn.
   */
  serverMessageId?: string;
  role: "user" | "assistant";
  text: string;
  /** Pasted text sent with a user turn: rendered as a chip, never as `text`. */
  attachments?: AgentTextAttachment[];
  timestamp: string;
  /**
   * When the message was sent or created (epoch ms): the live send moment or
   * the restored row's `created_at`. Absent when unknown; never guessed.
   */
  sentAtMs?: number;
  status?: "streaming" | "done" | "error";
  ephemeral?: boolean;
  restoredFromHistory?: boolean;
  memoryCapture?: AgentPkmCaptureStatus;
  receiptPrivate?: {
    ownerId: string;
    vaultEpoch: number;
    conversationId: string | null;
    expiresAt: number;
    liveFinancePreview?: boolean;
    presentation?: "calendar";
    kind?: "portfolio";
  };
  receiptRedacted?: boolean;
  kind?: "selection";
  /** Sent while One was working and taken into that reply at its next step. */
  queuedPlacement?: "joined";
  /** Session-only source handle for the owner-selected Gmail KYC request. */
  gmailInformationRequestWorkflowId?: string;
  // Calendar proposal status is already a bounded confirmation/result. Keep
  // that one message on the regular assistant surface instead of wrapping it
  // in the generic turn stream panel.
  renderAsPlainAssistantMessage?: boolean;
  specialistDirective?: SpecialistDirectiveEvent | null;
  streamEvents?: AgentVisibleStreamEvent[];
  sources?: AgentSource[];
  structuredExperience?: AgentStructuredExperience | null;
  structuredExperiences?: AgentStructuredExperienceEntry[];
  driveCompilation?: DriveCompilationUiState;
  /** Provider-authored thought summary (`husshThoughtSummary: true`) when generated. */
  thinkingSummary?: string;
  /** True while the model is actively streaming thought summary chunks. */
  isThinkingStreaming?: boolean;
  /** Why a partial answer stopped, shown below the text that did arrive. */
  errorNotice?: string;
  /** The stream was lost, not the turn: Retry checks history before resending. */
  lostTurn?: AgentLostTurn;
  /** One's 2-3 next questions for this answer; in memory only, shown while it is latest. */
  followUps?: string[];
  reaction?: AgentMessageReaction | null;
  /**
   * The information request this outcome chip or continuation answer belongs
   * to. Set live when the turn starts; restored from history metadata
   * (`metadata.consentBundleId`) when the server tags it.
   */
  consentBundleId?: string;
  /** The outcome chip's words for the person; the message text stays the fixed sent label. */
  consentChipText?: string;
  /** The server already hid this answer because the sharing it used ended. */
  consentAccessEnded?: boolean;
  /** Whose shared information this answer used (`metadata.consentAccess`), names and labels only. */
  consentAccess?: AgentChatConsentAccess;
};

export type AgentLostTurn = { conversationId: string; startedAtMs: number };

/** Replace only this answer; independent consent and delivery receipts survive. */
export function replaceAssistantResponse(
  messages: AgentMessage[],
  messageId: string,
  replacement: AgentMessage,
): AgentMessage[] {
  const index = messages.findIndex(message => message.id === messageId && message.role === "assistant");
  if (index < 0) return [...messages, replacement];
  return messages.map((message, position) => position === index ? replacement : message);
}

export type ResponseRetryGuard = {
  messageId: string;
  busy: boolean;
  emailDeliveries?: readonly Pick<EmailDeliveryTimelineItem, "anchorMessageId" | "status">[];
};

export function canRetryResponse(input: ResponseRetryGuard): boolean {
  return !input.busy && !input.emailDeliveries?.some(item => item.status === "sending" ||
    (item.anchorMessageId === input.messageId && item.status === "outcome_unknown"));
}

/** Retire proposals, never operations or another response's presentation. */
export function retireRetriedResponsePresentation(input: ResponseRetryGuard & {
  specialistMessageId?: string | null;
  emailDraftMessageId: string | null;
  retireSpecialist: () => void;
  retireEmailDraft: () => void;
}): boolean {
  if (!canRetryResponse(input)) return false;
  if (input.specialistMessageId === input.messageId) input.retireSpecialist();
  if (input.emailDraftMessageId === input.messageId) input.retireEmailDraft();
  return true;
}

export const EMPTY_CONSENT_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({});

/** How a follow-up turn ended; a consent answer another device already gave is settled, not failed. */
export type FollowUpTurnResult = "answered" | "continued_elsewhere" | "failed";

/** Short inline notice under a partial answer whose connection was lost. */
export const AGENT_PARTIAL_ANSWER_LOST_NOTICE = "Connection lost before One finished.";

/**
 * Settle an assistant bubble as failed. With no text yet the reason is the
 * message; with a partial answer the text stays and the reason shows as a
 * short notice below it, so the person knows why it stopped. Idempotent: the
 * stream's error callback and the thrown error both land here for one failure.
 */
export function settleAssistantMessageError<T extends AgentMessage>(
  current: T,
  reason: string,
  error?: unknown,
): T {
  const lostTurn = error instanceof AgentChatStreamLostError
    ? { conversationId: error.conversationId, startedAtMs: error.startedAtMs }
    : current.lostTurn;
  if (current.status === "error") return lostTurn ? { ...current, lostTurn } : current;
  const safeReason =
    error instanceof OwnerPodError ||
    /^(?:POD_DIRECT_UNAVAILABLE:|SELF_ENROLL_FAILED:|POD_ENROLLMENT_REQUIRES_OWNER_SESSION$|POD_ADMISSION_REFUSED:|BINDING_UNAVAILABLE:|ENDPOINT_UNAVAILABLE:)/.test(
      reason,
    )
      ? "Your private agent could not be reached from this browser session. Check Hosting settings and try again."
      : reason;
  const partial = current.text.trim().length > 0;
  return {
    ...current,
    text: partial ? current.text : safeReason,
    ...(partial
      ? {
          errorNotice:
            safeReason === AGENT_CHAT_STREAM_LOST_ERROR
              ? AGENT_PARTIAL_ANSWER_LOST_NOTICE
              : safeReason,
        }
      : {}),
    ...(lostTurn ? { lostTurn } : {}),
    status: "error",
    isThinkingStreaming: false,
    streamEvents: settleVisibleStreamEvents(current.streamEvents, "error"),
  };
}

export type LostTurnRetryPlan = "rerun" | "restore" | "reattach";

/**
 * Before a lost turn is sent again, ask history where it stands: an answer the
 * server already saved is shown ("restore"), a turn still running is waited on
 * ("reattach"), and only a turn that never finished is sent again ("rerun").
 * An unreadable history falls back to today's resend.
 */
export async function planLostTurnRetry(input: {
  lostTurn: AgentLostTurn | undefined;
  retryText: string;
  vaultOwnerToken: string | null;
  vaultKey: string | null;
}): Promise<LostTurnRetryPlan> {
  if (!input.lostTurn || !input.vaultOwnerToken || !input.vaultKey) return "rerun";
  try {
    const outcome = await getLostAgentTurnOutcome({
      conversationId: input.lostTurn.conversationId,
      userMessage: input.retryText,
      vaultOwnerToken: input.vaultOwnerToken,
      vaultKey: input.vaultKey,
    });
    return outcome === "answered" ? "restore" : outcome === "pending" ? "reattach" : "rerun";
  } catch {
    return "rerun";
  }
}

export type AgentStructuredExperienceEntry = {
  id: string;
  experience: AgentStructuredExperienceWithPresentation;
};

/**
 * Upsert a transport-identified AGUI card without silently dropping earlier
 * cards from the same turn. The server may emit several distinct activities;
 * only a repeated identity is a revision of an existing card.
 */
export function upsertAgentStructuredExperience(
  current: readonly AgentStructuredExperienceEntry[],
  id: string,
  experience: AgentStructuredExperienceWithPresentation,
): AgentStructuredExperienceEntry[] {
  const existingIndex = current.findIndex((entry) => entry.id === id);
  if (existingIndex < 0) {
    return [...current, { id, experience }];
  }
  return current.map((entry, index) =>
    index === existingIndex ? { id, experience } : entry,
  );
}

export type EmailDeliveryTimelineItem = EmailDeliveryHistoryItem & {
  anchorMessageId: string | null;
};

export type AgentDebugEvent = {
  id: string;
  turnId: string;
  timestamp: string;
  event: string;
  payload: unknown;
};

export type QueuedWorkspaceOperation = {
  id: string;
  prompt?: QueuedAgentPrompt;
  /** Receives the operation as it is when dequeued, so an edited prompt sends its edit. */
  run: (current: QueuedWorkspaceOperation) => Promise<void>;
};

export function upsertVisibleStreamEvent(
  events: AgentVisibleStreamEvent[] | undefined,
  event: AgentVisibleStreamEvent,
): AgentVisibleStreamEvent[] {
  const current = events ?? [];
  const existingIndex = current.findIndex((item) => item.id === event.id);
  if (existingIndex >= 0) {
    const prior = current[existingIndex]!;
    return current.map((item, index) =>
      index === existingIndex ? {
        ...event,
        createdAtMs: prior.createdAtMs,
        ...(event.status !== "running"
          ? { durationMs: Math.max(0, event.createdAtMs - prior.createdAtMs) }
          : {}),
      } : item,
    );
  }
  return [...current, event].slice(-10);
}

export function settleVisibleStreamEvents(
  events: AgentVisibleStreamEvent[] | undefined,
  status: Extract<AgentVisibleStreamStatus, "done" | "blocked" | "error">,
): AgentVisibleStreamEvent[] {
  return (events ?? []).map((event) => {
    if (event.status !== "running") return event;
    if (event.batchProgress) {
      return {
        ...event,
        status: status === "error" ? "error" as const : "blocked" as const,
        message: "Document batch stopped before completion.",
      };
    }
    return {
      ...event,
      status,
      durationMs: Math.max(0, Date.now() - event.createdAtMs),
    };
  });
}

/**
 * A browser review failure has no server tool-result event to replace its
 * Activity rows. Settle only the opaque ids that emitted this review, never a
 * different pending call, and never promise that a post-receipt result did not
 * reach the provider.
 */
export function settleMcpReviewActivity(
  events: AgentVisibleStreamEvent[] | undefined,
  activityIds: readonly string[] | undefined,
  outcome: McpReviewActivityOutcome,
): AgentVisibleStreamEvent[] | undefined {
  if (!events || !activityIds?.length) return events;
  const ids = new Set(activityIds);
  const presentation: Record<McpReviewActivityOutcome, {
    status: Extract<AgentVisibleStreamStatus, "blocked" | "error">;
    tag: string;
    message: string;
  }> = {
    unavailable: {
      status: "error",
      tag: "Unavailable",
      message: "Connector review unavailable. No change was sent.",
    },
    expired: {
      status: "blocked",
      tag: "Expired",
      message: "Review expired. No change was sent.",
    },
    unknown: {
      status: "error",
      tag: "Check status",
      message: "Connector outcome could not be verified. Check the connector before trying again.",
    },
  };
  const next = presentation[outcome];
  return events.map((event) =>
    ids.has(event.id) && (event.status === "running" || event.status === "waiting")
      ? {
          ...event,
          ...next,
          durationMs: Math.max(0, Date.now() - event.createdAtMs),
        }
      : event,
  );
}

export function stopDriveCompilationProgress(
  events: AgentVisibleStreamEvent[] | undefined,
): AgentVisibleStreamEvent[] | undefined {
  return events?.map((event) => event.batchProgress && event.status === "running"
    ? { ...event, status: "blocked" as const,
        message: "Document batch stopped before completion." }
    : event);
}

export function clearDriveCompilationFromMessages(messages: AgentMessage[]): AgentMessage[] {
  if (!messages.some((message) => message.driveCompilation)) return messages;
  return messages.map((message) => message.driveCompilation
    ? { ...message, driveCompilation: undefined,
        streamEvents: stopDriveCompilationProgress(message.streamEvents) }
    : message);
}

/**
 * Inline secure card widget in the chat surface. The decrypted values live
 * only in this client state; they are never written into messages, model
 * context, history, or telemetry.
 */
export type AgentWalletWidget =
  | { id: string; kind: "add" }
  /** Secrets the device guard kept from an outgoing turn: ids and labels only. */
  | { id: string; kind: "secrets"; items: KeptSecretRef[] }
  | { id: string; kind: "list"; summaries: WalletCardSummary[] }
  | {
      id: string;
      kind: "reveal";
      summary: WalletCardSummary;
      secrets: WalletCardSecrets;
    };

export type AgentTurnSource = "typed";
export type AgentRunTurnOptions = {
  source: AgentTurnSource;
  calendarMeeting?: MeetingSelection;
  timeZoneOverride?: string;
  personSelectionHandle?: string;
  gmailInformationRequestWorkflowId?: string;
  driveSearchSelection?: { jobId: string; position: number };
  kycInformationSaveConfirmed?: boolean;
  appendUserMessage?: boolean;
  reactionUserMessageId?: string;
  replaceAssistantMessageId?: string | null;
  deferPkmContext?: boolean;
  /** Pasted text sent as separate document parts beside the typed text. */
  attachments?: AgentTextAttachment[];
  /**
   * Queued messages sent together as this one turn, in order. Each shows as
   * its own bubble; the first one's id identifies the turn's message.
   */
  queuedPrompts?: QueuedAgentPrompt[];
};

export type ConsentRequiredDirectivePayload = {
  kind: "consent_required";
  agentId?: string;
  requiredScope?: string;
  reason?: string;
};

export type ConsentActionsDirectivePayload = {
  kind: "consent_actions";
  items: SpecialistConsentActionItem[];
};

export type PendingConsentRequestDirectivePayload = {
  kind: "pending_consent_request";
  item: SpecialistPendingConsentRequestItem;
};

export type OneStreamEventDirectivePayload = {
  kind: "one_stream_event";
  item: OneStreamEventItem;
};

/**
 * Which agent this workspace is showing.
 *
 * Two agents, two transcripts, never one. Puppy One answers on the owner's own
 * machine with its own model and its own memory; One answers in the cloud.
 * Merging their turns would leave a transcript that cannot say where any given
 * answer came from, which is the one thing this surface must always be able to
 * say (`docs/architecture/ai/puppy-one-on-device.md`). So this switches which
 * transcript is on screen and nothing else: no message, no conversation and no
 * history row ever crosses between them.
 */
export type AgentChatSurface = "one" | "puppy";

export type AgentChatWorkspaceProps = {
  className?: string;
};

export const AGENT_GREETING =
  "Hi, I'm Agent One. Ask me about your markets, portfolio, memories, or consent workflows.";
export const AGENT_GREETING_TIMESTAMP = "Just now";
export const EMPTY_PKM_CONTEXT: AgentPkmContext = {
  text: "",
  domains: [],
  totalAttributes: 0,
  updatedAt: null,
};
// Sent to One when memory.md could not be read, so it never claims nothing is saved.
export const MEMORY_UNAVAILABLE_FOR_TURN = "memory.md status: could not be read for this turn; its contents are unknown, not empty.";

export function toPkmFactCountBucket(
  count: number,
): "none" | "1_9" | "10_49" | "50_249" | "250_plus" {
  if (count <= 0) return "none";
  if (count < 10) return "1_9";
  if (count < 50) return "10_49";
  if (count < 250) return "50_249";
  return "250_plus";
}

/** Ambient capture is silent in chat; its failures stay countable here. */
export function trackAmbientPkmCaptureFailure(): void {
  trackEvent("agent_pkm_save_confirmation_completed", {
    route_id: "agent", result: "error", saved_count_bucket: toPkmFactCountBucket(0),
    failed_count_bucket: toPkmFactCountBucket(1), has_active_recipients: false,
  });
}

export function isSilentMemoryToolEvent(event: AgentChatToolEvent): boolean {
  return event.actionId === "pkm.add" || event.raw?.toolName === "add_to_pkm";
}

export const AGENT_STREAM_RENDER_FRAME_MS = 16;

export function getConsentRequiredPayload(
  event: SpecialistDirectiveEvent | null,
): ConsentRequiredDirectivePayload | null {
  if (!event || event.directive.kind !== "prompt") return null;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "consent_required") return null;
  return {
    kind: "consent_required",
    agentId:
      typeof payload.agentId === "string"
        ? payload.agentId
        : event.delegateAgentId,
    requiredScope:
      typeof payload.requiredScope === "string" ? payload.requiredScope : "",
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
  };
}

export function getGmailEmailDraftPayload(
  event: AgentChatToolEvent | null,
): { instruction: string; driveFileId: string | null; initialDraft: EmailDraft | null; gmailSend: GmailSendReadiness | null } | null {
  if (!event || event.raw.toolName !== "open_gmail_email_draft") return null;
  // A refusal opens no card; an event without a result (an older server) still does.
  const result = parseEmailDraftToolResult(event.raw.result);
  if (result && result.status !== "draft_opened") return null;
  const instruction = typeof event.slots.request === "string" ? event.slots.request.trim() : "";
  const driveFileId = typeof event.slots.drive_file_id === "string" ? event.slots.drive_file_id.trim() : "";
  const draftField = (name: "to" | "cc" | "bcc" | "subject" | "body", limit: number) => {
    // Recipients the server resolved win over the model's arguments.
    const value = result?.envelope && name !== "subject" && name !== "body" ? result.envelope[name] : event.slots[name];
    return typeof value === "string" && value.trim().length <= limit ? value.trim() : "";
  };
  const body = draftField("body", 12_000);
  const initialDraft = {
    to: draftField("to", 2_048),
    cc: draftField("cc", 2_048),
    bcc: draftField("bcc", 2_048),
    subject: draftField("subject", 512),
    body,
  };
  return instruction
    ? {
        instruction,
        driveFileId: driveFileId && driveFileId.length <= 256 ? driveFileId : null,
        initialDraft: Object.values(initialDraft).some(Boolean) ? initialDraft : null,
        gmailSend: result?.gmailSend ?? null,
      }
    : null;
}

/**
 * The draft card as the person sees it, for the next chat turn. A source-bound
 * reply shows its server-derived envelope, so that is what One is told too.
 */
export function buildPendingEmailDraftContext(
  draft: EmailDraft | null,
  sourceBoundEnvelope: { to: string; subject: string } | null,
  sourceBound: boolean,
): PendingEmailDraftContext | null {
  if (!draft) return null;
  const context: PendingEmailDraftContext = {
    to: (sourceBound ? sourceBoundEnvelope?.to ?? "" : draft.to).trim(),
    cc: sourceBound ? "" : draft.cc.trim(),
    bcc: sourceBound ? "" : draft.bcc.trim(),
    subject: (sourceBound ? sourceBoundEnvelope?.subject ?? "" : draft.subject).trim(),
    body: draft.body.trim(),
    sourceBound,
  };
  if (!sourceBound && draft.driveFileId) context.driveFileId = draft.driveFileId;
  return context.body || context.to || context.subject ? context : null;
}

export function getGmailInformationRequestReplyPayload(
  event: AgentChatToolEvent | null,
): { body: string } | null {
  if (!event || event.raw.toolName !== "open_gmail_information_request_reply") return null;
  const body = typeof event.slots.body === "string" ? event.slots.body.trim() : "";
  return body && body.length <= 12_000 ? { body } : null;
}

export function getCalendarDirectiveFromToolEvent(
  event: AgentChatToolEvent | null,
): SpecialistDirectiveEvent | null {
  if (!event) return null;
  const toolName = String(event.raw?.toolName || "");
  const rawResult = event.raw?.result;
  let parsed: Record<string, unknown> | null = null;
  if (typeof rawResult === "string") {
    try {
      parsed = JSON.parse(rawResult) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  } else if (rawResult && typeof rawResult === "object") {
    parsed = rawResult as Record<string, unknown>;
  }

  if (!parsed) return null;

  // 1. Explicit directive in tool result
  const rawDirective = parsed.directive as Record<string, unknown> | undefined;
  if (
    rawDirective &&
    rawDirective.delegateAgentId === "agent_calendar" &&
    rawDirective.payload &&
    typeof rawDirective.payload === "object"
  ) {
    const payload = rawDirective.payload as Record<string, unknown>;
    return {
      delegateAgentId: "agent_calendar",
      directive: {
        kind: rawDirective.kind === "prompt" ? "prompt" : "action",
        payload,
      },
      message: String(payload.summary || parsed.message || ""),
      stateChanged: true,
    };
  }

  // 2. Fallback: confirmation_required from calendar proposal tools
  if (
    (parsed.status === "confirmation_required" ||
      toolName === "propose_calendar_event" ||
      toolName === "propose_calendar_reschedule" ||
      toolName === "propose_calendar_cancellation") &&
    typeof parsed.proposal_id === "string" &&
    parsed.proposal_id
  ) {
    const action = toolName === "propose_calendar_cancellation" ? "cancel" :
      toolName === "propose_calendar_reschedule" ? "reschedule" : "create";
    const payload = legacyCalendarProposalPayload(parsed, action);
    return {
      delegateAgentId: "agent_calendar",
      directive: { kind: "action", payload },
      message: String(parsed.message || payload.summary || ""),
      stateChanged: true,
    };
  }

  // 3. Fallback: connection_required
  if (
    parsed.status === "connection_required" &&
    (toolName.startsWith("calendar_") || toolName.startsWith("propose_calendar_"))
  ) {
    return {
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: {
          type: "calendar.connect",
          accessLevel: "manage",
          summary: String(parsed.message || "Connect Google Calendar"),
          confirmLabel: "Allow Calendar scheduling",
        },
      },
      message: String(parsed.message || "Connect Google Calendar"),
      stateChanged: true,
    };
  }

  return null;
}

export function getConsentActionsPayload(
  event: SpecialistDirectiveEvent | null,
): ConsentActionsDirectivePayload | null {
  if (!event || event.directive.kind !== "prompt") return null;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "consent_actions") return null;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems
    .map((item) =>
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : null,
    )
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      label: typeof item.label === "string" ? item.label : "Approved access",
      summary: typeof item.summary === "string" ? item.summary : null,
      scope: typeof item.scope === "string" ? item.scope : null,
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : null,
      status: typeof item.status === "string" ? item.status : null,
      metadata:
        item.metadata && typeof item.metadata === "object"
          ? (item.metadata as Record<string, unknown>)
          : null,
      actions: normalizeConsentActions(item),
    }))
    .filter((item) => item.id && item.actions.length > 0);
  return { kind: "consent_actions", items };
}

export function pendingConsentScopeItemFromUnknown(
  value: unknown,
): ConsentScopeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const domainKey =
    typeof raw.domainKey === "string" ? raw.domainKey.trim() : "";
  const domainLabel =
    typeof raw.domainLabel === "string" ? raw.domainLabel.trim() : "";
  if (!id || !label || !domainKey || !domainLabel) return null;
  const pathSegments = Array.isArray(raw.pathSegments)
    ? raw.pathSegments.filter(
        (segment): segment is string =>
          typeof segment === "string" && Boolean(segment.trim()),
      )
    : [];
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const badge = typeof raw.badge === "string" ? raw.badge : null;
  return {
    id,
    label,
    description,
    domainKey,
    pathSegments,
    domainLabel,
    badge,
    disabled: raw.disabled === true,
    searchText:
      typeof raw.searchText === "string"
        ? raw.searchText
        : [label, description, domainKey, domainLabel]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
  };
}

/**
 * Re-reads a pending consent card item out of the directive payload it was
 * embedded in. The card item is stored as an untyped payload, so every field
 * the card or the approve handler needs has to be carried through here; a
 * field dropped at this hop is dropped for good, however faithfully the
 * mappers before it copied it.
 *
 * Bundle metadata is presentation-only and is retained as sanitized
 * descriptors. Live approval still re-looks up every request id, so restored
 * card payloads cannot grant access from stale transcript data.
 */
export function getPendingConsentRequestPayload(
  event: SpecialistDirectiveEvent | null,
): PendingConsentRequestDirectivePayload | null {
  if (!event || event.directive.kind !== "prompt") return null;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "pending_consent_request") return null;
  const rawItem =
    payload.item && typeof payload.item === "object"
      ? (payload.item as Record<string, unknown>)
      : null;
  if (!rawItem) return null;
  const id = typeof rawItem.id === "string" ? rawItem.id.trim() : "";
  if (!id) return null;
  const status = normalizePendingConsentCardStatus(rawItem.status);
  return {
    kind: "pending_consent_request",
    item: {
      id,
      requesterLabel:
        typeof rawItem.requesterLabel === "string" &&
        rawItem.requesterLabel.trim()
          ? rawItem.requesterLabel
          : "An agent",
      requesterImageUrl:
        typeof rawItem.requesterImageUrl === "string"
          ? rawItem.requesterImageUrl
          : null,
      requesterWebsiteUrl:
        typeof rawItem.requesterWebsiteUrl === "string"
          ? rawItem.requesterWebsiteUrl
          : null,
      scope: typeof rawItem.scope === "string" ? rawItem.scope : "",
      scopeDescription:
        typeof rawItem.scopeDescription === "string"
          ? rawItem.scopeDescription
          : null,
      requestedAt:
        typeof rawItem.requestedAt === "number" ||
        typeof rawItem.requestedAt === "string"
          ? rawItem.requestedAt
          : null,
      approvalTimeoutAt:
        typeof rawItem.approvalTimeoutAt === "number" ||
        typeof rawItem.approvalTimeoutAt === "string"
          ? rawItem.approvalTimeoutAt
          : null,
      expiryHours:
        typeof rawItem.expiryHours === "number" ||
        typeof rawItem.expiryHours === "string"
          ? rawItem.expiryHours
          : null,
      reason: typeof rawItem.reason === "string" ? rawItem.reason : null,
      additionalAccessSummary:
        typeof rawItem.additionalAccessSummary === "string"
          ? rawItem.additionalAccessSummary
          : null,
      status,
      // Approve wraps the vault key to the requester's public key, which only
      // travels in metadata. This parser used to rebuild the item without it,
      // so the card handed the approve handler nothing to wrap.
      metadata:
        rawItem.metadata &&
        typeof rawItem.metadata === "object" &&
        !Array.isArray(rawItem.metadata)
          ? (rawItem.metadata as Record<string, unknown>)
          : null,
      bundleId:
        typeof rawItem.bundleId === "string" && rawItem.bundleId.trim()
          ? rawItem.bundleId.trim()
          : null,
      bundleLabel:
        typeof rawItem.bundleLabel === "string" && rawItem.bundleLabel.trim()
          ? rawItem.bundleLabel.trim()
          : null,
      bundleScopeCount:
        typeof rawItem.bundleScopeCount === "number" &&
        Number.isFinite(rawItem.bundleScopeCount)
          ? rawItem.bundleScopeCount
          : null,
      bundledRequestIds: Array.isArray(rawItem.bundledRequestIds)
        ? Array.from(
            new Set(
              rawItem.bundledRequestIds.filter(
                (requestId): requestId is string =>
                  typeof requestId === "string" && Boolean(requestId.trim()),
              ),
            ),
          )
        : [],
      bundledScopes: Array.isArray(rawItem.bundledScopes)
        ? rawItem.bundledScopes.flatMap((scope) => {
            const parsed = pendingConsentScopeItemFromUnknown(scope);
            return parsed ? [parsed] : [];
          })
        : [],
    },
  };
}

export function pendingConsentLookupItemToCardItem(
  item: PendingConsentLookupItem,
): SpecialistPendingConsentRequestItem | null {
  const id = String(item.request_id || "").trim();
  if (!id) return null;
  const requesterLabel =
    item.requester_label || item.agent_id || item.developer || "An agent";
  const metadata = item.metadata ?? null;
  const expiryHours = metadata?.expiry_hours;
  return {
    id,
    requesterLabel,
    requesterImageUrl: item.requester_image_url ?? null,
    requesterWebsiteUrl: item.requester_website_url ?? null,
    scope: item.scope || "",
    scopeDescription: item.scope_description ?? null,
    requestedAt: item.issued_at ?? null,
    approvalTimeoutAt: item.poll_timeout_at ?? null,
    expiryHours:
      typeof expiryHours === "number" || typeof expiryHours === "string"
        ? expiryHours
        : null,
    reason: item.reason ?? null,
    additionalAccessSummary: item.additional_access_summary ?? null,
    status: "pending",
    // Approve wraps the vault key to the requester's public key, which rides
    // in metadata. Dropping it here left handleApprove with nothing to wrap
    // and the backend refusing the approval as missing its wrapped key.
    metadata,
    // These three were being dropped here, which is why a fourteen-field
    // request rendered as fourteen unrelated cards: the wire said they were one
    // ask and the mapper threw that away.
    bundleId: item.bundle_id ?? null,
    bundleLabel: item.bundle_label ?? null,
    bundleScopeCount: item.bundle_scope_count ?? null,
    bundledRequestIds: [id],
    bundledScopes: [scopeItemFromPendingConsent(item)].filter(
      (scope): scope is NonNullable<typeof scope> => Boolean(scope),
    ),
  };
}

export function pendingConsentCardItemToPendingConsent(
  item: SpecialistPendingConsentRequestItem,
): PendingConsent {
  const requestedAt =
    typeof item.requestedAt === "number"
      ? item.requestedAt
      : Number(item.requestedAt || Date.now());
  const approvalTimeoutAt =
    item.approvalTimeoutAt == null || item.approvalTimeoutAt === ""
      ? undefined
      : Number(item.approvalTimeoutAt);
  const expiryHours =
    item.expiryHours == null || item.expiryHours === ""
      ? undefined
      : Number(item.expiryHours);
  return {
    id: item.id,
    developer: item.requesterLabel,
    developerImageUrl: item.requesterImageUrl || undefined,
    developerWebsiteUrl: item.requesterWebsiteUrl || undefined,
    scope: item.scope,
    scopeDescription: item.scopeDescription || undefined,
    requestedAt: Number.isFinite(requestedAt) ? requestedAt : Date.now(),
    approvalTimeoutAt:
      typeof approvalTimeoutAt === "number" &&
      Number.isFinite(approvalTimeoutAt)
        ? approvalTimeoutAt
        : undefined,
    expiryHours:
      typeof expiryHours === "number" && Number.isFinite(expiryHours)
        ? expiryHours
        : undefined,
    reason: item.reason || undefined,
    additionalAccessSummary: item.additionalAccessSummary || undefined,
    bundleId: item.bundleId || undefined,
    metadata: item.metadata ?? null,
  };
}

/**
 * The requests a pending consent card decides for: the head request first,
 * then every request folded into the card. A single-request card yields only
 * its own id, so that path is unchanged.
 */
export function pendingConsentCardRequestIds(
  item: SpecialistPendingConsentRequestItem,
): string[] {
  const ids = [item.id, ...(item.bundledRequestIds || [])]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

/**
 * The PendingConsents a card's Approve or Deny acts on.
 *
 * A folded card says "you decide together, once", so its buttons must answer
 * every request in it, not only the head one. The card carries the head
 * request's metadata only (the others were folded in by id and scope), and
 * Approve wraps the vault key to the key in each request's own metadata, so a
 * folded card looks every member up again and acts on whichever are still
 * pending. Single requests also revalidate current authority; retained card
 * metadata is presentation, never a substitute for the live request.
 */
export async function resolvePendingConsentCardTargets(input: {
  userId: string;
  vaultOwnerToken: string | null;
  item: SpecialistPendingConsentRequestItem;
}): Promise<PendingConsent[]> {
  const requestIds = pendingConsentCardRequestIds(input.item);
  if (!input.userId.trim() || !input.vaultOwnerToken?.trim()) {
    throw new Error("Unlock your vault first.");
  }
  // Notifications can arrive one item at a time. Never decide a partially
  // hydrated bundle and then label the whole request approved or denied.
  if (
    input.item.bundleId &&
    typeof input.item.bundleScopeCount === "number" &&
    input.item.bundleScopeCount > requestIds.length
  ) {
    throw new Error("This request is still loading. Review all its fields before deciding.");
  }
  // The owner-scoped lookup currently admits 25 IDs, while creation admits
  // up to 50. Failing closed prevents a truncated batch from being decided.
  if (requestIds.length > 25) {
    throw new Error("This request has too many fields for an inline decision.");
  }
  const result = await ConsentCenterService.lookupPendingRequests({
    userId: input.userId,
    vaultOwnerToken: input.vaultOwnerToken,
    requestIds,
  });
  const byId = new Map<string, SpecialistPendingConsentRequestItem>();
  for (const raw of result.items) {
    const card = pendingConsentLookupItemToCardItem(raw);
    if (card) byId.set(card.id, card);
  }
  const targets: PendingConsent[] = [];
  for (const id of requestIds) {
    const card = byId.get(id);
    if (card) targets.push(pendingConsentCardItemToPendingConsent(card));
  }
  return targets;
}

export function agentMessagePendingConsentRequestId(
  message: AgentMessage,
): string | null {
  const payload = getPendingConsentRequestPayload(
    message.specialistDirective ?? null,
  );
  return payload?.item.id ?? null;
}

/**
 * Keep consent cards that arrived while history was warming.
 *
 * Pending requests are owner-scoped live state, while the conversation
 * snapshot is an eventually-consistent transcript. A snapshot must not erase
 * a card that was just hydrated, and a newer local status (approve/deny) must
 * win over an older transcript copy. This merges only safe card descriptors;
 * it never merges decrypted information or replays an action.
 */
export function getOneStreamEventPayload(
  event: SpecialistDirectiveEvent | null,
): OneStreamEventDirectivePayload | null {
  if (!event || event.directive.kind !== "prompt") return null;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "one_stream_event") return null;
  const rawItem =
    payload.item && typeof payload.item === "object"
      ? (payload.item as Record<string, unknown>)
      : null;
  if (!rawItem) return null;
  const id = typeof rawItem.id === "string" ? rawItem.id.trim() : "";
  const eventKind = typeof rawItem.eventKind === "string" ? rawItem.eventKind : "";
  if (
    !id ||
    (eventKind !== "incoming_connection" &&
      eventKind !== "shared_access_unlocked" &&
      eventKind !== "commerce_settlement")
  ) {
    return null;
  }
  const statusRaw = typeof rawItem.status === "string" ? rawItem.status : "pending";
  const status: OneStreamEventStatus =
    statusRaw === "accepted" ||
    statusRaw === "declined" ||
    statusRaw === "acknowledged"
      ? statusRaw
      : "pending";
  return {
    kind: "one_stream_event",
    item: {
      id,
      eventKind: eventKind as OneStreamEventKind,
      actorLabel:
        typeof rawItem.actorLabel === "string" && rawItem.actorLabel.trim()
          ? rawItem.actorLabel
          : "Someone",
      actorPhotoUrl:
        typeof rawItem.actorPhotoUrl === "string" ? rawItem.actorPhotoUrl : null,
      headline:
        typeof rawItem.headline === "string" ? rawItem.headline : "Update",
      detail: typeof rawItem.detail === "string" ? rawItem.detail : null,
      href: typeof rawItem.href === "string" ? rawItem.href : null,
      requiresScopeReview: rawItem.requiresScopeReview === true,
      status,
    },
  };
}

export function markOneStreamEventDirectiveStatus(
  event: SpecialistDirectiveEvent | null | undefined,
  itemId: string,
  status: OneStreamEventStatus,
): SpecialistDirectiveEvent | null | undefined {
  if (!event || event.directive.kind !== "prompt") return event;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "one_stream_event") return event;
  const item =
    payload.item && typeof payload.item === "object"
      ? (payload.item as Record<string, unknown>)
      : null;
  if (!item || item.id !== itemId) return event;
  return {
    ...event,
    directive: {
      ...event.directive,
      payload: {
        ...payload,
        item: {
          ...item,
          status,
        },
      },
    },
  };
}

export function stagePendingConsentRequestDirectiveDuration(
  event: SpecialistDirectiveEvent | null | undefined,
  requestIds: readonly string[],
  expiryHours: number,
): SpecialistDirectiveEvent | null | undefined {
  if (!event || event.directive.kind !== "prompt") return event;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "pending_consent_request") return event;
  const item =
    payload.item && typeof payload.item === "object"
      ? (payload.item as Record<string, unknown>)
      : null;
  if (!item) return event;
  const targetSet = new Set(requestIds.map((id) => id.trim()).filter(Boolean));
  if (!targetSet.size) return event;
  const headId = typeof item.id === "string" ? item.id.trim() : "";
  const bundledIds = Array.isArray(item.bundledRequestIds)
    ? item.bundledRequestIds.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const matches =
    (headId && targetSet.has(headId)) ||
    bundledIds.some((entry) => targetSet.has(entry.trim()));
  if (!matches) return event;
  const existingMetadata =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : {};
  return {
    ...event,
    directive: {
      ...event.directive,
      payload: {
        ...payload,
        item: {
          ...item,
          expiryHours,
          metadata: {
            ...existingMetadata,
            staged_by_agent: true,
          },
        },
      },
    },
  };
}

export function insertMessageChronologically(
  messages: readonly AgentMessage[],
  candidate: AgentMessage,
): AgentMessage[] {
  const candidateMs =
    typeof candidate.sentAtMs === "number" && Number.isFinite(candidate.sentAtMs) && candidate.sentAtMs > 0
      ? candidate.sentAtMs
      : null;
  if (candidateMs === null || messages.length === 0) {
    return [...messages, candidate];
  }
  const next = [...messages];
  let insertAt = next.length;
  for (let i = 0; i < next.length; i += 1) {
    const existingMs = next[i]?.sentAtMs;
    if (
      typeof existingMs === "number" &&
      Number.isFinite(existingMs) &&
      existingMs > candidateMs
    ) {
      insertAt = i;
      break;
    }
  }
  next.splice(insertAt, 0, candidate);
  return next;
}

export function mergePendingConsentMessages(
  restored: AgentMessage[],
  current: readonly AgentMessage[],
): AgentMessage[] {
  let merged = [...restored];

  for (const candidate of current) {
    const payload = getPendingConsentRequestPayload(
      candidate.specialistDirective ?? null,
    );
    if (payload) {
      const candidateIds = new Set(pendingConsentCardRequestIds(payload.item));
      const existingIndex = merged.findIndex((message) => {
        const existing = getPendingConsentRequestPayload(
          message.specialistDirective ?? null,
        );
        if (!existing) return false;
        return pendingConsentCardRequestIds(existing.item).some((id) =>
          candidateIds.has(id),
        );
      });

      if (existingIndex >= 0) {
        merged[existingIndex] = candidate;
      } else {
        merged = insertMessageChronologically(merged, candidate);
      }
      continue;
    }

    const streamPayload = getOneStreamEventPayload(
      candidate.specialistDirective ?? null,
    );
    if (!streamPayload) continue;
    const existingStreamIndex = merged.findIndex((message) => {
      const existing = getOneStreamEventPayload(
        message.specialistDirective ?? null,
      );
      return existing?.item.id === streamPayload.item.id;
    });
    if (existingStreamIndex >= 0) {
      merged[existingStreamIndex] = candidate;
    } else {
      merged = insertMessageChronologically(merged, candidate);
    }
  }

  return merged;
}

/** The Undo toast's line for a decline from the chat card, as the Consent Center words it. */
export function declinedChatRequestMessage(requesterLabel: string): string {
  const first = requesterLabel.trim().split(/\s+/)[0];
  return first ? `Declined ${first}'s request.` : "Declined the request.";
}

export function markPendingConsentRequestDirectiveStatus(
  event: SpecialistDirectiveEvent | null | undefined,
  itemId: string,
  // "pending" puts a card back after Undo on a decline.
  status: PendingConsentCardStatus,
  expiryHoursOverride?: number,
): SpecialistDirectiveEvent | null | undefined {
  if (!event || event.directive.kind !== "prompt") return event;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "pending_consent_request") return event;
  const item =
    payload.item && typeof payload.item === "object"
      ? (payload.item as Record<string, unknown>)
      : null;
  if (!item) return event;
  const bundledIds = Array.isArray(item.bundledRequestIds)
    ? item.bundledRequestIds.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  if (item.id !== itemId && !bundledIds.includes(itemId)) return event;

  return {
    ...event,
    directive: {
      ...event.directive,
      payload: {
        ...payload,
        item: {
          ...item,
          status,
          ...(expiryHoursOverride !== undefined
            ? { expiryHours: expiryHoursOverride }
            : {}),
        },
      },
    },
  };
}

export function normalizeConsentActions(item: Record<string, unknown>): string[] {
  const rawActions = Array.isArray(item.actions)
    ? item.actions.filter(
        (action): action is string => typeof action === "string",
      )
    : [];
  const metadata =
    item.metadata && typeof item.metadata === "object"
      ? (item.metadata as Record<string, unknown>)
      : {};
  const id = typeof item.id === "string" ? item.id : "";
  const scope = typeof item.scope === "string" ? item.scope : "";
  const requestSource =
    typeof metadata.request_source === "string"
      ? metadata.request_source.trim()
      : "";
  const isLocationGrant =
    id.startsWith("one_location_grant:") ||
    requestSource === "one_location_share_grant" ||
    scope.startsWith("cap.location.");

  if (!isLocationGrant) {
    return rawActions;
  }

  const normalized = new Set(["revoke", ...rawActions, "details"]);
  return Array.from(normalized);
}

export function markConsentDirectiveItemRevoked(
  event: SpecialistDirectiveEvent | null | undefined,
  itemId: string,
): SpecialistDirectiveEvent | null | undefined {
  if (!event || event.directive.kind !== "prompt") return event;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "consent_actions" || !Array.isArray(payload.items))
    return event;

  let changed = false;
  const nextItems = payload.items.map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return rawItem;
    const item = rawItem as Record<string, unknown>;
    if (item.id !== itemId) return rawItem;

    changed = true;
    const rawActions = Array.isArray(item.actions) ? item.actions : [];
    const actions = rawActions.filter((action) => action !== "revoke");
    if (!actions.includes("details")) actions.push("details");
    const label = typeof item.label === "string" ? item.label : "This person";
    const summary = `${label} can no longer view your live location`;

    return {
      ...item,
      status: "revoked",
      summary,
      actions,
    };
  });

  if (!changed) return event;
  return {
    ...event,
    directive: {
      ...event.directive,
      payload: {
        ...payload,
        items: nextItems,
      },
    },
  };
}

export function formatNow(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

/** The label and the moment for a message created now, taken together. */
export function stampNow(): { timestamp: string; sentAtMs: number } {
  const sentAtMs = Date.now();
  return {
    timestamp: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(sentAtMs)),
    sentAtMs,
  };
}

export function createGreetingMessage(): AgentMessage {
  return {
    id: "agent-greeting",
    role: "assistant",
    text: AGENT_GREETING,
    timestamp: AGENT_GREETING_TIMESTAMP,
    status: "done",
  };
}

export function formatAgentDisplayName(
  displayName?: string | null,
  email?: string | null,
): string {
  const rawName = displayName?.trim() || email?.split("@")[0]?.trim() || "";
  const firstName = rawName
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .find(Boolean);
  if (!firstName) return "there";
  return firstName.charAt(0).toUpperCase() + firstName.slice(1);
}

// Safety-net for legacy DB rows written before Task 8 metadata was added.
// Those rows carry no metadata and their content is the raw recipient/duration
// seed "I selected: recipientUserId=…; … do not guess — and proceed."
// Matching them prevents the ugly id-dump from ever rendering as a user bubble.
// The shorter acknowledgement seeds ("Yes, go ahead.", "No, do not proceed.",
// "I changed my mind — cancel that, take no action.") are already human-readable
// and must NOT be reclassified — the pattern is intentionally narrow.
const LEGACY_SELECTION_SEED = /^I selected:.*do not guess/s;

export function storedMessageToAgentMessage(
  message: StoredAgentChatMessage,
  seenExperienceIds: Set<string> = new Set(),
): AgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const createdAt = restoredMessageTime(message.created_at);
  // A selection message must never re-render its raw `I selected:` seed on
  // reload: prefer the persisted display label and render it as a chip. The
  // backend (Task 3) guarantees metadata.display for new selection messages;
  // legacy rows without metadata are detected via LEGACY_SELECTION_SEED below.
  // The follow-up turn after an answer is sent as the server's fixed label
  // ("Consent approved"). It is a status chip, never the person's words, even
  // when the server did not mark it (it refused the continuation, or a retry
  // sent the label as a plain turn): the chip then names the request above it.
  const isConsentOutcomeLabel =
    message.role === "user" && wireOutcomeForSentLabel(message.content.trim()) !== null;
  const isSelection = message.metadata?.kind === "selection" || isConsentOutcomeLabel;
  // Detect legacy rows: user message with raw seed content and no usable metadata.
  const isLegacySelectionSeed =
    !isSelection &&
    message.role === "user" &&
    LEGACY_SELECTION_SEED.test(message.content);

  const displayText =
    isConsentOutcomeLabel
      ? message.content.trim()
      : isSelection && message.metadata?.display
      ? message.metadata.display
      : isLegacySelectionSeed
        ? "Your selection"
        : message.content;
  const descriptor = message.metadata?.structuredExperience;
  const restoredExperience =
    descriptor && typeof descriptor.activityType === "string"
      ? parseAgentActivityExperience(descriptor.activityType, descriptor.content)
      : null;
  const orderedExperiences = message.metadata?.structuredExperiences?.flatMap((entry, index) => {
    if (!entry || typeof entry.activityType !== "string") return [];
    const experience = parseAgentActivityExperience(entry.activityType, entry.content);
    return experience ? [{
      id: (typeof entry.id === "string" ? entry.id.trim() : "") ||
        `${message.id}:structured-experience:${index}`,
      experience,
    }] : [];
  });
  const candidates = orderedExperiences?.length ? orderedExperiences : restoredExperience
    ? [
        {
          id:
            (typeof message.metadata?.structuredExperienceId === "string"
              ? message.metadata.structuredExperienceId.trim()
              : "") ||
            `${message.id}:structured-experience`,
          experience: restoredExperience,
        },
      ]
    : [];
  const connectorRead =
    message.role === "assistant" ? message.metadata?.connectorRead : null;
  const structuredExperiences = [
    ...candidates,
    ...(connectorRead
      ? [
          {
            id: `${message.id}:connector-read`,
            experience: connectorRead,
          },
        ]
      : []),
  ].filter(entry => {
    if (seenExperienceIds.has(entry.id)) return false;
    seenExperienceIds.add(entry.id);
    return true;
  });
  // The same Activity rows the owner saw live, rebuilt from app-owned labels.
  const streamEvents: AgentVisibleStreamEvent[] = message.role === "assistant"
    ? parseRestoredTurnActivity(message.metadata?.turnActivity).map((step) => {
      // The same product mark the live row carried, from the same rule.
      const brand = connectorBrandForTool(step.toolName, step.provider) ?? step.provider;
      return {
        id: step.id,
        label: step.label,
        message: step.message,
        status: step.status,
        ...(step.tag ? { tag: step.tag } : {}),
        ...(brand ? { brand } : {}),
        icon: agentActivityIconForTool(step.toolName),
        ...(step.connectorId ? { connectorId: step.connectorId } : {}),
        ...(isRoutineReadinessTool(step.toolName) ? { routine: true as const } : {}),
        createdAtMs: createdAt?.getTime() ?? 0,
      };
    })
    : [];
  // Do not resurrect a duplicate through the legacy descriptor, or leave an
  // empty thinking bubble. Prose and all distinct cards retain source order.
  if (candidates.length && !structuredExperiences.length && !displayText.trim()) return null;
  // Pasted text restores as the chip it was sent as, never as expanded text.
  const attachments = message.role === "user"
    ? parseStoredTextAttachments(message.metadata?.attachments)
    : [];
  const restoredThinkingSummary =
    message.role === "assistant" &&
    message.status !== "error" &&
    !message.metadata?.consentBundleId &&
    !message.metadata?.consentAccessEnded
      ? getAgentThoughtSummary({
          conversationId: message.conversation_id,
          messageId: message.id,
        })
      : undefined;
  return {
    id: message.id,
    serverMessageId: message.role === "assistant" ? message.id : undefined,
    role: message.role,
    text: displayText,
    ...(restoredThinkingSummary ? { thinkingSummary: restoredThinkingSummary } : {}),
    ...(attachments.length ? { attachments } : {}),
    structuredExperience: connectorRead,
    timestamp:
      createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(createdAt)
        : formatNow(),
    ...(createdAt && !Number.isNaN(createdAt.getTime())
      ? { sentAtMs: createdAt.getTime() }
      : {}),
    status: message.status === "error" ? "error" : "done",
    ...(isSelection || isLegacySelectionSeed
      ? { kind: "selection" as const }
      : {}),
    ...(structuredExperiences.length ? { structuredExperiences } : {}),
    ...(streamEvents.length ? { streamEvents } : {}),
    ...(message.metadata?.consentBundleId ? { consentBundleId: message.metadata.consentBundleId } : {}),
    ...(message.metadata?.consentAccessEnded ? { consentAccessEnded: true } : {}),
    ...(message.metadata?.consentAccess ? { consentAccess: message.metadata.consentAccess } : {}),
    ...(message.role === "user" && message.metadata?.queuedInput === "joined"
      ? { queuedPlacement: "joined" as const }
      : {}),
  };
}

/**
 * History timestamps are ADK event times in epoch seconds; ISO strings are
 * accepted too. Reading seconds as milliseconds dated every restored turn to
 * January 1970, which rendered as a wrong clock time after returning to a chat.
 */
export function restoredMessageTime(value: unknown): Date | null {
  return parseChatTimestamp(value);
}

export const RESTORED_CONNECTOR_STEP_LABEL = "Connected tool";

/** Replace restored opaque connector rows with the owner's names; unchanged rows keep identity. */
export function labelRestoredConnectorSteps<T extends { streamEvents?: AgentVisibleStreamEvent[] }>(
  messages: T[],
  names: ReadonlyMap<string, string>,
): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (!message.streamEvents?.some((event) => event.connectorId &&
      event.label === RESTORED_CONNECTOR_STEP_LABEL && names.get(event.connectorId)?.trim())) return message;
    changed = true;
    return {
      ...message,
      streamEvents: message.streamEvents.map((event) => {
        const name = event.connectorId ? names.get(event.connectorId)?.trim() : undefined;
        return name && event.label === RESTORED_CONNECTOR_STEP_LABEL ? { ...event, label: name } : event;
      }),
    };
  });
  return changed ? next : messages;
}

export function storedMessagesToAgentMessages(messages: StoredAgentChatMessage[]): AgentMessage[] {
  const seenExperienceIds = new Set<string>();
  // A sent request comes back as a draft plus its Send receipt; fold them so
  // the card restores in place as sent, never as "Not sent yet".
  return foldSubmittedRequestReceipts(messages
    .map(message => storedMessageToAgentMessage(message, seenExperienceIds))
    .filter((message): message is AgentMessage => Boolean(message)));
}

export function agentMessagesToStoredMessages(
  messages: readonly AgentMessage[],
  conversationId: string,
): StoredAgentChatMessage[] {
  const result: StoredAgentChatMessage[] = [];
  for (const message of messages) {
    if (message.id === "agent-greeting") continue;
    const hasMetadata =
      Boolean(message.attachments?.length) ||
      message.kind === "selection" ||
      Boolean(message.consentBundleId) ||
      Boolean(message.consentAccessEnded) ||
      Boolean(message.consentAccess) ||
      message.queuedPlacement === "joined";
    const metadata: StoredAgentChatMessage["metadata"] = hasMetadata
      ? {
          ...(message.kind === "selection" ? { kind: "selection", display: message.text } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(message.consentBundleId ? { consentBundleId: message.consentBundleId } : {}),
          ...(message.consentAccessEnded ? { consentAccessEnded: true } : {}),
          ...(message.consentAccess ? { consentAccess: message.consentAccess } : {}),
          ...(message.queuedPlacement === "joined" ? { queuedInput: "joined" as const } : {}),
        }
      : undefined;
    const timestampIso =
      typeof message.sentAtMs === "number" && Number.isFinite(message.sentAtMs)
        ? new Date(message.sentAtMs).toISOString()
        : null;
    result.push({
      id: message.serverMessageId || message.id,
      conversation_id: conversationId,
      role: message.role,
      status: message.status === "error" ? "error" : "complete",
      content: message.text,
      created_at: timestampIso,
      completed_at:
        message.status === "done" || message.status === "error" ? timestampIso : null,
      ...(metadata ? { metadata } : {}),
    });
  }
  return result;
}
