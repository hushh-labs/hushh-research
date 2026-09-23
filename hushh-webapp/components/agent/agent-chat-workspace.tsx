"use client";

import { Capacitor } from "@capacitor/core";
import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AgentMemoryCaptureStatus } from "@/components/agent/agent-memory-capture-status";
import { aggregateAgentPkmCaptures, createAgentPkmCaptureGuard, describeAgentPkmCapture, isAgentPkmProcessingReady, type AgentPkmCaptureStatus } from "@/lib/agent/agent-pkm-capture-runtime";
import { AgentPersonSelectionContext } from "@/components/agent/agent-structured-experience";
import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  KeyRound,
  Laptop,
  LogIn,
  Maximize2,
  Mic,
  Minimize2,
  Pencil,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  X,
} from "@/components/icons";

import { usePuppyConversations } from "@/lib/agent/puppy-conversations";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { Button } from "@/components/ui/button";
import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import { ConnectorsPanel } from "@/components/agent/connectors-panel";
import {
  AgentConnectionsDrawer,
  type ConnectionsDrawerMode,
} from "@/components/agent/agent-connections-drawer";
import { SegmentedControl } from "@/lib/morphy-ux/ui/segmented-control";
import {
  mergeScopeItems,
  scopeItemFromPendingConsent,
  type ConsentScopeItem,
} from "@/lib/consent/consent-scope-items";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { EmailDraftCard } from "@/components/agent/email-draft-card";
import { richEmailPlainText } from "@/components/agent/email-rich-text";
import {
  EmailDeliveryHistoryCard,
  type EmailDeliveryHistoryItem,
} from "@/components/agent/email-delivery-history-card";
import { bucketEmailDeliveryTimelineItems } from "@/lib/agent/agent-chat-email-delivery-timeline";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AnimatedMenuCrossIcon } from "@/components/agent/animated-menu-cross-icon";
import { loadPkmAgentLabContext } from "@/lib/profile/pkm-agent-lab-capture";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import { SecureCardAddForm } from "@/components/wallet/secure-card-add-form";
import { SecureCardReveal } from "@/components/wallet/secure-card-reveal";
import {
  detectLikelyPan,
  redactLikelyPans,
} from "@/lib/wallet/pan-paste-guard";
import {
  WalletService,
  type WalletCardSecrets,
  type WalletCardSummary,
} from "@/lib/services/wallet-service";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";
import {
  CardNetworkMark,
  cardNetworkLabel,
} from "@/components/wallet/card-network-mark";
import {
  ModelPreferenceService,
  type ModelPreference,
} from "@/lib/services/model-preference-service";
import {
  SpecialistConsentActionsCard,
  SpecialistConsentRequiredCard,
  SpecialistDirectiveCard,
  SpecialistFreeTextPromptCard,
  SpecialistPendingConsentRequestCard,
  SpecialistPromptCard,
  normalizePendingConsentCardStatus,
  type PendingConsentCardStatus,
  type SpecialistConsentActionItem,
  type SpecialistPendingConsentRequestItem,
} from "@/components/agent/specialist-directive-card";
import { copyTextToClipboard } from "@/components/agent/chat-markdown-link";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { SelectionChip } from "@/components/agent/selection-chip";
import { PuppyOneSurface } from "@/components/agent/puppy-one-surface";
import {
  AgentTurnStreamPanel,
  agentToolEventToVisibleStreamEvent,
  type AgentVisibleStreamEvent,
  type AgentVisibleStreamStatus,
} from "@/components/agent/agent-turn-stream-panel";
import { describeSelection } from "@/lib/agent/describe-selection";
import { useEntryWelcome, type EntryWelcome } from "@/lib/agent/use-entry-welcome";
import {
  parseAgentActivityExperience,
  type AgentStructuredExperience,
  type AgentStructuredExperienceWithPresentation,
} from "@/lib/agent/agui-structured-experiences";
import {
  getWelcomePromptSetIndex,
  getWelcomePrompts,
} from "@/lib/agent/agent-welcome-prompts";
import type { ClientPrompt } from "@/lib/one-location/types";
import { AgentVoiceWaveInput } from "@/components/agent/agent-voice-wave-input";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { AvatarBubble } from "@/lib/morphy-ux/ui";
import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import {
  addToPKM,
  clearAgentPkmContext,
  getPkmConfirmationCards,
  getPkmAutoSaveCards,
  loadAgentPkmContext,
  peekAgentPkmContext,
  warmAgentPkmContext,
  type AgentPkmContext,
} from "@/lib/agent/agent-pkm-memory";
import { prepareNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
import {
  DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
  AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT,
  loadAgentPkmAutoSavePolicy,
  subscribeAgentPkmAutoSavePolicyInvalidation,
  type AgentPkmAutoSavePolicy,
} from "@/lib/agent/agent-pkm-auto-save-policy";
import {
  loadAgentChatConversationHistory,
  peekAgentChatHistoryCache,
  warmAgentChatHistoryCache,
} from "@/lib/agent/agent-chat-history-cache";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { isRiaAdvisoryAccessReady } from "@/lib/ria/ria-profile-view-model";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { toDurationBucket, trackEvent } from "@/lib/observability/client";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import {
  isAgentCommandEnabled,
  requestAgentConversation,
  requestAgentConversationStop,
} from "@/lib/agent/agent-voice-settings";
import {
  onContentScroll as onKaiBottomChromeScroll,
  snapKaiBottomChromeVisible,
} from "@/lib/navigation/kai-bottom-chrome-visibility";
import {
  deleteAgentChatConversation,
  renameAgentChatConversation,
  streamAgentChat,
  streamAgentIntro,
  type AgentChatConversation,
  type AgentChatMessage as StoredAgentChatMessage,
  type AgentChatToolEvent,
  type SpecialistDirectiveEvent,
  type AgentSource,
  getAgentChatFeedback,
  setAgentChatFeedback,
} from "@/lib/services/agent-chat-client";
import { runConnectedSystemDirective } from "@/lib/agent/connected-system-directive-runtime";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import { runCalendarDirective } from "@/lib/agent/calendar-directive-runtime";
import { clearCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import {
  runLocationDirective,
  type DelegateResult,
} from "@/lib/agent/specialist-directive-runtime";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { cn } from "@/lib/utils";
import {
  useConsentActions,
  type PendingConsent,
} from "@/lib/consent/use-consent-actions";
import { useOneLocationConsentActions } from "@/lib/consent/use-one-location-consent-actions";
import { useVault } from "@/lib/vault/vault-context";
import {
  appInteractionCoordinator,
  useActiveActionRun,
} from "@/lib/interaction/interaction-intent-coordinator";
import { FCM_MESSAGE_EVENT } from "@/lib/notifications";
import {
  ConsentCenterService,
  type PendingConsentLookupItem,
} from "@/lib/services/consent-center-service";
import { ApiService } from "@/lib/services/api-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { useRootChatDeferredReady } from "@/lib/navigation/use-root-chat-deferred-ready";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  useOneConversationSession,
  type GmailInformationRequestHandoff,
} from "@/lib/agent/one-conversation-session";
import { dedupeAdjacentAgentMessages } from "@/lib/agent/agent-chat-turn-safety";
import {
  editQueuedAgentPrompt,
  removeQueuedAgentPrompt,
  SerialAgentOperationQueue,
  type QueuedAgentPrompt,
} from "@/lib/agent/agent-chat-prompt-queue";
import {
  combineAttachmentAndComposerText,
  createPendingTextAttachment,
  getTextAttachmentTitle,
  mergePastedText,
  shouldCaptureLargePaste,
  type PendingTextAttachment,
} from "@/lib/agent/large-text-attachment";
import {
  DRIVE_CHAT_RECOVERY_RETURN_EVENT,
  clearDriveChatRecovery,
  saveDriveChatRecovery,
  takeDriveChatRecovery,
  type DriveChatRecoveryReason,
} from "@/lib/agent/drive-oauth-chat-recovery";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { buildOneVoiceStructuredScreenContext } from "@/lib/voice/screen-context-builder";
import type {
  EmailDeliveryError,
  EmailDraft,
} from "@/lib/services/email-delivery-service";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { prepareScopedGmailInformationRequestDraft } from "@/lib/services/gmail-information-request-draft-service";
import { GmailInformationRequestsService } from "@/lib/services/gmail-information-requests-service";

type AgentMessage = {
  id: string;
  /**
   * The server's id for this answer (ADK event id), set when the run's closing
   * snapshot arrives. Ratings key on this, so a thumbs given during the live
   * turn matches the same reply after a reload and joins to its turn.
   */
  serverMessageId?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  status?: "streaming" | "done" | "error";
  ephemeral?: boolean;
  memoryCapture?: AgentPkmCaptureStatus;
  kind?: "selection";
  // Calendar proposal status is already a bounded confirmation/result. Keep
  // that one message on the regular assistant surface instead of wrapping it
  // in the generic turn stream panel.
  renderAsPlainAssistantMessage?: boolean;
  specialistDirective?: SpecialistDirectiveEvent | null;
  streamEvents?: AgentVisibleStreamEvent[];
  sources?: AgentSource[];
  structuredExperience?: AgentStructuredExperience | null;
  structuredExperiences?: AgentStructuredExperienceEntry[];
};

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

type EmailDeliveryTimelineItem = EmailDeliveryHistoryItem & {
  anchorMessageId: string | null;
};

type AgentDebugEvent = {
  id: string;
  turnId: string;
  timestamp: string;
  event: string;
  payload: unknown;
};

type QueuedWorkspaceOperation = {
  id: string;
  prompt?: QueuedAgentPrompt;
  run: () => Promise<void>;
};

function upsertVisibleStreamEvent(
  events: AgentVisibleStreamEvent[] | undefined,
  event: AgentVisibleStreamEvent,
): AgentVisibleStreamEvent[] {
  const current = events ?? [];
  const existingIndex = current.findIndex((item) => item.id === event.id);
  if (existingIndex >= 0) {
    return current.map((item, index) =>
      index === existingIndex ? event : item,
    );
  }
  return [...current, event].slice(-10);
}

function settleVisibleStreamEvents(
  events: AgentVisibleStreamEvent[] | undefined,
  status: Extract<AgentVisibleStreamStatus, "done" | "blocked" | "error">,
): AgentVisibleStreamEvent[] {
  return (events ?? []).map((event) =>
    event.status === "running" ? { ...event, status } : event,
  );
}

type AgentPkmActivity = {
  id: string;
  text: string;
  status: "streaming" | "done" | "error";
};

/**
 * Inline secure card widget in the chat surface. The decrypted values live
 * only in this client state; they are never written into messages, model
 * context, history, or telemetry.
 */
type AgentWalletWidget =
  | { id: string; kind: "add" }
  | { id: string; kind: "list"; summaries: WalletCardSummary[] }
  | {
      id: string;
      kind: "reveal";
      summary: WalletCardSummary;
      secrets: WalletCardSecrets;
    };

type AgentTurnSource = "typed";
type AgentRunTurnOptions = {
  source: AgentTurnSource;
  personSelectionHandle?: string;
  appendUserMessage?: boolean;
  replaceAssistantMessageId?: string | null;
  deferPkmContext?: boolean;
};

type ConsentRequiredDirectivePayload = {
  kind: "consent_required";
  agentId?: string;
  requiredScope?: string;
  reason?: string;
};

type ConsentActionsDirectivePayload = {
  kind: "consent_actions";
  items: SpecialistConsentActionItem[];
};

type PendingConsentRequestDirectivePayload = {
  kind: "pending_consent_request";
  item: SpecialistPendingConsentRequestItem;
};

/**
 * Which agent this workspace is showing.
 *
 * Two agents, two transcripts, never one. Puppy One answers on the owner's own
 * machine with its own model and its own memory; One answers in the cloud.
 * Merging their turns would leave a transcript that cannot say where any given
 * answer came from, which is the one thing this surface must always be able to
 * say (`docs/reference/ai/puppy-one-on-device.md`). So this switches which
 * transcript is on screen and nothing else: no message, no conversation and no
 * history row ever crosses between them.
 */
export type AgentChatSurface = "one" | "puppy";

type AgentChatWorkspaceProps = {
  className?: string;
};

const AGENT_GREETING =
  "Hi, I'm One \u2014 your private agent. Ask me about your markets, portfolio, memories, or consent workflows.";
const AGENT_GREETING_TIMESTAMP = "Just now";
const EMPTY_PKM_CONTEXT: AgentPkmContext = {
  text: "",
  domains: [],
  totalAttributes: 0,
  updatedAt: null,
};

function toPkmFactCountBucket(
  count: number,
): "none" | "1_9" | "10_49" | "50_249" | "250_plus" {
  if (count <= 0) return "none";
  if (count < 10) return "1_9";
  if (count < 50) return "10_49";
  if (count < 250) return "50_249";
  return "250_plus";
}
const AGENT_STREAM_RENDER_FRAME_MS = 32;

function getConsentRequiredPayload(
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

function getGmailEmailDraftPayload(
  event: AgentChatToolEvent | null,
): { instruction: string; driveFileId: string | null } | null {
  if (!event || event.raw.toolName !== "open_gmail_email_draft") return null;
  const instruction =
    typeof event.slots.request === "string" ? event.slots.request.trim() : "";
  const driveFileId =
    typeof event.slots.drive_file_id === "string"
      ? event.slots.drive_file_id.trim()
      : "";
  return instruction
    ? { instruction, driveFileId: driveFileId && driveFileId.length <= 256 ? driveFileId : null }
    : null;
}

/** Metadata-only context for a Gmail KYC handoff. Gmail content never enters chat. */
function gmailKycRequestSummary(request: GmailInformationRequestHandoff): string {
  const labels = request.requested_field_labels
    .map((label) => label.trim())
    .filter(Boolean);
  return labels.length ? labels.join(", ") : "KYC details";
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
    const plan = (parsed.plan as Record<string, unknown>) || {};
    const action =
      toolName === "propose_calendar_cancellation"
        ? "cancel"
        : toolName === "propose_calendar_reschedule"
          ? "reschedule"
          : "create";
    const verb =
      action === "cancel"
        ? "Cancel"
        : action === "reschedule"
          ? "Reschedule"
          : "Schedule";
    const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
    const confirmLabel = conflicts.length > 0 ? `${verb} anyway` : verb;
    const title = String(plan.title || plan.event_id || "event");
    const summary = `${verb} '${title}'`;

    return {
      delegateAgentId: "agent_calendar",
      directive: {
        kind: "action",
        payload: {
          type: "calendar.execute_proposal",
          proposalId: parsed.proposal_id,
          action,
          summary,
          confirmLabel,
          expiresAt: String(parsed.expires_at || ""),
        },
      },
      message: String(parsed.message || summary),
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

function getConsentActionsPayload(
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

function pendingConsentScopeItemFromUnknown(
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

function agentMessagePendingConsentRequestId(
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
export function mergePendingConsentMessages(
  restored: AgentMessage[],
  current: readonly AgentMessage[],
): AgentMessage[] {
  const merged = [...restored];

  for (const candidate of current) {
    const payload = getPendingConsentRequestPayload(
      candidate.specialistDirective ?? null,
    );
    if (!payload) continue;
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
      merged.push(candidate);
    }
  }

  return merged;
}

function markPendingConsentRequestDirectiveStatus(
  event: SpecialistDirectiveEvent | null | undefined,
  itemId: string,
  status: Exclude<PendingConsentCardStatus, "pending">,
): SpecialistDirectiveEvent | null | undefined {
  if (!event || event.directive.kind !== "prompt") return event;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "pending_consent_request") return event;
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

function normalizeConsentActions(item: Record<string, unknown>): string[] {
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

function markConsentDirectiveItemRevoked(
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

function formatNow(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function createGreetingMessage(): AgentMessage {
  return {
    id: "agent-greeting",
    role: "assistant",
    text: AGENT_GREETING,
    timestamp: AGENT_GREETING_TIMESTAMP,
    status: "done",
  };
}

function formatAgentDisplayName(
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

function AgentPromptSuggestions({
  prompts,
  disabled,
  align = "center",
  onPromptSelect,
}: {
  prompts: readonly string[];
  disabled: boolean;
  align?: "center" | "start";
  onPromptSelect: (prompt: string) => void;
}) {
  return (
    <div
      data-testid="agent-chat-suggestions"
      role="group"
      aria-label="Suggestions"
      className={cn(
        "flex flex-wrap gap-2.5",
        align === "center" ? "justify-center" : "justify-start",
      )}
    >
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          disabled={disabled}
          onClick={() => onPromptSelect(prompt)}
          className="group relative inline-flex !h-auto !min-h-11 max-w-full items-center !justify-between gap-2.5 !rounded-2xl border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] !px-4 !py-2.5 text-left text-sm font-medium text-foreground shadow-[var(--app-glass-shadow)] transition-colors duration-150 hover:bg-[color:var(--app-shell-surface-bg-hover)] active:opacity-90 disabled:pointer-events-none disabled:opacity-60"
        >
          <span className="min-w-0 whitespace-normal leading-5">{prompt}</span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-[color:var(--app-accent-deep)]"
            aria-hidden
          />
        </button>
      ))}
    </div>
  );
}

function AgentWelcomePanel({
  name,
  prompts,
  disabled,
  onPromptSelect,
}: {
  name: string;
  prompts: readonly string[];
  disabled: boolean;
  onPromptSelect: (prompt: string) => void;
}) {
  return (
    <section className="flex min-h-[clamp(18rem,45vh,32rem)] flex-col justify-center py-6 sm:py-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-1 text-center sm:px-2">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-black/10 bg-black/[0.035] px-3 py-1.5 text-xs font-medium text-[rgba(0,0,0,0.56)] dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
          One workspace
        </div>
        <h2 className="text-[34px] font-medium leading-[1.08] tracking-normal text-foreground max-sm:font-[family-name:var(--font-app-display)] max-sm:font-semibold max-sm:tracking-[-0.5px] sm:text-[38px]">
          Hi {name}
        </h2>
        <p className="mt-3 max-w-xl text-[16px] leading-7 text-muted-foreground max-sm:font-[family-name:var(--font-app-body)] sm:text-[17px] mx-auto text-center text-balance">
          Ask One about your markets, portfolio, memories, or consent workflows.
        </p>
        <AgentPromptSuggestions
          prompts={prompts}
          disabled={disabled}
          onPromptSelect={onPromptSelect}
          align="center"
        />
      </div>
    </section>
  );
}

function formatWelcomeDomain(domain: string): string {
  return domain
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function PostSetupWelcomeCard({
  name,
  context,
  disabled,
  onPromptSelect,
}: {
  name: string;
  context: EntryWelcome;
  disabled: boolean;
  onPromptSelect: (prompt: string) => void;
}) {
  const domains = context.domains.slice(0, 5);
  const savedDetails = Math.max(0, context.totalAttributes || 0);
  return (
    <section
      data-testid="post-setup-welcome-card"
      className="motion-step-enter mx-auto mt-6 w-full max-w-2xl rounded-[28px] border border-border/70 bg-card/80 p-5 shadow-[0_18px_60px_-42px_rgba(0,0,0,0.42)] sm:p-7"
    >
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        One · Your private agent
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        Welcome, {name}
      </h2>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
        I’m One, your private agent. You’ve finished setup and opened your vault.
        Here’s where we can start together.
      </p>

      <div className="mt-6 rounded-2xl bg-muted/45 px-4 py-4 text-sm text-foreground">
        <p className="font-medium">What’s ready so far</p>
        {context.status === "loading" ? (
          <p className="mt-1 text-muted-foreground" role="status">I’m checking your setup summary…</p>
        ) : context.status === "unavailable" ? (
          <p className="mt-1 text-muted-foreground">I couldn’t load your saved summary yet. You can still ask me for help or try “Show what you know.”</p>
        ) : domains.length > 0 ? (
          <>
            <p className="mt-1 text-muted-foreground">
              {savedDetails > 0
                ? `${savedDetails} saved ${savedDetails === 1 ? "detail" : "details"} across ${context.domains.length} ${context.domains.length === 1 ? "category" : "categories"}.`
                : `Context is available across ${context.domains.length} ${context.domains.length === 1 ? "category" : "categories"}.`}
            </p>
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Available categories">
              {domains.map((domain) => (
                <span
                  key={domain}
                  className="rounded-full bg-background px-3 py-1.5 text-xs text-muted-foreground"
                >
                  {formatWelcomeDomain(domain)}
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-1 text-muted-foreground">
            No categories have been added yet. You can connect a source or
            tell me what you want to organize.
          </p>
        )}
      </div>

      <p className="mt-5 text-sm leading-6 text-muted-foreground">
        Try asking what I remember, tell me a goal you’d like help with, or
        choose a connection to set up. You decide what to share and with whom.
      </p>
      <AgentPromptSuggestions
        prompts={[
          "Show what you know",
          "Set up a connection",
          "What can you help with?",
        ]}
        disabled={disabled}
        onPromptSelect={onPromptSelect}
        align="start"
      />
    </section>
  );
}


function useAnimatedAssistantText(targetText: string, active: boolean) {
  const [displayedText, setDisplayedText] = useState(active ? "" : targetText);
  const displayedTextRef = useRef(displayedText);
  const targetTextRef = useRef(targetText);

  useEffect(() => {
    displayedTextRef.current = displayedText;
  }, [displayedText]);

  useEffect(() => {
    targetTextRef.current = targetText;

    if (!active && !targetText.startsWith(displayedTextRef.current)) {
      displayedTextRef.current = targetText;
      setDisplayedText(targetText);
    }
  }, [active, targetText]);

  useEffect(() => {
    let frame = 0;
    let lastPaintAt = 0;

    const tick = (now: number) => {
      const target = targetTextRef.current;
      const current = displayedTextRef.current;

      if (!target.startsWith(current)) {
        displayedTextRef.current = target;
        setDisplayedText(target);
        return;
      }

      if (current.length >= target.length) {
        return;
      }

      if (lastPaintAt && now - lastPaintAt < AGENT_STREAM_RENDER_FRAME_MS) {
        frame = window.requestAnimationFrame(tick);
        return;
      }

      const elapsedMs = lastPaintAt
        ? Math.max(12, now - lastPaintAt)
        : AGENT_STREAM_RENDER_FRAME_MS;
      lastPaintAt = now;
      const backlog = target.length - current.length;
      const charsPerSecond = backlog > 900 ? 2600 : backlog > 260 ? 1500 : 620;
      const step = Math.max(
        1,
        Math.min(backlog, Math.ceil((charsPerSecond * elapsedMs) / 1000)),
      );
      const nextText = target.slice(0, current.length + step);
      displayedTextRef.current = nextText;
      setDisplayedText(nextText);

      if (nextText.length < target.length) {
        frame = window.requestAnimationFrame(tick);
      }
    };

    const target = targetTextRef.current;
    const current = displayedTextRef.current;
    if (
      target &&
      (!target.startsWith(current) || current.length < target.length)
    ) {
      frame = window.requestAnimationFrame(tick);
    }

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [active, targetText]);

  return {
    displayedText,
    isAnimating: active || displayedText.length < targetText.length,
  };
}

function AgentThinkingDots() {
  return (
    <span
      className="inline-flex items-center gap-1 py-1 text-muted-foreground"
      aria-label="Agent is thinking"
    >
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-160ms] motion-reduce:animate-none" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-80ms] motion-reduce:animate-none" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
    </span>
  );
}

function AgentBubble({
  message,
  onOpenConnections,
  userAvatarUrl,
  userInitials = "YO",
  onRetry,
  retryDisabled = false,
  busyConsentItemId = null,
  turnPanelOpportunities,
  onConsentRevoke,
  onConsentDetails,
  onPendingConsentApprove,
  onPendingConsentDeny,
  onPendingConsentDetails,
  rating = null,
  onRate,
}: {
  message: AgentMessage;
  onOpenConnections?: (trigger: HTMLButtonElement) => void;
  userAvatarUrl?: string | null;
  userInitials?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  busyConsentItemId?: string | null;
  turnPanelOpportunities?: ReactNode;
  onConsentRevoke?: (item: SpecialistConsentActionItem) => Promise<void> | void;
  onConsentDetails?: (item: SpecialistConsentActionItem) => void;
  onPendingConsentApprove?: (
    item: SpecialistPendingConsentRequestItem,
  ) => Promise<void> | void;
  onPendingConsentDeny?: (
    item: SpecialistPendingConsentRequestItem,
  ) => Promise<void> | void;
  onPendingConsentDetails?: (item: SpecialistPendingConsentRequestItem) => void;
  rating?: "up" | "down" | null;
  onRate?: (rating: "up" | "down" | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  // The rating is owned by the workspace so it survives a reload; the bubble
  // only reflects it. It used to be local state that died with the tab, which
  // meant nobody could ever read what people thought of an answer.
  const liked = rating === "up";
  const disliked = rating === "down";
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";
  const streamEvents = (message.streamEvents ?? []).filter(
    (event) => !message.memoryCapture || event.label !== "Memory",
  );
  const structuredExperiences =
    message.structuredExperiences ??
    (message.structuredExperience
      ? [
          {
            id: "legacy-structured-experience",
            experience: message.structuredExperience,
          },
        ]
      : []);
  // Use the activity surface only while a turn is active or when the settled
  // turn has safe, inspectable activity. Plain completed answers stay readable.
  const hasStreamContent =
    isStreaming ||
    streamEvents.length > 0 ||
    Boolean(message.sources?.length) ||
    structuredExperiences.length > 0;
  const shouldRenderStreamPanel =
    !isUser && !isError && hasStreamContent && !message.renderAsPlainAssistantMessage;
  const animated = useAnimatedAssistantText(
    message.text,
    !isUser && isStreaming,
  );
  const assistantText = isUser ? message.text : animated.displayedText;
  const consentActionsPayload = !isUser
    ? getConsentActionsPayload(message.specialistDirective ?? null)
    : null;
  const canRenderConsentActions = Boolean(
    consentActionsPayload && onConsentRevoke && onConsentDetails,
  );
  const pendingConsentRequestPayload = !isUser
    ? getPendingConsentRequestPayload(message.specialistDirective ?? null)
    : null;
  const canRenderPendingConsentRequest = Boolean(
    pendingConsentRequestPayload &&
    onPendingConsentApprove &&
    onPendingConsentDeny &&
    onPendingConsentDetails,
  );
  const showResponseActions =
    !isUser &&
    !message.ephemeral &&
    !isStreaming &&
    assistantText.trim().length > 0;
  // Give the assistant turn the same rounded-card shape as the user bubble
  // (just in a neutral tone, not primary) so both sides of the conversation
  // read as one consistent rhythm. The stream panel and the consent-actions-
  // only turn (nothing rendered here; actions render elsewhere) own their
  // own framing, so they're excluded to avoid a double card or an empty box.
  const showAssistantBubble =
    !isUser &&
    !shouldRenderStreamPanel &&
    (assistantText.trim().length > 0 ||
      !(canRenderConsentActions || canRenderPendingConsentRequest));

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(message.text || assistantText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Could not copy response.");
    }
  };

  return (
    <div
      data-message-role={message.role}
      data-message-status={message.status}
      className={cn(
        "motion-step-enter flex w-full items-start gap-2",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "min-w-0",
          shouldRenderStreamPanel && !isUser
            ? "w-full max-w-none"
            : "max-w-[90%] sm:max-w-[min(82%,48rem)]",
          isUser && "order-first sm:max-w-[min(76%,42rem)]",
        )}
      >
        <div
          aria-live={!isUser && isStreaming ? "polite" : undefined}
          data-agent-streaming={!isUser && isStreaming ? "true" : undefined}
          className={cn(
            "text-sm leading-6",
            isUser
              ? "rounded-[22px] rounded-br-[7px] bg-[linear-gradient(145deg,var(--app-accent),var(--app-accent-deep))] px-4 py-2.5 text-[color:var(--app-accent-fg)] shadow-[0_14px_34px_-24px_var(--app-accent-deep)]"
              : showAssistantBubble
                ? "px-1 py-2 text-foreground"
                : "px-0 py-1 text-foreground",
            isError &&
              "rounded-2xl border border-destructive/20 bg-destructive/[0.06] px-4 py-2.5 text-foreground",
          )}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap break-words">
              {message.text}
            </span>
          ) : shouldRenderStreamPanel ? (
            <AgentTurnStreamPanel
              streamEvents={streamEvents}
              sources={message.sources}
              structuredExperience={message.structuredExperience}
              structuredExperiences={structuredExperiences}
              onOpenConnections={onOpenConnections}
              responseText={assistantText}
              isStreaming={isStreaming}
              isError={isError}
              opportunities={turnPanelOpportunities}
              response={
                assistantText ? <AgentMarkdown text={assistantText} /> : null
              }
            />
          ) : assistantText ? (
            <AgentMarkdown text={assistantText} />
          ) : canRenderConsentActions ||
            canRenderPendingConsentRequest ? null : (
            <AgentThinkingDots />
          )}
        </div>
        {!isUser && message.memoryCapture ? <AgentMemoryCaptureStatus status={message.memoryCapture} /> : null}
        <div
          className={cn(
            "mt-1 flex items-center gap-2 text-[11px] text-[rgba(0,0,0,0.46)] dark:text-zinc-500",
            isUser && "justify-end text-right",
          )}
        >
          <span>{message.timestamp}</span>
          {showResponseActions ? (
            <div className="flex items-center gap-1">
              {!isError ? (
                <>
              <button
                type="button"
                onClick={handleCopy}
                className="grid h-7 w-7 place-items-center rounded-md border border-transparent text-[rgba(0,0,0,0.46)] transition hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
                aria-label={copied ? "Response copied" : "Copy response"}
                title={copied ? "Copied" : "Copy response"}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onRate?.(liked ? null : "up")}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  liked
                    ? "border-black/10 bg-black/[0.06] text-[#1d1d1f] dark:border-white/15 dark:bg-zinc-800 dark:text-zinc-100"
                    : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200",
                )}
                aria-label="Like response"
                aria-pressed={liked}
                title="Like response"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onRate?.(disliked ? null : "down")}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  disliked
                    ? "border-black/10 bg-black/[0.06] text-[#1d1d1f] dark:border-white/15 dark:bg-zinc-800 dark:text-zinc-100"
                    : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200",
                )}
                aria-label="Dislike response"
                aria-pressed={disliked}
                title="Dislike response"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
                </>
              ) : null}
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={retryDisabled}
                  className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-[rgba(0,0,0,0.46)] transition hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
                  aria-label="Try again"
                  title="Try again"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Try again</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {canRenderConsentActions && consentActionsPayload ? (
          <div className="mt-4">
            <SpecialistConsentActionsCard
              items={consentActionsPayload.items}
              busyItemId={busyConsentItemId}
              onRevoke={(item) => {
                void onConsentRevoke?.(item);
              }}
              onDetails={(item) => {
                onConsentDetails?.(item);
              }}
            />
          </div>
        ) : null}
        {canRenderPendingConsentRequest && pendingConsentRequestPayload ? (
          <div className="mt-4">
            <SpecialistPendingConsentRequestCard
              item={pendingConsentRequestPayload.item}
              busy={busyConsentItemId === pendingConsentRequestPayload.item.id}
              onApprove={(item) => {
                void onPendingConsentApprove?.(item);
              }}
              onDeny={(item) => {
                void onPendingConsentDeny?.(item);
              }}
              onDetails={(item) => {
                onPendingConsentDetails?.(item);
              }}
            />
          </div>
        ) : null}
      </div>
      {isUser ? (
        <span className="mt-0.5 shrink-0" data-testid="agent-chat-self-avatar">
          <AvatarBubble
            initials={userInitials}
            imageUrl={userAvatarUrl}
            size={30}
          />
        </span>
      ) : null}
    </div>
  );
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
  const createdAt = message.created_at ? new Date(message.created_at) : null;
  // A selection message must never re-render its raw `I selected:` seed on
  // reload: prefer the persisted display label and render it as a chip. The
  // backend (Task 3) guarantees metadata.display for new selection messages;
  // legacy rows without metadata are detected via LEGACY_SELECTION_SEED below.
  const isSelection = message.metadata?.kind === "selection";
  // Detect legacy rows: user message with raw seed content and no usable metadata.
  const isLegacySelectionSeed =
    !isSelection &&
    message.role === "user" &&
    LEGACY_SELECTION_SEED.test(message.content);

  const displayText =
    isSelection && message.metadata?.display
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
  // Do not resurrect a duplicate through the legacy descriptor, or leave an
  // empty thinking bubble. Prose and all distinct cards retain source order.
  if (candidates.length && !structuredExperiences.length && !displayText.trim()) return null;
  return {
    id: message.id,
    role: message.role,
    text: displayText,
    structuredExperience: connectorRead,
    timestamp:
      createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(createdAt)
        : formatNow(),
    status: message.status === "error" ? "error" : "done",
    ...(isSelection || isLegacySelectionSeed
      ? { kind: "selection" as const }
      : {}),
    ...(structuredExperiences.length ? { structuredExperiences } : {}),
  };
}

export function storedMessagesToAgentMessages(messages: StoredAgentChatMessage[]): AgentMessage[] {
  const seenExperienceIds = new Set<string>();
  return messages
    .map(message => storedMessageToAgentMessage(message, seenExperienceIds))
    .filter((message): message is AgentMessage => Boolean(message));
}

export function AgentChatWorkspace({ className }: AgentChatWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const isCanonicalChatRoute = pathname === ROUTES.HOME;
  const searchParams = useSearchParams();
  const localCrmEnabled = isLocalCrmBuildEnabled();
  const { user, loading: authLoading, phoneNumber, sessionVerificationRequired } = useAuth();
  const {
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
    getVaultOwnerToken,
  } = useVault();
  const {
    activePersona,
    primaryNavPersona,
    personaTransitionTarget,
    riaSetupAvailable,
    riaSwitchAvailable,
    riaOnboardingStatus,
    switchPersona,
  } = usePersonaState();
  const riaOnboardingComplete = isRiaAdvisoryAccessReady(riaOnboardingStatus);
  const analysisParams = useKaiSession((state) => state.analysisParams);
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  // Shared single source of truth for the agent runtime snapshot. The chat
  // workspace consumes this base and overlays only the fields it uniquely owns
  // (background-task tracking and its local voice state) below.
  const sharedRuntime = useAgentRuntimeStateOptional();
  // Which agent is on screen. Local to the workspace and deliberately not
  // persisted: the cloud agent is the default every time this opens, so a
  // forgotten mode can never make One's answers look like they were generated
  // on the owner's machine.
  const [agentSurface, setAgentSurface] = useState<AgentChatSurface>("one");
  const isPuppySurface = agentSurface === "puppy";
  // Puppy One is mounted on FIRST use and hidden thereafter, never unmounted.
  // Unmounting it destroyed the whole on-device conversation and its Hermes
  // session on every glance at One, which is exactly what the comment beside
  // One's own transcript says must not happen to a turn in flight. Lazy,
  // because a workspace that never opens Puppy must still cost the loopback
  // gateway and the trusted-device list nothing.
  const [puppyEverOpened, setPuppyEverOpened] = useState(false);
  // One's transcript is hidden with display:none while Puppy is on screen, and
  // a display:none element has no layout box, so the browser discards its
  // scrollTop and it comes back at the top of a long history. Captured on
  // scroll (before the state change, which a layout effect is too late for)
  // and written back instantly (`scroll-smooth` on the same element would
  // otherwise animate a long crawl down from the top).
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const oneScrollTopRef = useRef(0);
  const [recoveryScrollTop, setRecoveryScrollTop] = useState<number | null>(null);
  // Programmatic history/anchor restoration must not be interpreted as a
  // person's scroll gesture. Chat's transcript is nested inside the app
  // shell, so this distinction is what keeps the shared bottom chrome visible
  // while the initial conversation is being positioned at its latest turn.
  const transcriptProgrammaticScrollRef = useRef(false);
  const transcriptProgrammaticTargetRef = useRef<number | null>(null);
  const transcriptProgrammaticScrollTimeoutRef = useRef<number | null>(null);
  const transcriptUserScrollRef = useRef(false);

  const clearTranscriptProgrammaticScroll = useCallback(() => {
    transcriptProgrammaticScrollRef.current = false;
    transcriptProgrammaticTargetRef.current = null;
    if (
      transcriptProgrammaticScrollTimeoutRef.current !== null &&
      typeof window !== "undefined"
    ) {
      window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
      transcriptProgrammaticScrollTimeoutRef.current = null;
    }
  }, []);

  const beginTranscriptProgrammaticScroll = useCallback(
    (target: number) => {
      transcriptProgrammaticScrollRef.current = true;
      transcriptProgrammaticTargetRef.current = Math.max(0, target);
      if (
        transcriptProgrammaticScrollTimeoutRef.current !== null &&
        typeof window !== "undefined"
      ) {
        window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
      }
      if (typeof window !== "undefined") {
        transcriptProgrammaticScrollTimeoutRef.current = window.setTimeout(
          clearTranscriptProgrammaticScroll,
          600,
        );
      }
    },
    [clearTranscriptProgrammaticScroll],
  );
  const enterPuppySurface = useCallback(() => {
    // Unconditional, and not behind a `voiceActive` guard. It is a no-op when
    // nothing is running, and it is the only shape that also covers the window
    // where the microphone lease is held but the shared store still reads
    // "idle": a session that came alive after the switch would be the cloud
    // agent listening and speaking under a header that says "on your machine",
    // with its mute and cancel controls inside the hidden composer.
    requestAgentConversationStop();
    setPuppyEverOpened(true);
    setAgentSurface("puppy");
  }, []);

  const [input, setInput] = useState("");
  const [longPromptAttachment, setLongPromptAttachment] =
    useState<PendingTextAttachment | null>(null);
  // Which model runs this person's agent. The catalog is served, so a new
  // generation appears here without a client release.
  const [modelPreference, setModelPreference] = useState<ModelPreference | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedAgentPrompt[]>([]);
  const [editingQueuedPromptId, setEditingQueuedPromptId] = useState<
    string | null
  >(null);
  const [editingQueuedPromptText, setEditingQueuedPromptText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Ratings for this conversation, keyed by message id. Durable, so a reload
  // and a conversation switch both keep what the person said about an answer.
  const [messageRatings, setMessageRatings] = useState<
    Record<string, "up" | "down">
  >({});
  const [conversations, setConversations] = useState<AgentChatConversation[]>(
    [],
  );
  const puppyHistory = usePuppyConversations(user?.uid ?? null);
  const { conversations: puppyConversations, activeId: puppyConversationId } = puppyHistory;
  const [messages, setMessages] = useState<AgentMessage[]>(() => [
    createGreetingMessage(),
  ]);
  const [queuedHandoffPrompt, setQueuedHandoffPrompt] = useState<string | null>(
    null,
  );
  const pendingSessionHandoff = useOneConversationSession(
    (state) => state.pendingHandoff,
  );
  const handoff = pendingSessionHandoff;
  const postSetupWelcomeContext = useEntryWelcome({
    userId: user?.uid, isVaultUnlocked, vaultKey, vaultOwnerToken,
  });
  const consumeHandoff = useOneConversationSession(
    (state) => state.consumeHandoff,
  );
  const consumedHandoffIdRef = useRef<string | null>(null);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ConnectionsDrawerMode>("chats");
  const [recoveryCheckedForUid, setRecoveryCheckedForUid] = useState<string | null>(null);
  const pendingDriveRecoveryRef = useRef<{
    ownerUid: string;
    state: Awaited<ReturnType<typeof takeDriveChatRecovery>>;
  } | null>(null);
  const currentDraftRef = useRef({ input, attachment: longPromptAttachment });
  currentDraftRef.current = { input, attachment: longPromptAttachment };
  const recoveryUiRef = useRef({
    conversationId, composerExpanded, drawerOpen: isHistoryDrawerOpen, drawerMode,
  });
  recoveryUiRef.current = {
    conversationId, composerExpanded, drawerOpen: isHistoryDrawerOpen, drawerMode,
  };
  useEffect(() => {
    if (!user?.uid || !vaultKey) {
      pendingDriveRecoveryRef.current = null;
      setRecoveryCheckedForUid(null);
    }
  }, [user?.uid, vaultKey]);
  useEffect(() => {
    const onReturn = () => setRecoveryCheckedForUid(null);
    window.addEventListener(DRIVE_CHAT_RECOVERY_RETURN_EVENT, onReturn);
    return () => window.removeEventListener(DRIVE_CHAT_RECOVERY_RETURN_EVENT, onReturn);
  }, []);
  const [connectionsAvailable, setConnectionsAvailable] = useState(false);
  const [connectorExternalModalOpen, setConnectorExternalModalOpen] =
    useState(false);
  useEffect(() => {
    // `?panel=connectors` is the connector OAuth-return flow's landing signal
    // -- connectors live in this sidebar panel now, not a dedicated route, so
    // completing a connect has to reopen it here instead of navigating to one.
    if (searchParams?.get("panel") !== "connectors") return;
    setDrawerMode("connections");
    setIsHistoryDrawerOpen(true);
    const next = new URLSearchParams(searchParams.toString());
    next.delete("panel");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const [historyActionPendingId, setHistoryActionPendingId] = useState<
    string | null
  >(null);
  const [isVoiceConnecting, setIsVoiceConnecting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  // Just-in-time vault unlock: the agent prompts to unlock in place (the same
  // reusable VaultUnlockDialog used by Kai / consent / connected-systems)
  // instead of bouncing the user to /one/profile. Opened only when a vault-gated
  // operation is requested while the vault is locked.
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [emailDraftOpen, setEmailDraftOpen] = useState(false);
  const [emailDraftInstruction, setEmailDraftInstruction] = useState("");
  const [emailDraftAutoDraft, setEmailDraftAutoDraft] = useState(false);
  const [emailDraftInitialValue, setEmailDraftInitialValue] =
    useState<EmailDraft | null>(null);
  const [emailDraftAnchorMessageId, setEmailDraftAnchorMessageId] = useState<
    string | null
  >(null);
  const [gmailKycReplyRequest, setGmailKycReplyRequest] = useState<
    GmailInformationRequestHandoff | null
  >(null);
  const [gmailKycEmailDraftWorkflowId, setGmailKycEmailDraftWorkflowId] =
    useState<string | null>(null);
  const [gmailKycMissingLabels, setGmailKycMissingLabels] = useState<string[]>(
    [],
  );
  const [isGmailKycSaving, setIsGmailKycSaving] = useState(false);
  // This is intentionally session-only. The normal user prompt is stored by
  // the encrypted chat service, but raw email fields must not become durable
  // chat/workflow records.
  const [emailDeliveryHistory, setEmailDeliveryHistory] = useState<
    EmailDeliveryTimelineItem[]
  >([]);
  const [activeFrontendToolCount, setActiveFrontendToolCount] = useState(0);
  const [activePkmToolCount, setActivePkmToolCount] = useState(0);
  const [walletWidgets, setWalletWidgets] = useState<AgentWalletWidget[]>([]);
  const [pkmAutoSavePolicy, setPkmAutoSavePolicy] =
    useState<AgentPkmAutoSavePolicy>(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY);
  const [pkmPolicyReady, setPkmPolicyReady] = useState(false);
  const [pkmPolicyRevision, setPkmPolicyRevision] = useState(0);
  const [pkmPolicyOwnerId, setPkmPolicyOwnerId] = useState<string | null>(null);
  const pkmCapturePolicyRef = useRef(pkmAutoSavePolicy);
  pkmCapturePolicyRef.current = pkmAutoSavePolicy;
  const pkmCaptureEnabledRef = useRef(false);
  pkmCaptureEnabledRef.current = pkmPolicyReady && pkmPolicyOwnerId === user?.uid && pkmAutoSavePolicy.enabled && isVaultUnlocked;
  const pkmCaptureReadinessRef = useRef({ authLoading, sessionVerificationRequired, isVaultUnlocked, vaultOwnerToken, tokenExpiresAt });
  pkmCaptureReadinessRef.current = { authLoading, sessionVerificationRequired, isVaultUnlocked, vaultOwnerToken, tokenExpiresAt };
  // A specialist (e.g. agent_location) can return a directive that must be
  // explicitly confirmed by the user before it runs. Stored here and rendered
  // as an inline card; never auto-fired for kind:"action".
  const [pendingSpecialistDirective, setPendingSpecialistDirective] =
    useState<SpecialistDirectiveEvent | null>(null);
  const [pendingAppAction, setPendingAppAction] = useState<{
    event: AgentChatToolEvent;
    cancel?: () => Promise<void>;
    execute: () => Promise<AgentActionRuntimeResult>;
  } | null>(null);
  const [appActionBusy, setAppActionBusy] = useState(false);
  const [specialistBusy, setSpecialistBusy] = useState(false);
  const [specialistBusyItemId, setSpecialistBusyItemId] = useState<
    string | null
  >(null);
  const voiceState = useAgentVoiceState((state) => state.status);
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [welcomePromptSetIndex, setWelcomePromptSetIndex] = useState(0);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState(),
  );
  const activeActionRun = useActiveActionRun();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyLoadKeyRef = useRef<string | null>(null);
  const welcomePromptSetInitializedRef = useRef(false);
  const historyRestoreEpochRef = useRef(0);
  const skipInitialHistoryLoadRef = useRef(false);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const operationQueueRef = useRef(
    new SerialAgentOperationQueue<QueuedWorkspaceOperation>(),
  );
  const calendarActionIdsRef = useRef<Set<string>>(new Set());
  const handoffPromptSubmitRef = useRef<
    ((prompt: string) => Promise<void>) | null
  >(null);
  const pkmAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const pkmCaptureJobsRef = useRef(new Map<string, Promise<AgentPkmCaptureStatus>>());
  const pkmCaptureReceiptsRef = useRef(new Map<string, Map<string, AgentPkmCaptureStatus>>());
  const latestVisibleTurnIdRef = useRef<string | null>(null);
  const inlineConsentRequestIdsRef = useRef<Set<string>>(new Set());
  // Set by the FCM effect below; lets a server tool result (pending requests
  // One listed) render the same cards a push would, without a second lookup path.
  const appendPendingConsentRequestRef = useRef<((requestId: string) => Promise<void>) | null>(null);
  const updateConversationId = useCallback(
    (nextConversationId: string | null) => {
      conversationIdRef.current = nextConversationId;
      setConversationId(nextConversationId);
    },
    [],
  );
  const oneLocationConsentActions = useOneLocationConsentActions({
    userId: user?.uid,
    onActionComplete: () => {
      setPendingSpecialistDirective(null);
    },
  });
  const consentActions = useConsentActions({
    userId: user?.uid,
    onActionComplete: (detail) => {
      const requestId = detail.requestId;
      if (!requestId || detail.action === "revoke") return;
      const status = detail.action === "approve" ? "approved" : "denied";
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          specialistDirective: markPendingConsentRequestDirectiveStatus(
            message.specialistDirective,
            requestId,
            status,
          ),
        })),
      );
    },
  });

  const voiceActive = voiceState !== "idle";
  const voiceLevel = useAgentVoiceState((state) => state.level);
  const isToolWorking = activeFrontendToolCount > 0;
  const isPkmMemoryWorking = activePkmToolCount > 0;
  const rootChatReady = useRootChatDeferredReady();
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
  const agentVoiceEnabled = isAgentCommandEnabled();
  const abortAgentTurnWork = useCallback(() => {
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    for (const controller of pkmAbortControllersRef.current) {
      controller.abort();
    }
    pkmAbortControllersRef.current.clear();
    pkmCaptureJobsRef.current.clear();
    pkmCaptureReceiptsRef.current.clear();
    setActivePkmToolCount(0);
  }, []);

  useEffect(() => {
    // Token renewal invalidates the captured vault generation, but must not
    // cancel the answer stream or replay the underlying route transition.
    for (const controller of pkmAbortControllersRef.current) controller.abort();
    pkmAbortControllersRef.current.clear();
    pkmCaptureJobsRef.current.clear();
    pkmCaptureReceiptsRef.current.clear();
    setActivePkmToolCount(0);
    setMessages((current) => current.map((message) =>
      message.memoryCapture?.phase === "preparing" || message.memoryCapture?.phase === "saving"
        ? { ...message, memoryCapture: { phase: message.memoryCapture.saved ? "partial" : "canceled", saved: message.memoryCapture.saved } }
        : message,
    ));
  }, [vaultOwnerToken, pkmAutoSavePolicy, isVaultUnlocked, pkmPolicyReady, authLoading, sessionVerificationRequired]);

  useEffect(() => {
    if (user?.uid && isVaultUnlocked && vaultKey) {
      return;
    }
    clearAgentPkmContext(user?.uid);
    setEmailDraftOpen(false);
    setEmailDraftInitialValue(null);
    setEmailDraftAnchorMessageId(null);
    setEmailDeliveryHistory([]);
  }, [isVaultUnlocked, user?.uid, vaultKey]);

  useEffect(() => {
    if (!user?.uid) return;
    return subscribeAgentPkmAutoSavePolicyInvalidation(user.uid, () => {
      pkmCaptureEnabledRef.current = false;
      setPkmPolicyReady(false);
      setPkmPolicyRevision((revision) => revision + 1);
    });
  }, [user?.uid]);

  useEffect(() => {
    let cancelled = false;
    setPkmPolicyReady(false);
    setPkmPolicyOwnerId(null);
    if (!user?.uid || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setPkmAutoSavePolicy(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY);
      return undefined;
    }
    void loadAgentPkmAutoSavePolicy({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
    })
      .then((policy) => {
        if (!cancelled) {
          setPkmAutoSavePolicy(policy);
          setPkmPolicyOwnerId(user.uid);
          setPkmPolicyReady(true);
        }
      })
      .catch(() => {
        if (!cancelled)
          setPkmAutoSavePolicy(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY);
      });
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken, pkmPolicyRevision]);

  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      return undefined;
    }
    if (peekAgentPkmContext({ userId: user.uid })?.text) {
      return undefined;
    }

    // UnlockWarmOrchestrator normally starts this memory-only warmup after
    // unlock. Keep this workspace effect as a coalesced fallback so direct
    // routes and interrupted unlock warmups still prepare the first turn.
    const timeoutId = window.setTimeout(() => {
      void warmAgentPkmContext({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      }).catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timeoutId);
  }, [isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken]);

  const routeQuery = searchParams?.toString() || "";
  const pathnameWithQuery = routeQuery
    ? `${pathname || ""}?${routeQuery}`
    : pathname || "";
  const routeInfo = useMemo(
    () =>
      deriveVoiceRouteScreen(pathname || "", routeQuery, {
        authenticated: Boolean(user?.uid),
      }),
    [pathname, routeQuery, user?.uid],
  );
  const activeAnalysisTask = useMemo(() => {
    if (!user?.uid) return null;
    return (
      backgroundTaskState.tasks.find(
        (task) =>
          task.userId === user.uid &&
          task.kind === "stock_analysis_stream" &&
          task.status === "running" &&
          !task.dismissedAt,
      ) || null
    );
  }, [backgroundTaskState.tasks, user?.uid]);
  const runningImportTask = useMemo(() => {
    if (!user?.uid) return null;
    return (
      backgroundTaskState.tasks.find(
        (task) =>
          task.userId === user.uid &&
          task.kind === "portfolio_import_stream" &&
          task.status === "running" &&
          !task.dismissedAt,
      ) || null
    );
  }, [backgroundTaskState.tasks, user?.uid]);
  const activeAnalysisTicker = useMemo(() => {
    const ticker = activeAnalysisTask?.metadata?.ticker;
    return typeof ticker === "string" && ticker.trim() ? ticker.trim() : null;
  }, [activeAnalysisTask]);
  const hasChatAccess = Boolean(
    !authLoading &&
    user?.uid &&
    isVaultUnlocked &&
    vaultOwnerToken &&
    tokenIsFresh,
  );
  const availablePersonas = useMemo(() => {
    const personas = new Set<typeof activePersona>([activePersona]);
    personas.add("investor");
    if (riaSwitchAvailable) personas.add("ria");
    personas.add(primaryNavPersona);
    return Array.from(personas);
  }, [activePersona, primaryNavPersona, riaSwitchAvailable]);
  const appRuntimeState = useMemo<AppRuntimeState>(() => {
    // Base snapshot from the shared provider (auth/vault/route/persona). When
    // the provider is unavailable (e.g. isolated test mounts) we fall back to
    // computing the same shape locally.
    const base: AppRuntimeState = sharedRuntime?.appRuntimeState ?? {
      auth: {
        signed_in: Boolean(user?.uid),
        user_id: user?.uid ?? null,
      },
      vault: {
        unlocked: isVaultUnlocked,
        token_available: Boolean(vaultOwnerToken),
        token_valid: tokenIsFresh,
      },
      route: {
        pathname: pathnameWithQuery,
        screen: routeInfo.screen,
        subview: routeInfo.subview ?? null,
      },
      runtime: {
        analysis_active: false,
        analysis_ticker: null,
        analysis_run_id: null,
        import_active: false,
        import_run_id: null,
        busy_operations: [],
      },
      portfolio: {
        has_portfolio_data: hasPortfolioData,
      },
      persona: {
        active: activePersona,
        primary_nav: primaryNavPersona,
        available: availablePersonas,
        transition_target: personaTransitionTarget,
        ria_switch_available: riaSwitchAvailable,
        ria_setup_available: riaSetupAvailable,
        ria_onboarding_complete: riaOnboardingComplete,
      },
      voice: {
        available: false,
        tts_playing: false,
        last_tool_name: null,
        last_ticker: null,
      },
    };
    // Overlay the workspace-owned enrichment: background-task tracking and the
    // local voice state, which only this component observes.
    return {
      ...base,
      runtime: {
        ...base.runtime,
        analysis_active:
          base.runtime.analysis_active || Boolean(activeAnalysisTask),
        analysis_ticker:
          base.runtime.analysis_ticker ||
          activeAnalysisTicker ||
          analysisParams?.ticker ||
          null,
        analysis_run_id:
          activeAnalysisTask?.taskId || base.runtime.analysis_run_id,
        import_active: base.runtime.import_active || Boolean(runningImportTask),
        import_run_id: runningImportTask?.taskId || base.runtime.import_run_id,
      },
      voice: {
        ...base.voice,
        available: voiceActive,
        tts_playing: voiceState === "speaking",
      },
    };
  }, [
    sharedRuntime,
    activePersona,
    activeAnalysisTask,
    activeAnalysisTicker,
    analysisParams,
    availablePersonas,
    hasPortfolioData,
    isVaultUnlocked,
    pathnameWithQuery,
    personaTransitionTarget,
    primaryNavPersona,
    riaSetupAvailable,
    riaSwitchAvailable,
    riaOnboardingComplete,
    runningImportTask,
    routeInfo.screen,
    routeInfo.subview,
    tokenIsFresh,
    user?.uid,
    vaultOwnerToken,
    voiceActive,
    voiceState,
  ]);
  const appRuntimeStateRef = useRef(appRuntimeState);
  useEffect(() => {
    appRuntimeStateRef.current = appRuntimeState;
  }, [appRuntimeState]);
  // The single agent bar can always send text: with vault access it runs the
  // full agent, otherwise it runs the pre-vault informational tier. Voice and
  // vault-backed tools stay gated separately by hasChatAccess.
  const recoveryInspectionPending = Boolean(
    user?.uid && vaultKey && vaultOwnerToken && recoveryCheckedForUid !== user.uid,
  );
  const canSend =
    !recoveryInspectionPending &&
    !isVoiceConnecting &&
    !voiceActive &&
    !emailDraftOpen &&
    !isGmailKycSaving &&
    // Do not trim a potentially very large expanded attachment on every
    // keystroke. The submit path performs the authoritative empty check.
    (input.length > 0 || longPromptAttachment !== null);
  const canToggleVoice =
    agentVoiceEnabled && !recoveryInspectionPending && !isVoiceConnecting && !emailDraftOpen;
  const historyInteractionDisabled =
    recoveryInspectionPending ||
    isChatLoading ||
    isToolWorking ||
    isVoiceConnecting ||
    isStreaming ||
    voiceActive ||
    specialistBusy ||
    queuedPrompts.length > 0;
  // Whether this person has more than one cloud model to choose between. The
  // header reserves the picker's slot on this, and renders the control itself
  // only in One: see the comment at the slot.
  const canPickOneModel = Boolean(
    modelPreference && modelPreference.choices.length > 1,
  );
  const statusText = useMemo(() => {
    // Every line below narrates One's turn, so in Puppy One a bare "Thinking"
    // or "Streaming" would report on an agent the reader is not looking at:
    // the same lie as merging the transcripts, told in the header instead.
    //
    // Silence is wrong too, though. One keeps streaming, keeps draining its
    // queue and keeps waiting on a confirmation behind display:none, and none
    // of that is visible from here. So the ambient and access states (still
    // One's workspace, and unreadable as claims about the Puppy link) stay
    // silent, and only One's own work in flight speaks -- always naming the
    // agent, never with a bare verb.
    if (isPuppySurface) {
      if (
        activeActionRun?.phase === "awaiting_confirmation" || emailDraftOpen
      ) {
        // Blocked on the person, not working: its confirmation lives in the
        // hidden transcript, so saying "working" would leave them waiting on
        // something that can never finish by itself. The One segment of the
        // toggle above is the way back.
        return "One needs you";
      }
      if (
        isStreaming ||
        isChatLoading ||
        isToolWorking ||
        isPkmMemoryWorking ||
        queuedPrompts.length > 0
      ) {
        return "One is still working";
      }
      return null;
    }
    if (authLoading) return "Checking access";
    if (!user?.uid) return "Sign in required";
    if (!isVaultUnlocked || !vaultOwnerToken || !tokenIsFresh)
      return "Vault locked";
    if (activeActionRun) return activeActionRun.message;
    if (!agentVoiceEnabled && voiceActive) return "Voice disabled";
    if (voiceState === "connecting") return "Voice connecting";
    if (voiceState === "listening") return "Listening";
    if (voiceState === "muted") return "Muted";
    if (voiceState === "transcribing") return "Transcribing";
    if (voiceState === "thinking") return "Thinking";
    if (voiceState === "speaking") return "Speaking";
    if (voiceState === "error") return "Voice error";
    if (isVoiceConnecting) return "Voice connecting";
    if (isToolWorking) return "Working";
    if (isPkmMemoryWorking) return "Updating Memory";
    if (queuedPrompts.length > 0) return `${queuedPrompts.length} queued`;
    if (isChatLoading) return "Thinking";
    if (isStreaming) return "Streaming";
    return null;
  }, [
    authLoading,
    activeActionRun,
    agentVoiceEnabled,
    isChatLoading,
    isPkmMemoryWorking,
    emailDraftOpen,
    isPuppySurface,
    isToolWorking,
    isStreaming,
    isVoiceConnecting,
    isVaultUnlocked,
    queuedPrompts.length,
    tokenIsFresh,
    user?.uid,
    vaultOwnerToken,
    voiceState,
    voiceActive,
  ]);

  useEffect(() => {
    if (isCanonicalChatRoute) {
      snapKaiBottomChromeVisible();
    }
  }, [isCanonicalChatRoute]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const messagesEnd = messagesEndRef.current;
    if (!transcript || !messagesEnd || isPuppySurface) return;

    const distanceFromBottom =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
    // Keep the latest-turn behavior for a fresh/initial conversation, but do
    // not yank a reader back to the bottom after they have started browsing
    // older messages. The ref is intentionally session-local and does not
    // add a render to the scroll path.
    const shouldFollowTranscript =
      !transcriptUserScrollRef.current &&
      (oneScrollTopRef.current <= 2 || distanceFromBottom <= 48);
    if (!shouldFollowTranscript) return;

    beginTranscriptProgrammaticScroll(
      Math.max(0, transcript.scrollHeight - transcript.clientHeight),
    );
    messagesEnd.scrollIntoView({
      behavior: "auto",
      block: "end",
    });
  }, [
    beginTranscriptProgrammaticScroll,
    emailDraftOpen,
    isPuppySurface,
    messages,
    pendingSpecialistDirective,
  ]);

  // Put One's transcript back where the reader left it after a look at Puppy.
  // `useLayoutEffect` and not `useEffect`, so the correction lands in the same
  // frame the element is re-displayed and no top-of-history flash is painted;
  // `behavior: "instant"`, because `scroll-smooth` on this element applies to
  // a scrollTop write too and would animate a long crawl down from the top.
  // The browser clamps to scrollHeight, which is the right failure mode if the
  // transcript shrank while Puppy was on screen.
  useLayoutEffect(() => {
    if (isPuppySurface) return;
    const element = transcriptRef.current;
    if (!element) return;
    const target = Math.min(
      oneScrollTopRef.current,
      Math.max(0, element.scrollHeight - element.clientHeight),
    );
    beginTranscriptProgrammaticScroll(target);
    element.scrollTo({
      top: target,
      behavior: "instant" as ScrollBehavior,
    });
  }, [beginTranscriptProgrammaticScroll, isPuppySurface]);

  useLayoutEffect(() => {
    if (recoveryScrollTop === null || isPuppySurface) return;
    const element = transcriptRef.current;
    if (!element) return;
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const target = Math.min(recoveryScrollTop, max);
    oneScrollTopRef.current = target;
    transcriptUserScrollRef.current = max - target > 48;
    beginTranscriptProgrammaticScroll(target);
    element.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
    setRecoveryScrollTop(null);
  }, [beginTranscriptProgrammaticScroll, isPuppySurface, messages, recoveryScrollTop]);

  useEffect(() => {
    const token = getVaultOwnerToken();
    if (!conversationId || !token) {
      setMessageRatings({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const ratings = await getAgentChatFeedback({
        conversationId,
        vaultOwnerToken: token,
      });
      if (!cancelled) setMessageRatings(ratings);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, getVaultOwnerToken]);

  // Asking someone for information needs a connector: the keypair their reply
  // is encrypted to. It is generated in the owner's unlocked vault, so only the
  // browser can mint it, and the backend tool can only report that it is
  // missing. Without this, chat could describe a person's shareable fields and
  // then dead-end on "set up the secure connector", sending someone to a
  // profile page to do something the app could have done itself. ensureConnector
  // is idempotent: it reuses the stored keypair and re-registers the public half.
  useEffect(() => {
    const token = getVaultOwnerToken();
    if (
      !user?.uid ||
      !vaultKey ||
      !token ||
      shouldSkipReviewerBackgroundWritesForAutomation()
    ) return;
    let cancelled = false;
    void (async () => {
      try {
        await OneKycClientZkService.ensureConnector({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken: token,
        });
      } catch {
        // Never surfaced: the request path still reports the missing connector
        // itself, and a failure here must not disturb an unrelated turn.
      }
    })();
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, [user?.uid, vaultKey, getVaultOwnerToken]);

  useEffect(() => {
    if (!user) {
      setModelPreference(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const preference = await ModelPreferenceService.get(await user.getIdToken());
        if (!cancelled) setModelPreference(preference);
      } catch {
        // A picker that cannot load is non-blocking: the turn still runs on
        // whatever the backend resolves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea || voiceActive) return;
    textarea.style.height = "0px";
    const nextHeight = textarea.scrollHeight;
    if (!input.trim()) setComposerExpanded(false);
    // The compact pill grows to its CSS ceiling; text that outgrows it moves
    // into the expanded writing surface (the same place the expand button
    // opens) instead of scrolling inside the pill, which drew a scrollbar
    // beside the expand icon (founder report, 2026-09-22).
    const compactCeiling = Number.parseFloat(
      window.getComputedStyle(textarea).maxHeight,
    );
    if (
      !composerExpanded &&
      Number.isFinite(compactCeiling) &&
      nextHeight > compactCeiling + 1
    ) {
      setComposerExpanded(true);
      return;
    }
    // The expanded writing surface owns its fixed, spacious height.
    textarea.style.height = composerExpanded ? "" : `${nextHeight}px`;
  }, [composerExpanded, input, voiceActive]);

  useEffect(() => {
    if (!composerExpanded) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      // Keep typing where the person was: at the end of what they wrote.
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composerExpanded]);

  useEffect(() => {
    return () => {
      abortAgentTurnWork();
    };
  }, [abortAgentTurnWork]);

  useEffect(() => {
    const unsubscribe = AppBackgroundTaskService.subscribe((state) => {
      setBackgroundTaskState(state);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setHasPortfolioData(false);
      return;
    }

    const cache = CacheService.getInstance();
    const computeHasPortfolioData = () => {
      const cachedPortfolio =
        cache.get<Record<string, unknown>>(
          CACHE_KEYS.PORTFOLIO_DATA(user.uid),
        ) ??
        cache.get<Record<string, unknown>>(
          CACHE_KEYS.DOMAIN_DATA(user.uid, "financial"),
        );
      const nestedPortfolio =
        cachedPortfolio?.portfolio &&
        typeof cachedPortfolio.portfolio === "object" &&
        !Array.isArray(cachedPortfolio.portfolio)
          ? (cachedPortfolio.portfolio as Record<string, unknown>)
          : null;
      const holdings =
        (Array.isArray(cachedPortfolio?.holdings) &&
          cachedPortfolio.holdings) ||
        (Array.isArray(nestedPortfolio?.holdings) &&
          nestedPortfolio.holdings) ||
        [];
      setHasPortfolioData(holdings.length > 0);
    };

    computeHasPortfolioData();
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.type === "set" ||
        event.type === "invalidate" ||
        event.type === "invalidate_user" ||
        event.type === "clear"
      ) {
        computeHasPortfolioData();
      }
    });
    return () => unsubscribe();
  }, [user?.uid]);

  const welcomePrompts = useMemo(
    () => getWelcomePrompts(welcomePromptSetIndex, { hasPortfolioData }),
    [hasPortfolioData, welcomePromptSetIndex],
  );

  useEffect(() => {
    if (welcomePromptSetInitializedRef.current) return;
    welcomePromptSetInitializedRef.current = true;
    setWelcomePromptSetIndex(getWelcomePromptSetIndex(null));
  }, []);

  useEffect(() => {
    abortAgentTurnWork();
    clearTranscriptProgrammaticScroll();
    transcriptUserScrollRef.current = false;
    oneScrollTopRef.current = 0;
    setIsChatLoading(false);
    setIsLoadingHistory(false);
    setIsVoiceConnecting(false);
    setIsStreaming(false);
    setActiveFrontendToolCount(0);
    setActivePkmToolCount(0);
    setWalletWidgets([]);
    updateConversationId(null);
    setConversations([]);
    setHistoryActionPendingId(null);
    setMessages([createGreetingMessage()]);
    setPendingAppAction(null);
    setAppActionBusy(false);
    setPendingSpecialistDirective(null);
    setSpecialistBusy(false);
    setSpecialistBusyItemId(null);
    operationQueueRef.current.replace([]);
    calendarActionIdsRef.current.clear();
    setQueuedPrompts([]);
    setEditingQueuedPromptId(null);
    setEditingQueuedPromptText("");
    historyLoadKeyRef.current = null;
    historyRestoreEpochRef.current += 1;
    skipInitialHistoryLoadRef.current = false;
    latestVisibleTurnIdRef.current = null;
    inlineConsentRequestIdsRef.current.clear();
  }, [
    abortAgentTurnWork,
    clearTranscriptProgrammaticScroll,
    isVaultUnlocked,
    updateConversationId,
    user?.uid,
  ]);

  const handleCreateNewChat = useCallback(() => {
    abortAgentTurnWork();
    clearTranscriptProgrammaticScroll();
    transcriptUserScrollRef.current = false;
    oneScrollTopRef.current = 0;
    historyRestoreEpochRef.current += 1;
    latestVisibleTurnIdRef.current = null;
    updateConversationId(null);
    setMessages([createGreetingMessage()]);
    setInput("");
    setIsLoadingHistory(false);
    setWalletWidgets([]);
    setPendingAppAction(null);
    setAppActionBusy(false);
    setPendingSpecialistDirective(null);
    setEmailDraftOpen(false);
    setEmailDraftInitialValue(null);
    setEmailDraftAnchorMessageId(null);
    setGmailKycReplyRequest(null);
    setGmailKycEmailDraftWorkflowId(null);
    setGmailKycMissingLabels([]);
    setIsGmailKycSaving(false);
    setEmailDeliveryHistory([]);
    setSpecialistBusy(false);
    operationQueueRef.current.replace([]);
    calendarActionIdsRef.current.clear();
    setQueuedPrompts([]);
    setEditingQueuedPromptId(null);
    setEditingQueuedPromptText("");
    setWelcomePromptSetIndex((current) => getWelcomePromptSetIndex(current));
  }, [
    abortAgentTurnWork,
    clearTranscriptProgrammaticScroll,
    updateConversationId,
  ]);

  const updateMessage = (
    messageId: string,
    update: (message: AgentMessage) => AgentMessage,
  ) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? update(message) : message,
      ),
    );
  };

  const appendMessage = (message: AgentMessage) => {
    setMessages((current) => [...current, message]);
  };

  const prepareGmailKycReply = useCallback(
    async (
      request: GmailInformationRequestHandoff,
      assistantMessageId: string,
      options: { retryCandidateResolution?: boolean } = {},
    ) => {
      if (!user?.uid || !vaultKey || !vaultOwnerToken) return;

      setIsGmailKycSaving(true);
      try {
        let workflow = request;
        let draft = await prepareScopedGmailInformationRequestDraft({
          workflow,
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
        });
        // The scan already supplied exact candidates. Re-resolving them for
        // every click adds a slow metadata round trip without making the
        // initial draft safer. Only retry after a just-completed PKM write
        // failed to satisfy one of those candidates.
        if (
          options.retryCandidateResolution &&
          (!draft.body || draft.unavailableLabels.length > 0)
        ) {
          const firebaseIdToken = await user.getIdToken();
          const refreshed = await GmailInformationRequestsService.refreshCandidates({
            firebaseIdToken,
            vaultOwnerToken,
            workflowId: request.workflow_id,
          });
          workflow = {
            ...request,
            candidate_scopes: refreshed.candidate_scopes,
          };
          draft = await prepareScopedGmailInformationRequestDraft({
            workflow,
            userId: user.uid,
            vaultKey,
            vaultOwnerToken,
          });
        }
        const unavailableLabels = draft.unavailableLabels
          .map((label) => label.trim())
          .filter(Boolean);

        if (!draft.body || unavailableLabels.length > 0) {
          setEmailDraftOpen(false);
          setGmailKycEmailDraftWorkflowId(null);
          setGmailKycMissingLabels(
            unavailableLabels.length > 0
              ? unavailableLabels
              : request.requested_field_labels,
          );
          updateMessage(assistantMessageId, (message) => ({
            ...message,
            text: `I couldn’t find ${(unavailableLabels.length > 0 ? unavailableLabels : request.requested_field_labels).join(", ")} in your private memory. Reply here with only the details you want to share, and I’ll save them privately before preparing the Mail reply.`,
            status: "done",
          }));
          return;
        }

        setGmailKycMissingLabels([]);
        const requestSummary = gmailKycRequestSummary(workflow);
        setEmailDraftInstruction(
          `Replying to the selected Mail request. Requested: ${requestSummary}.`,
        );
        setEmailDraftInitialValue({
          to: "",
          cc: "",
          bcc: "",
          subject: "",
          body: draft.body,
        });
        setEmailDraftAutoDraft(false);
        setGmailKycEmailDraftWorkflowId(request.workflow_id);
        setEmailDraftAnchorMessageId(assistantMessageId);
        setEmailDraftOpen(true);
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: "I found the matching private details. Your editable reply to the selected Mail request is ready below.",
          status: "done",
        }));
      } catch {
        setEmailDraftOpen(false);
        setGmailKycEmailDraftWorkflowId(null);
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: "I couldn’t prepare the Mail reply right now. Please try again.",
          status: "error",
        }));
      } finally {
        setIsGmailKycSaving(false);
      }
    },
    [user, vaultKey, vaultOwnerToken],
  );

  const submitGmailKycDetails = async (details: string) => {
    const request = gmailKycReplyRequest;
    if (!request || !user?.uid || !vaultKey || !vaultOwnerToken) return;
    const timestamp = formatNow();
    const userMessageId = `gmail-kyc-details-${request.workflow_id}-${Date.now()}`;
    const assistantMessageId = `${userMessageId}-assistant`;
    const missingLabels = gmailKycMissingLabels.length > 0
      ? gmailKycMissingLabels
      : request.requested_field_labels;
    // The person has already answered this prompt. Clear it before the PKM
    // write begins so the disabled composer never asks for the same details.
    setGmailKycMissingLabels([]);
    appendMessage({
      id: userMessageId,
      role: "user",
      text: details,
      timestamp,
      status: "done",
      ephemeral: true,
    });
    appendMessage({
      id: assistantMessageId,
      role: "assistant",
      text: `Saving those details privately and preparing a reply to the selected Mail request for ${gmailKycRequestSummary(request)}…`,
      timestamp,
      status: "streaming",
      ephemeral: true,
      renderAsPlainAssistantMessage: true,
    });
    setIsGmailKycSaving(true);
    try {
      const saved = await KycIdentityProfilePkmService.saveProfile({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        profile: { aboutMe: details },
      });
      if (!saved.success) {
        throw new Error(saved.message || "One could not save those private details.");
      }
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: "Finding the matching private details and preparing the reply in the original Mail thread…",
        status: "streaming",
      }));
      await prepareGmailKycReply(request, assistantMessageId, {
        retryCandidateResolution: true,
      });
    } catch (error) {
      setGmailKycMissingLabels(missingLabels);
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text:
          error instanceof Error
            ? error.message
            : "One could not save those private details. Edit them and try again.",
        status: "error",
      }));
    } finally {
      setIsGmailKycSaving(false);
    }
  };

  const closeEmailDraft = () => {
    setEmailDraftOpen(false);
    setEmailDraftInstruction("");
    setEmailDraftAutoDraft(false);
    setEmailDraftInitialValue(null);
    setEmailDraftAnchorMessageId(null);
    setGmailKycEmailDraftWorkflowId(null);
  };

  const handleEmailSendStarted = (draft: EmailDraft): string => {
    const id = `email-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setEmailDeliveryHistory((current) => [
      ...current,
      {
        id,
        instruction: emailDraftInstruction,
        draft,
        status: "sending",
        sourceBoundWorkflowId: gmailKycEmailDraftWorkflowId,
        anchorMessageId:
          emailDraftAnchorMessageId ??
          [...messages].reverse().find((message) => message.role === "user")
            ?.id ??
          null,
      },
    ]);
    closeEmailDraft();
    return id;
  };

  const handleEmailSent = (attemptId?: string | null) => {
    if (!attemptId) return;
    setEmailDeliveryHistory((current) =>
      current.map((item) =>
        item.id === attemptId
          ? { ...item, status: "sent", errorMessage: null }
          : item,
      ),
    );
  };

  const handleEmailSendFailed = (
    error: EmailDeliveryError,
    attemptId?: string | null,
  ) => {
    if (!attemptId) return;
    setEmailDeliveryHistory((current) =>
      current.map((item) =>
        item.id === attemptId
          ? {
              ...item,
              status:
                error.code === "EMAIL_ACTION_OUTCOME_UNKNOWN"
                  ? "outcome_unknown"
                  : "failed",
              errorMessage: error.message,
              errorCode: error.code,
            }
          : item,
      ),
    );
  };

  const retryEmailDelivery = (item: EmailDeliveryHistoryItem) => {
    const anchorMessageId =
      emailDeliveryHistory.find((candidate) => candidate.id === item.id)
        ?.anchorMessageId ?? null;
    setEmailDraftInstruction(item.instruction);
    setEmailDraftInitialValue(item.draft);
    setEmailDraftAutoDraft(false);
    setEmailDraftAnchorMessageId(anchorMessageId);
    setGmailKycEmailDraftWorkflowId(item.sourceBoundWorkflowId ?? null);
    setEmailDraftOpen(true);
  };

  const openGmailEmailDraftFromDirective = useCallback(
    (event: AgentChatToolEvent, assistantMessageId: string): boolean => {
      const payload = getGmailEmailDraftPayload(event);
      if (!payload) return false;
      if (!hasChatAccess) {
        if (user) setVaultDialogOpen(true);
        else router.push(ROUTES.LOGIN);
        return true;
      }
      setEmailDraftInstruction(payload.instruction);
      setEmailDraftInitialValue(payload.driveFileId
        ? { to: "", cc: "", bcc: "", subject: "", body: "", driveFileId: payload.driveFileId }
        : null);
      setEmailDraftAutoDraft(true);
      setEmailDraftAnchorMessageId(assistantMessageId);
      setEmailDraftOpen(true);
      return true;
    },
    [hasChatAccess, router, user],
  );

  const upsertMessageStreamEvent = (
    messageId: string,
    event: AgentVisibleStreamEvent,
  ) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              streamEvents: upsertVisibleStreamEvent(
                message.streamEvents,
                event,
              ),
            }
          : message,
      ),
    );
  };

  useEffect(() => {
    if (!handoff || consumedHandoffIdRef.current === handoff.id) return;
    consumedHandoffIdRef.current = handoff.id;
    // Every handoff is One speaking. Landing one behind the Puppy surface
    // would run a cloud turn under a header that says "on your machine", which
    // is the one thing this tier promises never happens -- and its confirmation
    // card, its queued prompt and its vault dialog would all be invisible or
    // over the wrong agent. Placed AFTER the dedupe guard on purpose, so a
    // re-render carrying an already-consumed handoff cannot yank the surface
    // away from someone who just toggled to Puppy. Setting "one" while already
    // "one" is a React bail-out, so no dependency changes and no loop.
    setAgentSurface("one");
    const timestamp = formatNow();
    const nextMessages: AgentMessage[] = [];
    const transcript = handoff.transcript?.trim();
    const emailDraftInstruction = handoff.emailDraftInstruction?.trim();
    const assistantText = handoff.assistantText?.trim();
    const resultSummary = handoff.resultSummary?.trim();
      const gmailInformationRequest = handoff.gmailInformationRequest ?? null;
      if (handoff.reason === "user_requested" && gmailInformationRequest) {
      if (!hasChatAccess || !user?.uid || !vaultKey || !vaultOwnerToken) {
        consumedHandoffIdRef.current = null;
        if (user) setVaultDialogOpen(true);
        else router.push(ROUTES.LOGIN);
        return;
      }
      const shouldSkipInitialHistoryLoad = historyLoadKeyRef.current === null;
      handleCreateNewChat();
      skipInitialHistoryLoadRef.current = shouldSkipInitialHistoryLoad;
      const handoffMessageId = `handoff-${handoff.id}-assistant`;
      setGmailKycReplyRequest(gmailInformationRequest);
      setGmailKycEmailDraftWorkflowId(null);
      setGmailKycMissingLabels([]);
      const requestedFields = gmailKycRequestSummary(gmailInformationRequest);
      setMessages((current) => [
        ...current,
        {
          id: handoffMessageId,
          role: "assistant",
          text: `I’m replying in the selected Mail thread. This request asks for: ${requestedFields}. I’ll use only matching private details, and you can review the response before it sends.`,
          timestamp,
          status: "done",
          ephemeral: true,
          renderAsPlainAssistantMessage: true,
        },
      ]);
      void prepareGmailKycReply(gmailInformationRequest, handoffMessageId);
      consumeHandoff(handoff.id);
      return;
    }
    if (handoff.reason === "user_requested" && emailDraftInstruction) {
      if (!hasChatAccess) {
        consumedHandoffIdRef.current = null;
        if (user) setVaultDialogOpen(true);
        else router.push(ROUTES.LOGIN);
        return;
      }
      const shouldSkipInitialHistoryLoad = historyLoadKeyRef.current === null;
      handleCreateNewChat();
      skipInitialHistoryLoadRef.current = shouldSkipInitialHistoryLoad;
      setQueuedHandoffPrompt(emailDraftInstruction);
      consumeHandoff(handoff.id);
      return;
    }
    if (handoff.reason === "user_requested" && transcript) {
      const shouldSkipInitialHistoryLoad = historyLoadKeyRef.current === null;
      handleCreateNewChat();
      skipInitialHistoryLoadRef.current = shouldSkipInitialHistoryLoad;
      setQueuedHandoffPrompt(transcript);
      consumeHandoff(handoff.id);
      return;
    }
    if (transcript) {
      nextMessages.push({
        id: `handoff-${handoff.id}-user`,
        role: "user",
        text: transcript,
        timestamp,
      });
    }
    // The owner reads the action's label, never its identifier.
    const handoffActionLabel = handoff.actionId
      ? getKaiActionById(handoff.actionId)?.label?.trim() || null
      : null;
    // Only a handoff that waits on the owner may promise a confirmation; a
    // long-running or delegated one simply continues here.
    const handoffOwesConfirmation =
      handoff.reason === "action_requires_chat" ||
      handoff.reason === "sensitive_action" ||
      handoff.reason === "manual_only";
    const handoffPurpose = handoffOwesConfirmation
      ? "so you can confirm it here"
      : "so you can finish it here";
    const summaryText =
      assistantText ||
      resultSummary ||
      (handoffActionLabel
        ? `One moved "${handoffActionLabel}" into chat ${handoffPurpose}.`
        : `One moved this command into chat ${handoffPurpose}.`);
    nextMessages.push({
      id: `handoff-${handoff.id}-assistant`,
      role: "assistant",
      text: summaryText,
      timestamp,
      status: "done",
    });
    if (
      handoff.specialistDirective &&
      (handoff.specialistDirective.delegateAgentId !== "agent_connected_systems" ||
        localCrmEnabled)
    ) {
      setPendingSpecialistDirective(handoff.specialistDirective);
    }
    setMessages((current) => [...current, ...nextMessages]);
    consumeHandoff(handoff.id);
  }, [
    consumeHandoff,
    handoff,
    handleCreateNewChat,
    hasChatAccess,
    prepareGmailKycReply,
    router,
    localCrmEnabled,
    user,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || !rootChatReady) return;

    let cancelled = false;

    const appendPendingConsentRequest = async (requestId: string) => {
      const normalizedRequestId = requestId.trim();
      if (
        !normalizedRequestId ||
        inlineConsentRequestIdsRef.current.has(normalizedRequestId)
      ) {
        return;
      }
      inlineConsentRequestIdsRef.current.add(normalizedRequestId);

      const token = getVaultOwnerToken();
      if (!token) {
        inlineConsentRequestIdsRef.current.delete(normalizedRequestId);
        return;
      }

      try {
        const result = await ConsentCenterService.lookupPendingRequests({
          userId: user.uid,
          vaultOwnerToken: token,
          requestIds: [normalizedRequestId],
        });
        if (cancelled) return;
        const item = result.items
          .map(pendingConsentLookupItemToCardItem)
          .find((candidate): candidate is SpecialistPendingConsentRequestItem =>
            Boolean(candidate),
          );
        if (!item) {
          inlineConsentRequestIdsRef.current.delete(normalizedRequestId);
          return;
        }

        const event: SpecialistDirectiveEvent = {
          delegateAgentId: "agent_nav",
          directive: {
            kind: "prompt",
            payload: {
              kind: "pending_consent_request",
              item,
            },
          },
          message: `${item.requesterLabel} is asking for access. Review the request here in Agent One.`,
          stateChanged: true,
        };

        setMessages((current) => {
          if (
            current.some(
              (message) =>
                agentMessagePendingConsentRequestId(message) === item.id,
            )
          ) {
            return current;
          }

          // One ask, one card. When this request belongs to a bundle a card is
          // already showing, fold it into that card's list rather than stacking
          // another Approve button underneath the last one.
          if (item.bundleId) {
            const existingIndex = current.findIndex((message) => {
              if (!message.specialistDirective) return false;
              const payload = getPendingConsentRequestPayload(message.specialistDirective);
              return payload?.item?.bundleId === item.bundleId;
            });
            if (existingIndex >= 0) {
              const existing = current[existingIndex]!;
              const payload = existing.specialistDirective
                ? getPendingConsentRequestPayload(existing.specialistDirective)
                : null;
              const previous = payload?.item;
              if (previous) {
                const mergedItem: SpecialistPendingConsentRequestItem = {
                  ...previous,
                  bundledRequestIds: [
                    ...new Set([...(previous.bundledRequestIds || []), ...(item.bundledRequestIds || [])]),
                  ],
                  bundledScopes: mergeScopeItems(
                    previous.bundledScopes || [],
                    item.bundledScopes || [],
                  ),
                };
                const next = [...current];
                next[existingIndex] = {
                  ...existing,
                  specialistDirective: {
                    ...existing.specialistDirective!,
                    directive: {
                      ...existing.specialistDirective!.directive,
                      payload: { kind: "pending_consent_request", item: mergedItem },
                    },
                  },
                };
                return next;
              }
            }
          }

          return [
            ...current,
            {
              id: `msg-${Date.now()}-pending-consent-${item.id}`,
              role: "assistant",
              text: event.message,
              timestamp: formatNow(),
              status: "done",
              specialistDirective: event,
            },
          ];
        });
      } catch (error) {
        inlineConsentRequestIdsRef.current.delete(normalizedRequestId);
        console.warn(
          "[AgentChatWorkspace] Failed to hydrate pending consent request:",
          error,
        );
      }
    };

    const handleConsentMessage = (event: Event) => {
      const customEvent = event as CustomEvent<{
        data?: Record<string, unknown>;
      }>;
      const data = customEvent.detail?.data;
      if (!data) return;
      const type = String(data.type || "").trim();
      const requestId = String(data.request_id || "").trim();
      if (!requestId) return;
      if (type === "consent_request") {
        void appendPendingConsentRequest(requestId);
        return;
      }
      if (type === "consent_resolved") {
        const action = String(data.action || "")
          .trim()
          .toUpperCase();
        const status =
          action === "CONSENT_GRANTED"
            ? "approved"
            : action === "CONSENT_DENIED"
              ? "denied"
              : null;
        if (!status) return;
        setMessages((current) =>
          current.map((message) => ({
            ...message,
            specialistDirective: markPendingConsentRequestDirectiveStatus(
              message.specialistDirective,
              requestId,
              status,
            ),
          })),
        );
      }
    };

    const reconcilePendingConsentRequests = async () => {
      const token = getVaultOwnerToken();
      if (!token) return;
      try {
        const response = await ApiService.getPendingConsents(user.uid, token);
        const payload = (await response.json().catch(() => ({}))) as {
          pending?: Array<{ id?: string; request_id?: string }>;
        };
        if (!response.ok || cancelled) return;
        for (const item of Array.isArray(payload.pending) ? payload.pending : []) {
          const requestId = String(item.id || item.request_id || "").trim();
          if (requestId) void appendPendingConsentRequest(requestId);
        }
      } catch {
        // FCM and the next explicit consent refresh remain authoritative. A
        // failed reconciliation must not block Chat or create a fake card.
      }
    };

    const handleConsentStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      const requestId = String(detail?.requestId || "").trim();
      const action = String(detail?.action || "").trim().toLowerCase();
      if (!requestId || (action !== "approve" && action !== "deny")) return;
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          specialistDirective: markPendingConsentRequestDirectiveStatus(
            message.specialistDirective,
            requestId,
            action === "approve" ? "approved" : "denied",
          ),
        })),
      );
    };

    appendPendingConsentRequestRef.current = appendPendingConsentRequest;
    window.addEventListener(FCM_MESSAGE_EVENT, handleConsentMessage);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleConsentStateChanged);
    void reconcilePendingConsentRequests();
    return () => {
      cancelled = true;
      appendPendingConsentRequestRef.current = null;
      window.removeEventListener(FCM_MESSAGE_EVENT, handleConsentMessage);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleConsentStateChanged);
    };
  }, [getVaultOwnerToken, isVaultUnlocked, rootChatReady, user?.uid]);

  const appendDebugEvent = useCallback(
    (
      _turnId: string,
      _event: AgentDebugEvent["event"],
      _payload: AgentDebugEvent["payload"],
    ) => {
      // Debug events are intentionally kept internal while the Agent debug UI is disabled.
    },
    [],
  );

  const addErrorMessage = (text: string) => {
    appendMessage({
      id: `msg-${Date.now()}-assistant-error`,
      role: "assistant",
      text,
      timestamp: formatNow(),
      status: "error",
    });
  };

  useEffect(() => {
    if (
      !hasChatAccess ||
      !user?.uid ||
      !vaultOwnerToken ||
      recoveryCheckedForUid !== user.uid
    ) return;
    const loadKey = `${user.uid}:${vaultOwnerToken.slice(0, 12)}`;
    if (skipInitialHistoryLoadRef.current) {
      skipInitialHistoryLoadRef.current = false;
      historyLoadKeyRef.current = loadKey;
      return;
    }
    if (historyLoadKeyRef.current === loadKey) return;
    const restoreEpoch = historyRestoreEpochRef.current;
    let cancelled = false;
    const cached = peekAgentChatHistoryCache(user.uid);

    const applySnapshot = (snapshot: NonNullable<typeof cached>) => {
      if (cancelled || restoreEpoch !== historyRestoreEpochRef.current) return;
      setConversations(snapshot.conversations);
      if (!snapshot.latestConversationId) {
        updateConversationId(null);
        setMessages((current) =>
          mergePendingConsentMessages([createGreetingMessage()], current),
        );
        return;
      }
      const restored = storedMessagesToAgentMessages(snapshot.latestMessages);
      updateConversationId(snapshot.latestConversationId);
      setMessages((current) =>
        mergePendingConsentMessages(
          restored.length > 0 ? restored : [createGreetingMessage()],
          current,
        ),
      );
    };

    if (cached) applySnapshot(cached);

    const loadRecentConversation = async () => {
      if (skipInitialHistoryLoadRef.current) {
        skipInitialHistoryLoadRef.current = false;
        historyLoadKeyRef.current = loadKey;
        return;
      }
      historyLoadKeyRef.current = loadKey;
      setIsLoadingHistory(true);
      try {
        const next = await warmAgentChatHistoryCache({
          userId: user.uid,
          vaultOwnerToken,
          force: cached ? !cached.isFresh : false,
        });
        applySnapshot(next);
      } catch {
        if (!cancelled && restoreEpoch === historyRestoreEpochRef.current) {
          historyLoadKeyRef.current = null;
        }
      } finally {
        if (!cancelled && restoreEpoch === historyRestoreEpochRef.current) {
          setIsLoadingHistory(false);
        }
      }
    };

    // History is never on the workspace's critical open/render path. Unlock
    // warming usually makes this an immediate memory hit; cold sessions wait
    // for an idle beat so the composer and direct Ask One handoff stay usable.
    const timeoutId = window.setTimeout(
      () => {
        void loadRecentConversation();
      },
      cached ? 0 : 250,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [hasChatAccess, recoveryCheckedForUid, updateConversationId, user?.uid, vaultOwnerToken]);

  const restoreConversationMessages = useCallback(
    async (
      nextConversationId: string,
      token: string,
      isCurrent: () => boolean = () => true,
    ) => {
      if (!user?.uid) return;
      clearTranscriptProgrammaticScroll();
      transcriptUserScrollRef.current = false;
      oneScrollTopRef.current = 0;
      const history = await loadAgentChatConversationHistory({
        userId: user.uid,
        conversationId: nextConversationId,
        vaultOwnerToken: token,
      });
      if (!isCurrent()) return;
      const restored = storedMessagesToAgentMessages(history);
      latestVisibleTurnIdRef.current = null;
      updateConversationId(nextConversationId);
      setMessages(restored.length > 0 ? restored : [createGreetingMessage()]);
      setEmailDraftOpen(false);
      setEmailDraftInstruction("");
      setEmailDraftAutoDraft(false);
      setEmailDraftInitialValue(null);
      setEmailDraftAnchorMessageId(null);
      setEmailDeliveryHistory([]);
      setWalletWidgets([]);
    setWalletWidgets([]);
      setPendingSpecialistDirective(null);
      setSpecialistBusy(false);
    },
    [
      clearTranscriptProgrammaticScroll,
      updateConversationId,
      user?.uid,
    ],
  );

  useEffect(() => {
    if (
      !rootChatReady ||
      !user?.uid ||
      !vaultKey ||
      !vaultOwnerToken ||
      recoveryCheckedForUid === user.uid
    ) return;
    let cancelled = false;
    const ownerUid = user.uid;
    void (async () => {
      const existing = pendingDriveRecoveryRef.current;
      const state = existing?.ownerUid === ownerUid
        ? existing.state
        : await takeDriveChatRecovery({ ownerUserId: ownerUid, vaultKey });
      if (state) pendingDriveRecoveryRef.current = { ownerUid, state };
      if (cancelled) return;
      if (state) {
        const mayRestore = () => !cancelled &&
          currentDraftRef.current.input === "" &&
          currentDraftRef.current.attachment === null;
        if (!mayRestore()) {
          pendingDriveRecoveryRef.current = null;
          setRecoveryCheckedForUid(ownerUid);
          return;
        }
        historyRestoreEpochRef.current += 1;
        skipInitialHistoryLoadRef.current = true;
        if (state.conversationId) {
          try {
            await restoreConversationMessages(
              state.conversationId,
              getVaultOwnerToken() || vaultOwnerToken,
              mayRestore,
            );
          } catch {
            // Preserve the draft even if the selected history is temporarily
            // unavailable. No fabricated transcript is shown.
            if (mayRestore()) {
              updateConversationId(null);
              setMessages([createGreetingMessage()]);
            }
          }
        } else {
          if (mayRestore()) {
            updateConversationId(null);
            setMessages([createGreetingMessage()]);
          }
        }
        if (cancelled) return;
        if (!mayRestore()) {
          pendingDriveRecoveryRef.current = null;
          setRecoveryCheckedForUid(ownerUid);
          return;
        }
        setInput(state.input);
        setLongPromptAttachment(state.attachment);
        setComposerExpanded(state.composerExpanded);
        setDrawerMode(state.drawerMode);
        setIsHistoryDrawerOpen(state.drawerOpen);
        setRecoveryScrollTop(state.scrollTop);
        pendingDriveRecoveryRef.current = null;
      }
      if (!cancelled) setRecoveryCheckedForUid(ownerUid);
    })().catch(() => {
      if (!cancelled && pendingDriveRecoveryRef.current?.ownerUid !== ownerUid)
        setRecoveryCheckedForUid(ownerUid);
    });
    return () => { cancelled = true; };
  }, [
    recoveryCheckedForUid,
    getVaultOwnerToken,
    restoreConversationMessages,
    rootChatReady,
    updateConversationId,
    user?.uid,
    vaultKey,
    vaultOwnerToken,
  ]);

  const prepareDriveChatRecovery = useCallback(async (request: {
    attemptId: string;
    reason: DriveChatRecoveryReason;
  }): Promise<"ready" | "busy" | "unavailable"> => {
    if (
      !user?.uid ||
      !vaultKey ||
      !hasChatAccess ||
      isPuppySurface ||
      historyInteractionDisabled ||
      isPkmMemoryWorking ||
      isLoadingHistory ||
      activeActionRun ||
      pendingAppAction ||
      pendingSpecialistDirective ||
      emailDraftOpen ||
      isGmailKycSaving ||
      gmailKycReplyRequest ||
      queuedHandoffPrompt ||
      connectorExternalModalOpen
    ) return "busy";
    try {
      const state = {
        conversationId,
        input,
        attachment: longPromptAttachment,
        composerExpanded,
        scrollTop: Math.min(10_000_000, Math.max(0, transcriptRef.current?.scrollTop ?? oneScrollTopRef.current)),
        drawerOpen: isHistoryDrawerOpen,
        drawerMode,
      };
      await saveDriveChatRecovery({
        ownerUserId: user.uid,
        vaultKey,
        attemptId: request.attemptId,
        reason: request.reason,
        state,
      });
      const live = recoveryUiRef.current;
      const draft = currentDraftRef.current;
      if (
        draft.input !== state.input ||
        draft.attachment?.text !== state.attachment?.text ||
        draft.attachment?.isExpanded !== state.attachment?.isExpanded ||
        live.conversationId !== state.conversationId ||
        live.composerExpanded !== state.composerExpanded ||
        live.drawerOpen !== state.drawerOpen ||
        live.drawerMode !== state.drawerMode ||
        (transcriptRef.current?.scrollTop ?? oneScrollTopRef.current) !== state.scrollTop
      ) {
        await clearDriveChatRecovery(user.uid);
        return "unavailable";
      }
      return "ready";
    } catch {
      return "unavailable";
    }
  }, [
    activeActionRun, composerExpanded, connectorExternalModalOpen,
    conversationId, drawerMode, emailDraftOpen, gmailKycReplyRequest,
    hasChatAccess, historyInteractionDisabled, input,
    isGmailKycSaving, isHistoryDrawerOpen, isLoadingHistory, isPkmMemoryWorking,
    isPuppySurface, longPromptAttachment, pendingAppAction,
    pendingSpecialistDirective, queuedHandoffPrompt, user?.uid, vaultKey,
  ]);

  const clearPreparedDriveChatRecovery = useCallback(async () => {
    if (user?.uid) await clearDriveChatRecovery(user.uid);
  }, [user?.uid]);

  const loadConversationList = useCallback(
    async (force = false) => {
      if (!user?.uid) return [];
      const token = getVaultOwnerToken();
      if (!token) return [];
      setIsLoadingHistory(true);
      try {
        const next = await warmAgentChatHistoryCache({
          userId: user.uid,
          vaultOwnerToken: token,
          force,
        });
        setConversations(next.conversations);
        return next.conversations;
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [getVaultOwnerToken, user?.uid],
  );

  const handleSelectConversation = useCallback(
    async (nextConversationId: string) => {
      if (nextConversationId === conversationId || historyInteractionDisabled)
        return;
      const token = getVaultOwnerToken();
      if (!token) {
        toast.error("Vault access expired. Unlock again to continue.");
        return;
      }
      abortAgentTurnWork();
      setIsLoadingHistory(true);
      try {
        await restoreConversationMessages(nextConversationId, token);
      } catch {
        toast.error("Could not load Agent chat.");
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [
      conversationId,
      abortAgentTurnWork,
      getVaultOwnerToken,
      historyInteractionDisabled,
      restoreConversationMessages,
    ],
  );

  const handleCreateNewPuppyChat = puppyHistory.create;
  const handleSelectPuppyConversation = puppyHistory.select;
  const handleRenamePuppyConversation = (id: string, title: string) => {
    puppyHistory.rename(id, title);
  };
  const handleDeletePuppyConversation = (id: string) => {
    puppyHistory.remove(id);
  };

  const handleSidebarCreateNewChat = useCallback(() => {
    setIsHistoryDrawerOpen(false);
    if (isPuppySurface) {
      handleCreateNewPuppyChat();
      return;
    }
    setAgentSurface("one");
    handleCreateNewChat();
  }, [handleCreateNewChat, handleCreateNewPuppyChat, isPuppySurface]);

  const handleSidebarSelectConversation = useCallback(
    (nextConversationId: string) => {
      setIsHistoryDrawerOpen(false);
      if (isPuppySurface) {
        handleSelectPuppyConversation(nextConversationId);
        return;
      }
      setAgentSurface("one");
      void handleSelectConversation(nextConversationId);
    },
    [handleSelectConversation, handleSelectPuppyConversation, isPuppySurface],
  );

  const handleRenameConversation = useCallback(
    async (targetConversationId: string, title: string) => {
      const token = getVaultOwnerToken();
      if (!token) {
        toast.error("Vault access expired. Unlock again to continue.");
        return;
      }
      setHistoryActionPendingId(targetConversationId);
      try {
        const renamed = await renameAgentChatConversation({
          conversationId: targetConversationId,
          title,
          vaultOwnerToken: token,
        });
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === targetConversationId ? renamed : conversation,
          ),
        );
        void loadConversationList(true).catch(() => undefined);
        toast.success("Agent chat renamed.");
      } catch {
        toast.error("Could not rename Agent chat.");
      } finally {
        setHistoryActionPendingId(null);
      }
    },
    [getVaultOwnerToken, loadConversationList],
  );

  const handleDeleteConversation = useCallback(
    async (targetConversationId: string) => {
      if (historyInteractionDisabled) return;
      const token = getVaultOwnerToken();
      if (!token || !user?.uid) {
        toast.error("Vault access expired. Unlock again to continue.");
        return;
      }
      if (conversationId === targetConversationId) {
        abortAgentTurnWork();
      }
      setHistoryActionPendingId(targetConversationId);
      try {
        await deleteAgentChatConversation({
          conversationId: targetConversationId,
          vaultOwnerToken: token,
        });
        const refreshed = await warmAgentChatHistoryCache({
          userId: user.uid,
          vaultOwnerToken: token,
          force: true,
        });
        const nextConversations = refreshed.conversations;
        setConversations(nextConversations);
        if (conversationId === targetConversationId) {
          const nextConversation = nextConversations[0];
          if (nextConversation) {
            await restoreConversationMessages(nextConversation.id, token);
          } else {
            handleCreateNewChat();
          }
        }
        toast.success("Agent chat deleted.");
      } catch {
        toast.error("Could not delete Agent chat.");
      } finally {
        setHistoryActionPendingId(null);
      }
    },
    [
      conversationId,
      abortAgentTurnWork,
      getVaultOwnerToken,
      handleCreateNewChat,
      historyInteractionDisabled,
      restoreConversationMessages,
      user?.uid,
    ],
  );

  /**
   * Reveal one card from the chat list widget. Decryption happens here, on the
   * owner's device, and the secrets go straight into a reveal widget: they are
   * never written into a message, model context, history, or telemetry.
   */
  const handleWalletWidgetReveal = useCallback(
    async (listWidgetId: string, summary: WalletCardSummary) => {
      const token = getVaultOwnerToken();
      if (!user?.uid || !vaultKey || !token) {
        setVaultDialogOpen(true);
        return;
      }
      try {
        const full = await WalletService.getCard({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken: token,
          cardId: summary.cardId,
        });
        if (!full) return;
        setWalletWidgets((current) => [
          ...current,
          {
            id: `${listWidgetId}-reveal-${summary.cardId}`,
            kind: "reveal",
            summary: full.summary,
            secrets: full.secrets,
          },
        ]);
      } catch {
        // A failed decrypt must not surface card material in an error path.
        setVaultDialogOpen(true);
      }
    },
    [getVaultOwnerToken, user?.uid, vaultKey],
  );

  /**
   * Record what the owner thought of one answer. Optimistic, because a rating
   * is a gesture and must feel instant; a failed write restores exactly what
   * was showing rather than leaving a rating the server never received.
   */
  const handleRateMessage = useCallback(
    (messageId: string, rating: "up" | "down" | null) => {
      const token = getVaultOwnerToken();
      if (!conversationId || !token) return;
      const previous = messageRatings;
      setMessageRatings((current) => {
        const next = { ...current };
        if (rating === null) delete next[messageId];
        else next[messageId] = rating;
        return next;
      });
      void (async () => {
        try {
          await setAgentChatFeedback({
            conversationId,
            messageId,
            rating,
            vaultOwnerToken: token,
          });
        } catch {
          setMessageRatings(previous);
        }
      })();
    },
    [conversationId, getVaultOwnerToken, messageRatings],
  );

  // One memory-only job belongs to its originating turn. Later turns may
  // continue; a conversation/owner/vault change cancels pending effects.
  const captureEligiblePkmFactsInBackground = useCallback(
    (params: {
      turnId: string;
      assistantMessageId: string;
      sourceMessage: string;
      currentDomains: string[];
    }): Promise<AgentPkmCaptureStatus> => {
      // Private source text is used only in this transient deduplication key.
      const jobKey = JSON.stringify([params.assistantMessageId, params.sourceMessage]);
      const existing = pkmCaptureJobsRef.current.get(jobKey);
      if (existing) return existing;
      const token = getVaultOwnerToken();
      if (!user?.uid || !vaultKey || !token || !pkmCaptureEnabledRef.current) {
        return Promise.resolve({ phase: "review", saved: 0 });
      }
      const userId = user.uid;
      const policy = pkmCapturePolicyRef.current;
      const controller = new AbortController();
      const guard = createAgentPkmCaptureGuard({
        userId, signal: controller.signal,
        isEnabled: () => pkmCaptureEnabledRef.current && pkmCapturePolicyRef.current === policy &&
          isAgentPkmProcessingReady(pkmCaptureReadinessRef.current, token),
      });
      pkmAbortControllersRef.current.add(controller);
      setActivePkmToolCount((count) => count + 1);
      const settle = (status: AgentPkmCaptureStatus) => {
        if (guard.isCurrent()) {
          const receipts = pkmCaptureReceiptsRef.current.get(params.assistantMessageId) || new Map<string, AgentPkmCaptureStatus>();
          receipts.set(jobKey, status);
          pkmCaptureReceiptsRef.current.set(params.assistantMessageId, receipts);
          const aggregate = aggregateAgentPkmCaptures([...receipts.values()]);
          setMessages((current) => current.map((message) =>
            message.id === params.assistantMessageId ? { ...message, memoryCapture: aggregate } : message,
          ));
        }
        return status;
      };
      const job = (async (): Promise<AgentPkmCaptureStatus> => {
        try {
          // Yield presentation without creating an untracked detached timer.
          await guard.assertCurrent();
          settle({ phase: "preparing", saved: 0 });
          const labContext = await loadPkmAgentLabContext({ userId, vaultOwnerToken: token });
          await guard.assertCurrent();
          const prepared = await prepareNaturalLanguagePkm({
            userId, message: params.sourceMessage, currentDomains: params.currentDomains,
            currentManifests: Object.values(labContext.manifests || {}).filter(Boolean),
            findDuplicate: (candidate) => AgentPkmContextStore.findLocalDuplicate({ userId, candidate }),
            vaultOwnerToken: token, source: "agent_chat_auto_capture", allowEmpty: true,
            beforeEffect: guard.assertCurrent,
            isEffectCurrent: guard.isCurrent,
          });
          await guard.assertCurrent();
          const needsAttention = prepared.sourceCoverage.some((block) =>
            block.disposition === "failed" || block.disposition === "review_required",
          );
          // A malformed/degraded proposal cannot authorize automatic effects.
          const degraded = prepared.previews.some((preview) => preview.error || preview.used_fallback);
          const reviewRequired =
            needsAttention ||
            degraded ||
            getPkmConfirmationCards(prepared.cards).length > 0;
          const cards = degraded ? [] : getPkmAutoSaveCards(prepared.cards);
          if (!cards.length) return settle({ phase: reviewRequired ? "review" : "skipped", saved: 0 });
          settle({ phase: "saving", saved: 0 });
          const result = await addToPKM({
            userId, cards, sourceMessage: params.sourceMessage, vaultKey, vaultOwnerToken: token,
            source: "agent_chat_auto_save", beforeEffect: guard.assertCurrent,
            mayPublish: guard.isCurrent,
            confirmation: policy.source === "owner_choice" && policy.enabledAt
              ? { authorizationMode: "owner_auto_save_policy", surface: "chat", source: "agent_chat_auto_save_policy",
                  autoSavePolicyVersion: policy.version, autoSavePolicyEnabledAt: policy.enabledAt }
              : { authorizationMode: "product_default_auto_save_policy", surface: "chat", source: "agent_chat_product_default_auto_save",
                  autoSavePolicyVersion: policy.version, productDefaultEffectiveAt: AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT },
          });
          // Preserve confirmed receipts even if publication is no longer allowed.
          // Never log the result's decrypted fullBlob or item-level summaries.
          appendDebugEvent(params.turnId, "pkm_auto_save_result", { saved: result.saved, failed: result.failed });
          trackEvent("agent_pkm_save_confirmation_completed", {
            route_id: "agent", result: result.saved > 0 ? "success" : "expected_error",
            saved_count_bucket: toPkmFactCountBucket(result.saved), failed_count_bucket: toPkmFactCountBucket(result.failed),
            has_active_recipients: false,
          });
          return settle({ phase: result.saved > 0 ? (result.failed || reviewRequired ? "partial" : "saved") : "failed", saved: result.saved });
        } catch {
          return settle({ phase: "failed", saved: 0 });
        } finally {
          // A canceled old job must not decrement a new conversation's count.
          if (pkmAbortControllersRef.current.delete(controller)) {
            setActivePkmToolCount((count) => Math.max(0, count - 1));
          }
        }
      })();
      pkmCaptureJobsRef.current.set(jobKey, job);
      return job;
    },
    [appendDebugEvent, getVaultOwnerToken, user?.uid, vaultKey],
  );

  const runAgentTurn = async (
    textInput: string,
    options: AgentRunTurnOptions = { source: "typed" },
  ) => {
    const text = textInput.trim();
    if (!text || !hasChatAccess || !user?.uid) return;
    // Pre-model paste guard: a message that appears to contain a full card
    // number must never reach /api/one/agent-chat, history, or telemetry.
    // Block before ANY network call and route to the secure add form.
    if (detectLikelyPan(text)) {
      appendMessage({
        id: `msg-${Date.now()}-pan-blocked`,
        role: "assistant",
        text: "That looked like a full card number, so it was blocked on this device and never sent. Use the secure form to save a card.",
        timestamp: formatNow(),
        status: "done",
        renderAsPlainAssistantMessage: true,
      });
      if (WalletService.isEnabled()) {
        setWalletWidgets((current) => [
          ...current,
          { id: `pan-guard-${Date.now()}`, kind: "add" },
        ]);
      }
      return;
    }
    // A person starting a new turn owns the workspace. Invalidate any ambient
    // initial-history restoration so a late warmup cannot replace this turn.
    historyRestoreEpochRef.current += 1;
    // A new user turn supersedes any unconfirmed proposal. Never let a stale
    // action card remain armed after the person asks for something else.
    setPendingAppAction(null);

    const userId = user.uid;
    const token = getVaultOwnerToken();
    const appendUserMessage = options.appendUserMessage ?? true;
    const timestamp = formatNow();
    const turnId = Date.now();
    const debugTurnId = `agent_turn_${turnId}`;
    const assistantMessageId = `msg-${turnId}-assistant`;
    const executedToolCalls = new Set<string>();
    let pkmToolHandledFullTurn = false;
    let toolStatusMessageId: string | null = null;
    let pkmStatusItemId: string | null = null;
    let turnPkmContext = EMPTY_PKM_CONTEXT;
    let pendingAssistantDelta = "";
    let assistantFlushFrame: number | null = null;
    const flushAssistantDelta = () => {
      assistantFlushFrame = null;
      const delta = pendingAssistantDelta;
      pendingAssistantDelta = "";
      if (!delta) return;
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: message.ephemeral ? delta : `${message.text}${delta}`,
        status: "streaming",
        ephemeral: false,
      }));
    };

    const queueAssistantDelta = (delta: string) => {
      pendingAssistantDelta += delta;
      if (assistantFlushFrame !== null) return;
      assistantFlushFrame = window.requestAnimationFrame(flushAssistantDelta);
    };

    const cancelAssistantFlush = () => {
      if (assistantFlushFrame !== null) {
        window.cancelAnimationFrame(assistantFlushFrame);
        assistantFlushFrame = null;
      }
      pendingAssistantDelta = "";
    };

    const finishCanceledTurn = () => {
      flushAssistantDelta();
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: message.text || "Agent turn canceled.",
        status: "done",
        streamEvents: settleVisibleStreamEvents(
          message.streamEvents,
          "blocked",
        ),
      }));
      setIsChatLoading(false);
      setIsStreaming(false);
    };

    const upsertTurnStreamEvent = (event: AgentVisibleStreamEvent) => {
      upsertMessageStreamEvent(assistantMessageId, event);
    };

    const upsertToolStatusMessage = (
      messageText: string,
      status: AgentMessage["status"] = "streaming",
    ) => {
      const cleanText = messageText.trim() || "Working on that.";
      const visibleStatus: AgentVisibleStreamStatus =
        status === "error" ? "error" : status === "done" ? "done" : "running";
      const nextId = toolStatusMessageId || `turn-status-${turnId}`;
      toolStatusMessageId = nextId;
      upsertTurnStreamEvent({
        id: nextId,
        label: "Progress",
        message: cleanText,
        status: visibleStatus,
        createdAtMs: Date.now(),
      });
    };

    const upsertPkmStatusMessage = (
      messageText: string,
      status: AgentPkmActivity["status"] = "streaming",
    ) => {
      if (latestVisibleTurnIdRef.current !== debugTurnId) return;
      const cleanText = messageText.trim();
      if (!cleanText) {
        if (pkmStatusItemId) upsertTurnStreamEvent({
          id: pkmStatusItemId,
          label: "Memory",
          message: "No new information needed saving.",
          status: "done",
          createdAtMs: Date.now(),
        });
        return;
      }
      const nextStatusItemId = pkmStatusItemId || `pkm-status-${turnId}`;
      pkmStatusItemId = nextStatusItemId;
      upsertTurnStreamEvent({
        id: nextStatusItemId,
        label: "Memory",
        message: cleanText,
        status: status === "error" ? "error" : status === "done" ? "done" : "running",
        createdAtMs: Date.now(),
      });
    };

    const toolResultStatus = (
      result: AgentActionRuntimeResult,
    ): AgentMessage["status"] => {
      if (
        result.status === "blocked" ||
        result.status === "failed" ||
        result.status === "invalid"
      ) {
        return "error";
      }
      return "done";
    };

    const executePkmAddTool = async (toolEvent: AgentChatToolEvent) => {
      if (!vaultKey || !token) {
        upsertPkmStatusMessage(
          "Unlock your vault before saving to Memory.",
          "error",
        );
        return { phase: "failed", saved: 0 } as AgentPkmCaptureStatus;
      }

      const sourceText =
        typeof toolEvent.slots.source_text === "string" &&
        toolEvent.slots.source_text.trim()
          ? toolEvent.slots.source_text.trim()
          : text;
      // One already chose capture passages. Do not run a second full-turn
      // extraction over those passages after its explicit capture invocations.
      pkmToolHandledFullTurn = true;

      return captureEligiblePkmFactsInBackground({
        turnId: `${debugTurnId}:${toolEvent.callId || "pkm.add"}`,
        assistantMessageId,
        sourceMessage: sourceText,
        currentDomains: turnPkmContext.domains,
      });
    };

    const executeFrontendTool = async (
      toolEvent: AgentChatToolEvent,
    ): Promise<AgentActionRuntimeResult> => {
      if (!toolEvent.actionId) {
        throw new Error("The proposed action has no action ID.");
      }
      appendDebugEvent(debugTurnId, "frontend_execute_start", toolEvent);

      if (toolEvent.actionId === "pkm.add") {
        const capture = await executePkmAddTool(toolEvent);
        return {
          status: capture.phase === "saved" || capture.phase === "skipped" ? "succeeded" : "blocked",
          actionId: toolEvent.actionId,
          label: toolEvent.label,
          routeBefore: pathname,
          resultSummary: describeAgentPkmCapture(capture),
        };
      }

      // Wallet actions execute entirely on this device: the browser decrypts
      // under the vault key and renders secure widgets. Only metadata (and
      // never PAN/CVV/PIN) flows back to the model through resultSummary.
      if (
        toolEvent.actionId === "wallet.list" ||
        toolEvent.actionId === "wallet.add" ||
        toolEvent.actionId === "wallet.reveal"
      ) {
        if (!WalletService.isEnabled()) {
          return {
            status: "failed",
            actionId: toolEvent.actionId,
            label: toolEvent.label,
            routeBefore: pathname,
            resultSummary: "Payment cards are not enabled in this environment.",
            reason: "feature_disabled",
          };
        }
        if (!vaultKey || !token) {
          return {
            status: "failed",
            actionId: toolEvent.actionId,
            label: toolEvent.label,
            routeBefore: pathname,
            resultSummary: "Unlock your vault to work with your cards.",
            reason: "vault_locked",
          };
        }
        const cardsContext = {
          userId,
          vaultKey,
          vaultOwnerToken: token,
        };
        if (toolEvent.actionId === "wallet.list") {
          const summaries =
            await WalletService.listCardSummaries(cardsContext);
          const described = WalletService.describeSummaries(summaries);
          // Metadata only (nickname, brand, last4, expiry, region): safe to
          // show and to hand back to the model. This renders as a widget rather
          // than a second assistant message: the model already speaks the answer
          // from resultSummary, so appending the same text produced two blocks
          // with two copy/thumbs rails for one question. The widget also carries
          // a Reveal control per card, which plain text could not.
          if (summaries.length > 0) {
            setWalletWidgets((current) => [
              ...current,
              {
                id: `${debugTurnId}-card-list-${current.length}`,
                kind: "list",
                summaries,
              },
            ]);
          }
          return {
            status: "succeeded",
            actionId: toolEvent.actionId,
            label: toolEvent.label,
            routeBefore: pathname,
            resultSummary: described,
          };
        }
        if (toolEvent.actionId === "wallet.add") {
          setWalletWidgets((current) => [
            ...current,
            { id: `${debugTurnId}-card-add-${current.length}`, kind: "add" },
          ]);
          return {
            status: "succeeded",
            actionId: toolEvent.actionId,
            label: toolEvent.label,
            routeBefore: pathname,
            resultSummary:
              "A secure add-card form was opened on this device. Card details go into the form, never into chat.",
          };
        }
        const cardRef =
          typeof toolEvent.slots.card_ref === "string"
            ? toolEvent.slots.card_ref.trim().toLowerCase()
            : "";
        const summaries =
          await WalletService.listCardSummaries(cardsContext);
        const match = summaries.find(
          (card) =>
            card.cardId.toLowerCase() === cardRef ||
            card.nickname.trim().toLowerCase() === cardRef ||
            card.last4 === cardRef.replace(/\D/g, "").slice(-4),
        );
        if (!match) {
          return {
            status: "failed",
            actionId: toolEvent.actionId,
            label: toolEvent.label,
            routeBefore: pathname,
            resultSummary:
              summaries.length === 0
                ? "No cards are stored yet."
                : "No stored card matches that reference. Ask for the card list first.",
            reason: "card_not_found",
          };
        }
        const full = await WalletService.getCard({
          ...cardsContext,
          cardId: match.cardId,
        });
        if (!full) {
          return {
            status: "failed",
            actionId: toolEvent.actionId,
            label: toolEvent.label,
            routeBefore: pathname,
            resultSummary: "That card could not be decrypted on this device.",
            reason: "card_decrypt_failed",
          };
        }
        setWalletWidgets((current) => [
          ...current,
          {
            id: `${debugTurnId}-card-reveal-${current.length}`,
            kind: "reveal",
            summary: full.summary,
            secrets: full.secrets,
          },
        ]);
        return {
          status: "succeeded",
          actionId: toolEvent.actionId,
          label: toolEvent.label,
          routeBefore: pathname,
          resultSummary: `Card "${full.summary.nickname || full.summary.brand}" ending ${full.summary.last4} was shown privately on this device.`,
        };
      }

      setActiveFrontendToolCount((count) => count + 1);
      const action = getKaiActionById(toolEvent.actionId);
      const actionRun = appInteractionCoordinator.startActionRun({
        actionId: toolEvent.actionId,
        label: action?.label ?? "your request",
        source: "search",
        directiveId: toolEvent.callId ?? null,
      });
      try {
        appInteractionCoordinator.updateActionRun(actionRun.id, {
          phase: "executing",
        });
        const execute =
          action?.activation_policy === "trusted_activation_required"
            ? executeTrustedActivationGatewayAction
            : executeAgentGatewayAction;
        const result = await execute({
          actionId: toolEvent.actionId,
          slots: toolEvent.slots,
          userId,
          router,
          appRuntimeState: appRuntimeStateRef.current,
          surfaceMetadata: getVoiceSurfaceMetadata(),
          hasPortfolioData,
          busyOperations,
          setAnalysisParams,
          switchPersona,
        });
        if (result.routeAfter) {
          appInteractionCoordinator.updateActionRun(actionRun.id, {
            phase: "navigating",
            message: `Opening ${action?.label ?? "your request"}`,
          });
        }
        appInteractionCoordinator.finishActionRunFromSettlement(actionRun.id, {
          status: result.status,
          summary: result.resultSummary,
          reason: result.reason,
          routeAfter: result.routeAfter,
          screenAfter: result.screenAfter,
        });
        appendDebugEvent(debugTurnId, "tool_result", result);
        upsertToolStatusMessage(result.resultSummary, toolResultStatus(result));
        return result;
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Agent tool execution failed.";
        appInteractionCoordinator.updateActionRun(actionRun.id, {
          phase: "failed",
          message,
        });
        appendDebugEvent(debugTurnId, "tool_result", {
          status: "failed",
          message,
          tool: toolEvent,
        });
        upsertToolStatusMessage(message, "error");
        return {
          status: "failed",
          actionId: toolEvent.actionId,
          label: toolEvent.label,
          routeBefore: pathname,
          resultSummary: message,
          reason: "frontend_execution_failed",
        };
      } finally {
        setActiveFrontendToolCount((count) => Math.max(0, count - 1));
      }
    };

    const stageToolForConfirmation = (toolEvent: AgentChatToolEvent) => {
      const callKey =
        toolEvent.callId || `${toolEvent.actionId || "unknown"}-${turnId}`;
      if (executedToolCalls.has(callKey)) return;
      if (toolEvent.execution !== "frontend" || !toolEvent.actionId) return;
      const aguiResume =
        toolEvent.raw.protocol === "ag-ui" && typeof toolEvent.raw.resume === "function"
          ? (toolEvent.raw.resume as (status: "resolved" | "cancelled", payload?: unknown) => Promise<void>)
          : null;
      if (aguiResume) {
        setPendingAppAction({
          event: toolEvent,
          cancel: () => aguiResume("cancelled", { reason: "user_cancelled" }),
          // No `authorize` step. There used to be one, and it did nothing: it
          // returned the template string `agui:${callId}`, stored it as a
          // receipt, and told the person to tap again. No signature, no
          // permission check, no ledger proof -- a second tap that bought
          // exactly nothing and read as a security step. Confirming IS the
          // authorization here; the directive ledger is what actually binds it.
          execute: async () => {
            if (executedToolCalls.has(callKey)) {
              throw new Error("This action was already completed.");
            }
            executedToolCalls.add(callKey);
            const result = await executeFrontendTool(toolEvent);
            await aguiResume("resolved", {
              status: result.status,
              summary: result.resultSummary,
              actionId: result.actionId,
              ...(result.actionId === "consent.request" && result.data
                ? { data: result.data }
                : {}),
            });
            return result;
          },
        });
      }
    };

    const userMessage: AgentMessage = {
      id: `msg-${turnId}-user`,
      role: "user",
      text,
      timestamp,
    };
    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "",
      timestamp,
      status: "streaming",
    };

    setMessages((current) => {
      if (options.replaceAssistantMessageId) {
        let replaced = false;
        const nextMessages = current.map((message) => {
          if (message.id !== options.replaceAssistantMessageId) return message;
          replaced = true;
          return assistantMessage;
        });
        if (replaced) return nextMessages;
      }
      return [
        ...current,
        ...(appendUserMessage ? [userMessage] : []),
        assistantMessage,
      ];
    });
    latestVisibleTurnIdRef.current = debugTurnId;
    setIsChatLoading(true);
    setIsStreaming(true);

    if (!token) {
      trackEvent("agent_pkm_context_unavailable", {
        route_id: "agent",
        result: "expected_error",
        reason: "vault_locked",
      });
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: "Vault access expired. Unlock again to continue.",
        status: "error",
        streamEvents: [],
      }));
      setIsChatLoading(false);
      setIsStreaming(false);
      return;
    }

    const streamAbortController = new AbortController();
    streamAbortControllerRef.current = streamAbortController;
    const pkmContextStartedAt = performance.now();

    const loadTurnPkmContext = async (): Promise<AgentPkmContext> => {
      if (!vaultKey) {
        throw new Error(
          "Your vault must remain unlocked while One prepares your private memory.",
        );
      }

      const cachedContext = peekAgentPkmContext({
        userId,
        message: text,
      });
      if (cachedContext?.text) {
        void loadAgentPkmContext({
          userId,
          vaultOwnerToken: token,
          vaultKey,
          message: text,
        }).catch(() => undefined);
        return cachedContext;
      }

      // Large pasted context is already in the user turn and is handled by the
      // guarded background capture lane after the answer starts. Do not make a
      // foreground paste wait for a full decrypted inventory to hydrate. A
      // warm session cache is still useful, but it is not required for this
      // explicitly deferred lane.
      if (options.deferPkmContext) {
        if (cachedContext?.text) {
          void loadAgentPkmContext({
            userId,
            vaultOwnerToken: token,
            vaultKey,
            message: text,
          }).catch(() => undefined);
          return cachedContext;
        }
        return EMPTY_PKM_CONTEXT;
      }

      // A warm cache returns immediately. A cold unlocked turn waits for the
      // local decrypted inventory instead of substituting metadata or sending
      // an empty prompt to One.
      const context = await loadAgentPkmContext({
        userId,
        vaultOwnerToken: token,
        vaultKey,
        message: text,
      });
      if (!context.text) {
        throw new Error(
          "One could not prepare your private memory for this turn. Please try again.",
        );
      }
      return context;
    };

    try {
      let agentPkmContext = EMPTY_PKM_CONTEXT;
      try {
        agentPkmContext = await loadTurnPkmContext();
        turnPkmContext = agentPkmContext;
        if (streamAbortController.signal.aborted) {
          finishCanceledTurn();
          return;
        }
        if (agentPkmContext.text) {
          const coverage = agentPkmContext.coverage;
          trackEvent("agent_pkm_context_resolved", {
            route_id: "agent",
            result: "success",
            context_mode:
              agentPkmContext.mode === "broad" ? "broad" : "relevant",
            total_fact_count_bucket: toPkmFactCountBucket(
              coverage?.totalFactCount || 0,
            ),
            selected_fact_count_bucket: toPkmFactCountBucket(
              coverage?.selectedFactCount || 0,
            ),
            context_clipped: coverage?.clipped === true,
            inventory_only: coverage?.inventoryOnly === true,
            safety_omitted: (coverage?.safetyOmittedNodeCount || 0) > 0,
            duration_ms_bucket: toDurationBucket(
              performance.now() - pkmContextStartedAt,
            ),
          });
          appendDebugEvent(debugTurnId, "pkm_context_loaded", {
            domain_count: agentPkmContext.domains.length,
            total_attributes: agentPkmContext.totalAttributes,
            detail_count: agentPkmContext.detailCount || 0,
            source: agentPkmContext.source || "metadata",
            mode: agentPkmContext.mode || "summary",
            updated_at: agentPkmContext.updatedAt,
            coverage: agentPkmContext.coverage,
          });
        }
      } catch (error) {
        trackEvent("agent_pkm_context_unavailable", {
          route_id: "agent",
          result: "error",
          reason: vaultKey ? "load_failed" : "vault_locked",
        });
        appendDebugEvent(debugTurnId, "pkm_context_load_failed", {
          message:
            error instanceof Error && error.message
              ? error.message
              : "Failed to load private PKM context.",
        });
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: "One couldn't load your private memory for this turn. Keep your vault unlocked and try again.",
          status: "error",
          streamEvents: [],
        }));
        setIsChatLoading(false);
        setIsStreaming(false);
        return;
      }

      const streamResult = await streamAgentChat({
        userId,
        message: text,
        conversationId: conversationIdRef.current,
        vaultOwnerToken: token,
        pkmContext: agentPkmContext.text || undefined,
        personSelectionHandle: options.personSelectionHandle,
        screenContext: buildOneVoiceStructuredScreenContext({
          appRuntimeState: appRuntimeStateRef.current,
          state: useAgentVoiceState.getState().oneVoiceState,
          lastTransition: useAgentVoiceState.getState().lastTransition,
        }) as unknown as Record<string, unknown>,
        signal: streamAbortController.signal,
        handlers: {
          onStart: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            if (nextConversationId) {
              updateConversationId(nextConversationId);
            }
          },
          onToolStart: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_start", toolEvent);
            upsertTurnStreamEvent(
              agentToolEventToVisibleStreamEvent("start", toolEvent),
            );
          },
          onToolWaiting: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_waiting", toolEvent);
            const visibleEvent = agentToolEventToVisibleStreamEvent(
              "waiting",
              toolEvent,
            );
            upsertTurnStreamEvent(visibleEvent);
            // A parked run_app_action directive that owes no confirmation
            // runs through the governed client executor; one
            // that does owe a confirmation (or a trusted tap) is staged.
            if (
              toolEvent.raw.parked === true &&
              toolEvent.actionId &&
              !toolEvent.requiresConfirmation &&
              !toolEvent.trustedActivationRequired
            ) {
              const callKey = toolEvent.callId;
              if (executedToolCalls.has(callKey)) return;
              executedToolCalls.add(callKey);
              void executeFrontendTool(toolEvent);
              return;
            }
            stageToolForConfirmation(toolEvent);
          },
          onPendingConsentRequests: (requestIds) => {
            if (streamAbortController.signal.aborted) return;
            for (const requestId of requestIds) {
              void appendPendingConsentRequestRef.current?.(requestId);
            }
          },
          onToolResult: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_result", toolEvent);
            openGmailEmailDraftFromDirective(toolEvent, assistantMessageId);
            const calendarDirective = getCalendarDirectiveFromToolEvent(toolEvent);
            if (calendarDirective) {
              setPendingSpecialistDirective(calendarDirective);
            }
            const visibleEvent = agentToolEventToVisibleStreamEvent(
              "result",
              toolEvent,
            );
            upsertTurnStreamEvent(visibleEvent);
          },
          onToken: (delta) => {
            if (streamAbortController.signal.aborted) return;
            queueAssistantDelta(delta);
          },
          onSources: (sources) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              sources,
            }));
          },
          onStructuredExperience: (structuredExperience, eventId) => {
            if (streamAbortController.signal.aborted) return;
            const stableId =
              eventId || `${assistantMessageId}:${structuredExperience.type}`;
            updateMessage(assistantMessageId, (message) => {
              const current = message.structuredExperiences ?? [];
              return {
                ...message,
                structuredExperiences: upsertAgentStructuredExperience(
                  current,
                  stableId,
                  structuredExperience,
                ),
              };
            });
          },
          onSpecialistDirective: (directive) => {
            if (streamAbortController.signal.aborted) return;
            setPendingSpecialistDirective(directive);
          },
          onInterrupt: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            // AG-UI interrupts are the normal boundary for a visible action
            // card. The card remains actionable, but the assistant turn has
            // finished thinking until the owner confirms or cancels it.
            flushAssistantDelta();
            if (nextConversationId) {
              updateConversationId(nextConversationId);
            }
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              status: "done",
              streamEvents: settleVisibleStreamEvents(
                message.streamEvents,
                "done",
              ),
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
          onServerMessageId: (serverMessageId) => {
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              serverMessageId,
            }));
          },
          onComplete: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            if (nextConversationId) {
              updateConversationId(nextConversationId);
            }
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              status: "done",
              streamEvents: settleVisibleStreamEvents(
                message.streamEvents,
                "done",
              ),
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
          onError: (message) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            updateMessage(assistantMessageId, (current) => ({
              ...current,
              text: current.text || message,
              status: "error",
              streamEvents: settleVisibleStreamEvents(
                current.streamEvents,
                "error",
              ),
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
        },
      });
      if (streamAbortController.signal.aborted) {
        finishCanceledTurn();
        return;
      }
      if (streamResult.interrupted) {
        // The confirmation card is now the active surface. Do not append a
        // fabricated fallback sentence or start background capture while the
        // resumable action is waiting for the owner's tap.
        return;
      }
      flushAssistantDelta();
      if (streamResult.conversationId) {
        updateConversationId(streamResult.conversationId);
      }
      updateMessage(assistantMessageId, (message) => {
        if (message.status === "error") return message;
        return {
          ...message,
          text:
            message.text || "I couldn't generate a response. Please try again.",
          status: "done",
        };
      });
      // Only facts deliberately typed into the normal composer are eligible
      // for automatic capture. Assistant output, tool events, and Gmail
      // content never enter this client-side proposal path.
      if (options.source === "typed" && !pkmToolHandledFullTurn) {
        void captureEligiblePkmFactsInBackground({
          turnId: debugTurnId,
          assistantMessageId,
          sourceMessage: text,
          currentDomains: turnPkmContext.domains,
        });
      }
      void loadConversationList(true).catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } catch (error) {
      if (streamAbortController.signal.aborted) {
        finishCanceledTurn();
        return;
      }
      flushAssistantDelta();
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Agent chat request failed.";
      updateMessage(assistantMessageId, (current) => ({
        ...current,
        text: current.text || message,
        status: "error",
        streamEvents: settleVisibleStreamEvents(
          current.streamEvents,
          "error",
        ),
      }));
      void loadConversationList(true).catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } finally {
      cancelAssistantFlush();
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
      }
    }
  };

  /**
   * Follow-up turn that reports a specialist DelegateResult back to One.
   *
   * Modeled on runAgentTurn's stream-start path: it opens a normal assistant
   * turn (streaming bubble) with `delegateResult` set and no user `message`,
   * reusing the same SSE handlers so One's confirmation renders as a regular
   * assistant response. Used by the specialist directive card's confirm/cancel.
   */
  const sendDelegateResult = async (result: DelegateResult) => {
    if (!hasChatAccess || !user?.uid) return;
    const userId = user.uid;
    const token = getVaultOwnerToken();
    if (!token) {
      addErrorMessage("Vault access expired. Unlock again to continue.");
      return;
    }

    const turnId = Date.now();
    const debugTurnId = `agent_delegate_${turnId}`;
    const assistantMessageId = `msg-${turnId}-assistant`;
    const timestamp = formatNow();

    let pendingAssistantDelta = "";
    let assistantFlushFrame: number | null = null;
    const flushAssistantDelta = () => {
      assistantFlushFrame = null;
      const delta = pendingAssistantDelta;
      pendingAssistantDelta = "";
      if (!delta) return;
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: `${message.text}${delta}`,
        status: "streaming",
      }));
    };
    const queueAssistantDelta = (delta: string) => {
      pendingAssistantDelta += delta;
      if (assistantFlushFrame !== null) return;
      assistantFlushFrame = window.requestAnimationFrame(flushAssistantDelta);
    };
    const cancelAssistantFlush = () => {
      if (assistantFlushFrame !== null) {
        window.cancelAnimationFrame(assistantFlushFrame);
        assistantFlushFrame = null;
      }
      pendingAssistantDelta = "";
    };

    appendMessage({
      id: assistantMessageId,
      role: "assistant",
      text: "",
      timestamp,
      status: "streaming",
    });
    latestVisibleTurnIdRef.current = debugTurnId;
    setIsChatLoading(true);
    setIsStreaming(true);

    const streamAbortController = new AbortController();
    streamAbortControllerRef.current = streamAbortController;

    try {
      const streamResult = await streamAgentChat({
        userId,
        message:
          result.detail ||
          result.display ||
          `The requested action ${result.status}.`,
        conversationId: conversationIdRef.current,
        vaultOwnerToken: token,
        screenContext: buildOneVoiceStructuredScreenContext({
          appRuntimeState: appRuntimeStateRef.current,
          state: useAgentVoiceState.getState().oneVoiceState,
          lastTransition: useAgentVoiceState.getState().lastTransition,
        }) as unknown as Record<string, unknown>,
        signal: streamAbortController.signal,
        // Handler set is intentionally reduced. A delegate_result turn is
        // serviced by the backend delegation branch (Task 6), which never
        // emits `tool_waiting`/PKM frames — those only come from the central
        // planner path, which delegated turns bypass. So onToolWaiting and
        // onPkmResults are intentionally omitted; only the events a delegated
        // confirmation turn can actually emit are wired here.
        handlers: {
          onStart: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            if (nextConversationId) updateConversationId(nextConversationId);
          },
          onToken: (delta) => {
            if (streamAbortController.signal.aborted) return;
            queueAssistantDelta(delta);
          },
          onSources: (sources) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              sources,
            }));
          },
          onServerMessageId: (serverMessageId) => {
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              serverMessageId,
            }));
          },
          onComplete: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            if (nextConversationId) updateConversationId(nextConversationId);
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              status: "done",
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
          onError: (message) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            updateMessage(assistantMessageId, (current) => ({
              ...current,
              text: current.text || message,
              status: "error",
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
        },
      });
      if (streamAbortController.signal.aborted) {
        flushAssistantDelta();
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: message.text || "Agent turn canceled.",
          status: "done",
        }));
        setIsChatLoading(false);
        setIsStreaming(false);
        return;
      }
      flushAssistantDelta();
      if (streamResult.conversationId) {
        updateConversationId(streamResult.conversationId);
      }
      updateMessage(assistantMessageId, (message) => {
        if (message.status === "error") return message;
        return {
          ...message,
          text: message.text || "Done.",
          status: "done",
        };
      });
      void loadConversationList(true).catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } catch (error) {
      flushAssistantDelta();
      if (streamAbortController.signal.aborted) {
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: message.text || "Agent turn canceled.",
          status: "done",
        }));
      } else {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Agent chat request failed.";
        updateMessage(assistantMessageId, (current) => ({
          ...current,
          text: current.text || message,
          status: "error",
        }));
      }
      void loadConversationList(true).catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } finally {
      cancelAssistantFlush();
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
      }
    }
  };

  /**
   * Pre-vault informational turn for the single agent bar.
   *
   * Runs before the vault is unlocked (including anonymous onboarding
   * visitors). It only talks to the lower-privilege informational backend
   * tier, never sends PKM/vault data, is not persisted, and only executes
   * pure navigation (route.*) actions. Anything that needs the vault prompts
   * an in-place unlock instead.
   */
  const runIntroTurn = async (textInput: string) => {
    const text = textInput.trim();
    if (!text) return;

    const turnId = Date.now();
    const assistantMessageId = `msg-${turnId}-assistant`;
    const executedNavCalls = new Set<string>();
    const timestamp = formatNow();
    let assistantHasToken = false;

    // rAF-coalesce streamed tokens so the pre-vault intro tier renders as
    // smoothly as the full agent tier (one commit per frame, not per token).
    let pendingAssistantDelta = "";
    let assistantFlushFrame: number | null = null;
    const flushAssistantDelta = () => {
      assistantFlushFrame = null;
      const delta = pendingAssistantDelta;
      pendingAssistantDelta = "";
      if (!delta) return;
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: `${message.text}${delta}`,
        status: "streaming",
      }));
    };
    const queueAssistantDelta = (delta: string) => {
      pendingAssistantDelta += delta;
      if (assistantFlushFrame !== null) return;
      assistantFlushFrame = window.requestAnimationFrame(flushAssistantDelta);
    };
    const cancelAssistantFlush = () => {
      if (assistantFlushFrame !== null) {
        window.cancelAnimationFrame(assistantFlushFrame);
        assistantFlushFrame = null;
      }
      pendingAssistantDelta = "";
    };

    const userMessage: AgentMessage = {
      id: `msg-${turnId}-user`,
      role: "user",
      text,
      timestamp,
    };
    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "",
      timestamp,
      status: "streaming",
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setIsChatLoading(true);
    setIsStreaming(true);

    const streamAbortController = new AbortController();
    streamAbortControllerRef.current = streamAbortController;

    const stageIntroNavigation = (toolEvent: AgentChatToolEvent) => {
      if (toolEvent.execution !== "frontend" || !toolEvent.actionId) return;
      // The informational tier only forwards route.* actions, but guard anyway.
      if (!toolEvent.actionId.startsWith("route.")) return;
      const callKey = toolEvent.callId || `${toolEvent.actionId}-${turnId}`;
      if (executedNavCalls.has(callKey)) return;
      setPendingAppAction({
        event: toolEvent,
        execute: async () => {
          if (executedNavCalls.has(callKey)) {
            throw new Error("This navigation was already used.");
          }
          executedNavCalls.add(callKey);
          const action = getKaiActionById(toolEvent.actionId!);
          const actionRun = appInteractionCoordinator.startActionRun({
            actionId: toolEvent.actionId!,
            label: action?.label ?? "your request",
            source: "search",
            directiveId: toolEvent.callId ?? null,
          });
          appInteractionCoordinator.updateActionRun(actionRun.id, {
            phase: "executing",
          });
          const result = await executeAgentGatewayAction({
            actionId: toolEvent.actionId!,
            slots: toolEvent.slots,
            userId: user?.uid ?? "",
            router,
            appRuntimeState: appRuntimeStateRef.current,
            surfaceMetadata: getVoiceSurfaceMetadata(),
            hasPortfolioData,
            busyOperations,
            setAnalysisParams,
            switchPersona,
          });
          if (result.routeAfter) {
            appInteractionCoordinator.updateActionRun(actionRun.id, {
              phase: "navigating",
              message: `Opening ${action?.label ?? "your request"}`,
            });
          }
          appInteractionCoordinator.finishActionRunFromSettlement(
            actionRun.id,
            {
              status: result.status,
              summary: result.resultSummary,
              reason: result.reason,
              routeAfter: result.routeAfter,
              screenAfter: result.screenAfter,
            },
          );
          return result;
        },
      });
    };

    try {
      await streamAgentIntro({
        message: text,
        screenContext: buildOneVoiceStructuredScreenContext({
          appRuntimeState: appRuntimeStateRef.current,
          state: useAgentVoiceState.getState().oneVoiceState,
          lastTransition: useAgentVoiceState.getState().lastTransition,
        }) as unknown as Record<string, unknown>,
        signal: streamAbortController.signal,
        handlers: {
          onToken: (delta) => {
            if (streamAbortController.signal.aborted) return;
            assistantHasToken = true;
            queueAssistantDelta(delta);
          },
          onToolWaiting: stageIntroNavigation,
          onComplete: () => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              text:
                message.text ||
                (assistantHasToken
                  ? message.text
                  : "I couldn't generate a response. Please try again."),
              status: "done",
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
          onError: (message) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            updateMessage(assistantMessageId, (current) => ({
              ...current,
              text: current.text || message,
              status: "error",
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
        },
      });
    } catch (error) {
      cancelAssistantFlush();
      if (streamAbortController.signal.aborted) {
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: message.text || "Agent turn canceled.",
          status: "done",
        }));
      } else {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Agent chat request failed.";
        updateMessage(assistantMessageId, (current) => ({
          ...current,
          text: current.text || message,
          status: "error",
        }));
      }
      setIsChatLoading(false);
      setIsStreaming(false);
    } finally {
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
      }
    }
  };

  const syncQueuedPrompts = () => {
    setQueuedPrompts(
      operationQueueRef.current
        .snapshot()
        .flatMap((operation) => (operation.prompt ? [operation.prompt] : [])),
    );
  };

  const drainOperationQueue = async () => {
    await operationQueueRef.current.drain(async (operation) => {
      syncQueuedPrompts();
      await operation.run();
    });
  };

  const enqueueWorkspaceOperation = (operation: QueuedWorkspaceOperation) => {
    operationQueueRef.current.enqueue(operation);
    syncQueuedPrompts();
    void drainOperationQueue();
  };

  const enqueuePrompt = (
    textInput: string,
    personSelectionHandle?: string,
    options: Pick<AgentRunTurnOptions, "deferPkmContext"> = {},
  ) => {
    const text = textInput.trim();
    if (!text) return;
    const prompt: QueuedAgentPrompt = {
      id: crypto.randomUUID(),
      text,
      createdAtMs: Date.now(),
      deferPkmContext: options.deferPkmContext,
    };
    const operation: QueuedWorkspaceOperation = {
      id: prompt.id,
      prompt,
      run: async () => {
        if (hasChatAccess) {
          await runAgentTurn(operation.prompt?.text ?? "", {
            source: "typed",
            personSelectionHandle,
            deferPkmContext: operation.prompt?.deferPkmContext,
          });
          return;
        }
        await runIntroTurn(operation.prompt?.text ?? "");
      },
    };
    enqueueWorkspaceOperation(operation);
  };

  const editQueuedPrompt = (id: string, textInput: string) => {
    const text = textInput.trim();
    if (!text) return;
    operationQueueRef.current.replace(
      operationQueueRef.current
        .snapshot()
        .map((operation) =>
          operation.prompt?.id === id
            ? { ...operation, prompt: { ...operation.prompt, text } }
            : operation,
        ),
    );
    setQueuedPrompts((current) => editQueuedAgentPrompt(current, id, text));
    setEditingQueuedPromptId(null);
    setEditingQueuedPromptText("");
  };

  const removeQueuedPrompt = (id: string) => {
    operationQueueRef.current.replace(
      operationQueueRef.current
        .snapshot()
        .filter((operation) => operation.prompt?.id !== id),
    );
    setQueuedPrompts((current) => removeQueuedAgentPrompt(current, id));
    if (editingQueuedPromptId === id) {
      setEditingQueuedPromptId(null);
      setEditingQueuedPromptText("");
    }
  };

  const enqueueCalendarDirective = (
    directive: SpecialistDirectiveEvent,
    token: string,
    userId: string,
  ) => {
    const payload = directive.directive.payload as Record<string, unknown>;
    const actionKey = String(
      payload.proposalId ?? payload.id ?? directive.message,
    );
    if (calendarActionIdsRef.current.has(actionKey)) return;
    calendarActionIdsRef.current.add(actionKey);
    const label = String(payload.confirmLabel ?? "Confirm");
    const resultMessageId = `msg-${crypto.randomUUID()}-calendar-result`;

    appendMessage({
      id: `msg-${crypto.randomUUID()}-calendar-confirm`,
      role: "user",
      text: label,
      timestamp: formatNow(),
      status: "done",
      kind: "selection",
    });
    appendMessage({
      id: resultMessageId,
      role: "assistant",
      text: "Scheduling…",
      timestamp: formatNow(),
      status: "streaming",
      renderAsPlainAssistantMessage: true,
    });
    setPendingSpecialistDirective(null);
    setSpecialistBusy(true);

    enqueueWorkspaceOperation({
      id: `calendar-${actionKey}`,
      run: async () => {
        try {
          const result = await runCalendarDirective(
            directive.directive,
            token,
            userId,
          );
          updateMessage(resultMessageId, (message) => ({
            ...message,
            text: result.detail || "Calendar updated.",
            status: "done",
          }));
        } catch (error) {
          updateMessage(resultMessageId, (message) => ({
            ...message,
            text:
              error instanceof Error
                ? error.message
                : "The Calendar change could not be completed.",
            status: "error",
          }));
        } finally {
          calendarActionIdsRef.current.delete(actionKey);
          setSpecialistBusy(false);
        }
      },
    });
  };

  const enqueueDelegateResult = (result: DelegateResult) => {
    enqueueWorkspaceOperation({
      id: `delegate-${crypto.randomUUID()}`,
      run: async () => {
        await sendDelegateResult(result);
      },
    });
  };

  const submitComposerText = async () => {
    const attachment = longPromptAttachment;
    const draftText = input;
    const attachmentText = attachment?.isExpanded ? draftText : attachment?.text ?? null;
    const text = combineAttachmentAndComposerText({
      attachmentText,
      composerText: attachment?.isExpanded ? "" : draftText,
    });
    if (!text.trim() || isVoiceConnecting || voiceActive) return;
    setInput("");
    setLongPromptAttachment(null);
    setComposerExpanded(false);
    // A large paste is a dedicated browser-memory import lane. Redact payment
    // card numbers before the text can enter Chat, history, telemetry, or the
    // guarded background PKM proposal flow; ordinary typed PAN input remains a
    // hard block and is routed to the secure card form.
    const submittedText =
      attachment && detectLikelyPan(text) ? redactLikelyPans(text) : text;
    if (detectLikelyPan(submittedText)) {
      appendMessage({
        id: `msg-${Date.now()}-pan-blocked`,
        role: "assistant",
        text: "That looked like a full card number, so it was blocked on this device and never sent. Use the secure form to save a card.",
        timestamp: formatNow(),
        status: "done",
        renderAsPlainAssistantMessage: true,
      });
      if (WalletService.isEnabled()) {
        setWalletWidgets((current) => [
          ...current,
          { id: `pan-guard-${Date.now()}`, kind: "add" },
        ]);
      }
      return;
    }
    if (gmailKycReplyRequest && gmailKycMissingLabels.length > 0) {
      await submitGmailKycDetails(text);
      return;
    }
    enqueuePrompt(submittedText, undefined, {
      deferPkmContext: attachment !== null,
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitComposerText();
  };

  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!shouldCaptureLargePaste(pasted)) return;
    event.preventDefault();
    const nextComposerText = mergePastedText({
      currentText: input,
      pastedText: pasted,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
    });
    const nextText = longPromptAttachment?.isExpanded
      ? nextComposerText
      : combineAttachmentAndComposerText({
          attachmentText: longPromptAttachment?.text ?? null,
          composerText: nextComposerText,
        });
    setLongPromptAttachment(createPendingTextAttachment(nextText));
    setInput("");
    setComposerExpanded(false);
  };

  const openLongPromptAttachment = () => {
    const attachment = longPromptAttachment;
    if (!attachment) return;
    const text = combineAttachmentAndComposerText({
      attachmentText: attachment.text,
      composerText: input,
    });
    setInput(text);
    setLongPromptAttachment(createPendingTextAttachment(text, true));
    setComposerExpanded(true);
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  };

  const collapseComposer = () => {
    if (longPromptAttachment?.isExpanded) {
      setLongPromptAttachment(createPendingTextAttachment(input));
      setInput("");
    }
    setComposerExpanded(false);
  };

  const removeLongPromptAttachment = () => {
    // A collapsed card has a separate companion instruction in the composer.
    // Removing the card must not discard that instruction. Once opened, the
    // editor is the attachment itself, so clearing it removes the attachment.
    if (longPromptAttachment?.isExpanded) setInput("");
    setLongPromptAttachment(null);
    setComposerExpanded(false);
  };

  handoffPromptSubmitRef.current = async (prompt: string) => {
    enqueuePrompt(prompt);
  };

  useEffect(() => {
    const prompt = queuedHandoffPrompt?.trim();
    if (!prompt) return;
    setQueuedHandoffPrompt(null);
    void handoffPromptSubmitRef.current?.(prompt);
  }, [queuedHandoffPrompt, setQueuedHandoffPrompt]);

  // Agent Chat never owns audio. Its microphone affordance delegates to the
  // persistent Agent Bar, which is the sole owner of command capture.
  const startConversationalVoice = requestAgentConversation;
  const cancelConversationalVoice = requestAgentConversationStop;

  // The single agent bar always works. Before the vault is unlocked it runs the
  // informational tier (help + navigation), so the access banner is a soft,
  // non-blocking affordance, not a wall. It only surfaces when the user is
  // signed in but the vault is locked, offering an in-place unlock to upgrade
  // to the full agent. Anonymous visitors get a quiet sign-in nudge instead.
  const needsVaultUnlock = Boolean(
    user?.uid && (!isVaultUnlocked || !vaultOwnerToken || !tokenIsFresh),
  );
  const accessMessage = authLoading
    ? null
    : !user?.uid
      ? "You're chatting with One. Sign in and unlock your vault for personalized help."
      : needsVaultUnlock
        ? "You're chatting with One. Unlock your vault to work with your private information."
        : null;
  const accessAction = authLoading
    ? null
    : !user?.uid
      ? {
          label: "Sign in",
          icon: LogIn,
          onClick: () => router.push(ROUTES.LOGIN),
        }
      : needsVaultUnlock
        ? {
            label: "Unlock vault",
            icon: KeyRound,
            // Just-in-time unlock in place via the shared dialog, instead of
            // navigating away to /one/profile and losing the agent context.
            onClick: () => setVaultDialogOpen(true),
          }
        : null;
  const displayName = useMemo(
    () => formatAgentDisplayName(user?.displayName, user?.email),
    [user?.displayName, user?.email],
  );
  const userAvatarUrl = useEffectiveAvatarUrl();
  const userInitials = useMemo(() => {
    const value = displayName === "there" ? "You" : displayName;
    return value.slice(0, 2).toUpperCase();
  }, [displayName]);
  const hasStartedConversation = messages.some(
    (message) => message.id !== "agent-greeting",
  );
  const visibleMessages = dedupeAdjacentAgentMessages(
    messages.filter((message) => {
      if (message.id === "agent-greeting") return false;
      if (
        pendingSpecialistDirective &&
        message.role === "assistant" &&
        !message.text.trim()
      ) {
        return false;
      }
      return true;
    }),
  );
  const trailingSpecialistLoadingMessages = pendingSpecialistDirective
    ? messages.filter(
        (message) =>
          message.id !== "agent-greeting" &&
          message.role === "assistant" &&
          !message.text.trim(),
      )
    : [];
  const emailDeliveryTimeline = useMemo(
    () =>
      bucketEmailDeliveryTimelineItems(
        emailDeliveryHistory,
        visibleMessages.map((message) => message.id),
      ),
    [emailDeliveryHistory, visibleMessages],
  );
  const emailDraftIsAnchored = Boolean(
    emailDraftOpen &&
      emailDraftAnchorMessageId &&
      visibleMessages.some(
        (message) => message.id === emailDraftAnchorMessageId),
  );
  const renderEmailDraftCard = () => {
    if (!emailDraftOpen) return null;
    const workflowId = gmailKycEmailDraftWorkflowId;
    return (
      <div className="border-t border-border/70 pt-3">
        <EmailDraftCard
          initialInstruction={emailDraftInstruction}
          initialDraft={emailDraftInitialValue}
          autoDraft={emailDraftAutoDraft}
          getAuth={getEmailDeliveryAuth}
          onRequireVault={() => setVaultDialogOpen(true)}
          onDismiss={closeEmailDraft}
          onSendStarted={handleEmailSendStarted}
          onSent={handleEmailSent}
          onSendFailed={handleEmailSendFailed}
          sourceBoundContext={
            gmailKycReplyRequest
              ? `This request asks for: ${gmailKycRequestSummary(gmailKycReplyRequest)}.`
              : undefined
          }
          sourceBoundReply={
            workflowId
              ? {
                  send: async ({
                    firebaseIdToken,
                    vaultOwnerToken,
                    draft,
                    idempotencyKey,
                  }) => {
                    const body = richEmailPlainText(draft.body);
                    if (!body) {
                      throw new Error("Write a reply before sending it.");
                    }
                    const prepared = await GmailInformationRequestsService.prepareReply({
                      firebaseIdToken,
                      vaultOwnerToken,
                      workflowId,
                      body,
                      htmlBody: draft.htmlBody ?? draft.body,
                      idempotencyKey,
                    });
                    const sent = await GmailInformationRequestsService.sendReply({
                      firebaseIdToken,
                      vaultOwnerToken,
                      workflowId,
                      actionId: prepared.actionId,
                      body,
                      htmlBody: draft.htmlBody ?? draft.body,
                    });
                    return { outcomeUnknown: sent.outcomeUnknown };
                  },
                }
              : null
          }
        />
      </div>
    );
  };
  const latestRetryableAssistantId =
    [...visibleMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          !message.ephemeral &&
          message.status !== "streaming" &&
          message.text.trim().length > 0,
      )?.id ?? null;
  const handleRetryAssistantResponse = (messageId: string) => {
    const assistantIndex = messages.findIndex(
      (message) => message.id === messageId,
    );
    if (assistantIndex < 0) return;
    const previousUserMessage = [...messages.slice(0, assistantIndex)]
      .reverse()
      .find(
        (message) => message.role === "user" && message.text.trim().length > 0,
      );
    const retryText = previousUserMessage?.text.trim();
    if (!retryText) {
      toast.error("No previous message found to retry.");
      return;
    }
    setWalletWidgets([]);
    // Pre-vault / anonymous turns go through the informational intro tier, which
    // runAgentTurn early-returns on (no vault access). Route the retry to the
    // same tier the original turn used so the button is not a no-op there.
    enqueueWorkspaceOperation({
      id: `retry-${crypto.randomUUID()}`,
      run: async () => {
        if (!hasChatAccess) {
          await runIntroTurn(retryText);
          return;
        }
        await runAgentTurn(retryText, {
          source: "typed",
          appendUserMessage: false,
          replaceAssistantMessageId: messageId,
        });
      },
    });
  };
  const handleWelcomePromptSelect = useCallback((prompt: string) => {
    setInput(prompt);
    window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
  }, []);
  const toggleHistoryDrawer = useCallback(() => {
    setIsHistoryDrawerOpen((prev) => {
      if (!prev) {
        if (!isPuppySurface) void loadConversationList().catch(() => undefined);
      }
      return !prev;
    });
  }, [isPuppySurface, loadConversationList]);
  const renderHistorySidebar = (
    sidebarClassName?: string,
    onClose?: () => void,
    collapsed = false,
    mode: "desktop" | "mobile" = "desktop",
  ) => (
    <AgentHistorySidebar
      conversations={isPuppySurface ? puppyConversations : conversations}
      activeConversationId={isPuppySurface ? puppyConversationId : conversationId}
      loading={isPuppySurface ? false : (isLoadingHistory && conversations.length === 0)}
      disabled={isPuppySurface ? false : (!hasChatAccess || historyInteractionDisabled)}
      actionPendingId={historyActionPendingId}
      className={sidebarClassName}
      collapsed={collapsed}
      mode={mode}
      hideCloseButton={true}
      surface={agentSurface}
      onClose={onClose}
      onToggleCollapsed={toggleHistoryDrawer}
      onOpenConnectors={
        !isPuppySurface && connectionsAvailable
          ? () => setDrawerMode("connections")
          : undefined
      }
      onCreateNew={handleSidebarCreateNewChat}
      onSelectConversation={handleSidebarSelectConversation}
      onRenameConversation={isPuppySurface ? handleRenamePuppyConversation : handleRenameConversation}
      onDeleteConversation={isPuppySurface ? handleDeletePuppyConversation : handleDeleteConversation}
    />
  );
  const getEmailDeliveryAuth = async () => {
    if (!user || !isVaultUnlocked || !tokenIsFresh) return null;
    const currentVaultOwnerToken = getVaultOwnerToken();
    if (!currentVaultOwnerToken) return null;
    const firebaseIdToken = await user.getIdToken();
    if (!firebaseIdToken) return null;
    return { firebaseIdToken, vaultOwnerToken: currentVaultOwnerToken };
  };
  const composerActionRail = (
    <>
      {agentVoiceEnabled ? (
        <ShellActionSurface
          type="button"
          data-native-voice-control-id="one_voice_agent_chat_start"
          data-testid="one-voice-agent-chat-start"
          className="text-[rgba(0,0,0,0.50)] max-sm:text-[color:var(--app-accent-deep)] dark:text-zinc-400 dark:max-sm:text-[color:var(--app-accent-deep)]"
          disabled={!canToggleVoice}
          onClick={() => {
            void startConversationalVoice();
          }}
          aria-label="Start voice mode"
          title="Start voice mode"
        >
          <Mic className="h-4 w-4" />
        </ShellActionSurface>
      ) : null}
      <ShellActionSurface
        type="submit"
        className="border-transparent bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)] disabled:bg-black/[0.06] disabled:text-[rgba(0,0,0,0.36)] dark:disabled:bg-white/[0.08] dark:disabled:text-zinc-500"
        disabled={!canSend}
        aria-label="Send message"
        title="Send message"
        onClick={(event) => {
          // Keep the form path for keyboard/assistive submission, but do not
          // rely on the wrapped shell/ripple button's native submit default.
          // A real pointer click can otherwise release without dispatching
          // submit while the control is visibly enabled.
          event.preventDefault();
          void submitComposerText();
        }}
      >
        <Send className="h-4 w-4" />
      </ShellActionSurface>
    </>
  );

  return (
    <div
      className={cn(
        "agent-chat-workspace flex min-h-0 w-full flex-col text-foreground",
        // Chat is the canonical root workspace. In canonical mode it spans full
        // height and manages its internal scroll streams and composer clearance.
        "min-h-[420px] overflow-hidden bg-background",
        isCanonicalChatRoute
          ? // The persistent bottom nav is `position: fixed`, so a flex-1/h-full
            // ancestor has no way to know it needs to leave room above it. Without
            // this subtraction the composer's own small `--agent-chat-composer-bottom`
            // padding (by design just a safe-area gap, not full nav clearance --
            // see the `[data-agent-chat-route="root"]` rule in globals.css) put the
            // composer's text field directly underneath the fixed nav instead of
            // above it.
            //
            // `flex-1` sets `flex-basis: 0%`, which becomes this item's main-axis
            // (height, in a flex-col ancestor) size and makes the browser ignore
            // an explicit `height` utility on the same element entirely -- the
            // element still grows to fill 100% of the flex column regardless of
            // what `h-[calc(...)]` says. Dropping `flex-1` lets `flex-basis: auto`
            // fall back to the `height` property instead, so the calc() actually
            // governs the rendered size.
            "agent-chat-workspace--root flex-1 h-full min-h-0"
          : "h-[calc(100dvh-var(--app-top-content-offset,0px)-var(--app-bottom-shell-height,calc(var(--app-bottom-fixed-ui,0px)+var(--app-safe-area-bottom-effective,0px))))]",
        className,
      )}
      data-agent-chat-workspace="page"
      data-agent-chat-route={isCanonicalChatRoute ? "root" : "embedded"}
      data-agent-history-drawer-open={isHistoryDrawerOpen ? "true" : undefined}
    >
      <AgentPersonSelectionContext.Provider value={hasChatAccess && !isStreaming
        ? (handle, name) => enqueuePrompt(`Check what I can ask ${name} for.`, handle)
        : null}>
      <div
        className={cn(
          "relative flex min-h-0 flex-1",
          // The route-level workspace owns one continuous surface. There is
          // no retired popover frame or second overlay surface here.
          "overflow-hidden",
        )}
      >
        <AgentConnectionsDrawer
          triggerRef={historyDrawerTriggerRef}
          open={isHistoryDrawerOpen}
          onOpenChange={setIsHistoryDrawerOpen}
          mode={drawerMode}
          externalModalOpen={connectorExternalModalOpen}
          chats={renderHistorySidebar(
            "h-full w-full",
            () => setIsHistoryDrawerOpen(false),
            false,
            "mobile",
          )}
          connections={
            <ConnectorsPanel
              open={isHistoryDrawerOpen && drawerMode === "connections"}
              onBack={() => setDrawerMode("chats")}
              onAvailableChange={setConnectionsAvailable}
              onExternalModalChange={setConnectorExternalModalOpen}
              onPrepareRecovery={prepareDriveChatRecovery}
              onClearRecovery={clearPreparedDriveChatRecovery}
            />
          }
        />

        <section
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_78%_8%,color-mix(in_srgb,var(--app-accent-soft)_42%,transparent),transparent_34%),var(--background)]",
          )}
        >
          <div
            className={cn(
              "agent-chat-header relative z-[540] flex shrink-0 touch-pan-y items-center justify-between gap-3 bg-background/90 px-4 pt-[var(--agent-chat-header-safe-top)] backdrop-blur-2xl sm:px-5",
              "h-[var(--agent-chat-header-height)] lg:px-6",
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <ShellActionSurface
                variant="icon"
                ref={historyDrawerTriggerRef}
                onClick={(event) => { historyDrawerTriggerRef.current = event.currentTarget; toggleHistoryDrawer(); }}
                aria-label={isHistoryDrawerOpen ? "Close chat history" : "Open chat history"}
                title={isHistoryDrawerOpen ? "Close chat history" : "Open chat history"}
                className="relative z-[540]"
              >
                <AnimatedMenuCrossIcon isOpen={isHistoryDrawerOpen} />
              </ShellActionSurface>
              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[13px] bg-[color:var(--app-accent-soft)] shadow-[0_10px_28px_-20px_var(--app-accent-deep)]">
                {isPuppySurface ? (
                  <Laptop
                    className="h-5 w-5 text-[color:var(--app-accent-deep)]"
                    aria-hidden
                  />
                ) : (
                  /* The mark, as text, exactly like the top bar / sidebar /
                     intro gate. This slot used to render a raster of Noto
                     (Android) artwork — so it stayed Android on a Mac no matter
                     what the font stack said, and it was the one brand mark in
                     the app that could not follow the platform.
                     .hushh-brand-mark pins the emoji font the same way every
                     other mark does. */
                  <span
                    aria-label="One"
                    role="img"
                    className="hushh-brand-mark select-none text-[24px] leading-none max-sm:text-[30px]"
                  >
                    🤫
                  </span>
                )}
              </div>
              {/* The name in the header is the reader's only guarantee about
                  which agent is answering, so it names the agent actually on
                  screen rather than the workspace. */}
              <div className="min-w-0">
                <div className="truncate text-base font-medium leading-5 text-foreground">
                  {isPuppySurface ? "Puppy One" : "One"}
                </div>
                <p className="hidden truncate text-xs text-muted-foreground sm:block">
                  {/* Not "On your machine": most accounts have no machine, and
                      this line renders identically for them. What Puppy One is
                      is said once, by the surface below, and only to the reader
                      who has not connected one yet; the workspace header must
                      not promise a Mac it cannot see. */}
                  {isPuppySurface
                    ? "Separate conversation"
                    : "Your private agent"}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/*
                The compact segmented control at header scale. The full-width
                filter primitive was tried here first and stood ~44px tall
                against 36px icon buttons, so the header stopped lining up.
                This one is h-8. It has NO sliding thumb: the active segment is
                a per-button background that cross-fades, and a comment here
                used to claim a slide the code never had. `SegmentedPill` is
                the primitive that ships the translateX indicator, with its own
                theme hooks and reduced-motion guard; the day this header wants
                that animation it should move to that component rather than
                grow a second implementation of it.
              */}
              <SegmentedControl
                variant="compact"
                size="sm"
                ariaLabel="Agent"
                value={agentSurface}
                onValueChange={(next) => {
                  const surface = next as AgentChatSurface;
                  if (surface === "puppy") {
                    enterPuppySurface();
                    return;
                  }
                  setAgentSurface(surface);
                }}
                options={[
                  {
                    value: "one",
                    label: "One",
                    accessibleLabel: "One, your cloud agent",
                  },
                  {
                    value: "puppy",
                    label: "Puppy",
                    accessibleLabel:
                      "Puppy One, on your machine, with its own conversation",
                  },
                ]}
                className="w-auto shrink-0"
              />
              {/* A fixed slot, present whenever this person HAS a picker,
                  so switching surfaces cannot slide the toggle sideways under
                  the thumb that just pressed it. This is the same jump the
                  status slot below was widened to stop, and the picker is the
                  higher-frequency control of the two: it also pops in after
                  the async load on every One mount. An explicit width, because
                  a spacer carrying only max-w collapses to zero; and no slot
                  at all for someone with a single model, so the header does
                  not reserve space for a control they never see. */}
              {canPickOneModel && modelPreference ? (
              <span className="flex w-[7.5rem] shrink-0 justify-end sm:w-[9.5rem]">
              {/* One's model picker names the CLOUD model and writes One's
                  preference. In Puppy One it would assert a Gemini is running
                  on the owner's machine, and choosing an item would silently
                  rewrite the other agent's model with no visible consequence
                  on the screen being looked at. Gated, not merely hidden: the
                  write must not stay reachable from the on-device surface. */}
              {!isPuppySurface ? (
                <Select
                  value={modelPreference.effective_model}
                  onValueChange={(nextModel) => {
                    const previous = modelPreference;
                    // Optimistic: the picker must not stall the header while the
                    // write lands. A failure restores exactly what was showing.
                    setModelPreference({ ...previous, effective_model: nextModel });
                    void (async () => {
                      try {
                        if (!user) return;
                        const saved = await ModelPreferenceService.set(
                          await user.getIdToken(),
                          nextModel,
                        );
                        setModelPreference(saved);
                      } catch {
                        setModelPreference(previous);
                      }
                    })();
                  }}
                >
                  <SelectTrigger
                    data-testid="agent-chat-model-picker"
                    // Names the agent it configures, so it still says which
                    // one when it is read out of context.
                    aria-label="One's model"
                    title={`Running ${modelPreference.effective_model}`}
                    className="h-8 w-auto max-w-full shrink-0 gap-1 rounded-full border-0 bg-foreground/[0.045] px-2.5 text-[11px] font-medium text-muted-foreground"
                  >
                    {/* "3.8 Flash", not "Gemini 3.8 Flash": every option is a
                        Gemini, so the shared word is the one thing a narrow
                        header cannot afford. The full label stays in the menu
                        and in the tooltip. */}
                    <span className="truncate">
                      {(
                        modelPreference.choices.find(
                          (choice) => choice.model_id === modelPreference.effective_model,
                        )?.label ?? modelPreference.effective_model
                      ).replace(/^Gemini\s+/i, "")}
                    </span>
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="end"
                    sideOffset={6}
                    className="z-[560] min-w-[12rem]"
                  >
                    {modelPreference.choices.map((choice) => (
                      <SelectItem key={choice.model_id} value={choice.model_id}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              </span>
              ) : null}
              {/* A fixed slot, always present. This used to mount and unmount
                  with the status, and because the cluster is shrink-0 the whole
                  right side, One/Puppy toggle included, jumped sideways every
                  time One started or stopped thinking. The width is reserved so
                  nothing moves, and the text truncates instead of pushing. */}
              <span
                className="hidden w-28 shrink-0 truncate text-right text-xs font-medium text-muted-foreground sm:inline-block"
                role="status"
                aria-live="polite"
                title={statusText || undefined}
              >
                {statusText}
              </span>
              <ShellActionSurface
                variant="icon"
                data-testid="profile-open-button"
                aria-label="Open Profile"
                onClick={() => requestProfilePaneOpen("tap")}
                className="!h-8 !w-8 shrink-0 !border-transparent !bg-[color:var(--app-accent)] p-0 !text-[color:var(--app-accent-fg)] !shadow-none hover:!bg-[color:var(--app-accent-hover)]"
              >
                <Avatar className="h-8 w-8">
                  {userAvatarUrl ? (
                    <AvatarImage src={userAvatarUrl} alt="" />
                  ) : null}
                  <AvatarFallback className="bg-transparent text-[15px] font-semibold leading-5 text-current">
                    {user?.displayName ? (
                      user.displayName
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((part) => part[0]?.toUpperCase())
                        .join("")
                    ) : (
                      <User className="h-4 w-4" />
                    )}
                  </AvatarFallback>
                </Avatar>
              </ShellActionSurface>
            </div>
          </div>

          {/* Both transcripts are HIDDEN rather than unmounted, and the
              symmetry is the point: `hidden` is display:none, so the surface
              that is not on screen leaves the tab order and the accessibility
              tree, while a turn already in flight (One's cloud stream, or a
              local answer that can take tens of seconds) is not destroyed by a
              glance at the other agent. Puppy is mounted lazily, so a
              workspace that never opens it costs the loopback gateway and the
              trusted-device list nothing, and `active` is what stops the
              hidden one polling and what closes its portalled machine panel,
              which a `hidden` ancestor cannot reach. Nothing is shared between
              the two: no message, no history row. */}
          {puppyEverOpened ? (
            <PuppyOneSurface
              key={user?.uid ?? "signed-out"}
              active={isPuppySurface}
              conversations={puppyConversations}
              activeConversationId={puppyConversationId}
              onCreateConversation={handleCreateNewPuppyChat}
              className={cn(!isPuppySurface && "hidden", "lg:px-8")}
            />
          ) : null}

          <div
            className="relative min-h-0 flex-1 overflow-hidden"
            inert={isHistoryDrawerOpen}
          >
            <div
              ref={transcriptRef}
              onScroll={(event) => {
                // A display:none element fires no scroll events, so this only
                // ever records One's own position; the guard is belt and braces.
                if (!isPuppySurface) {
                  const transcript = event.currentTarget;
                  const scrollTop = transcript.scrollTop;
                  const previousScrollTop = oneScrollTopRef.current;
                  oneScrollTopRef.current = scrollTop;

                  const maxScrollTop = Math.max(
                    0,
                    transcript.scrollHeight - transcript.clientHeight,
                  );
                  const distanceFromBottom = maxScrollTop - scrollTop;

                  // When the reader scrolls up or moves noticeably away from the bottom,
                  // immediately clear any programmatic lock and mark active reader control.
                  if (scrollTop < previousScrollTop - 2 || distanceFromBottom > 64) {
                    clearTranscriptProgrammaticScroll();
                    transcriptUserScrollRef.current = true;
                  } else if (distanceFromBottom <= 16) {
                    // Re-enable following when the reader returns to the latest message
                    transcriptUserScrollRef.current = false;
                  }

                  if (transcriptProgrammaticScrollRef.current) {
                    const target = transcriptProgrammaticTargetRef.current;
                    if (
                      target === null ||
                      Math.abs(scrollTop - Math.min(target, maxScrollTop)) <= 3
                    ) {
                      clearTranscriptProgrammaticScroll();
                    }
                    return;
                  }
                  // Any unclassified scroll event after the programmatic guard
                  // is a real reader movement (wheel, keyboard, or touch). Once
                  // that happens, message updates must respect the reader's
                  // position instead of repeatedly snapping to the end.
                  transcriptUserScrollRef.current = true;
                  // Chat owns an inner transcript scroller inside the shared
                  // route shell. Feed its committed movement into the same
                  // bottom-chrome visibility state used by every other route so
                  // scrolling Chat up/down hides or reveals nav consistently,
                  // without a React render on each frame.
                  if (isCanonicalChatRoute) {
                    onKaiBottomChromeScroll(scrollTop);
                  }
                }
              }}
              onWheelCapture={() => {
                clearTranscriptProgrammaticScroll();
                transcriptUserScrollRef.current = true;
              }}
              onTouchStartCapture={() => {
                clearTranscriptProgrammaticScroll();
                transcriptUserScrollRef.current = true;
              }}
              className={cn(
                "h-full w-full overflow-y-auto px-4 pt-5 scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent sm:px-6",
                "pb-[calc(var(--agent-chat-composer-bottom,5rem)+5.5rem)] lg:px-8",
                isPuppySurface && "hidden",
              )}
              tabIndex={0}
              role="region"
              aria-label="Agent conversation history"
            >
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6">
              {accessMessage ? (
                <div className="flex flex-col gap-3 rounded-[20px] bg-foreground/[0.045] px-4 py-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>{accessMessage}</span>
                  {accessAction ? (
                    <Button
                      type="button"
                      size="sm"
                      className="w-full shrink-0 gap-2 rounded-lg sm:w-auto"
                      onClick={accessAction.onClick}
                    >
                      <accessAction.icon
                        className="h-4 w-4"
                        aria-hidden="true"
                      />
                      {accessAction.label}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {postSetupWelcomeContext ? (
                <PostSetupWelcomeCard
                  name={displayName}
                  context={postSetupWelcomeContext}
                  disabled={isChatLoading || isStreaming}
                  onPromptSelect={handleWelcomePromptSelect}
                />
              ) : !hasStartedConversation ? (
                <AgentWelcomePanel
                  name={displayName}
                  prompts={welcomePrompts}
                  disabled={isChatLoading || isStreaming}
                  onPromptSelect={handleWelcomePromptSelect}
                />
              ) : null}

              {visibleMessages.map((message) => (
                <Fragment key={message.id}>
                  {message.kind === "selection" ? (
                    <SelectionChip label={message.text} />
                  ) : (
                    <AgentBubble
                      message={message}
                      onOpenConnections={(trigger) => { historyDrawerTriggerRef.current = trigger; setDrawerMode("connections"); setIsHistoryDrawerOpen(true); }}
                      userAvatarUrl={userAvatarUrl}
                      userInitials={userInitials}
                      retryDisabled={isChatLoading || isStreaming}
                      rating={messageRatings[message.serverMessageId ?? message.id] ?? null}
                      onRate={(next) =>
                        handleRateMessage(message.serverMessageId ?? message.id, next)
                      }
                      onRetry={
                        message.id === latestRetryableAssistantId
                          ? () => handleRetryAssistantResponse(message.id)
                          : undefined
                      }
                      busyConsentItemId={specialistBusyItemId}
                      onConsentRevoke={async (item) => {
                        setSpecialistBusyItemId(item.id);
                        try {
                          await oneLocationConsentActions.handleRevoke({
                            id: item.id,
                            scope: item.scope ?? null,
                            metadata: item.metadata ?? null,
                          });
                          updateMessage(message.id, (current) => ({
                            ...current,
                            specialistDirective:
                              markConsentDirectiveItemRevoked(
                                current.specialistDirective,
                                item.id,
                              ),
                          }));
                        } finally {
                          setSpecialistBusyItemId(null);
                        }
                      }}
                      onConsentDetails={(item) => {
                        // Tag the agent's current route as origin so the consent
                        // screen's back button retraces here, not to Profile
                        // (the breadcrumb reads ?from; bare nav falls to Profile).
                        router.push(
                          `${ROUTES.CONSENTS}?tab=active&requestId=${encodeURIComponent(item.id)}&from=${pathname || ROUTES.ONE_HOME}`,
                        );
                      }}
                      onPendingConsentApprove={async (item) => {
                        // The hook returns without throwing when the vault is
                        // locked, which would mark the card approved for an
                        // approval that never went out. Refuse here instead.
                        if (!user?.uid || !isVaultUnlocked || !vaultKey) {
                          addErrorMessage(
                            "Unlock your vault to approve this request.",
                          );
                          return;
                        }
                        setSpecialistBusyItemId(item.id);
                        try {
                          // A folded card answers every request in it. Each
                          // member is looked up again so Approve wraps the key
                          // in that request's own metadata.
                          const targets = await resolvePendingConsentCardTargets({
                            userId: user.uid,
                            vaultOwnerToken: getVaultOwnerToken(),
                            item,
                          });
                          if (!targets.length) {
                            addErrorMessage(
                              "That request is no longer waiting on you.",
                            );
                            return;
                          }
                          // Quiet so the outcome lands in the transcript, not
                          // a toast over it. Quiet rethrows a failed request,
                          // so the card is only marked approved when every
                          // request in it was.
                          for (const target of targets) {
                            await consentActions.handleApprove(target, {
                              quiet: true,
                            });
                          }
                          updateMessage(message.id, (current) => ({
                            ...current,
                            specialistDirective:
                              markPendingConsentRequestDirectiveStatus(
                                current.specialistDirective,
                                item.id,
                                "approved",
                              ),
                          }));
                        } catch (error) {
                          addErrorMessage(
                            error instanceof Error && error.message.startsWith("This request")
                              ? error.message
                              : "Could not approve that request. Try again.",
                          );
                        } finally {
                          setSpecialistBusyItemId(null);
                        }
                      }}
                      onPendingConsentDeny={async (item) => {
                        // Same guard as approve: the hook returns silently
                        // without a signed-in owner or an unlocked vault.
                        if (!user?.uid || !isVaultUnlocked) {
                          addErrorMessage(
                            "Unlock your vault to decline this request.",
                          );
                          return;
                        }
                        setSpecialistBusyItemId(item.id);
                        try {
                          // Same shape as approve: a folded card declines every
                          // request in it, and only those still pending.
                          const targets = await resolvePendingConsentCardTargets({
                            userId: user.uid,
                            vaultOwnerToken: getVaultOwnerToken(),
                            item,
                          });
                          if (!targets.length) {
                            addErrorMessage(
                              "That request is no longer waiting on you.",
                            );
                            return;
                          }
                          for (const target of targets) {
                            await consentActions.handleDeny(target.id, {
                              quiet: true,
                            });
                          }
                          updateMessage(message.id, (current) => ({
                            ...current,
                            specialistDirective:
                              markPendingConsentRequestDirectiveStatus(
                                current.specialistDirective,
                                item.id,
                                "denied",
                              ),
                          }));
                        } catch (error) {
                          addErrorMessage(
                            error instanceof Error && error.message.startsWith("This request")
                              ? error.message
                              : "Could not decline that request. Try again.",
                          );
                        } finally {
                          setSpecialistBusyItemId(null);
                        }
                      }}
                      onPendingConsentDetails={(item) => {
                        // Origin-tagged so back retraces to the agent's route.
                        router.push(
                          `${ROUTES.CONSENTS}?tab=pending&requestId=${encodeURIComponent(item.id)}&from=${pathname || ROUTES.ONE_HOME}`,
                        );
                      }}
                    />
                  )}
                  {(
                    emailDeliveryTimeline.itemsAfterMessage.get(message.id) ??
                    []
                  ).map((item) => (
                    <EmailDeliveryHistoryCard
                      key={item.id}
                      item={item}
                      onRetry={retryEmailDelivery}
                    />
                  ))}
                  {message.id === emailDraftAnchorMessageId
                    ? renderEmailDraftCard()
                    : null}
                </Fragment>
              ))}

              {walletWidgets.map((widget) =>
                widget.kind === "list" ? (
                  <div
                    key={widget.id}
                    data-testid="agent-chat-wallet-list"
                    className="rounded-2xl border border-border/60 bg-card/60 p-3"
                  >
                    <p className="px-1 pb-2 text-xs text-muted-foreground">
                      Your cards. Revealing one decrypts it on this device only.
                    </p>
                    <ul className="flex flex-col gap-1">
                      {widget.summaries.map((summary) => (
                        <li
                          key={summary.cardId}
                          className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-foreground/[0.04]"
                        >
                          <span className="flex min-w-0 items-center gap-3">
                            <CardNetworkMark brand={summary.brand} />
                            <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {summary.nickname || cardNetworkLabel(summary.brand)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {cardNetworkLabel(summary.brand)} ····{summary.last4} ·{" "}
                              {String(summary.expiryMonth).padStart(2, "0")}/{summary.expiryYear} ·{" "}
                              {summary.issuingRegion}
                            </span>
                            </span>
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="shrink-0"
                            data-testid={`agent-chat-wallet-reveal-${summary.last4}`}
                            onClick={() => void handleWalletWidgetReveal(widget.id, summary)}
                          >
                            Reveal
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : widget.kind === "add" ? (
                  <SecureCardAddForm
                    key={widget.id}
                    compact
                    onSubmit={async (card) => {
                      const token = getVaultOwnerToken();
                      if (!user?.uid || !vaultKey || !token) {
                        throw new Error("Unlock your vault to save a card.");
                      }
                      const saved = await WalletService.addCard({
                        userId: user.uid,
                        vaultKey,
                        vaultOwnerToken: token,
                        card,
                        surface: "chat",
                        source: "agent_chat_wallet_add",
                      });
                      setWalletWidgets((current) =>
                        current.filter((item) => item.id !== widget.id),
                      );
                      appendMessage({
                        id: `msg-${Date.now()}-card-saved`,
                        role: "assistant",
                        text: `Saved card "${saved.summary.nickname || saved.summary.brand}" ending ${saved.summary.last4}.`,
                        timestamp: formatNow(),
                        status: "done",
                        renderAsPlainAssistantMessage: true,
                      });
                    }}
                    onCancel={() =>
                      setWalletWidgets((current) =>
                        current.filter((item) => item.id !== widget.id),
                      )
                    }
                  />
                ) : (
                  <SecureCardReveal
                    key={widget.id}
                    summary={widget.summary}
                    secrets={widget.secrets}
                    onDismiss={() =>
                      setWalletWidgets((current) =>
                        current.filter((item) => item.id !== widget.id),
                      )
                    }
                  />
                ),
              )}

              {pendingAppAction ? (
                <SpecialistDirectiveCard
                  summary={
                    pendingAppAction.event.message ||
                    `One is ready to ${pendingAppAction.event.label || "continue"}. Nothing runs until you confirm.`
                  }
                  confirmLabel={pendingAppAction.event.label || "Run"}
                  busy={appActionBusy}
                  onConfirm={async () => {
                    const pending = pendingAppAction;
                    if (!pending || appActionBusy) return;
                    setAppActionBusy(true);
                    try {
                      await pending.execute();
                      setPendingAppAction(null);
                    } catch {
                      setPendingAppAction(null);
                      addErrorMessage(
                        "The app could not complete the confirmed action.",
                      );
                    } finally {
                      setAppActionBusy(false);
                    }
                  }}
                  onCancel={() => {
                    const pending = pendingAppAction;
                    setPendingAppAction(null);
                    void pending.cancel?.().catch(() => undefined);
                    toast.info("Action cancelled. Nothing was changed.");
                  }}
                />
              ) : null}

              {pendingSpecialistDirective ? (
                getConsentRequiredPayload(pendingSpecialistDirective) ? (
                  <SpecialistConsentRequiredCard
                    agentId={
                      getConsentRequiredPayload(pendingSpecialistDirective)
                        ?.agentId ?? pendingSpecialistDirective.delegateAgentId
                    }
                    requiredScope={
                      getConsentRequiredPayload(pendingSpecialistDirective)
                        ?.requiredScope ?? ""
                    }
                    reason={
                      getConsentRequiredPayload(pendingSpecialistDirective)
                        ?.reason
                    }
                    busy={specialistBusy}
                    onOpenConsent={() => {
                      setPendingSpecialistDirective(null);
                      router.push(
                        `${ROUTES.CONSENTS}?tab=pending&from=${pathname || ROUTES.ONE_HOME}`,
                      );
                    }}
                    onCancel={() => {
                      setPendingSpecialistDirective(null);
                    }}
                  />
                ) : pendingSpecialistDirective.directive.kind === "prompt" &&
                  localCrmEnabled &&
                  pendingSpecialistDirective.delegateAgentId ===
                    "agent_connected_systems" &&
                  pendingSpecialistDirective.directive.payload.kind ===
                    "free_text" ? (
                  <SpecialistFreeTextPromptCard
                    question={String(
                      pendingSpecialistDirective.directive.payload.question ??
                        "What value should I use?",
                    )}
                    placeholder={String(
                      pendingSpecialistDirective.directive.payload
                        .placeholder ?? "",
                    )}
                    confirmLabel={
                      typeof pendingSpecialistDirective.directive.payload
                        .confirmLabel === "string"
                        ? pendingSpecialistDirective.directive.payload
                            .confirmLabel
                        : null
                    }
                    cancelLabel={
                      typeof pendingSpecialistDirective.directive.payload
                        .cancelLabel === "string"
                        ? pendingSpecialistDirective.directive.payload
                            .cancelLabel
                        : null
                    }
                    busy={specialistBusy}
                    onSubmit={async (value) => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive.payload as Record<
                        string,
                        unknown
                      >;
                      setSpecialistBusy(true);
                      try {
                        setPendingSpecialistDirective(null);
                        appendMessage({
                          id: `msg-${Date.now()}-crm-answer`,
                          role: "user",
                          text: value,
                          timestamp: formatNow(),
                          status: "done",
                          kind: "selection",
                        });
                        enqueueDelegateResult({
                          delegate_agent_id: "agent_connected_systems",
                          kind: "selection",
                          id: String(prompt.id ?? ""),
                          type: String(prompt.type ?? ""),
                          selected: [
                            {
                              slots: prompt.slots,
                              fieldName: prompt.fieldName,
                            },
                          ],
                          freeText: value,
                          status: "answered",
                          display: value,
                        });
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
                    onCancel={async () => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive.payload as Record<
                        string,
                        unknown
                      >;
                      setPendingSpecialistDirective(null);
                      appendMessage({
                        id: `msg-${Date.now()}-crm-cancel`,
                        role: "user",
                        text: "Cancelled",
                        timestamp: formatNow(),
                        status: "done",
                        kind: "selection",
                      });
                      enqueueDelegateResult({
                        delegate_agent_id: "agent_connected_systems",
                        kind: "selection",
                        id: String(prompt.id ?? ""),
                        type: String(prompt.type ?? ""),
                        status: "cancelled",
                        display: "Cancelled",
                      });
                    }}
                  />
                ) : pendingSpecialistDirective.directive.kind === "prompt" ? (
                  // ── Prompt / disambiguation mode ──────────────────────────
                  // The location specialist emits a clientPrompt (which/who?,
                  // confirm duration, etc.) as a directive.kind:"prompt".
                  // Prompts never auto-fire; the user answers via the card and
                  // the selection result is sent back as a follow-up turn.
                  // Crypto is not involved — no coordinates pass through here.
                  <SpecialistPromptCard
                    prompt={
                      pendingSpecialistDirective.directive
                        .payload as unknown as ClientPrompt
                    }
                    busy={specialistBusy}
                    onAnswer={async (refs) => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive
                        .payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, {
                        selected: refs,
                      });
                      setSpecialistBusy(true);
                      try {
                        setPendingSpecialistDirective(null);
                        appendMessage({
                          id: `msg-${Date.now()}-sel`,
                          role: "user",
                          text: display,
                          timestamp: formatNow(),
                          status: "done",
                          kind: "selection",
                        });
                        enqueueDelegateResult({
                          delegate_agent_id:
                            evt.delegateAgentId as DelegateResult["delegate_agent_id"],
                          kind: "selection",
                          id: prompt.id,
                          promptKind: prompt.kind,
                          selected: refs,
                          status: "answered",
                          display,
                        });
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
                    onConfirm={async (yes) => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive
                        .payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, {
                        confirmed: yes,
                      });
                      setSpecialistBusy(true);
                      try {
                        setPendingSpecialistDirective(null);
                        appendMessage({
                          id: `msg-${Date.now()}-sel`,
                          role: "user",
                          text: display,
                          timestamp: formatNow(),
                          status: "done",
                          kind: "selection",
                        });
                        enqueueDelegateResult({
                          delegate_agent_id:
                            evt.delegateAgentId as DelegateResult["delegate_agent_id"],
                          kind: "selection",
                          id: prompt.id,
                          promptKind: prompt.kind,
                          confirmed: yes,
                          status: "answered",
                          display,
                        });
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
                    onCancel={async () => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive
                        .payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, {
                        status: "cancelled",
                      });
                      setPendingSpecialistDirective(null);
                      appendMessage({
                        id: `msg-${Date.now()}-sel`,
                        role: "user",
                        text: display,
                        timestamp: formatNow(),
                        status: "done",
                        kind: "selection",
                      });
                      enqueueDelegateResult({
                        delegate_agent_id:
                          evt.delegateAgentId as DelegateResult["delegate_agent_id"],
                        kind: "selection",
                        id: prompt.id,
                        promptKind: prompt.kind,
                        status: "cancelled",
                        display,
                      });
                    }}
                  />
                ) : pendingSpecialistDirective.delegateAgentId ===
                  "agent_calendar" ? (
                  <SpecialistDirectiveCard
                    summary={String(
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).summary ?? pendingSpecialistDirective.message,
                    )}
                    confirmLabel={String(
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).confirmLabel ?? "Continue",
                    )}
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      const payload = directive.directive.payload as Record<
                        string,
                        unknown
                      >;
                      const type = String(payload.type ?? "");
                      if (type === "calendar.connect") {
                        if (!user?.uid) {
                          addErrorMessage(
                            "Sign in again before connecting Google Calendar.",
                          );
                          return;
                        }
                        setSpecialistBusy(true);
                        try {
                          const accessLevel =
                            payload.accessLevel === "manage"
                              ? "manage"
                              : "read";
                          clearCalendarSetupOAuthReturn();
                          const start =
                            await GoogleCalendarService.startConnect({
                              idToken: await user.getIdToken(),
                              userId: user.uid,
                              accessLevel,
                            });
                          setPendingSpecialistDirective(null);
                          window.location.assign(start.authorize_url);
                        } catch (error) {
                          addErrorMessage(
                            error instanceof Error
                              ? error.message
                              : "Unable to request Google Calendar permission.",
                          );
                        } finally {
                          setSpecialistBusy(false);
                        }
                        return;
                      }
                      if (type !== "calendar.execute_proposal") {
                        setPendingSpecialistDirective(null);
                        addErrorMessage(
                          "That Calendar action is no longer available.",
                        );
                        return;
                      }
                      const token = getVaultOwnerToken();
                      if (!token || !user?.uid) {
                        addErrorMessage(
                          "Vault access expired. Unlock again to continue.",
                        );
                        return;
                      }
                      enqueueCalendarDirective(directive, token, user.uid);
                    }}
                    onCancel={() => {
                      setPendingSpecialistDirective(null);
                      toast.info(
                        "Calendar change cancelled. Nothing was changed.",
                      );
                    }}
                  />
                ) : localCrmEnabled && pendingSpecialistDirective.delegateAgentId ===
                  "agent_connected_systems" ? (
                  <SpecialistDirectiveCard
                    summary={String(
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).summary ?? pendingSpecialistDirective.message,
                    )}
                    confirmLabel={String(
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).confirmLabel ?? "Update",
                    )}
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      setSpecialistBusy(true);
                      try {
                        const token = getVaultOwnerToken();
                        if (!token) {
                          addErrorMessage(
                            "Vault access expired. Unlock again to continue.",
                          );
                          return;
                        }
                        const confirmLabel = String(
                          (
                            directive.directive.payload as Record<
                              string,
                              unknown
                            >
                          ).confirmLabel ?? "Update",
                        );
                        appendMessage({
                          id: `msg-${Date.now()}-crm-act`,
                          role: "user",
                          text: confirmLabel,
                          timestamp: formatNow(),
                          status: "done",
                          kind: "selection",
                        });
                        const result = await runConnectedSystemDirective(
                          directive.directive,
                          token,
                          {
                            email: user?.email,
                            phone: phoneNumber,
                          },
                        );
                        setPendingSpecialistDirective(null);
                        enqueueDelegateResult(result);
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
                    onCancel={async () => {
                      const directive = pendingSpecialistDirective;
                      setPendingSpecialistDirective(null);
                      appendMessage({
                        id: `msg-${Date.now()}-crm-cancel`,
                        role: "user",
                        text: "Cancelled",
                        timestamp: formatNow(),
                        status: "done",
                        kind: "selection",
                      });
                      enqueueDelegateResult({
                        delegate_agent_id: "agent_connected_systems",
                        kind: "action",
                        id: String(
                          (
                            directive.directive.payload as Record<
                              string,
                              unknown
                            >
                          ).id ?? "",
                        ),
                        type: String(
                          (
                            directive.directive.payload as Record<
                              string,
                              unknown
                            >
                          ).type ?? "",
                        ),
                        status: "cancelled",
                      });
                    }}
                  />
                ) : (
                  // ── Action / crypto mode (existing path, unchanged) ───────
                  <SpecialistDirectiveCard
                    summary={String(
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).summary ?? pendingSpecialistDirective.message,
                    )}
                    confirmLabel={
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).type === "sos_panic"
                        ? "Send SMS"
                        : (
                              pendingSpecialistDirective.directive
                                .payload as Record<string, unknown>
                            ).type === "request_device_location_permission"
                          ? "Allow location"
                          : "Share"
                    }
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      setSpecialistBusy(true);
                      const directivePayloadType = String(
                        (directive.directive.payload as Record<string, unknown>)
                          .type ?? "",
                      );
                      const confirmText =
                        directivePayloadType === "sos_panic"
                          ? "Send SMS"
                          : directivePayloadType ===
                              "request_device_location_permission"
                            ? "Allow location"
                            : "Share";
                      try {
                        // Source the vault owner token from the same place every
                        // other authed call uses (never hardcoded/invented).
                        const token = getVaultOwnerToken();
                        if (!token) {
                          addErrorMessage(
                            "Vault access expired. Unlock again to continue.",
                          );
                          return;
                        }
                        appendMessage({
                          id: `msg-${Date.now()}-act`,
                          role: "user",
                          text: confirmText,
                          timestamp: formatNow(),
                          status: "done",
                          kind: "selection",
                        });
                        const result = await runLocationDirective(
                          directive.directive,
                          token,
                          user?.uid ?? null,
                        );
                        setPendingSpecialistDirective(null);
                        // view_envelope fetches a coordinate-free result here; the
                        // decrypted point is rendered on the dedicated location
                        // surface, so hand the user off there to see it.
                        if (
                          directivePayloadType === "view_envelope" &&
                          result.status === "completed"
                        ) {
                          router.push(
                            `${ROUTES.ONE_LOCATION}?from=${pathname || ROUTES.ONE_HOME}`,
                          );
                        }
                        // Follow-up turn: report the result back so One confirms in words.
                        enqueueDelegateResult(result);
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
                    onCancel={async () => {
                      const directive = pendingSpecialistDirective;
                      setPendingSpecialistDirective(null);
                      appendMessage({
                        id: `msg-${Date.now()}-act`,
                        role: "user",
                        text: "Cancelled",
                        timestamp: formatNow(),
                        status: "done",
                        kind: "selection",
                      });
                      enqueueDelegateResult({
                        delegate_agent_id:
                          directive.delegateAgentId as DelegateResult["delegate_agent_id"],
                        kind: "action",
                        id: String(
                          (
                            directive.directive.payload as Record<
                              string,
                              unknown
                            >
                          ).id ?? "",
                        ),
                        // Include type so the backend renders the tailored cancel message.
                        type: String(
                          (
                            directive.directive.payload as Record<
                              string,
                              unknown
                            >
                          ).type ?? "",
                        ),
                        status: "cancelled",
                      });
                    }}
                  />
                )
              ) : null}

              {trailingSpecialistLoadingMessages.map((message) => (
                <AgentBubble
                  key={message.id}
                  message={message}
                  onOpenConnections={(trigger) => { historyDrawerTriggerRef.current = trigger; setDrawerMode("connections"); setIsHistoryDrawerOpen(true); }}
                  retryDisabled={isChatLoading || isStreaming}
                />
              ))}
              {!emailDraftIsAnchored ? renderEmailDraftCard() : null}
              {emailDeliveryTimeline.trailingItems.map((item) => (
                <EmailDeliveryHistoryCard
                  key={item.id}
                  item={item}
                  onRetry={retryEmailDelivery}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <form
            onSubmit={handleSubmit}
            inert={isHistoryDrawerOpen}
            data-agent-chat-composer-form={
              isCanonicalChatRoute ? "root" : "embedded"
            }
            className={cn(
              // CSS-only focus-within drives the padding shift in lockstep with
              // the native keyboard resize (no React state/rerender round-trip
              // in the path, which was the source of the visible lag on iOS).
              "pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pt-3 sm:px-5",
              "bg-transparent pb-[var(--agent-chat-composer-bottom)] focus-within:pb-[var(--agent-chat-composer-focused-bottom)]",
              // Puppy One has its own composer. Leaving One's on screen would
              // let a message meant for the on-device agent be sent to the
              // cloud one, which is exactly the confusion this mode prevents.
              isPuppySurface && "hidden",
            )}
          >
            <div
              className={cn(
                "pointer-events-auto mx-auto w-full",
                isCanonicalChatRoute
                  ? "max-w-[var(--app-bottom-shell-max-width)]"
                  : "max-w-4xl",
              )}
            >
              {queuedPrompts.length > 0 ? (
                <div
                  className="mb-2 rounded-[18px] bg-foreground/[0.045] px-3 py-2"
                  data-testid="agent-chat-prompt-queue"
                  aria-live="polite"
                >
                  <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                    <span>
                      {queuedPrompts.length}{" "}
                      {queuedPrompts.length === 1 ? "message" : "messages"}{" "}
                      queued
                    </span>
                    <span>One will send these in order.</span>
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    {queuedPrompts.map((prompt, index) => (
                      <div
                        key={prompt.id}
                        className="flex min-w-0 items-center gap-2 rounded-xl bg-background/75 px-2 py-1.5 text-sm"
                      >
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {index + 1}
                        </span>
                        {editingQueuedPromptId === prompt.id ? (
                          <input
                            autoFocus
                            aria-label="Edit queued message"
                            className="min-w-0 flex-1 bg-transparent outline-none"
                            value={editingQueuedPromptText}
                            onChange={(event) =>
                              setEditingQueuedPromptText(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                editQueuedPrompt(
                                  prompt.id,
                                  editingQueuedPromptText,
                                );
                              }
                              if (event.key === "Escape") {
                                setEditingQueuedPromptId(null);
                                setEditingQueuedPromptText("");
                              }
                            }}
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate">
                            {prompt.text}
                          </span>
                        )}
                        {editingQueuedPromptId === prompt.id ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              editQueuedPrompt(
                                prompt.id,
                                editingQueuedPromptText,
                              )
                            }
                          >
                            Save
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-label={`Edit queued message ${index + 1}`}
                            onClick={() => {
                              setEditingQueuedPromptId(prompt.id);
                              setEditingQueuedPromptText(prompt.text);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          aria-label={`Remove queued message ${index + 1}`}
                          onClick={() => removeQueuedPrompt(prompt.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {voiceActive ? (
                <div className="rounded-[22px] bg-foreground/[0.045] p-2 shadow-[0_18px_55px_-42px_rgba(0,0,0,0.55)]">
                  <AgentVoiceWaveInput
                    status={voiceState}
                    level={voiceLevel}
                    disabled={isVoiceConnecting}
                    onCancel={cancelConversationalVoice}
                  />
                </div>
              ) : (
                <>
                  {longPromptAttachment ? (
                    <div
                      className="relative mb-2 rounded-[18px] border border-foreground/[0.12] bg-foreground/[0.045] p-3 pr-11 text-sm"
                      data-testid="agent-chat-text-attachment"
                    >
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
                        aria-expanded={longPromptAttachment.isExpanded}
                        aria-label={
                          longPromptAttachment.isExpanded
                            ? "Text attachment open for editing"
                            : "Open text attachment to view and edit"
                        }
                        onClick={() => {
                          if (longPromptAttachment.isExpanded) {
                            collapseComposer();
                            return;
                          }
                          openLongPromptAttachment();
                        }}
                      >
                        <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {getTextAttachmentTitle(longPromptAttachment.text)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            Pasted text · {(longPromptAttachment.byteSize / 1024).toFixed(1)} KB{longPromptAttachment.isExpanded ? " · editing" : ""}
                          </span>
                        </span>
                      </button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="absolute right-2 top-2 h-8 w-8"
                        aria-label="Remove text attachment"
                        onClick={removeLongPromptAttachment}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                  {/* One composer, two sizes. The compact pill and the expanded
                   * editor used to be separate text boxes in separate trees, so
                   * React swapped one for the other when a long draft auto-
                   * expanded, and keystrokes landing in that frame were lost
                   * ("number 3 fopand" on a Galaxy S24 Ultra, 2026-09-22). The
                   * text box now stays the same element; only its size, the
                   * corner control and the labels change. */}
                  <div
                    data-testid={composerExpanded ? "agent-chat-composer-expanded" : "agent-chat-composer"}
                    className={cn(
                      composerExpanded
                        ? "relative mb-2 overflow-hidden rounded-[24px]"
                        : "flex min-h-14 items-center gap-2 overflow-hidden rounded-[var(--app-input-radius)] border-[1.5px] border-black/10 px-4 transition-[border-color,box-shadow,background-color] dark:border-white/15 focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)]",
                      composerExpanded
                        ? isCanonicalChatRoute
                          ? "bottom-chrome-surface"
                          : "bg-foreground/[0.045] shadow-[0_18px_55px_-42px_rgba(0,0,0,0.55)] ring-1 ring-inset ring-foreground/[0.045]"
                        : isCanonicalChatRoute
                          ? "bottom-chrome-surface min-h-14 rounded-[var(--app-input-radius)]"
                          : "bg-foreground/[0.045] shadow-[0_18px_55px_-42px_rgba(0,0,0,0.55)]",
                    )}
                  >
                    <div
                      className={
                        composerExpanded
                          ? "relative"
                          : "relative flex min-h-0 min-w-0 flex-1 items-center"
                      }
                    >
                      <textarea
                        ref={composerTextareaRef}
                        data-testid={
                          composerExpanded
                            ? "agent-chat-composer-expanded-textarea"
                            : "agent-chat-composer-textarea"
                        }
                        aria-label={composerExpanded ? "Expanded message One" : "Message One"}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onFocus={() => {
                          if (isCanonicalChatRoute) {
                            snapKaiBottomChromeVisible();
                          }
                        }}
                        onPaste={handleComposerPaste}
                        onKeyDown={(event) => {
                          if (
                            event.key !== "Enter" ||
                            event.shiftKey ||
                            event.nativeEvent.isComposing
                          ) {
                            return;
                          }
                          event.preventDefault();
                          if (canSend) {
                            const composer = event.currentTarget;
                            composer.form?.requestSubmit();
                            // On a phone, sending puts the keyboard away so
                            // the reply has the screen (founder report,
                            // 2026-09-22: Enter left it up). The desktop
                            // keeps focus for the next message.
                            if (Capacitor.isNativePlatform()) composer.blur();
                          }
                        }}
                        disabled={
                          recoveryInspectionPending ||
                          isVoiceConnecting ||
                          emailDraftOpen ||
                          isGmailKycSaving
                        }
                        placeholder={
                          isGmailKycSaving && gmailKycReplyRequest
                            ? "Preparing your reply to the selected Mail request…"
                            : gmailKycMissingLabels.length > 0
                            ? `Reply with: ${gmailKycMissingLabels.join(", ")}`
                            : composerExpanded
                            ? "Write a longer message..."
                            : "Message One..."
                        }
                        rows={1}
                        className={
                          composerExpanded
                            ? "block h-[min(38dvh,18rem)] w-full resize-none overscroll-contain overflow-y-auto bg-transparent px-4 pb-14 pr-32 pt-4 text-[16px] leading-6 text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 sm:h-[min(48dvh,30rem)] sm:px-5 sm:pb-16 sm:pr-36 sm:pt-5 sm:text-sm break-words [overflow-wrap:anywhere] [word-break:break-word]"
                            : "h-auto max-h-28 min-h-0 min-w-0 flex-1 resize-none overscroll-contain overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-0 bg-transparent px-0 py-2.5 text-[15px] leading-snug text-foreground caret-[color:var(--app-accent)] outline-none shadow-none focus-visible:border-transparent focus-visible:ring-0 placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60 sm:max-h-36 sm:text-sm break-words [overflow-wrap:anywhere] [word-break:break-word]"
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid={composerExpanded ? undefined : "agent-chat-composer-expand"}
                        className={
                          composerExpanded
                            ? "absolute right-2 top-2 h-8 w-8 rounded-lg text-muted-foreground"
                            : "h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        }
                        aria-label={composerExpanded ? "Collapse message editor" : "Expand message editor"}
                        title={composerExpanded ? "Collapse" : "Expand"}
                        disabled={
                          composerExpanded
                            ? false
                            : !input.trim() ||
                              isVoiceConnecting ||
                              emailDraftOpen ||
                              isGmailKycSaving
                        }
                        onClick={composerExpanded ? collapseComposer : () => setComposerExpanded(true)}
                      >
                        {composerExpanded ? (
                          <Minimize2 className="h-4 w-4" />
                        ) : (
                          <Maximize2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <div
                      className={
                        composerExpanded
                          ? "absolute bottom-3 right-3 flex items-center gap-2 sm:bottom-4 sm:right-4"
                          : "flex shrink-0 items-center gap-1.5"
                      }
                    >
                      {composerActionRail}
                    </div>
                  </div>
                </>
              )}
            </div>
          </form>
        </div>
        </section>
      </div>
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          title="Unlock Vault to use Agent"
          description="Unlock your Vault so the agent can work with your private information."
          onSuccess={() => setVaultDialogOpen(false)}
        />
      ) : null}
      </AgentPersonSelectionContext.Provider>
    </div>
  );
}
