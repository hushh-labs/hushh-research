"use client";

import { Capacitor } from "@capacitor/core";
import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AgentMemoryCaptureStatus } from "@/components/agent/agent-memory-capture-status";
import { aggregateAgentPkmCaptures, createAgentPkmCaptureGuard, describeAgentPkmCapture, isAgentPkmCaptureRunning, isAgentPkmProcessingReady, shouldPresentAgentPkmCapture, shouldPublishAgentPkmCapture, type AgentPkmCaptureStatus } from "@/lib/agent/agent-pkm-capture-runtime";
import {
  applyOwnerConfirmedSave,
  describeOwnerMemoryReview,
  formatPkmSaveReceiptForAgent,
  pkmSaveReceiptWrote,
  runExplicitPkmSave,
  saveOwnerConfirmedCards,
  type PkmSaveReceipt,
} from "@/lib/agent/agent-pkm-explicit-save";
import { isCommittedPkmSave, type AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import {
  AgentConsentContinuationContext,
  AgentPersonSelectionContext,
  AgentTranscriptRevealContext,
  type AgentConsentContinuationHandler,
  type InformationRequestSubmissionReceipt,
} from "@/components/agent/agent-structured-experience";
import { CustomConnectorChatContext } from "@/components/agent/custom-connector-probe-card";
import {
  claimConsentContinuation,
  collectOutgoingRequestCards,
  consentRequestDirectiveDuplicatesAskCard,
  continuedElsewhere,
  foldSubmittedRequestReceipts,
  markConsentContinuationUnavailable,
  mergeServerRedactionFlags,
  prepareConsentContinuation,
  rebuildWaitingRequests,
  redactedConsentAnswers,
  releaseConsentContinuation,
  revealConsentContinuationReply,
  setInformationRequestPhase,
  tagAnswersFromLiveAccess,
  tagConsentContinuationMessages,
  useInformationRequestPhaseReader,
  watchSentInformationRequest,
} from "@/lib/agent/consent-continuation";
import { ConsentCardPhaseContext } from "@/components/agent/consent/requester-consent-card";
import { firstName as personFirstName } from "@/components/agent/consent/request-progress";
import { AccessEndedNotice } from "@/components/agent/consent/access-ended-notice";
import {
  consentAccessEndedChipText,
  consentOutcomeDisplayText,
  informationRequestOutcome,
  isAccessEndedOutcome,
  isSharedOutcome,
  wireOutcomeForSentLabel,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import type { InformationRequestBundle } from "@/lib/services/person-profile-service";
import { FEED_ATTENTION_LABEL } from "@/lib/agent/feed-attention";
import { useFeedAttentionTurn } from "@/lib/agent/use-feed-attention-turn";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  FileText,
  KeyRound,
  Laptop,
  Loader2,
  LogIn,
  Mail,
  Mic,
  RotateCcw,
  Send,
  StopSquare,
  ThumbsDown,
  ThumbsUp,
  User,
  X,
} from "@/components/icons";

import { usePuppyConversations } from "@/lib/agent/puppy-conversations";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { Button } from "@/components/ui/button";
import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import { ConnectorsPanel } from "@/components/agent/connectors-panel";
import { McpCallReviewCard, type McpChatReview } from "@/components/agent/mcp-call-review-card";
import { FirstConnectInsightsCard } from "@/components/agent/first-connect-insights-card";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";
import {
  AgentConnectionsDrawer,
  transitionConnectionsDrawer,
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
import { ConnectorBrandMark, type ConnectorBrand } from "@/components/agent/connector-brand-mark";
import { AgentResponseReportButton } from "@/components/agent/agent-response-report";
import { isAndroid } from "@/lib/capacitor/platform";
import {
  CHAT_USER_BUBBLE_CLASSNAME,
  ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME,
} from "@/components/agent/chat-message-styles";
import { SelectionChip } from "@/components/agent/selection-chip";
import { AgentFollowUpSuggestions, visibleFollowUps } from "@/components/agent/agent-follow-up-suggestions";
import { PuppyOneSurface } from "@/components/agent/puppy-one-surface";
import {
  AgentTurnStreamPanel,
  PRIVATE_MEMORY_PREPARATION_EVENT_ID,
  isRoutineReadinessTool,
  connectorBrandForTool,
  driveBatchProgressToVisibleStreamEvent,
  agentToolEventToVisibleStreamEvent,
  type AgentVisibleStreamEvent,
  type AgentVisibleStreamStatus,
} from "@/components/agent/agent-turn-stream-panel";
import { describeSelection } from "@/lib/agent/describe-selection";
import type { DriveBatchProgress, DriveCompilationUiState } from "@/lib/agent/drive-batch-progress";
import { driveOwnerCompileKey, type DriveOwnerCompileWindow } from "@/lib/agent/connector-read-receipt";
import { useEntryWelcome } from "@/lib/agent/use-entry-welcome";
import { useChatOnboarding } from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import {
  ChatOnboardingDailyTip,
  ChatOnboardingTurns,
  turnsForSlot,
  type ChatOnboardingBubbleMessage,
} from "@/components/agent/chat-onboarding/chat-onboarding-transcript";
import {
  computeChatTimeSeparators,
  parseChatTimestamp,
  type ChatTimeSeparator,
  type ChatTimelineItem,
} from "@/lib/agent/chat-time-separators";
import { AgentGetAppPrompt } from "@/components/agent/agent-get-app-prompt";
import {
  parseAgentActivityExperience,
  personSelectionPrompt,
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
import {
  ingestNaturalLanguagePkm,
  isExplicitKycIdentitySaveRequest,
  prepareNaturalLanguagePkm,
} from "@/lib/pkm/pkm-natural-language-ingestion";
import {
  DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
  AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT,
  loadAgentPkmAutoSavePolicy,
  subscribeAgentPkmAutoSavePolicyInvalidation,
  type AgentPkmAutoSavePolicy,
} from "@/lib/agent/agent-pkm-auto-save-policy";
import { isChatKeyRefusal } from "@/lib/vault/one-chat-key";
import {
  loadAgentChatConversationHistory,
  peekAgentChatHistoryCache,
  warmAgentChatHistoryCache,
  clearAgentChatHistoryCache,
} from "@/lib/agent/agent-chat-history-cache";
import { rememberInAppChat, selectedInAppChat } from "@/lib/agent/in-app-chat-selection";
import {
  AGENT_TURN_DETACH_REASON,
  isAgentTurnWatched,
  subscribeAgentTurnSettled,
  subscribeOpenAgentConversation,
  waitForWatchedAgentTurn,
  watchDetachedAgentTurn,
} from "@/lib/agent/agent-chat-turn-watch";
import { dispatchAgentChatHistoryInvalidated } from "@/lib/agent/agent-chat-history-events";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
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
  AGENT_CHAT_STREAM_LOST_ERROR,
  AgentChatStreamLostError,
  createQueuedInputPorts,
  deleteAgentChatConversation,
  getAgentChatConsentOutcomes,
  getLostAgentTurnOutcome,
  renameAgentChatConversation,
  streamAgentChat,
  streamAgentIntro,
  type AgentChatConsentContinuation,
  type AgentChatConversation,
  type AgentChatMessage as StoredAgentChatMessage,
  type AgentChatConsentAccess,
  type AgentChatToolEvent,
  type PendingEmailDraftContext,
  type SpecialistDirectiveEvent,
  type AgentSource,
  getAgentChatFeedback,
  setAgentChatFeedback,
  type AgentResponseReportReason,
  InformationRequestReceiptError,
  recordAgentChatInformationRequestWithRetry,
  parseRestoredTurnActivity,
} from "@/lib/services/agent-chat-client";
import { runConnectedSystemDirective } from "@/lib/agent/connected-system-directive-runtime";
import {
  DRIVE_REVIEW_DELEGATE,
  driveReviewDetails,
  getDriveReviewDirectiveFromToolResult,
  runDriveReviewDirective,
} from "@/lib/agent/drive-review-directive-runtime";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import { runCalendarDirective } from "@/lib/agent/calendar-directive-runtime";
import {
  GMAIL_MAILBOX_ACTION_COPY,
  gmailMailboxAction,
  gmailMailboxDetails,
  runGmailMailboxDirective,
} from "@/lib/agent/gmail-mailbox-directive-runtime";
import {
  connectCalendarInPlace,
  connectGmailInPlace,
  inPlaceConnectCopy,
} from "@/lib/connections/google-connect-in-place";
import { useInPlaceConnect } from "@/lib/connections/use-in-place-connect";
import { OAUTH_WINDOW_BLOCKED_COPY } from "@/lib/connections/oauth-window";
import {
  runLocationDirective,
  type DelegateResult,
} from "@/lib/agent/specialist-directive-runtime";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import {
  useConsentActions,
  type PendingConsent,
} from "@/lib/consent/use-consent-actions";
import { useOneLocationConsentActions } from "@/lib/consent/use-one-location-consent-actions";
import { useDeferredConsentDeclines } from "@/lib/consent/deferred-consent-decline";
import { DriveRecentSharing, type SelectedDriveSearchFile } from "@/components/agent/drive-background-search";
import { canReviewDriveMemory, DriveReadMemoryAction } from "@/components/agent/drive-read-memory-action";
import { clearGeneratedDriveSearchDraft } from "@/lib/agent/drive-search-draft";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";
import { loadCustomConnectorSnapshot } from "@/lib/connections/custom-connector-configuration";
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
import {
  DriveCompilationError,
  streamOwnerDriveCompilation,
} from "@/lib/services/drive-owner-compilation-service";
import { exportPrivateDriveMarkdown } from "@/lib/utils/private-markdown-export";
import { CONSENT_STATE_CHANGED_EVENT, dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { subscribeInformationRequest } from "@/lib/consent/information-request-reads";
import { wakeLiveAccessWatch, watchLiveAccess } from "@/lib/consent/live-access-watch";
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
  canJoinAgentTurn,
  combineQueuedPromptText,
  editQueuedAgentPrompt,
  removeQueuedAgentPrompt,
  SerialAgentOperationQueue,
  takeJoinableRun,
  type QueuedAgentPrompt,
} from "@/lib/agent/agent-chat-prompt-queue";
import { LiveTurnQueue } from "@/lib/agent/agent-chat-live-turn-queue";
import { AgentQueuedStack, QueuedJoinedCaption } from "@/components/agent/agent-queued-stack";
import { useAgentChatSlowNotice } from "@/components/agent/agent-chat-slow-notice";
import {
  combineAttachmentAndComposerText,
  composeTurnSourceText,
  createAgentTextAttachment,
  createPendingTextAttachment,
  mergePastedText,
  parseStoredTextAttachments,
  replaceTextAttachmentForResend,
  shouldCaptureLargePaste,
  type AgentTextAttachment,
  type PendingTextAttachment,
} from "@/lib/agent/large-text-attachment";
import { AgentMessageAttachments } from "@/components/agent/agent-message-attachments";
import { AgentComposerTextAttachment } from "@/components/agent/agent-text-attachment-editor";
import {
  findPendingAssistantTurn,
  measureTranscriptReveal,
  transcriptFollowsLatest,
  transcriptRevealScrollTop,
} from "@/lib/agent/agent-chat-transcript-scroll";
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
import {
  EmailDeliveryService,
  type EmailDeliveryError,
  type EmailDraft,
} from "@/lib/services/email-delivery-service";
import {
  GmailInformationRequestsService,
  type GmailInformationRequestSourcePreview,
} from "@/lib/services/gmail-information-requests-service";

// Every memory capture job ends: auto-capture prepares within 120 s, an
// explicit save of a long document within 300 s, and each leaves time to write.
const AGENT_PKM_CAPTURE_DEADLINE_MS = 4 * 60_000;
const AGENT_PKM_EXPLICIT_SAVE_DEADLINE_MS = 8 * 60_000;

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
  memoryCapture?: AgentPkmCaptureStatus;
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
  /** Why a partial answer stopped, shown below the text that did arrive. */
  errorNotice?: string;
  /** The stream was lost, not the turn: Retry checks history before resending. */
  lostTurn?: AgentLostTurn;
  /** One's 2-3 next questions for this answer; in memory only, shown while it is latest. */
  followUps?: string[];
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

type AgentLostTurn = { conversationId: string; startedAtMs: number };

const EMPTY_CONSENT_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({});

/** How a follow-up turn ended; a consent answer another device already gave is settled, not failed. */
type FollowUpTurnResult = "answered" | "continued_elsewhere" | "failed";

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
  const partial = current.text.trim().length > 0;
  return {
    ...current,
    text: partial ? current.text : reason,
    ...(partial
      ? { errorNotice: reason === AGENT_CHAT_STREAM_LOST_ERROR ? AGENT_PARTIAL_ANSWER_LOST_NOTICE : reason }
      : {}),
    ...(lostTurn ? { lostTurn } : {}),
    status: "error",
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
  /** Receives the operation as it is when dequeued, so an edited prompt sends its edit. */
  run: (current: QueuedWorkspaceOperation) => Promise<void>;
};

function upsertVisibleStreamEvent(
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

function settleVisibleStreamEvents(
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

function stopDriveCompilationProgress(
  events: AgentVisibleStreamEvent[] | undefined,
): AgentVisibleStreamEvent[] | undefined {
  return events?.map((event) => event.batchProgress && event.status === "running"
    ? { ...event, status: "blocked" as const,
        message: "Document batch stopped before completion." }
    : event);
}

function clearDriveCompilationFromMessages(messages: AgentMessage[]): AgentMessage[] {
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
  gmailInformationRequestWorkflowId?: string;
  driveSearchSelection?: { jobId: string; position: number };
  kycInformationSaveConfirmed?: boolean;
  appendUserMessage?: boolean;
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

export function getGmailEmailDraftPayload(
  event: AgentChatToolEvent | null,
): { instruction: string; driveFileId: string | null; initialDraft: EmailDraft | null } | null {
  if (!event || event.raw.toolName !== "open_gmail_email_draft") return null;
  const instruction =
    typeof event.slots.request === "string" ? event.slots.request.trim() : "";
  const driveFileId =
    typeof event.slots.drive_file_id === "string"
      ? event.slots.drive_file_id.trim()
      : "";
  const draftField = (name: "to" | "cc" | "bcc" | "subject" | "body", limit: number) => {
    const value = event.slots[name];
    return typeof value === "string" && value.trim().length <= limit
      ? value.trim()
      : "";
  };
  const body = draftField("body", 12_000);
  return instruction
    ? {
        instruction,
        driveFileId: driveFileId && driveFileId.length <= 256 ? driveFileId : null,
        initialDraft: body
          ? {
              to: draftField("to", 2_048),
              cc: draftField("cc", 2_048),
              bcc: draftField("bcc", 2_048),
              subject: draftField("subject", 512),
              body,
            }
          : null,
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

/** The Undo toast's line for a decline from the chat card, as the Consent Center words it. */
export function declinedChatRequestMessage(requesterLabel: string): string {
  const first = requesterLabel.trim().split(/\s+/)[0];
  return first ? `Declined ${first}'s request.` : "Declined the request.";
}

function markPendingConsentRequestDirectiveStatus(
  event: SpecialistDirectiveEvent | null | undefined,
  itemId: string,
  // "pending" puts a card back after Undo on a decline.
  status: PendingConsentCardStatus,
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

/** The label and the moment for a message created now, taken together. */
function stampNow(): { timestamp: string; sentAtMs: number } {
  const sentAtMs = Date.now();
  return {
    timestamp: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(sentAtMs)),
    sentAtMs,
  };
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
          className="group relative inline-flex !h-auto !min-h-11 max-w-full items-center !justify-between gap-2.5 overflow-hidden !rounded-2xl border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] !px-4 !py-2.5 text-left text-sm font-medium text-foreground shadow-[var(--app-glass-shadow)] transition-colors duration-150 hover:bg-[color:var(--app-shell-surface-bg-hover)] active:opacity-90 disabled:pointer-events-none disabled:opacity-60"
        >
          <span className="min-w-0 whitespace-normal leading-5">{prompt}</span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-[color:var(--app-accent-deep)]"
            aria-hidden
          />
          <MaterialRipple variant="none" effect="glass" disabled={disabled} />
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
          Ask One about your calendar, your email, what it remembers, or who can see your information.
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

export function GmailInformationRequestAttachment({
  loadPreview,
}: {
  loadPreview: () => Promise<GmailInformationRequestSourcePreview>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<GmailInformationRequestSourcePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const previewRequestRef = useRef(0);
  const previewId = useId();

  useEffect(() => {
    return () => {
      previewRequestRef.current += 1;
    };
  }, []);

  const toggle = async () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (!nextOpen) {
      previewRequestRef.current += 1;
      setPreview(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (preview || loading) return;
    const requestId = ++previewRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const source = await loadPreview();
      if (previewRequestRef.current === requestId) setPreview(source);
    } catch {
      if (previewRequestRef.current === requestId) {
        setError("Couldn’t load this Gmail message. Please try again.");
      }
    } finally {
      if (previewRequestRef.current === requestId) setLoading(false);
    }
  };

  return (
    <div
      className={cn(
        "mt-3 overflow-hidden rounded-[18px] border text-left shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)] transition-colors",
        open
          ? "border-white/30 bg-white/[0.11]"
          : "border-white/20 bg-white/[0.075] hover:border-white/30 hover:bg-white/[0.11]",
      )}
    >
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-controls={open ? previewId : undefined}
        className="group relative flex min-h-14 w-full items-center gap-3 rounded-[inherit] px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
      >
        <MaterialRipple variant="none" effect="fill" />
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-black/[0.12] text-white shadow-sm">
          <Mail className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-5 text-white">
            Mail
          </span>
          <span className="block text-xs leading-5 text-white/65">
            Selected Gmail message
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/[0.10] px-2.5 py-1 text-[11px] font-semibold text-white/90 transition-colors group-hover:bg-white/[0.16]">
          {open ? "Hide" : "View"}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-150",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </span>
      </button>
      {open ? (
        <div
          id={previewId}
          aria-live="polite"
          className="border-t border-white/15 bg-black/[0.075] px-3.5 py-3.5 text-xs leading-5"
        >
          {loading ? (
            <span className="flex items-center gap-2 text-white/70">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading Gmail message…
            </span>
          ) : null}
          {error ? <span className="text-red-100">{error}</span> : null}
          {preview ? (
            <div className="space-y-3 whitespace-pre-wrap break-words">
              <dl className="space-y-2">
                {preview.from ? (
                  <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                    <dt className="font-medium text-white/55">From</dt>
                    <dd className="min-w-0 text-white/95">{preview.from}</dd>
                  </div>
                ) : null}
                {preview.subject ? (
                  <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                    <dt className="font-medium text-white/55">Subject</dt>
                    <dd className="min-w-0 font-medium text-white">{preview.subject}</dd>
                  </div>
                ) : null}
              </dl>
              <p className="border-t border-white/15 pt-3 text-white/85">
                {preview.body || "This email has no readable text."}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AgentBubble({
  message,
  onOpenConnections,
  onInformationRequestSubmitted,
  onCompileDriveNotes,
  onDownloadDriveNotes,
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
  reported = false,
  onReport,
  gmailInformationRequestAttachment,
  driveMemoryReview,
  onResendAttachment,
  onConfirmMemoryNeedsOwner,
  pendingMemoryCards,
  canConfirmMemoryNeedsOwner,
  onUnlockVault,
}: {
  message: AgentMessage;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
  onInformationRequestSubmitted?: (activityId: string, receipt: InformationRequestSubmissionReceipt) => Promise<void>;
  onCompileDriveNotes?: (query: string, window: DriveOwnerCompileWindow) => void;
  onDownloadDriveNotes?: () => void;
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
  reported?: boolean;
  onReport?: (reason: AgentResponseReportReason) => Promise<void>;
  gmailInformationRequestAttachment?: ReactNode;
  driveMemoryReview?: ReactNode;
  /** "Edit and send again" on a sent paste: a new turn, never an edit of this one. */
  onResendAttachment?: (index: number, editedText: string) => boolean | void;
  onConfirmMemoryNeedsOwner?: (reviewedCards: readonly AgentPkmPreviewCard[]) => Promise<void>;
  pendingMemoryCards?: readonly AgentPkmPreviewCard[];
  canConfirmMemoryNeedsOwner?: boolean;
  onUnlockVault?: () => void;
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

  // Only settled, successful answers move their controls beside the bubble;
  // an error keeps its Try again in plain sight.
  const hoverResponseActions = showResponseActions && !isError;
  const responseActionButtons = (
    <div className="flex items-center gap-1">
      {!isError ? (
        <>
      <button
        type="button"
        onClick={handleCopy}
        className="relative grid h-7 w-7 place-items-center rounded-md border border-transparent text-[rgba(0,0,0,0.46)] transition hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
        aria-label={copied ? "Response copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <MaterialRipple variant="none" effect="glass" />
      </button>
      <button
        type="button"
        onClick={() => onRate?.(liked ? null : "up")}
        className={cn(
          "relative grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          liked
            ? "border-transparent bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]"
            : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200",
        )}
        aria-label="Like response"
        aria-pressed={liked}
        title="Like response"
      >
        <ThumbsUp className="h-3.5 w-3.5" weight={liked ? "fill" : "regular"} />
        <MaterialRipple variant="none" effect="glass" />
      </button>
      <button
        type="button"
        onClick={() => onRate?.(disliked ? null : "down")}
        className={cn(
          "relative grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          disliked
            ? "border-transparent bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]"
            : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200",
        )}
        aria-label="Dislike response"
        aria-pressed={disliked}
        title="Dislike response"
      >
        <ThumbsDown className="h-3.5 w-3.5" weight={disliked ? "fill" : "regular"} />
        <MaterialRipple variant="none" effect="glass" />
      </button>
      {onReport && isAndroid() ? (
        // Google Play AI-Generated Content policy. Android only for
        // now, so iOS and web chat stay exactly as they are.
        <AgentResponseReportButton reported={reported} onReport={onReport} />
      ) : null}
        </>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
          className="relative ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 text-xs font-medium text-[rgba(0,0,0,0.46)] transition hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
          aria-label="Try again"
          title="Try again"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {/* One line everywhere: it wrapped to two lines beside the bubble. */}
          <span>Try again</span>
          <MaterialRipple variant="none" effect="glass" disabled={retryDisabled} />
        </button>
      ) : null}
    </div>
  );
  const hoverResponseActionsNode = hoverResponseActions ? (
    <div
      data-agent-response-actions="hover"
      className="one-chat-hover-actions items-center text-[rgba(0,0,0,0.46)] dark:text-zinc-500"
    >
      {responseActionButtons}
    </div>
  ) : null;

  return (
    <div
      data-message-role={message.role}
      data-message-status={message.status}
      // The time is kept on the row for tooling; the transcript shows it in
      // the centered separator above each group instead of under every bubble.
      data-message-sent-at={message.sentAtMs ? new Date(message.sentAtMs).toISOString() : undefined}
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
          isUser && "sm:max-w-[min(76%,42rem)]",
        )}
      >
        <div
          aria-live={!isUser && isStreaming ? "polite" : undefined}
          data-agent-streaming={!isUser && isStreaming ? "true" : undefined}
          className={cn(
            "text-sm leading-6",
            isUser
              ? CHAT_USER_BUBBLE_CLASSNAME
              : showAssistantBubble
                ? cn(ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME, "relative")
                : "px-0 py-1 text-foreground",
            isError &&
              "rounded-2xl border border-destructive/20 bg-destructive/[0.06] px-4 py-2.5 text-foreground",
          )}
        >
          {isUser ? (
            <>
              {message.text ? (
                <span className="whitespace-pre-wrap break-words">{message.text}</span>
              ) : null}
              {message.attachments?.length ? (
                <div className={cn(message.text && "mt-2")}>
                  <AgentMessageAttachments
                    attachments={message.attachments}
                    onResend={onResendAttachment}
                  />
                </div>
              ) : null}
              {gmailInformationRequestAttachment}
            </>
          ) : shouldRenderStreamPanel ? (
            <AgentTurnStreamPanel
              streamEvents={streamEvents}
              sources={message.sources}
              structuredExperience={message.structuredExperience}
              structuredExperiences={structuredExperiences}
              onOpenConnections={onOpenConnections}
              onInformationRequestSubmitted={onInformationRequestSubmitted}
              onCompileDriveNotes={onCompileDriveNotes}
              onDownloadDriveNotes={onDownloadDriveNotes}
              driveCompilation={message.driveCompilation}
              responseText={assistantText}
              isStreaming={isStreaming}
              isError={isError}
              opportunities={turnPanelOpportunities}
              response={
                assistantText ? (
                  <div
                    data-agent-response-bubble
                    className={cn(ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME, "relative w-fit max-w-full sm:max-w-[min(82%,48rem)]")}
                  >
                    <AgentMarkdown text={assistantText} />
                    {hoverResponseActionsNode}
                  </div>
                ) : null
              }
            />
          ) : assistantText ? (
            <>
              <AgentMarkdown text={assistantText} />
              {showAssistantBubble && !isError ? hoverResponseActionsNode : null}
            </>
          ) : canRenderConsentActions ||
            canRenderPendingConsentRequest ? null : (
            <AgentThinkingDots />
          )}
          {!isUser && isError && message.errorNotice ? (
            <p
              role="status"
              data-testid="agent-message-error-notice"
              className="mt-2 text-xs font-medium text-destructive"
            >
              {message.errorNotice}
            </p>
          ) : null}
        </div>
        {isUser && message.queuedPlacement === "joined" ? <QueuedJoinedCaption /> : null}
        {!isUser && message.memoryCapture ? <AgentMemoryCaptureStatus status={message.memoryCapture} onConfirmNeedsOwner={onConfirmMemoryNeedsOwner} pendingCards={pendingMemoryCards} canConfirmNeedsOwner={canConfirmMemoryNeedsOwner} onUnlock={onUnlockVault} /> : null}
        {!isUser && !isStreaming && !isError ? driveMemoryReview : null}
        {showResponseActions ? (
        <div
          data-testid="agent-message-response-actions"
          data-agent-response-actions="inline"
          // Pointer desktops show these beside the bubble on hover instead
          // (see `hoverResponseActions`); touch keeps this row, always shown.
          data-hover-twin={hoverResponseActions ? "true" : undefined}
          className="mt-1 flex items-center gap-2 text-[11px] text-[rgba(0,0,0,0.46)] dark:text-zinc-500"
        >
          {responseActionButtons}
        </div>
        ) : null}
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
    </div>
  );
}

/** The centered date/time line that opens a group of messages. */
function ChatTimeSeparatorRow({ separator }: { separator: ChatTimeSeparator }) {
  return (
    <div
      data-testid="agent-chat-time-separator"
      className="flex justify-center whitespace-nowrap pb-0.5 pt-2 first:pt-0"
    >
      {separator.dateTime ? (
        <time
          dateTime={separator.dateTime}
          title={separator.accessibleLabel}
          className="whitespace-nowrap text-[12.5px] font-medium tabular-nums text-[color:var(--one-chat-meta)]"
        >
          <span aria-hidden="true">{separator.text}</span>
          <span className="sr-only">{separator.accessibleLabel}</span>
        </time>
      ) : (
        <span className="whitespace-nowrap text-[12.5px] font-medium tabular-nums text-[color:var(--one-chat-meta)]">
          <span aria-hidden="true">{separator.text}</span>
          <span className="sr-only">{separator.accessibleLabel}</span>
        </span>
      )}
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
  return {
    id: message.id,
    role: message.role,
    text: displayText,
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

const RESTORED_CONNECTOR_STEP_LABEL = "Connected tool";

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

function ChatAgentSubtitle({ text, working, brand }: { text: string; working: boolean; brand?: ConnectorBrand | null }) {
  const [display, setDisplay] = useState(text);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (display === text) { setVisible(true); return; }
    setVisible(false);
    const timer = window.setTimeout(() => { setDisplay(text); setVisible(true); }, 90);
    return () => window.clearTimeout(timer);
  }, [display, text]);
  return <p aria-live="polite" className="flex max-w-48 items-center gap-1.5 truncate text-xs text-muted-foreground sm:max-w-64">
    {brand ? <ConnectorBrandMark brand={brand} size="sm" /> : working ? <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
    <span className={`block truncate transition-opacity duration-100 motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}>{display}</span>
  </p>;
}

export type ActiveToolCall = { id: string; label: string; activity?: string; brand?: ConnectorBrand | null };

export const IDLE_AGENT_SUBTITLE = "Your private agent";

/**
 * The line under the agent's name. While a turn runs it names what One is
 * doing right now ("Checking Gmail…"), from the same app-owned table that
 * labels the Activity rows; the newest running call wins. With nothing in
 * flight it falls back to the turn status, then to the idle subtitle.
 */
export function chatHeaderSubtitle(input: {
  isPuppySurface: boolean;
  activeToolCalls: readonly ActiveToolCall[];
  statusText: string | null;
}): string {
  if (input.isPuppySurface) return "Separate conversation";
  const current = input.activeToolCalls.at(-1);
  if (current) return `${current.activity || current.label}…`;
  return input.statusText || IDLE_AGENT_SUBTITLE;
}

export function AgentChatWorkspace({ className }: AgentChatWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const isCanonicalChatRoute = pathname === ROUTES.HOME;
  const searchParams = useSearchParams();
  const localCrmEnabled = isLocalCrmBuildEnabled();
  const { user, loading: authLoading, phoneNumber, sessionVerificationRequired } = useAuth();
  const renderedWorkspaceOwnerId = user?.uid ?? null;
  const workspaceOwnerIdRef = useRef<string | null>(renderedWorkspaceOwnerId);
  workspaceOwnerIdRef.current = renderedWorkspaceOwnerId;
  useEffect(() => {
    workspaceOwnerIdRef.current = renderedWorkspaceOwnerId;
    return () => {
      if (workspaceOwnerIdRef.current === renderedWorkspaceOwnerId) {
        workspaceOwnerIdRef.current = null;
      }
    };
  }, [renderedWorkspaceOwnerId]);
  const {
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
    getVaultOwnerToken,
  } = useVault();
  const vaultSessionEpoch = snapshotVaultSessionEpoch();
  // Chat history is sealed with a key derived from this; read it at call time so
  // history requests never capture a stale (or locked) vault.
  const vaultKeyRef = useRef<string | null>(vaultKey);
  vaultKeyRef.current = vaultKey;
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
  // The last follow left the latest turn in view; growth keeps following it.
  const transcriptStuckToEndRef = useRef(true);
  const scrollToSubmittedTurnRef = useRef(false);

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

  // A card that just appeared (the ask card's Send row) is lifted above the
  // composer the same way a sent turn is; it never lands behind it.
  const revealInTranscript = useCallback((element: HTMLElement) => {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (!transcript || !transcript.contains(element)) return;
      const top = transcriptRevealScrollTop(
        measureTranscriptReveal(transcript, element, composerStackRef.current),
      );
      if (Math.abs(top - transcript.scrollTop) < 1) return;
      beginTranscriptProgrammaticScroll(top);
      transcript.scrollTo({
        top,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  }, [beginTranscriptProgrammaticScroll]);
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
  // A selected search result is session-only; chat receives its opaque reference
  // separately from the human prompt and rechecks it against live Drive.
  const [pendingDriveSearchSelection, setPendingDriveSearchSelection] = useState<
    (SelectedDriveSearchFile & { ownerUid: string; vaultEpoch: number }) | null
  >(null);
  const pendingDriveSearchSelectionRef = useRef<typeof pendingDriveSearchSelection>(null);
  const generatedDriveSearchDraftRef = useRef(false);
  const [longPromptAttachment, setLongPromptAttachment] =
    useState<PendingTextAttachment | null>(null);
  // Which model runs this person's agent. The catalog is served, so a new
  // generation appears here without a client release.
  const [modelPreference, setModelPreference] = useState<ModelPreference | null>(null);
  const [composerExpanded, setComposerExpandedState] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedAgentPrompt[]>([]);
  const [queuedDeliveryUnconfirmed, setQueuedDeliveryUnconfirmed] = useState(false);
  const [queuedDeliveryChecking, setQueuedDeliveryChecking] = useState(false);
  // A typed turn is running that Stop can end at its next step.
  const [stoppableTurn, setStoppableTurn] = useState(false);
  const [editingQueuedPromptId, setEditingQueuedPromptId] = useState<
    string | null
  >(null);
  const [editingQueuedPromptText, setEditingQueuedPromptText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const activeDriveSearchSelection = pendingDriveSearchSelection &&
    pendingDriveSearchSelection.ownerUid === user?.uid && isVaultUnlocked &&
    isVaultSessionEpochCurrent(pendingDriveSearchSelection.vaultEpoch)
      ? pendingDriveSearchSelection : null;
  useEffect(() => {
    pendingDriveSearchSelectionRef.current = null;
    setPendingDriveSearchSelection(null);
    const generated = generatedDriveSearchDraftRef.current;
    generatedDriveSearchDraftRef.current = false;
    if (generated) setInput(current => clearGeneratedDriveSearchDraft(current, generated));
  }, [conversationId, user?.uid, isVaultUnlocked, vaultSessionEpoch]);
  // Ratings for this conversation, keyed by message id. Durable, so a reload
  // and a conversation switch both keep what the person said about an answer.
  const [messageRatings, setMessageRatings] = useState<
    Record<string, "up" | "down">
  >({});
  // Answers reported in this conversation during this session; the durable
  // record is the "down" rating plus the server-side report log.
  const [reportedMessageIds, setReportedMessageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conversations, setConversations] = useState<AgentChatConversation[]>(
    [],
  );
  const puppyHistory = usePuppyConversations(user?.uid ?? null);
  const { conversations: puppyConversations, activeId: puppyConversationId } = puppyHistory;
  const [messages, setMessages] = useState<AgentMessage[]>(() => [
    createGreetingMessage(),
  ]);
  const compiledDriveMarkdownRef = useRef(new Map<string, string>());
  const driveCompilationAbortRef = useRef<AbortController | null>(null);
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
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ConnectionsDrawerMode>("chats");
  const [connectorPanelInitialConnector, setConnectorPanelInitialConnector] =
    useState<"google_drive" | "gmail" | null>(null);
  const handleHistoryDrawerOpenChange = useCallback((open: boolean) => {
    const next = transitionConnectionsDrawer(
      { open: isHistoryDrawerOpen, mode: drawerMode },
      { type: "set-open", open },
    );
    setIsHistoryDrawerOpen(next.open);
    setDrawerMode(next.mode);
    if (!next.open) setConnectorPanelInitialConnector(null);
  }, [drawerMode, isHistoryDrawerOpen]);
  const openConnectorSurface = useCallback((
    provider?: WorkspaceConnectorProvider,
    trigger?: HTMLButtonElement,
  ) => {
    if (trigger) historyDrawerTriggerRef.current = trigger;
    if (provider === "calendar") {
      router.push(ROUTES.CALENDAR);
      return;
    }
    setConnectorPanelInitialConnector(
      provider === "drive" ? "google_drive" : provider === "gmail" ? "gmail" : null,
    );
    setDrawerMode("connections");
    setIsHistoryDrawerOpen(true);
  }, [router]);
  const [recoveryCheckedForUid, setRecoveryCheckedForUid] = useState<string | null>(null);
  const pendingDriveRecoveryRef = useRef<{
    ownerUid: string;
    state: Awaited<ReturnType<typeof takeDriveChatRecovery>>;
  } | null>(null);
  const currentDraftRef = useRef({ input, attachment: longPromptAttachment });
  const pendingChatKeyRetryRef = useRef<{ text: string; options: AgentRunTurnOptions } | null>(null);
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
  const [connectorExternalModalOpen, setConnectorExternalModalOpen] =
    useState(false);
  useEffect(() => {
    // `?panel=connectors` is the connector OAuth-return flow's landing signal
    // -- connectors live in the responsive modal, not a dedicated route, so
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
  const [gmailKycEmailDraftEnvelope, setGmailKycEmailDraftEnvelope] = useState<
    { to: string; subject: string } | null
  >(null);
  // The open draft card's current value, read when a chat turn actually runs
  // so a follow-up ("add Priya to cc") revises what is on screen right now.
  // Refs, not state: a keystroke in the card must not re-render the workspace.
  const emailDraftCardValueRef = useRef<EmailDraft | null>(null);
  const pendingEmailDraftFrameRef = useRef<{
    sourceBound: boolean;
    envelope: { to: string; subject: string } | null;
  } | null>(null);
  const handleEmailDraftChange = useCallback((draft: EmailDraft) => {
    emailDraftCardValueRef.current = draft;
  }, []);
  const runAgentTurnRef = useRef<(
    text: string,
    options: AgentRunTurnOptions,
  ) => Promise<void>>(async () => undefined);
  // This is intentionally session-only. The normal user prompt is stored by
  // the encrypted chat service, but raw email fields must not become durable
  // chat/workflow records.
  const [emailDeliveryHistory, setEmailDeliveryHistory] = useState<
    EmailDeliveryTimelineItem[]
  >([]);
  const [activeFrontendToolCount, setActiveFrontendToolCount] = useState(0);
  const [activePkmToolCount, setActivePkmToolCount] = useState(0);
  const [visiblePkmToolCount, setVisiblePkmToolCount] = useState(0);
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
  const [pendingMcpReviews, setPendingMcpReviews] = useState<McpChatReview[]>([]);
  const [specialistBusy, setSpecialistBusy] = useState(false);
  const [specialistBusyItemId, setSpecialistBusyItemId] = useState<
    string | null
  >(null);
  // Google connects from chat never navigate this window: the vault key is
  // memory-only. Each surface holds at most one in-place attempt.
  const gmailSendConnect = useInPlaceConnect();
  const directiveConnect = useInPlaceConnect();
  const directiveConnectWaiting = directiveConnect.pending?.cancellable === true;
  const voiceState = useAgentVoiceState((state) => state.status);
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [welcomePromptSetIndex, setWelcomePromptSetIndex] = useState(0);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState(),
  );
  const activeActionRun = useActiveActionRun();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null);
  // Everything the composer stacks over the transcript's bottom edge (queue,
  // attachment chip, text box). Its top is where the visible transcript ends.
  const composerStackRef = useRef<HTMLDivElement | null>(null);
  const composerExpandedRef = useRef(composerExpanded);
  composerExpandedRef.current = composerExpanded;
  const composerTransitionRectRef = useRef<DOMRect | null>(null);
  const composerSurfaceAnimationRef = useRef<Animation | null>(null);
  const setComposerExpanded = useCallback((
    expanded: boolean,
    originRect?: DOMRect | null,
  ) => {
    if (composerExpandedRef.current === expanded) return;
    const surface = composerSurfaceRef.current;
    // Capture the currently presented box before cancelling an in-flight FLIP
    // animation, so a quick second toggle continues smoothly from this frame.
    const currentRect = originRect === undefined
      ? surface?.getBoundingClientRect() ?? null
      : originRect;
    composerSurfaceAnimationRef.current?.cancel();
    composerSurfaceAnimationRef.current = null;
    composerTransitionRectRef.current = currentRect;
    composerExpandedRef.current = expanded;
    setComposerExpandedState(expanded);
  }, []);
  const historyDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyDrawerFallbackRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    // Next.js can hide and preserve this route instead of unmounting it.
    // History is transient: returning to Chat must require a fresh open action.
    return () => {
      setIsHistoryDrawerOpen(false);
      setDrawerMode("chats");
      setConnectorPanelInitialConnector(null);
    };
  }, [pathname]);
  const [driveReviewSignal, setDriveReviewSignal] = useState<{ ownerId: string | null; epoch: number; count: number }>(
    { ownerId: null, epoch: vaultSessionEpoch, count: 0 },
  );
  const onDriveNeedsReviewChange = useCallback((count: number) => {
    const ownerId = user?.uid ?? null;
    setDriveReviewSignal(current => current.ownerId === ownerId && current.epoch === vaultSessionEpoch && current.count === count
      ? current : { ownerId, epoch: vaultSessionEpoch, count });
  }, [user?.uid, vaultSessionEpoch]);
  const driveReviewsPending = user && isVaultUnlocked && driveReviewSignal.ownerId === user.uid &&
    driveReviewSignal.epoch === vaultSessionEpoch ? driveReviewSignal.count : 0;
  const [getAppOpen, setGetAppOpen] = useState(false);
  const getAppReturnFocusRef = useRef<HTMLElement | null>(null);
  // The installed app never offers to download itself.
  const offerGetApp = !Capacitor.isNativePlatform();
  const historyLoadKeyRef = useRef<string | null>(null);
  const welcomePromptSetInitializedRef = useRef(false);
  const historyRestoreEpochRef = useRef(0);
  const skipInitialHistoryLoadRef = useRef(false);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const reattachRestoreRef = useRef<Promise<void> | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const operationQueueRef = useRef(
    new SerialAgentOperationQueue<QueuedWorkspaceOperation>(),
  );
  // Messages sent while One works: offered to the running turn in queue
  // order (one chain), settled from the server's record before the next turn.
  const vaultOwnerTokenGetterRef = useRef(getVaultOwnerToken);
  vaultOwnerTokenGetterRef.current = getVaultOwnerToken;
  // One calm notice when a reply is slow or the server is strained.
  const slowNotice = useAgentChatSlowNotice();
  const liveTurnQueueRef = useRef<LiveTurnQueue | null>(null);
  if (liveTurnQueueRef.current === null) {
    liveTurnQueueRef.current = new LiveTurnQueue(
      createQueuedInputPorts(() => vaultOwnerTokenGetterRef.current()),
    );
  }
  const queuedOfferChainRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSettlementGateRef = useRef<{ promise: Promise<void>; release: () => void } | null>(null);
  const liveAssistantMessageIdRef = useRef<string | null>(null);
  const stopActiveTurnRef = useRef<(() => Promise<void>) | null>(null);
  const calendarActionIdsRef = useRef<Set<string>>(new Set());
  const handoffPromptSubmitRef = useRef<
    ((prompt: string) => Promise<void>) | null
  >(null);
  const pkmAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const pkmCaptureJobsRef = useRef(new Map<string, Promise<AgentPkmCaptureStatus>>());
  const pkmCaptureReceiptsRef = useRef(new Map<string, Map<string, AgentPkmCaptureStatus>>());
  // The newest explicit-save receipt in this conversation. One is told it on
  // the next turn, so it never has to guess whether a save finished.
  const latestPkmSaveReceiptRef = useRef<PkmSaveReceipt | null>(null);
  // Details that need the owner's direct tap, per assistant message. Session
  // memory only: they hold the owner's words and are dropped with the turn.
  const pkmNeedsOwnerCardsRef = useRef(new Map<string, { cards: AgentPkmPreviewCard[]; sourceMessage: string }>());
  const latestVisibleTurnIdRef = useRef<string | null>(null);
  const inlineConsentRequestIdsRef = useRef<Set<string>>(new Set());
  // Set by the FCM effect below; lets a server tool result (pending requests
  // One listed) render the same cards a push would, without a second lookup path.
  const appendPendingConsentRequestRef = useRef<((requestId: string) => Promise<void>) | null>(null);
  const updateConversationId = useCallback(
    (nextConversationId: string | null, remember = true) => {
      conversationIdRef.current = nextConversationId;
      setConversationId(nextConversationId);
      if (remember && user?.uid) rememberInAppChat(user.uid, nextConversationId);
    },
    [user?.uid],
  );
  const oneLocationConsentActions = useOneLocationConsentActions({
    userId: user?.uid,
    onActionComplete: () => {
      setPendingSpecialistDirective(null);
    },
  });
  // Don't allow from the chat card holds for the same five-second Undo as
  // the Consent Center rows and the Feed (lib/consent/deferred-consent-decline.ts).
  const { schedule: scheduleConsentDecline } = useDeferredConsentDeclines();
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
  const isVisiblePkmMemoryWorking = visiblePkmToolCount > 0;
  const rootChatReady = useRootChatDeferredReady();
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
  const agentVoiceEnabled = isAgentCommandEnabled();
  const abortAgentTurnWork = useCallback((reason?: string) => {
    setPendingMcpReviews([]);
    streamAbortControllerRef.current?.abort(reason);
    streamAbortControllerRef.current = null;
    for (const controller of pkmAbortControllersRef.current) {
      controller.abort();
    }
    pkmAbortControllersRef.current.clear();
    pkmCaptureJobsRef.current.clear();
    pkmCaptureReceiptsRef.current.clear();
    latestPkmSaveReceiptRef.current = null;
    pkmNeedsOwnerCardsRef.current.clear();
    setActivePkmToolCount(0);
    setVisiblePkmToolCount(0);
  }, []);

  useEffect(() => {
    // Token renewal invalidates the captured vault generation, but must not
    // cancel the answer stream or replay the underlying route transition.
    for (const controller of pkmAbortControllersRef.current) controller.abort();
    pkmAbortControllersRef.current.clear();
    pkmCaptureJobsRef.current.clear();
    pkmCaptureReceiptsRef.current.clear();
    setActivePkmToolCount(0);
    setVisiblePkmToolCount(0);
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
      performance.mark("hushh:agent-chat:pkm-warm-ready");
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
      })
        .then(() => performance.mark("hushh:agent-chat:pkm-warm-ready"))
        .catch(() => undefined);
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
  useEffect(() => {
    if (hasChatAccess) return;
    driveCompilationAbortRef.current?.abort();
    driveCompilationAbortRef.current = null;
    compiledDriveMarkdownRef.current.clear();
    setMessages(clearDriveCompilationFromMessages);
  }, [hasChatAccess, user?.uid]);

  useEffect(() => () => {
    driveCompilationAbortRef.current?.abort();
    compiledDriveMarkdownRef.current.clear();
  }, []);

  useEffect(() => {
    driveCompilationAbortRef.current?.abort();
    driveCompilationAbortRef.current = null;
    compiledDriveMarkdownRef.current.clear();
    setMessages(clearDriveCompilationFromMessages);
  }, [conversationId]);
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
    // A pending mail draft keeps the composer open: follow-ups revise it, and
    // sending still happens only from the card's own Send control.
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
        isVisiblePkmMemoryWorking ||
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
    if (isVisiblePkmMemoryWorking) return "Saving to Memory";
    if (queuedPrompts.length > 0) return `${queuedPrompts.length} queued`;
    if (isChatLoading) return "Thinking";
    if (isStreaming) return "Streaming";
    return null;
  }, [
    authLoading,
    activeActionRun,
    agentVoiceEnabled,
    isChatLoading,
    isVisiblePkmMemoryWorking,
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
    // older messages. The refs are intentionally session-local and do not
    // add a render to the scroll path. "At the end" is measured against the
    // composer, not the raw scroll bottom, and is sticky once followed, so a
    // growing answer never slides under the composer and bottom bar.
    const endBelowBand = transcriptRevealScrollTop(
      measureTranscriptReveal(transcript, messagesEnd, composerStackRef.current),
    ) - transcript.scrollTop;
    const shouldFollowTranscript = transcriptFollowsLatest({
      userScrolled: transcriptUserScrollRef.current,
      submittedTurn: scrollToSubmittedTurnRef.current,
      programmatic: transcriptProgrammaticScrollRef.current,
      scrollTop: oneScrollTopRef.current,
      stuckToEnd: transcriptStuckToEndRef.current,
      distanceFromBottom,
      endBelowBand,
    });
    transcriptStuckToEndRef.current = shouldFollowTranscript;
    if (!shouldFollowTranscript) return;

    const submittedTurn = scrollToSubmittedTurnRef.current;
    scrollToSubmittedTurnRef.current = false;
    // After a send the target is One's pending turn (the "One is preparing
    // your response" row), not the end of the person's own prompt. Both it
    // and the follow target are revealed ABOVE the composer overlay: a plain
    // `scrollIntoView({ block: "end" })` lands inside the transcript's
    // reserved bottom band, behind the composer, which is what hid the
    // working indicator under a long prompt.
    const target =
      (submittedTurn ? findPendingAssistantTurn(transcript) : null) ?? messagesEnd;
    const top = transcriptRevealScrollTop(
      measureTranscriptReveal(transcript, target, composerStackRef.current),
    );
    if (Math.abs(top - transcript.scrollTop) < 1) return;
    beginTranscriptProgrammaticScroll(top);
    transcript.scrollTo({
      top,
      behavior: submittedTurn && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "smooth" : "auto",
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
    setReportedMessageIds(new Set());
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
    const surface = composerSurfaceRef.current;
    const wasExpanded = composerExpanded;
    const previousHeight = textarea.style.height;
    const rectBeforeEmptyCollapse =
      wasExpanded && !input.trim() ? surface?.getBoundingClientRect() ?? null : null;
    textarea.style.height = "0px";
    // The field grows a line at a time up to its CSS ceiling (about six
    // lines), then scrolls inside itself, as in the reference composer. It no
    // longer jumps into the tall editor on the second line (founder direction,
    // 2026-09-29); that editor is only for opening a pasted-text attachment.
    const nextHeight = textarea.scrollHeight;

    if (!input.trim() && wasExpanded) {
      textarea.style.height = previousHeight;
      setComposerExpanded(false, rectBeforeEmptyCollapse);
      return;
    }
    // The expanded writing surface owns its fixed, spacious height.
    textarea.style.height = composerExpanded ? "" : `${nextHeight}px`;
  }, [composerExpanded, input, setComposerExpanded, voiceActive]);

  useLayoutEffect(() => {
    const fromRect = composerTransitionRectRef.current;
    composerTransitionRectRef.current = null;
    const surface = composerSurfaceRef.current;
    const textarea = composerTextareaRef.current;
    if (!fromRect || !surface || !textarea) return;

    // Set the destination dimensions before measuring. The actual layout only
    // changes once; the short transition below is compositor-only.
    if (composerExpanded) {
      textarea.style.height = "";
    } else {
      textarea.style.height = "0px";
      const compactStyles = window.getComputedStyle(textarea);
      const maxHeight = Number.parseFloat(compactStyles.maxHeight);
      const desiredHeight = textarea.scrollHeight;
      textarea.style.height = `${Number.isFinite(maxHeight)
        ? Math.min(desiredHeight, maxHeight)
        : desiredHeight}px`;
    }

    const toRect = surface.getBoundingClientRect();
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      fromRect.width <= 0 || fromRect.height <= 0 ||
      toRect.width <= 0 || toRect.height <= 0
    ) {
      return;
    }

    const easing =
      window.getComputedStyle(document.documentElement)
        .getPropertyValue("--motion-ease-emphasized")
        .trim() || "cubic-bezier(0.2, 0, 0, 1)";
    // FLIP keeps the composer's bottom edge as its anchor, so the expanded
    // surface grows upward from the same place as the compact pill.
    const animation = surface.animate(
      [
        {
          transformOrigin: "left bottom",
          transform: `translate3d(${fromRect.left - toRect.left}px, ${fromRect.bottom - toRect.bottom}px, 0) scale(${fromRect.width / toRect.width}, ${fromRect.height / toRect.height})`,
        },
        {
          transformOrigin: "left bottom",
          transform: "translate3d(0, 0, 0) scale(1, 1)",
        },
      ],
      { duration: 120, easing, fill: "none" },
    );
    composerSurfaceAnimationRef.current = animation;
    animation.onfinish = () => {
      if (composerSurfaceAnimationRef.current === animation) {
        composerSurfaceAnimationRef.current = null;
      }
    };
    animation.oncancel = () => {
      if (composerSurfaceAnimationRef.current === animation) {
        composerSurfaceAnimationRef.current = null;
      }
    };
  }, [composerExpanded]);

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
      // Leaving the chat stops reading; the server keeps the turn and the
      // app-shell turn watch reattaches (or says "One replied") later.
      abortAgentTurnWork(AGENT_TURN_DETACH_REASON);
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
    () => getWelcomePrompts(welcomePromptSetIndex),
    [welcomePromptSetIndex],
  );
  // One's conversational onboarding replaces the old post-setup tile card.
  const chatOnboarding = useChatOnboarding({
    userId: user?.uid,
    displayName: formatAgentDisplayName(user?.displayName, user?.email),
    vaultKey,
    vaultOwnerToken,
    isVaultUnlocked,
    startSignal: Boolean(postSetupWelcomeContext),
    messages,
    conversationId,
    onFocusComposer: () => composerTextareaRef.current?.focus(),
    visiblePrompts: welcomePrompts,
  });

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
    setVisiblePkmToolCount(0);
    setWalletWidgets([]);
    updateConversationId(null, false);
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
    pendingDriveSearchSelectionRef.current = null;
    setPendingDriveSearchSelection(null);
    generatedDriveSearchDraftRef.current = false;
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
    setGmailKycEmailDraftEnvelope(null);
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

  const closeEmailDraft = () => {
    setEmailDraftOpen(false);
    setEmailDraftInstruction("");
    setEmailDraftAutoDraft(false);
    setEmailDraftInitialValue(null);
    setEmailDraftAnchorMessageId(null);
    setGmailKycReplyRequest(null);
    setGmailKycEmailDraftWorkflowId(null);
    setGmailKycEmailDraftEnvelope(null);
  };

  const loadGmailInformationRequestPreview = useCallback(
    async (workflowId: string): Promise<GmailInformationRequestSourcePreview> => {
      const token = getVaultOwnerToken();
      if (!user?.uid || !token) {
        throw new Error("Vault access expired.");
      }
      return GmailInformationRequestsService.getSourcePreview({
        firebaseIdToken: await user.getIdToken(),
        vaultOwnerToken: token,
        workflowId,
      });
    },
    [getVaultOwnerToken, user],
  );

  useEffect(() => {
    const workflowId = gmailKycEmailDraftWorkflowId;
    if (!emailDraftOpen || !workflowId) {
      setGmailKycEmailDraftEnvelope(null);
      return;
    }
    let active = true;
    void loadGmailInformationRequestPreview(workflowId)
      .then((source) => {
        if (!active) return;
        const subject = source.subject.trim();
        setGmailKycEmailDraftEnvelope({
          to: source.reply_to?.trim() || source.from.trim(),
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        });
      })
      .catch(() => {
        if (active) setGmailKycEmailDraftEnvelope(null);
      });
    return () => {
      active = false;
    };
  }, [emailDraftOpen, gmailKycEmailDraftWorkflowId, loadGmailInformationRequestPreview]);

  useEffect(() => {
    if (!emailDraftOpen) {
      pendingEmailDraftFrameRef.current = null;
      emailDraftCardValueRef.current = null;
      return;
    }
    pendingEmailDraftFrameRef.current = {
      sourceBound: Boolean(gmailKycEmailDraftWorkflowId),
      envelope: gmailKycEmailDraftEnvelope,
    };
  }, [emailDraftOpen, gmailKycEmailDraftEnvelope, gmailKycEmailDraftWorkflowId]);

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

  /**
   * Grants Gmail sending in place. Call directly from the click: the consent
   * window opens synchronously. On success the reviewed draft reopens, so the
   * pending send resumes exactly where the person left it; nothing is sent
   * until they send it again.
   */
  const handleEnableGmailSend = (item?: EmailDeliveryHistoryItem) => {
    const owner = user;
    if (!owner?.uid || !owner.getIdToken) return;
    const ownerId = owner.uid;
    const started = gmailSendConnect.start(
      item?.id ?? "gmail_send",
      (controls) =>
        connectGmailInPlace({
          owner,
          purpose: "send",
          ...controls,
          isCurrent: () => workspaceOwnerIdRef.current === ownerId,
        }),
      (outcome, { cancelled }) => {
        if (outcome === "connected") {
          toast.success(inPlaceConnectCopy("gmail_send", outcome));
          if (item) retryEmailDelivery(item);
        } else if (outcome === "failed") {
          toast.error(inPlaceConnectCopy("gmail_send", outcome));
        } else if (!cancelled) {
          toast.info(inPlaceConnectCopy("gmail_send", outcome));
        }
      },
    );
    if (started === "blocked") toast.info(OAUTH_WINDOW_BLOCKED_COPY);
  };

  /**
   * Runs a connect requested by a specialist card. The card stays visible and
   * cancellable while Google's window is open; on success it is cleared, as
   * the old redirect-return did, and the person stays in this chat.
   */
  const runDirectiveConnect = (kind: "gmail_modify" | "calendar") => {
    const owner = user;
    if (!owner?.uid) return;
    const ownerId = owner.uid;
    const payload = (pendingSpecialistDirective?.directive.payload ?? {}) as Record<
      string,
      unknown
    >;
    const isCurrent = () => workspaceOwnerIdRef.current === ownerId;
    const started = directiveConnect.start(
      kind,
      (controls) =>
        kind === "calendar"
          ? connectCalendarInPlace({
              owner,
              accessLevel: payload.accessLevel === "manage" ? "manage" : "read",
              ...controls,
              isCurrent,
            })
          : connectGmailInPlace({
              owner,
              purpose: "modify",
              ...controls,
              isCurrent,
            }),
      (outcome, { cancelled, surface }) => {
        setSpecialistBusy(false);
        if (
          kind === "calendar" &&
          (outcome === "failed" || (outcome === "connected" && surface === "native"))
        ) {
          // Web outcomes are recorded by the verified callback page itself.
          trackEvent("one_calendar_action", {
            route_id: "one_calendar",
            action: "connected",
            result: outcome === "connected" ? "success" : "error",
          });
        }
        // Cancel already dismissed the card and said so.
        if (cancelled) return;
        if (outcome === "connected") {
          setPendingSpecialistDirective(null);
          toast.success(inPlaceConnectCopy(kind, outcome));
        } else if (outcome === "failed") {
          toast.error(inPlaceConnectCopy(kind, outcome));
        } else {
          toast.info(inPlaceConnectCopy(kind, outcome));
        }
      },
    );
    if (started === "started") setSpecialistBusy(true);
    else if (started === "blocked") toast.info(OAUTH_WINDOW_BLOCKED_COPY);
    else if (started === "unsupported") {
      // The native Google sign-in plugins request an explicit scope list and do
      // not yet include gmail.modify; never start a grant they would reject.
      setPendingSpecialistDirective(null);
      addErrorMessage("Allow Gmail changes from One on the web for now.");
    }
  };

  const openGmailEmailDraftFromDirective = useCallback(
    (event: AgentChatToolEvent, assistantMessageId: string): boolean => {
      const sourceBoundReply = getGmailInformationRequestReplyPayload(event);
      if (sourceBoundReply) {
        if (!hasChatAccess) {
          if (user) setVaultDialogOpen(true);
          else router.push(ROUTES.LOGIN);
          return true;
        }
        setEmailDraftInstruction("Replying to the selected Mail request with your private information.");
        setEmailDraftInitialValue({
          to: "",
          cc: "",
          bcc: "",
          subject: "",
          body: sourceBoundReply.body,
          sourceWorkflowId: gmailKycEmailDraftWorkflowId ?? undefined,
        });
        setEmailDraftAutoDraft(false);
        setEmailDraftAnchorMessageId(assistantMessageId);
        setEmailDraftOpen(true);
        return true;
      }
      const payload = getGmailEmailDraftPayload(event);
      if (!payload) return false;
      if (!hasChatAccess) {
        if (user) setVaultDialogOpen(true);
        else router.push(ROUTES.LOGIN);
        return true;
      }
      setEmailDraftInstruction(payload.instruction);
      setEmailDraftInitialValue(
        payload.initialDraft
          ? { ...payload.initialDraft, ...(payload.driveFileId ? { driveFileId: payload.driveFileId } : {}) }
          : payload.driveFileId
            ? { to: "", cc: "", bcc: "", subject: "", body: "", driveFileId: payload.driveFileId }
            : null,
      );
      setEmailDraftAutoDraft(!payload.initialDraft);
      setEmailDraftAnchorMessageId(assistantMessageId);
      setEmailDraftOpen(true);
      return true;
    },
    [gmailKycEmailDraftWorkflowId, hasChatAccess, router, user],
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

  const compileOwnerDriveNotes = async (
    messageId: string, query: string, window: DriveOwnerCompileWindow,
  ) => {
    if (!hasChatAccess || !user?.uid || !query || !window) return;
    const token = getVaultOwnerToken();
    if (!token) return;
    driveCompilationAbortRef.current?.abort();
    const controller = new AbortController();
    driveCompilationAbortRef.current = controller;
    compiledDriveMarkdownRef.current.clear();
    setMessages(clearDriveCompilationFromMessages);
    const ownerId = user.uid;
    const sourceKey = driveOwnerCompileKey(query, window);
    const eventId = `owner-compile:${messageId}`;
    let lastProgress: DriveBatchProgress = {
      phase: "searching", completed: 0, total: 0, failed: 0,
    };
    updateMessage(messageId, (message) => ({
      ...message,
      driveCompilation: { status: "running", sourceKey },
    }));
    upsertMessageStreamEvent(messageId,
      driveBatchProgressToVisibleStreamEvent(lastProgress, eventId));
    try {
      const result = await streamOwnerDriveCompilation({
        token,
        message: query,
        window,
        signal: controller.signal,
        guard: () => {
          if (workspaceOwnerIdRef.current !== ownerId || controller.signal.aborted ||
            !getVaultOwnerToken()) throw new Error("owner_changed");
        },
        onStage: (stage) => {
          if (stage === "fetching") {
            lastProgress = { ...lastProgress, phase: "fetching" };
          } else if (stage === "finalizing") {
            lastProgress = { ...lastProgress, phase: "finalizing" };
          }
          upsertMessageStreamEvent(messageId,
            driveBatchProgressToVisibleStreamEvent(lastProgress, eventId));
        },
        onFile: (progress) => {
          lastProgress = progress;
          upsertMessageStreamEvent(messageId,
            driveBatchProgressToVisibleStreamEvent(progress, eventId));
        },
      });
      if (controller.signal.aborted || workspaceOwnerIdRef.current !== ownerId) return;
      compiledDriveMarkdownRef.current.set(messageId, result.markdown);
      updateMessage(messageId, (message) => ({
        ...message,
        driveCompilation: {
          status: result.status === "partial" || result.truncated ? "partial" : "ready",
          sourceKey,
          matched: result.matched,
          included: result.included,
          failed: result.failed,
        },
      }));
      upsertMessageStreamEvent(messageId,
        driveBatchProgressToVisibleStreamEvent({
          phase: result.status === "partial" || result.truncated ? "partial" : "complete",
          completed: result.included,
          total: result.matched,
          failed: result.failed,
        }, eventId));
    } catch (error) {
      if (controller.signal.aborted || workspaceOwnerIdRef.current !== ownerId) return;
      const code = error instanceof DriveCompilationError ? error.code : "unavailable";
      const errorReason: NonNullable<DriveCompilationUiState["errorReason"]> =
        code === "connect_required" || code === "reconnect_required" ||
        code === "input_required" || code === "source_changed" || code === "interrupted"
          ? code
          : "unavailable";
      updateMessage(messageId, (message) => ({
        ...message,
        driveCompilation: { status: "error", sourceKey, errorReason },
      }));
      upsertMessageStreamEvent(messageId,
        driveBatchProgressToVisibleStreamEvent({ ...lastProgress, phase: "error" }, eventId));
    } finally {
      if (driveCompilationAbortRef.current === controller) {
        driveCompilationAbortRef.current = null;
      }
    }
  };

  const downloadCompiledDriveNotes = async (messageId: string) => {
    if (!hasChatAccess) return;
    const markdown = compiledDriveMarkdownRef.current.get(messageId);
    if (!markdown) return;
    await exportPrivateDriveMarkdown(markdown, `drive-notes-${new Date().toISOString().slice(0, 10)}.md`);
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
    const { timestamp, sentAtMs } = stampNow();
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
      setGmailKycReplyRequest(gmailInformationRequest);
      setGmailKycEmailDraftWorkflowId(gmailInformationRequest.workflow_id);
      // This is an ordinary One turn. The browser forwards only the opaque
      // workflow id; authenticated agent-chat ingress re-fetches the actual
      // selected Gmail message as one-turn source context for One.
      void runAgentTurnRef.current(
        "Reply to the selected Gmail email with appropriate details from my memory.",
        {
          source: "typed",
          gmailInformationRequestWorkflowId: gmailInformationRequest.workflow_id,
        },
      );
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
        sentAtMs,
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
      sentAtMs,
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
              ...stampNow(),
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
      ...stampNow(),
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

    const applySnapshot = async (snapshot: NonNullable<typeof cached>) => {
      if (cancelled || restoreEpoch !== historyRestoreEpochRef.current) return;
      setConversations(snapshot.conversations);
      const selectedId = selectedInAppChat(user.uid);
      // A first turn the person left may not be in a cached list yet; its
      // history load below is still owner-checked by the server.
      if (
        !selectedId ||
        (!snapshot.conversations.some((item) => item.id === selectedId) &&
          !isAgentTurnWatched(user.uid, selectedId))
      ) {
        updateConversationId(null, false);
        setMessages((current) =>
          mergePendingConsentMessages([createGreetingMessage()], current),
        );
        return;
      }
      // A turn the person left is still running server-side: read fresh
      // history rather than the cache, and show it as in progress.
      const reattaching = isAgentTurnWatched(user.uid, selectedId);
      const loadSelected = () => loadAgentChatConversationHistory({
        userId: user.uid, conversationId: selectedId, vaultOwnerToken, vaultKey: vaultKeyRef.current ?? "",
        force: reattaching,
      });
      let stored = !reattaching && selectedId === snapshot.latestConversationId && snapshot.latestMessages.length > 0
        ? snapshot.latestMessages
        : await loadSelected();
      // It may have settled while that read was in flight; read the answer.
      if (reattaching && !isAgentTurnWatched(user.uid, selectedId)) stored = await loadSelected();
      if (cancelled || restoreEpoch !== historyRestoreEpochRef.current) return;
      const restored = storedMessagesToAgentMessages(stored);
      const stillRunning = isAgentTurnWatched(user.uid, selectedId);
      updateConversationId(selectedId, false);
      setMessages((current) =>
        mergePendingConsentMessages(
          restored.length > 0
            ? [
                ...restored,
                ...(stillRunning
                  ? [{
                      id: `reattach-${selectedId}`,
                      role: "assistant" as const,
                      text: "",
                      ...stampNow(),
                      status: "streaming" as const,
                    }]
                  : []),
              ]
            : [createGreetingMessage()],
          current,
        ),
      );
      if (stillRunning) {
        setIsChatLoading(true);
        setIsStreaming(true);
      }
    };

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
          vaultKey: vaultKeyRef.current ?? "",
          force: cached ? !cached.isFresh : false,
        });
        await applySnapshot(next);
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

  // A restored connector step carries only its opaque id. Label it with the
  // owner's own connector name from the vault, as the live row did; the
  // server never learns or returns that name.
  const unresolvedConnectorIds = useMemo(() => Array.from(new Set(messages.flatMap((message) =>
    (message.streamEvents ?? []).flatMap((event) =>
      event.connectorId && event.label === RESTORED_CONNECTOR_STEP_LABEL ? [event.connectorId] : [])))).sort().join(","),
  [messages]);
  const attemptedConnectorNamesRef = useRef<string>("");
  useEffect(() => {
    const ownerId = user?.uid;
    if (!unresolvedConnectorIds || !ownerId || !vaultKey || !vaultOwnerToken) return;
    const attemptKey = `${ownerId}:${unresolvedConnectorIds}`;
    if (attemptedConnectorNamesRef.current === attemptKey) return;
    attemptedConnectorNamesRef.current = attemptKey;
    let cancelled = false;
    void loadCustomConnectorSnapshot({ userId: ownerId, vaultKey, vaultOwnerToken })
      .then(({ configurations }) => {
        if (cancelled || workspaceOwnerIdRef.current !== ownerId) return;
        const names = new Map(configurations.map((item) => [item.connectorId, item.displayName]));
        setMessages((current) => labelRestoredConnectorSteps(current, names));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [unresolvedConnectorIds, user?.uid, vaultKey, vaultOwnerToken]);

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
        vaultKey: vaultKeyRef.current ?? "",
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
        pendingDriveSearchSelectionRef.current = null;
        setPendingDriveSearchSelection(null);
        generatedDriveSearchDraftRef.current = false;
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
    setComposerExpanded,
    updateConversationId,
    user?.uid,
    vaultKey,
    vaultOwnerToken,
  ]);

  const prepareDriveChatRecovery = useCallback(async (request: {
    attemptId: string;
    reason: DriveChatRecoveryReason;
    customConnector?: { connectorId: string; revision: string };
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
      pendingMcpReviews.length > 0 ||
      pendingSpecialistDirective ||
      emailDraftOpen ||
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
        customConnector: request.customConnector,
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
    isHistoryDrawerOpen, isLoadingHistory, isPkmMemoryWorking,
    isPuppySurface, longPromptAttachment, pendingAppAction, pendingMcpReviews.length,
    pendingSpecialistDirective, queuedHandoffPrompt, user?.uid, vaultKey,
  ]);
  const customConnectorChat = useMemo(() => ({ prepareRecovery: prepareDriveChatRecovery }), [prepareDriveChatRecovery]);

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
          vaultKey: vaultKeyRef.current ?? "",
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

  // A turn this chat stopped reading has written its answer: show it in place.
  useEffect(() => {
    return subscribeAgentTurnSettled((turn) => {
      if (turn.ownerId !== user?.uid || turn.conversationId !== conversationIdRef.current) return;
      const token = getVaultOwnerToken();
      setIsChatLoading(false);
      setIsStreaming(false);
      if (!token) {
        setMessages((current) => current.filter((message) => message.id !== `reattach-${turn.conversationId}`));
        return;
      }
      // A prompt queued meanwhile starts only after this reload lands.
      reattachRestoreRef.current = restoreConversationMessages(
        turn.conversationId,
        token,
        () => conversationIdRef.current === turn.conversationId,
      ).catch(() => undefined);
    });
  }, [getVaultOwnerToken, restoreConversationMessages, user?.uid]);

  // "Open" on a One replied notice, or a push tap, while this chat is mounted.
  useEffect(() => {
    return subscribeOpenAgentConversation(({ ownerId, conversationId: requestedId }) => {
      if (ownerId !== user?.uid) return;
      void handleSelectConversation(requestedId);
    });
  }, [handleSelectConversation, user?.uid]);

  const handleCreateNewPuppyChat = puppyHistory.create;
  const handleSelectPuppyConversation = puppyHistory.select;
  const handleRenamePuppyConversation = (id: string, title: string) => {
    puppyHistory.rename(id, title);
  };
  const handleDeletePuppyConversation = (id: string) => {
    puppyHistory.remove(id);
  };

  const handleSidebarCreateNewChat = useCallback(() => {
    handleHistoryDrawerOpenChange(false);
    if (isPuppySurface) {
      handleCreateNewPuppyChat();
      return;
    }
    setAgentSurface("one");
    handleCreateNewChat();
  }, [handleCreateNewChat, handleCreateNewPuppyChat, handleHistoryDrawerOpenChange, isPuppySurface]);

  const handleSidebarSelectConversation = useCallback(
    (nextConversationId: string) => {
      handleHistoryDrawerOpenChange(false);
      if (isPuppySurface) {
        handleSelectPuppyConversation(nextConversationId);
        return;
      }
      setAgentSurface("one");
      void handleSelectConversation(nextConversationId);
    },
    [handleHistoryDrawerOpenChange, handleSelectConversation, handleSelectPuppyConversation, isPuppySurface],
  );

  const handleRenameConversation = useCallback(
    async (targetConversationId: string, title: string) => {
      const token = getVaultOwnerToken();
      if (!token) {
        toast.error("Vault access expired. Unlock again to continue.");
        throw new Error("VAULT_ACCESS_EXPIRED");
      }
      setHistoryActionPendingId(targetConversationId);
      try {
        const renamed = await renameAgentChatConversation({
          conversationId: targetConversationId,
          title,
          vaultOwnerToken: token,
          vaultKey: vaultKeyRef.current ?? "",
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
        throw new Error("CHAT_RENAME_FAILED");
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
        handleHistoryDrawerOpenChange(false);
        handleCreateNewChat();
      }
      setHistoryActionPendingId(targetConversationId);
      const deletion = deleteAgentChatConversation({
        conversationId: targetConversationId,
        vaultOwnerToken: token,
      });
      toast.promise(deletion, {
        loading: "Deleting chat…",
        success: "Chat deleted.",
        error: "Could not delete chat.",
      });
      try {
        await deletion;
        if (getVaultOwnerToken() !== token) return;
        setConversations((current) => current.filter((item) => item.id !== targetConversationId));
        void warmAgentChatHistoryCache({
          userId: user.uid,
          vaultOwnerToken: token,
          vaultKey: vaultKeyRef.current ?? "",
          force: true,
        }).catch(() => undefined);
      } catch {
        // The promise toast reports the failed server operation. Keep the row.
      } finally {
        if (getVaultOwnerToken() === token) setHistoryActionPendingId(null);
      }
    },
    [
      conversationId,
      getVaultOwnerToken,
      handleCreateNewChat,
      handleHistoryDrawerOpenChange,
      historyInteractionDisabled,
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

  /**
   * Report one answer to the Hussh team (Google Play AI-Generated Content
   * policy). Not optimistic: the dialog stays open and offers a retry until the
   * server has the report, so a person is never told it was sent when it was not.
   */
  const handleReportMessage = useCallback(
    async (messageId: string, reason: AgentResponseReportReason) => {
      const token = getVaultOwnerToken();
      if (!conversationId || !token) {
        throw new Error("This conversation is not available yet.");
      }
      await setAgentChatFeedback({
        conversationId,
        messageId,
        rating: "down",
        reportReason: reason,
        vaultOwnerToken: token,
      });
      setMessageRatings((current) => ({ ...current, [messageId]: "down" }));
      setReportedMessageIds((current) => new Set(current).add(messageId));
      toast.success("Thanks. The Hussh team reviews every report.");
    },
    [conversationId, getVaultOwnerToken],
  );

  // One memory-only job belongs to its originating turn. Later turns may
  // continue; a conversation/owner/vault change cancels pending effects.
  const captureEligiblePkmFactsInBackground = useCallback(
    (params: {
      turnId: string;
      assistantMessageId: string;
      sourceMessage: string;
      currentDomains: string[];
      kycInformationSaveConfirmed?: boolean;
      /** The owner asked One to save this; see lib/agent/agent-pkm-explicit-save.ts. */
      explicitRequest?: boolean;
    }): Promise<AgentPkmCaptureStatus> => {
      // Private source text is used only in this transient deduplication key.
      const jobKey = JSON.stringify([params.assistantMessageId, params.sourceMessage]);
      const existing = pkmCaptureJobsRef.current.get(jobKey);
      if (existing) return existing;
      const token = getVaultOwnerToken();
      const ownerConfirmedKycSave = params.kycInformationSaveConfirmed === true;
      const explicitRequest = params.explicitRequest === true;
      const userRequestedSave = explicitRequest || ownerConfirmedKycSave ||
        isExplicitKycIdentitySaveRequest(params.sourceMessage);
      if (explicitRequest && (!user?.uid || !vaultKey || !token)) {
        const locked: AgentPkmCaptureStatus = { phase: "needs_unlock", saved: 0 };
        setMessages((current) => current.map((message) =>
          message.id === params.assistantMessageId ? { ...message, memoryCapture: locked } : message,
        ));
        return Promise.resolve(locked);
      }
      if (!user?.uid || !vaultKey || !token || (!pkmCaptureEnabledRef.current && !ownerConfirmedKycSave && !explicitRequest)) {
        return Promise.resolve({ phase: "review", saved: 0 });
      }
      const userId = user.uid;
      const policy = pkmCapturePolicyRef.current;
      const controller = new AbortController();
      const guard = createAgentPkmCaptureGuard({
        userId, signal: controller.signal,
        // An explicit request does not depend on the background auto-save
        // policy; it still needs the same unlocked, unexpired vault session.
        isEnabled: () => ownerConfirmedKycSave ||
          (explicitRequest && isAgentPkmProcessingReady(pkmCaptureReadinessRef.current, token)) || (
            pkmCaptureEnabledRef.current && pkmCapturePolicyRef.current === policy &&
            isAgentPkmProcessingReady(pkmCaptureReadinessRef.current, token)
          ),
      });
      pkmAbortControllersRef.current.add(controller);
      setActivePkmToolCount((count) => count + 1);
      if (userRequestedSave) setVisiblePkmToolCount((count) => count + 1);
      let timedOut = false;
      // Every job ends. Before this deadline a vault token that expired by the
      // clock (no React change) made the guard false, the final status was
      // dropped, and "Checking for details worth remembering" stayed forever.
      const deadline = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, explicitRequest ? AGENT_PKM_EXPLICIT_SAVE_DEADLINE_MS : AGENT_PKM_CAPTURE_DEADLINE_MS);
      const settle = (status: AgentPkmCaptureStatus) => {
        // An explicit Save retains a terminal status after session expiry;
        // automatic preparation stays off an ordinary answer unless it saved.
        if (!shouldPublishAgentPkmCapture(status, guard.isCurrent())) return status;
        if (!shouldPresentAgentPkmCapture(status, userRequestedSave)) return status;
        const receipts = pkmCaptureReceiptsRef.current.get(params.assistantMessageId) || new Map<string, AgentPkmCaptureStatus>();
        receipts.set(jobKey, status);
        pkmCaptureReceiptsRef.current.set(params.assistantMessageId, receipts);
        const aggregate = aggregateAgentPkmCaptures([...receipts.values()]);
        setMessages((current) => current.map((message) =>
          message.id === params.assistantMessageId ? { ...message, memoryCapture: aggregate } : message,
        ));
        if (!isAgentPkmCaptureRunning(status) && status.receipt) {
          latestPkmSaveReceiptRef.current = status.receipt;
        }
        return status;
      };
      const job = (async (): Promise<AgentPkmCaptureStatus> => {
        try {
          // Yield presentation without creating an untracked detached timer.
          await guard.assertCurrent();
          settle({ phase: "preparing", saved: 0 });
          if (ownerConfirmedKycSave || isExplicitKycIdentitySaveRequest(params.sourceMessage)) {
            // A typed reply to an owner-selected KYC request is an explicit
            // confirmation for the fixed, restricted KYC schema. The Gmail
            // email never enters this writer; only the owner's message does.
            const ingestion = await ingestNaturalLanguagePkm({
              userId,
              message: params.sourceMessage,
              currentDomains: params.currentDomains,
              vaultKey,
              vaultOwnerToken: token,
              source: "agent_chat_kyc_owner_confirmed",
              memoryProfile: "kyc_identity_v1",
              confirmation: {
                confirmedByUser: true,
                surface: "chat",
                source: "agent_chat_kyc_owner_confirmed",
              },
              writePolicy: "reviewable",
              batchSimpleDomainExtensions: true,
            });
            await guard.assertCurrent();
            appendDebugEvent(params.turnId, "pkm_kyc_save_result", {
              saved: ingestion.save.saved,
              failed: ingestion.save.failed,
            });
            return settle({
              phase: ingestion.save.saved > 0
                ? (ingestion.save.failed ? "partial" : "saved")
                : "failed",
              saved: ingestion.save.saved,
            });
          }
          if (explicitRequest) {
            const labContext = await loadPkmAgentLabContext({ userId, vaultOwnerToken: token });
            await guard.assertCurrent();
            const { receipt, needsOwnerCards } = await runExplicitPkmSave({
              userId,
              message: params.sourceMessage,
              currentDomains: params.currentDomains,
              currentManifests: Object.values(labContext.manifests || {}).filter(Boolean),
              vaultKey,
              vaultOwnerToken: token,
              findDuplicate: (candidate) => AgentPkmContextStore.findLocalDuplicate({ userId, candidate }),
              findReconciliationCandidates: (passage) =>
                AgentPkmContextStore.findReconciliationCandidates({ userId, text: passage }),
              beforeEffect: guard.assertCurrent,
              isEffectCurrent: guard.isCurrent,
              mayPublish: guard.isCurrent,
              onProgress: (progress) => {
                settle({ phase: progress.stage === "saving" ? "saving" : "preparing", saved: 0, progress });
              },
            });
            if (needsOwnerCards.length) {
              pkmNeedsOwnerCardsRef.current.set(params.assistantMessageId, {
                cards: needsOwnerCards, sourceMessage: params.sourceMessage,
              });
            }
            const wrote = pkmSaveReceiptWrote(receipt);
            appendDebugEvent(params.turnId, "pkm_explicit_save_result", {
              saved: receipt.saved, updated: receipt.updated, merged: receipt.merged,
              unchanged: receipt.unchanged, skipped: receipt.skipped, excluded: receipt.excluded,
              unreadable: receipt.unreadable, needs_owner: receipt.needsOwner,
              failed: receipt.failed, unprepared: receipt.unprepared,
            });
            trackEvent("agent_pkm_save_confirmation_completed", {
              route_id: "agent", result: wrote > 0 ? "success" : "expected_error",
              saved_count_bucket: toPkmFactCountBucket(wrote), failed_count_bucket: toPkmFactCountBucket(receipt.failed),
              has_active_recipients: false,
            });
            const incomplete = receipt.failed + receipt.unprepared + receipt.unreadable + receipt.excluded + receipt.needsOwner > 0;
            return settle({
              phase: wrote > 0 || receipt.unchanged > 0
                ? (incomplete ? "partial" : "saved")
                : incomplete ? "failed" : "skipped",
              saved: wrote,
              receipt,
            });
          }
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
          appendDebugEvent(params.turnId, "pkm_capture_failed", {
            kind: timedOut ? "timeout" : guard.isCurrent() ? "capture_failed" : "session_changed",
            requested_by_owner: userRequestedSave,
          });
          if (timedOut) return settle({ phase: "failed", saved: 0, reason: "timeout" });
          return settle({ phase: guard.isCurrent() ? "failed" : "canceled", saved: 0 });
        } finally {
          globalThis.clearTimeout(deadline);
          // A canceled old job must not decrement a new conversation's count.
          if (pkmAbortControllersRef.current.delete(controller)) {
            setActivePkmToolCount((count) => Math.max(0, count - 1));
            if (userRequestedSave) setVisiblePkmToolCount((count) => Math.max(0, count - 1));
          }
        }
      })();
      pkmCaptureJobsRef.current.set(jobKey, job);
      return job;
    },
    [appendDebugEvent, getVaultOwnerToken, user?.uid, vaultKey],
  );

  // The owner tapped "Save these too" on a memory receipt card: their direct
  // confirmation for the details an explicit save held back.
  const confirmMemoryNeedsOwner = useCallback(async (
    messageId: string,
    reviewedCards: readonly AgentPkmPreviewCard[],
  ) => {
    const pending = pkmNeedsOwnerCardsRef.current.get(messageId);
    const token = getVaultOwnerToken();
    if (!pending || !user?.uid || !vaultKey || !token) {
      throw new Error("Unlock your vault to save these details.");
    }
    if (pending.cards !== reviewedCards ||
        !pending.cards.every((card) => describeOwnerMemoryReview(card) !== null)) {
      throw new Error("The proposed details changed. Review them again before saving.");
    }
    const result = await saveOwnerConfirmedCards({
      userId: user.uid, cards: pending.cards, sourceMessage: pending.sourceMessage,
      vaultKey, vaultOwnerToken: token,
    });
    const remaining = pending.cards.filter((_, index) => !isCommittedPkmSave(result.results[index]));
    if (remaining.length === pending.cards.length) throw new Error("Nothing was saved.");
    if (remaining.length) pkmNeedsOwnerCardsRef.current.set(messageId, { ...pending, cards: remaining });
    else pkmNeedsOwnerCardsRef.current.delete(messageId);
    setMessages((current) => current.map((message) => {
      const receipt = message.id === messageId ? message.memoryCapture?.receipt : undefined;
      if (!receipt || !message.memoryCapture) return message;
      const next = applyOwnerConfirmedSave(receipt, pending.cards, result);
      latestPkmSaveReceiptRef.current = next;
      return { ...message, memoryCapture: { ...message.memoryCapture, receipt: next, saved: pkmSaveReceiptWrote(next) } };
    }));
  }, [getVaultOwnerToken, user?.uid, vaultKey]);

  const runAgentTurn = async (
    textInput: string,
    options: AgentRunTurnOptions = { source: "typed" },
  ) => {
    for (const name of [
      "send-handler-entry",
      "pkm-prepare-start",
      "pkm-prepare-end",
      "dispatch-start",
    ]) {
      performance.clearMarks(`hushh:agent-chat:${name}`);
    }
    performance.mark("hushh:agent-chat:send-handler-entry");
    const text = textInput.trim();
    const attachments = options.attachments ?? [];
    if ((!text && attachments.length === 0) || !hasChatAccess || !user?.uid) return;
    // The whole turn as the person supplied it (typed text, then any pasted
    // attachment). On-device lanes that read the turn whole -- private-memory
    // lookup and memory capture -- use this. The wire and the transcript keep
    // the attachment separate from the typed text.
    const turnSourceText = composeTurnSourceText(text, attachments);
    // Pre-model paste guard: a message that appears to contain a full card
    // number must never reach /api/one/agent-chat, history, or telemetry.
    // Block before ANY network call and route to the secure add form.
    if (detectLikelyPan(turnSourceText)) {
      appendMessage({
        id: `msg-${Date.now()}-pan-blocked`,
        role: "assistant",
        text: "That looked like a full card number, so it was blocked on this device and never sent. Use the secure form to save a card.",
        ...stampNow(),
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
    setPendingMcpReviews([]);

    const userId = user.uid;
    const token = getVaultOwnerToken();
    const appendUserMessage = options.appendUserMessage ?? true;
    const { timestamp, sentAtMs } = stampNow();
    const turnId = Date.now();
    const debugTurnId = `agent_turn_${turnId}`;
    const assistantMessageId = `msg-${turnId}-assistant`;
    const executedToolCalls = new Set<string>();
    let pkmToolHandledFullTurn = false;
    let toolStatusMessageId: string | null = null;
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
      // `source_scope: "turn"` means the person asked to save what they pasted
      // this turn. The device reads it directly, so the model never has to copy
      // a long document into a tool argument (where it would be cut short).
      const wholeTurn = toolEvent.slots.source_scope === "turn";
      const sourceText =
        !wholeTurn &&
        typeof toolEvent.slots.source_text === "string" &&
        toolEvent.slots.source_text.trim()
          ? toolEvent.slots.source_text.trim()
          : turnSourceText;
      // One already chose capture passages. Do not run a second full-turn
      // extraction over those passages after its explicit capture invocations.
      pkmToolHandledFullTurn = true;

      return captureEligiblePkmFactsInBackground({
        turnId: `${debugTurnId}:${toolEvent.callId || "pkm.add"}`,
        assistantMessageId,
        sourceMessage: sourceText,
        currentDomains: turnPkmContext.domains,
        explicitRequest: true,
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
          ...(capture.phase === "needs_unlock" ? { reason: "vault_locked" } : {}),
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
      ...(attachments.length ? { attachments } : {}),
      timestamp,
      sentAtMs,
      gmailInformationRequestWorkflowId: options.gmailInformationRequestWorkflowId,
    };
    // Queued messages sent together keep one bubble each, in the order sent.
    const userMessages: AgentMessage[] = options.queuedPrompts?.length
      ? options.queuedPrompts.map((prompt, index) => ({
          ...userMessage,
          id: `msg-${turnId}-user-${index}`,
          text: prompt.text,
        }))
      : [userMessage];
    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "",
      timestamp,
      sentAtMs,
      status: "streaming",
      // A cold decrypted context read happens before the AG-UI request starts.
      // Show that real local work immediately without exposing private facts.
      ...(!options.deferPkmContext
        ? {
            streamEvents: [{
              id: PRIVATE_MEMORY_PREPARATION_EVENT_ID,
              label: "Private memory",
              message: "Preparing your private memory.",
              status: "running" as const,
              createdAtMs: Date.now(),
            }],
          }
        : {}),
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
        ...(appendUserMessage ? userMessages : []),
        assistantMessage,
      ];
    });
    latestVisibleTurnIdRef.current = debugTurnId;
    liveAssistantMessageIdRef.current = assistantMessageId;
    setActiveToolCalls([]);
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
    performance.mark("hushh:agent-chat:pkm-prepare-start");

    const loadTurnPkmContext = async (): Promise<AgentPkmContext> => {
      if (!vaultKey) {
        throw new Error(
          "Your vault must remain unlocked while One prepares your private memory.",
        );
      }

      const cachedContext = peekAgentPkmContext({
        userId,
        message: turnSourceText,
      });
      if (cachedContext?.text) {
        void loadAgentPkmContext({
          userId,
          vaultOwnerToken: token,
          vaultKey,
          message: turnSourceText,
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
            message: turnSourceText,
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
        message: turnSourceText,
        requireDecrypted: true,
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
        performance.mark("hushh:agent-chat:pkm-prepare-end");
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
            context_mode: "full",
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

      if (options.kycInformationSaveConfirmed) {
        // Persist the owner's supplied KYC details before One reasons about
        // the reply. Refreshing the decrypted context lets the same turn
        // draft only after the encrypted write has actually completed.
        pkmToolHandledFullTurn = true;
        const capture = await captureEligiblePkmFactsInBackground({
          turnId: debugTurnId,
          assistantMessageId,
          sourceMessage: turnSourceText,
          currentDomains: agentPkmContext.domains,
          kycInformationSaveConfirmed: true,
        });
        if (capture.saved > 0) {
          agentPkmContext = await loadAgentPkmContext({
            userId,
            vaultOwnerToken: token,
            vaultKey,
            message: turnSourceText,
            forceRefresh: true,
            requireDecrypted: true,
          });
          turnPkmContext = agentPkmContext;
        }
        if (streamAbortController.signal.aborted) {
          finishCanceledTurn();
          return;
        }
      }

      if (!options.deferPkmContext) {
        upsertTurnStreamEvent({
          id: PRIVATE_MEMORY_PREPARATION_EVENT_ID,
          label: "Private memory",
          message: "Private memory ready.",
          status: "done",
          createdAtMs: Date.now(),
        });
      }

      // Stop: settle the bubble now, ask the running turn to end at its next
      // step, and keep reading quietly until it does. Anything it held comes
      // back to the queue and is sent next, as after any interrupt.
      let turnStopped = false;
      const stopThisTurn = async () => {
        if (turnStopped || streamAbortController.signal.aborted) return;
        turnStopped = true;
        slowNotice.finish("stopped");
        flushAssistantDelta();
        updateMessage(assistantMessageId, (message) => ({
          ...message,
          text: message.text || "Stopped.",
          status: "done",
          streamEvents: settleVisibleStreamEvents(message.streamEvents, "blocked"),
        }));
        setIsChatLoading(false);
        setIsStreaming(false);
        setStoppableTurn(false);
        const result = await liveTurnQueueRef.current?.stop();
        if (result?.waiting.length) setQueuedPlacement(result.waiting, "waiting");
        // No server process runs this turn for us to stop: stop reading it.
        if (!result?.stopped) streamAbortController.abort();
      };

      performance.mark("hushh:agent-chat:dispatch-start");
      slowNotice.begin();
      const streamResult = await streamAgentChat({
        userId,
        message: text,
        attachments,
        messageId: options.queuedPrompts?.[0]?.id,
        conversationId: conversationIdRef.current,
        vaultOwnerToken: token,
        vaultKey: vaultKeyRef.current ?? "",
        loadConnectorConfigurations: async () => {
          if (!vaultKey) throw new Error("Unlock your vault to use connectors.");
          return (await loadCustomConnectorSnapshot({ userId, vaultKey, vaultOwnerToken: token }, true)).configurations;
        },
        // The latest save receipt leads the packet so the server's length clip
        // can never drop it. Counts and category names only.
        pkmContext: [
          latestPkmSaveReceiptRef.current
            ? formatPkmSaveReceiptForAgent(latestPkmSaveReceiptRef.current)
            : "",
          agentPkmContext.text || "",
        ].filter(Boolean).join("\n\n") || undefined,
        personSelectionHandle: options.personSelectionHandle,
        gmailInformationRequestWorkflowId: options.gmailInformationRequestWorkflowId,
        driveSearchSelection: options.driveSearchSelection,
        pendingEmailDraft: pendingEmailDraftFrameRef.current
          ? buildPendingEmailDraftContext(
              emailDraftCardValueRef.current,
              pendingEmailDraftFrameRef.current.envelope,
              pendingEmailDraftFrameRef.current.sourceBound,
            )
          : null,
        screenContext: buildOneVoiceStructuredScreenContext({
          appRuntimeState: appRuntimeStateRef.current,
          state: useAgentVoiceState.getState().oneVoiceState,
          lastTransition: useAgentVoiceState.getState().lastTransition,
        }) as unknown as Record<string, unknown>,
        signal: streamAbortController.signal,
        handlers: {
          // No onThinkingSummary: the model's reasoning is never shown in
          // chat, live or restored. Only the answer and Activity render.
          onStreamHealth: (signal) => {
            if (streamAbortController.signal.aborted || turnStopped) return;
            slowNotice.signal(signal);
          },
          onMcpReview: (review) => {
            if (streamAbortController.signal.aborted || !review.isCurrent()) return;
            // Ephemeral only: never copy pending references or private previews
            // into messages, stream diagnostics, or restored history.
            const boundReview: McpChatReview = {
              ...review,
              isCurrent: () => review.isCurrent() &&
                conversationIdRef.current === review.conversationId &&
                latestVisibleTurnIdRef.current === debugTurnId,
              resume: async (approval, signal) => {
                const abort = () => streamAbortController.abort();
                signal?.addEventListener("abort", abort, { once: true });
                try {
                  await review.resume(approval, signal);
                } finally {
                  signal?.removeEventListener("abort", abort);
                }
              },
            };
            setPendingMcpReviews((current) => current.some((item) =>
              item.reference.directiveId === review.reference.directiveId)
              ? current : [...current, boundReview]);
          },
          onStart: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            if (nextConversationId) {
              if (!queuedSettlementGateRef.current) {
                let release: () => void = () => {};
                const promise = new Promise<void>((resolve) => { release = resolve; });
                queuedSettlementGateRef.current = { promise, release };
              }
              updateConversationId(nextConversationId);
              // The turn is running: messages sent now can join it.
              liveTurnQueueRef.current?.begin(nextConversationId);
              stopActiveTurnRef.current = stopThisTurn;
              if (!turnStopped) setStoppableTurn(true);
              offerQueuedPromptsToLiveTurn();
            }
          },
          onQueuedInput: (notice) => {
            if (streamAbortController.signal.aborted) return;
            const settled = liveTurnQueueRef.current?.apply(notice);
            if (!settled) return;
            landJoinedPrompts(settled.joined);
            if (settled.waiting.length) setQueuedPlacement(settled.waiting, "waiting");
          },
          onToolStart: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            setActiveToolCalls(current => [...current.filter(item => item.id !== toolEvent.callId),
              { id: toolEvent.callId, label: toolEvent.label, activity: toolEvent.activity,
                brand: connectorBrandForTool(toolEvent.raw?.toolName, toolEvent.raw?.provider ?? toolEvent.slots?.provider) }]);
            appendDebugEvent(debugTurnId, "tool_start", toolEvent);
            upsertTurnStreamEvent(
              agentToolEventToVisibleStreamEvent("start", toolEvent),
            );
          },
          onToolWaiting: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            if (toolEvent.requiresConfirmation || toolEvent.trustedActivationRequired || toolEvent.raw.parked === true) {
              setActiveToolCalls(current => current.filter(item => item.id !== toolEvent.callId));
            } else {
              // The call's arguments are complete now, so a connector call can
              // name its product ("Checking Google Drive access…").
              setActiveToolCalls(current => current.map(item => item.id === toolEvent.callId
                ? { ...item, label: toolEvent.label, activity: toolEvent.activity,
                    brand: connectorBrandForTool(toolEvent.raw?.toolName, toolEvent.raw?.provider ?? toolEvent.slots?.provider) } : item));
            }
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
            setActiveToolCalls(current => current.filter(item => item.id !== toolEvent.callId));
            appendDebugEvent(debugTurnId, "tool_result", toolEvent);
            openGmailEmailDraftFromDirective(toolEvent, assistantMessageId);
            const calendarDirective = getCalendarDirectiveFromToolEvent(toolEvent);
            if (calendarDirective) {
              setPendingSpecialistDirective(calendarDirective);
            }
            const driveReview = getDriveReviewDirectiveFromToolResult(
              toolEvent.raw?.toolName,
              toolEvent.raw?.result,
            );
            if (driveReview) {
              setPendingSpecialistDirective(driveReview);
            }
            const visibleEvent = agentToolEventToVisibleStreamEvent(
              "result",
              toolEvent,
            );
            upsertTurnStreamEvent(visibleEvent);
          },
          onToken: (delta) => {
            if (streamAbortController.signal.aborted || turnStopped) return;
            queueAssistantDelta(delta);
          },
          onSources: (sources) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              sources,
            }));
          },
          onDriveBatchProgress: (progress, eventId) => {
            if (streamAbortController.signal.aborted) return;
            upsertTurnStreamEvent(
              driveBatchProgressToVisibleStreamEvent(progress, eventId),
            );
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
          onFollowUpSuggestions: (followUps) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({ ...message, followUps }));
          },
          onInterrupt: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            // AG-UI interrupts are the normal boundary for a visible action
            // card. The card remains actionable, but the assistant turn has
            // finished thinking until the owner confirms or cancels it.
            slowNotice.finish("answered");
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
            slowNotice.finish("answered");
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
            // The error in the transcript owns this turn; only server strain
            // keeps the notice up, as the heavy-usage explanation.
            slowNotice.finish("failed");
            flushAssistantDelta();
            updateMessage(assistantMessageId, (current) =>
              settleAssistantMessageError(current, message),
            );
            setIsChatLoading(false);
            setIsStreaming(false);
          },
        },
      });
      if (streamResult.detached) {
        // The app stopped reading (native background); the server keeps the
        // turn. The bubble stays in progress until the turn watch reports the
        // written answer and the settled-turn effect reloads it.
        flushAssistantDelta();
        if (streamResult.conversationId) updateConversationId(streamResult.conversationId);
        // Left before the server's turn was running: nothing to reattach to.
        if (!isAgentTurnWatched(userId, streamResult.conversationId)) finishCanceledTurn();
        return;
      }
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
          sourceMessage: turnSourceText,
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
      slowNotice.finish("failed");
      flushAssistantDelta();
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Agent chat request failed.";
      updateMessage(assistantMessageId, (current) =>
        settleAssistantMessageError(current, message, error),
      );
      if (isChatKeyRefusal(error)) {
        // Chat is locked, not failed. Keep the unsent message, show the unlock
        // flow, and send it once after unlock. Refreshing the conversation list
        // here would only be refused again.
        if (!currentDraftRef.current.input.trim()) setInput(text);
        if (attachments.length && !currentDraftRef.current.attachment) {
          setLongPromptAttachment(
            createPendingTextAttachment(attachments.map((item) => item.text).join("\n\n")),
          );
        }
        if (error.recovery === "unlock") {
          pendingChatKeyRetryRef.current = { text, options };
          setVaultDialogOpen(true);
        }
      } else {
        void loadConversationList(true).catch(() => undefined);
      }
      setIsChatLoading(false);
      setIsStreaming(false);
    } finally {
      // Detached, cancelled or settled above: never leave this turn timing.
      slowNotice.finish("stopped");
      cancelAssistantFlush();
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
      }
      // Before the next queued turn may start, every message this turn held is
      // resolved from the server's record: joined, or back in the queue.
      await settleLiveTurn();
    }
  };

  runAgentTurnRef.current = runAgentTurn;

  // One retry after the unlock a chat-key refusal asked for, and only of the
  // message the person left untouched in the composer.
  useEffect(() => {
    const pending = pendingChatKeyRetryRef.current;
    if (!hasChatAccess || !pending) return;
    pendingChatKeyRetryRef.current = null;
    if (currentDraftRef.current.input.trim() !== pending.text) return;
    const pendingAttachments = pending.options.attachments ?? [];
    if (pendingAttachments.length) {
      // Retry only the paste the person left untouched in the composer.
      const pendingAttachmentText = pendingAttachments.map((item) => item.text).join("\n\n");
      if (currentDraftRef.current.attachment?.text !== pendingAttachmentText) return;
      setLongPromptAttachment(null);
    }
    setInput("");
    void runAgentTurnRef.current(pending.text, pending.options);
  }, [hasChatAccess]);

  /**
   * Follow-up turn that reports a specialist DelegateResult back to One.
   *
   * Modeled on runAgentTurn's stream-start path: it opens a normal assistant
   * turn (streaming bubble) with `delegateResult` set and no user `message`,
   * reusing the same SSE handlers so One's confirmation renders as a regular
   * assistant response. Used by the specialist directive card's confirm/cancel.
   */
  const sendDelegateResult = (result: DelegateResult) =>
    sendFollowUpTurn(result.detail || result.display || `The requested action ${result.status}.`);

  /**
   * A follow-up turn with no typed prompt: a specialist's result, or the
   * other person's answer to an information request sent from this chat.
   */
  const sendFollowUpTurn = async (
    message: string,
    extra: {
      consentContinuation?: AgentChatConsentContinuation;
      feedAttention?: { itemId: string };
      pkmContext?: string;
    } = {},
  ): Promise<FollowUpTurnResult> => {
    if (!hasChatAccess || !user?.uid) return "failed";
    const userId = user.uid;
    const token = getVaultOwnerToken();
    if (!token) {
      addErrorMessage("Vault access expired. Unlock again to continue.");
      return "failed";
    }
    const consentBundleId = extra.consentContinuation?.bundleId.toLowerCase();
    // A consent follow-up another device already continued is refused by the
    // server (409). That is a settled answer, not an error: the reply from the
    // other device replaces this bubble, with no error shown.
    let consentFailure: { reason: string; error?: unknown } | null = null;
    const settleConsentFailure = async (): Promise<FollowUpTurnResult> => {
      const failure = consentFailure;
      if (!failure || !consentBundleId) return "failed";
      const threadId = conversationIdRef.current;
      const key = vaultKeyRef.current;
      if (threadId && key && await continuedElsewhere({
        conversationId: threadId,
        bundleId: consentBundleId,
        vaultOwnerToken: token,
        vaultKey: key,
      })) {
        setMessages((current) => current.filter((item) => item.id !== assistantMessageId));
        clearAgentChatHistoryCache(userId);
        dispatchAgentChatHistoryInvalidated(userId);
        if (conversationIdRef.current === threadId) {
          void restoreConversationMessages(threadId, token, () => conversationIdRef.current === threadId)
            .catch(() => undefined);
        }
        return "continued_elsewhere";
      }
      updateMessage(assistantMessageId, (current) =>
        settleAssistantMessageError(current, failure.reason, failure.error),
      );
      return "failed";
    };

    const turnId = Date.now();
    const debugTurnId = `agent_delegate_${turnId}`;
    const assistantMessageId = `msg-${turnId}-assistant`;
    const { timestamp, sentAtMs } = stampNow();

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
      sentAtMs,
      status: "streaming",
      ...(consentBundleId ? { consentBundleId } : {}),
    });
    latestVisibleTurnIdRef.current = debugTurnId;
    setActiveToolCalls([]);
    setIsChatLoading(true);
    setIsStreaming(true);

    const streamAbortController = new AbortController();
    streamAbortControllerRef.current = streamAbortController;

    try {
      slowNotice.begin();
      const streamResult = await streamAgentChat({
        userId,
        message,
        ...(extra.consentContinuation ? { consentContinuation: extra.consentContinuation } : {}),
        ...(extra.feedAttention ? { feedAttention: extra.feedAttention } : {}),
        ...(extra.pkmContext ? { pkmContext: extra.pkmContext } : {}),
        conversationId: conversationIdRef.current,
        vaultOwnerToken: token,
        vaultKey: vaultKeyRef.current ?? "",
        loadConnectorConfigurations: async () => {
          if (!vaultKey) throw new Error("Unlock your vault to use connectors.");
          return (await loadCustomConnectorSnapshot({ userId, vaultKey, vaultOwnerToken: token }, true)).configurations;
        },
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
          onStreamHealth: (signal) => {
            if (streamAbortController.signal.aborted) return;
            slowNotice.signal(signal);
          },
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
            slowNotice.finish("answered");
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
            slowNotice.finish("failed");
            flushAssistantDelta();
            if (consentBundleId) {
              consentFailure ??= { reason: message };
            } else {
              updateMessage(assistantMessageId, (current) =>
                settleAssistantMessageError(current, message),
              );
            }
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
        return "failed";
      }
      flushAssistantDelta();
      if (streamResult.conversationId) {
        updateConversationId(streamResult.conversationId);
      }
      if (consentFailure) {
        setIsChatLoading(false);
        setIsStreaming(false);
        return await settleConsentFailure();
      }
      if (streamResult.detached) return "answered"; // settled-turn effect reloads the answer
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
      return "answered";
    } catch (error) {
      slowNotice.finish(streamAbortController.signal.aborted ? "stopped" : "failed");
      flushAssistantDelta();
      let result: FollowUpTurnResult = "failed";
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
        if (consentBundleId) {
          consentFailure ??= { reason: message, error };
          result = await settleConsentFailure();
        } else {
          updateMessage(assistantMessageId, (current) =>
            settleAssistantMessageError(current, message, error),
          );
        }
      }
      void loadConversationList(true).catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
      return result;
    } finally {
      slowNotice.finish("stopped");
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
    const { timestamp, sentAtMs } = stampNow();
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
      sentAtMs,
    };
    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "",
      timestamp,
      sentAtMs,
      status: "streaming",
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setActiveToolCalls([]);
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
            updateMessage(assistantMessageId, (current) =>
              settleAssistantMessageError(current, message),
            );
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
        updateMessage(assistantMessageId, (current) =>
          settleAssistantMessageError(current, message, error),
        );
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
      await operation.run(operation);
    });
  };

  const enqueueWorkspaceOperation = (operation: QueuedWorkspaceOperation) => {
    operationQueueRef.current.enqueue(operation);
    syncQueuedPrompts();
    void drainOperationQueue();
  };

  // ── Messages sent while One works ──────────────────────────────────────
  const updateQueuedPrompt = (
    id: string,
    update: (prompt: QueuedAgentPrompt) => QueuedAgentPrompt,
  ) => {
    operationQueueRef.current.replace(
      operationQueueRef.current.snapshot().map((operation) =>
        operation.prompt?.id === id
          ? { ...operation, prompt: update(operation.prompt) }
          : operation,
      ),
    );
    syncQueuedPrompts();
  };

  const setQueuedPlacement = (ids: readonly string[], placement: "waiting" | "joining") => {
    for (const id of ids) updateQueuedPrompt(id, (prompt) => ({ ...prompt, placement }));
  };

  /** Joined messages leave the queue and show above the reply they joined. */
  const landJoinedPrompts = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const landed = operationQueueRef.current
      .snapshot()
      .flatMap((operation) =>
        operation.prompt && wanted.has(operation.prompt.id) ? [operation.prompt] : [],
      );
    operationQueueRef.current.replace(
      operationQueueRef.current
        .snapshot()
        .filter((operation) => !operation.prompt || !wanted.has(operation.prompt.id)),
    );
    syncQueuedPrompts();
    if (editingQueuedPromptId && wanted.has(editingQueuedPromptId)) {
      setEditingQueuedPromptId(null);
      setEditingQueuedPromptText("");
    }
    if (landed.length === 0) return;
    const anchorId = liveAssistantMessageIdRef.current;
    const bubbles: AgentMessage[] = landed.map((prompt) => ({
      id: `msg-queued-${prompt.id}`,
      role: "user",
      text: prompt.text,
      ...stampNow(),
      status: "done",
      queuedPlacement: "joined",
    }));
    setMessages((current) => {
      const index = anchorId ? current.findIndex((message) => message.id === anchorId) : -1;
      return index < 0
        ? [...current, ...bubbles]
        : [...current.slice(0, index), ...bubbles, ...current.slice(index)];
    });
  };

  /**
   * Offer waiting messages to the running turn, oldest first, one request at a
   * time so the server receives them in queue order. A message may join only
   * when every message ahead of it is joining too; otherwise it would overtake
   * one that must wait for its own turn.
   */
  const offerQueuedPromptsToLiveTurn = () => {
    const queue = liveTurnQueueRef.current;
    if (!queue) return;
    queuedOfferChainRef.current = queuedOfferChainRef.current.then(async () => {
      for (const operation of [...operationQueueRef.current.snapshot()]) {
        const prompt = operation.prompt;
        if (!prompt) return;
        if (prompt.placement === "joining") continue;
        if (!canJoinAgentTurn(prompt) || queue.liveConversationId === null) return;
        if (queue.liveConversationId !== conversationIdRef.current) return;
        const placement = await queue.offer(prompt.id, prompt.text);
        if (placement !== "joining") return;
        setQueuedPlacement([prompt.id], "joining");
      }
    }).catch(() => undefined);
  };

  const enqueuePrompt = (
    textInput: string,
    personSelectionHandle?: string,
    options: Pick<
      AgentRunTurnOptions,
      "deferPkmContext" | "driveSearchSelection" | "attachments"
    > = {},
  ) => {
    const text = textInput.trim();
    const attachments = options.attachments ?? [];
    if (!text && attachments.length === 0) return;
    const prompt: QueuedAgentPrompt = {
      id: crypto.randomUUID(),
      text,
      ...(attachments.length ? { attachments } : {}),
      createdAtMs: Date.now(),
      deferPkmContext: options.deferPkmContext,
      driveSearchSelection: options.driveSearchSelection,
      gmailInformationRequestWorkflowId: gmailKycReplyRequest?.workflow_id,
      // A reply that supplies details One asked for confirms the restricted
      // save. Once a draft is on screen, a follow-up revises that draft
      // instead ("remove the account number"), so it confirms no save.
      kycInformationSaveConfirmed:
        Boolean(gmailKycReplyRequest?.workflow_id) && !emailDraftOpen,
      // Plain typed text only; a picker choice carries its own authority.
      joinable: hasChatAccess && !personSelectionHandle,
      placement: "waiting",
    };
    const operation: QueuedWorkspaceOperation = {
      id: prompt.id,
      prompt,
      run: async (dequeued) => {
        const current = dequeued.prompt ?? prompt;
        if (hasChatAccess) {
          // One is still finishing a turn the app left: queue behind it and its
          // reload rather than start a second run in the same conversation.
          await waitForWatchedAgentTurn(user?.uid, conversationIdRef.current);
          await reattachRestoreRef.current;
          // A disconnected stream can end before a drained message finishes
          // sealing. Never start another turn until its receipt is terminal.
          await queuedSettlementGateRef.current?.promise;
          // This prompt and any plain messages queued right behind it go out
          // together as one turn, in order.
          const head = operationQueueRef.current.snapshot();
          if (canJoinAgentTurn(current)) {
            const { taken, rest } = takeJoinableRun(head);
            operationQueueRef.current.replace(rest);
            syncQueuedPrompts();
            const together = [current, ...taken.flatMap((item) => (item.prompt ? [item.prompt] : []))];
            await runAgentTurn(combineQueuedPromptText(together), {
              source: "typed",
              deferPkmContext: together.some((item) => item.deferPkmContext),
              ...(together.length > 1 ? { queuedPrompts: together } : {}),
            });
            return;
          }
          await runAgentTurn(current.text, {
            source: "typed",
            personSelectionHandle,
            attachments: current.attachments,
            deferPkmContext: current.deferPkmContext,
            driveSearchSelection: current.driveSearchSelection,
            gmailInformationRequestWorkflowId: current.gmailInformationRequestWorkflowId,
            kycInformationSaveConfirmed: current.kycInformationSaveConfirmed,
          });
          return;
        }
        // The pre-vault intro tier has no attachment channel; it reads the
        // whole turn as text, exactly as before.
        await runIntroTurn(
          composeTurnSourceText(current.text, current.attachments ?? []),
        );
      },
    };
    enqueueWorkspaceOperation(operation);
    offerQueuedPromptsToLiveTurn();
  };

  /** The turn ended: resolve what it held, exactly once, before anything else is sent. */
  const settleLiveTurn = async () => {
    const queue = liveTurnQueueRef.current;
    stopActiveTurnRef.current = null;
    setStoppableTurn(false);
    if (!queue) return;
    queue.stopAccepting();
    await queuedOfferChainRef.current;
    const { joined, waiting, unresolved } = await queue.settle();
    landJoinedPrompts(joined);
    if (waiting.length) setQueuedPlacement(waiting, "waiting");
    if (unresolved?.length) {
      setQueuedDeliveryUnconfirmed(true);
      return;
    }
    setQueuedDeliveryUnconfirmed(false);
    queuedSettlementGateRef.current?.release();
    queuedSettlementGateRef.current = null;
  };

  const recheckQueuedDelivery = async () => {
    const queue = liveTurnQueueRef.current;
    if (!queue || queuedDeliveryChecking) return;
    setQueuedDeliveryChecking(true);
    try {
      const { joined, waiting, unresolved } = await queue.settle();
      landJoinedPrompts(joined);
      if (waiting.length) setQueuedPlacement(waiting, "waiting");
      if (unresolved?.length) {
        toast.info("Delivery is still unconfirmed. Your message has not been sent again.");
        return;
      }
      setQueuedDeliveryUnconfirmed(false);
      queuedSettlementGateRef.current?.release();
      queuedSettlementGateRef.current = null;
    } finally {
      setQueuedDeliveryChecking(false);
    }
  };

  /** Take a message back from the running turn before it joins. */
  const reclaimQueuedPrompt = async (id: string): Promise<boolean> => {
    const queue = liveTurnQueueRef.current;
    if (!queue?.holds(id)) return true;
    const outcome = await queue.withdraw(id);
    if (outcome === "joined") {
      landJoinedPrompts([id]);
      return false;
    }
    return outcome === "withdrawn";
  };

  const editQueuedPrompt = async (id: string, textInput: string) => {
    const text = textInput.trim();
    if (!text) return;
    if (detectLikelyPan(text)) {
      // An edit is screened like a fresh message: the guard blocks it and
      // opens the secure form; the queued message keeps its previous text.
      enqueueGuardedTurn({ typedText: text, attachments: [], fromPaste: false });
      setEditingQueuedPromptId(null);
      setEditingQueuedPromptText("");
      return;
    }
    const held = liveTurnQueueRef.current?.holds(id) ?? false;
    if (!(await reclaimQueuedPrompt(id))) return;
    // A withdrawn id is spent on the server, so the edited message is new.
    const nextId = held ? crypto.randomUUID() : id;
    operationQueueRef.current.replace(
      operationQueueRef.current.snapshot().map((operation) =>
        operation.prompt?.id === id
          ? {
              ...operation,
              id: nextId,
              prompt: {
                ...operation.prompt,
                id: nextId,
                text,
                // As editQueuedAgentPrompt: a revised intent re-picks its file.
                driveSearchSelection: undefined,
                placement: "waiting" as const,
              },
            }
          : operation,
      ),
    );
    setQueuedPrompts((current) =>
      editQueuedAgentPrompt(current, id, text).map((prompt) =>
        prompt.id === id ? { ...prompt, id: nextId } : prompt,
      ),
    );
    setEditingQueuedPromptId(null);
    setEditingQueuedPromptText("");
    offerQueuedPromptsToLiveTurn();
  };

  const removeQueuedPrompt = async (id: string) => {
    if (!(await reclaimQueuedPrompt(id))) return;
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

  // One confirmed, server-persisted proposal at a time per proposal id:
  // echo the owner's choice, show progress, then the service's outcome.
  const enqueueReviewedDirective = (
    directive: SpecialistDirectiveEvent,
    options: {
      scope: "calendar" | "gmail-mailbox";
      pendingText: string;
      doneText: string;
      failedText: string;
      run: () => Promise<DelegateResult>;
    },
  ) => {
    const payload = directive.directive.payload as Record<string, unknown>;
    const actionKey = `${options.scope}:${String(
      payload.proposalId ?? payload.id ?? directive.message,
    )}`;
    if (calendarActionIdsRef.current.has(actionKey)) return;
    calendarActionIdsRef.current.add(actionKey);
    const label = String(payload.confirmLabel ?? "Confirm");
    const resultMessageId = `msg-${crypto.randomUUID()}-${options.scope}-result`;

    appendMessage({
      id: `msg-${crypto.randomUUID()}-${options.scope}-confirm`,
      role: "user",
      text: label,
      ...stampNow(),
      status: "done",
      kind: "selection",
    });
    appendMessage({
      id: resultMessageId,
      role: "assistant",
      text: options.pendingText,
      ...stampNow(),
      status: "streaming",
      renderAsPlainAssistantMessage: true,
    });
    setPendingSpecialistDirective(null);
    setSpecialistBusy(true);

    enqueueWorkspaceOperation({
      id: actionKey.replace(":", "-"),
      run: async () => {
        try {
          const result = await options.run();
          updateMessage(resultMessageId, (message) => ({
            ...message,
            text: result.detail || options.doneText,
            status: "done",
          }));
        } catch (error) {
          updateMessage(resultMessageId, (message) => ({
            ...message,
            text: error instanceof Error ? error.message : options.failedText,
            status: "error",
          }));
        } finally {
          calendarActionIdsRef.current.delete(actionKey);
          setSpecialistBusy(false);
        }
      },
    });
  };

  const enqueueCalendarDirective = (
    directive: SpecialistDirectiveEvent,
    token: string,
    userId: string,
  ) =>
    enqueueReviewedDirective(directive, {
      scope: "calendar",
      pendingText: "Scheduling…",
      doneText: "Calendar updated.",
      failedText: "The Calendar change could not be completed.",
      run: () => runCalendarDirective(directive.directive, token, userId),
    });

  const enqueueGmailMailboxDirective = (
    directive: SpecialistDirectiveEvent,
    auth: { firebaseIdToken: string; vaultOwnerToken: string },
  ) => {
    const payload = directive.directive.payload as Record<string, unknown>;
    const action = gmailMailboxAction(payload);
    enqueueReviewedDirective(directive, {
      scope: "gmail-mailbox",
      pendingText: action ? GMAIL_MAILBOX_ACTION_COPY[action].pending : "Updating Gmail…",
      doneText: "Gmail updated.",
      failedText: "The Gmail change could not be completed.",
      run: () => runGmailMailboxDirective(directive.directive, auth),
    });
  };

  // --- Requests this conversation sent: durable waiting and access ended ---
  // Rebuilt from the conversation itself on every load, so a reload, a cold
  // start or a second device never loses a request that is still waiting.
  const [consentLedger, setConsentLedger] = useState<{
    conversationId: string;
    continued: Record<string, string>;
  } | null>(null);
  const [liveBundleOutcomes, setLiveBundleOutcomes] = useState<Record<string, ConsentOutcome | null>>({});
  const outgoingRequestCards = useMemo(() => collectOutgoingRequestCards(messages), [messages]);
  const outgoingRequestCardsRef = useRef(outgoingRequestCards);
  outgoingRequestCardsRef.current = outgoingRequestCards;
  const outgoingRequestKey = outgoingRequestCards.map((card) => card.bundleId).join(",");
  const continuedOutcomes = consentLedger && consentLedger.conversationId === conversationId
    ? consentLedger.continued
    : EMPTY_CONSENT_OUTCOMES;

  useEffect(() => {
    const ownerId = user?.uid;
    const threadId = conversationId;
    const token = vaultOwnerToken;
    const key = vaultKey;
    if (!hasChatAccess || !ownerId || !threadId || !token || !key || !outgoingRequestKey) return;
    let active = true;
    void getAgentChatConsentOutcomes({ conversationId: threadId, vaultOwnerToken: token, vaultKey: key })
      .then((continued) => {
        if (!active) return;
        setConsentLedger({ conversationId: threadId, continued });
        // Every card whose answer this conversation has not continued waits
        // again: the doorbell finds an answer that landed while the app was
        // closed, and the card continues it once (the server marker holds).
        for (const request of rebuildWaitingRequests({
          ownerId,
          conversationId: threadId,
          cards: outgoingRequestCardsRef.current,
          continued,
        })) {
          watchSentInformationRequest(request);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [conversationId, hasChatAccess, outgoingRequestKey, user?.uid, vaultKey, vaultOwnerToken]);

  // Each outgoing card reads "Reading…" then "Answered" from the continuation.
  const consentCardPhaseFor = useInformationRequestPhaseReader(user?.uid);

  const consentTags = useMemo(() => tagConsentContinuationMessages({
    messages,
    cards: outgoingRequestCards,
    continued: continuedOutcomes,
  }), [continuedOutcomes, messages, outgoingRequestCards]);
  const sharedAnswerBundleKey = useMemo(() => [...new Set(
    [...consentTags.values()]
      .filter((tag) => tag.role === "answer" && isSharedOutcome(tag.continuedOutcome))
      .map((tag) => tag.bundleId),
  )].sort().join(","), [consentTags]);

  // Shared access this chat answered from, while it is still live. Ended
  // access leaves the watch; its answers already read "Access ended".
  const watchedAccessBundleKey = useMemo(() => sharedAnswerBundleKey
    .split(",")
    .filter((bundleId) => bundleId && !isAccessEndedOutcome(liveBundleOutcomes[bundleId]))
    .join(","), [liveBundleOutcomes, sharedAnswerBundleKey]);

  // Read by the access watch when sharing ends, without re-arming it.
  const continuedOutcomesRef = useRef(continuedOutcomes);
  useEffect(() => {
    continuedOutcomesRef.current = continuedOutcomes;
  }, [continuedOutcomes]);
  const liveBundleOutcomesRef = useRef(liveBundleOutcomes);
  useEffect(() => {
    liveBundleOutcomesRef.current = liveBundleOutcomes;
  }, [liveBundleOutcomes]);

  // Sharing ended: hide every answer One gave while it was live, now, not at
  // the next reload. Tag them here by the server's own rule, then bring the
  // server's redaction flags in so this chat and a reload agree.
  const hideAnswersFromEndedAccess = useCallback((bundleId: string, token: string) => {
    setMessages((current) => tagAnswersFromLiveAccess({
      messages: current,
      bundleId,
      tags: tagConsentContinuationMessages({
        messages: current,
        cards: collectOutgoingRequestCards(current),
        continued: continuedOutcomesRef.current,
      }),
      // Another request's access that is still live bounds what this one hides.
      liveOutcomes: liveBundleOutcomesRef.current,
    }));
    const ownerId = user?.uid;
    const threadId = conversationIdRef.current;
    const key = vaultKeyRef.current;
    if (!ownerId || !threadId || !key) return;
    void loadAgentChatConversationHistory({
      userId: ownerId,
      conversationId: threadId,
      vaultOwnerToken: token,
      vaultKey: key,
      force: true,
    }).then((history) => {
      if (conversationIdRef.current !== threadId) return;
      const server = storedMessagesToAgentMessages(history);
      setMessages((current) => mergeServerRedactionFlags(current, server));
    }).catch(() => undefined);
  }, [user?.uid]);

  // Answers from shared information: watch that access while it is live,
  // through the one app-wide live-access watch (about 5s for a minute after
  // the answer, then 10s, while visible, and at once on a push, a live event
  // or a return to the app). This chat reads each reading of those bundles,
  // whoever made it, so a bundle the card also shows is read once per tick.
  // A stop or a lapse hides every answer from it and ends the card within
  // seconds. Decrypted information itself is never kept past its turn.
  useEffect(() => {
    const token = vaultOwnerToken;
    if (!hasChatAccess || !token || !watchedAccessBundleKey) return;
    const bundles = watchedAccessBundleKey.split(",");
    let active = true;
    const onReading = (bundleId: string) => (bundle: InformationRequestBundle) => {
      if (!active || bundle.bundleId.toLowerCase() !== bundleId) return;
      const outcome = informationRequestOutcome(bundle);
      let changed = false;
      setLiveBundleOutcomes((current) => {
        if (current[bundleId] === outcome) return current;
        changed = true;
        return { ...current, [bundleId]: outcome };
      });
      // The card for this request reads its own status: tell it now,
      // so it turns to "Access ended" with the answers, not later.
      // Idempotent, and an ended bundle leaves the watch, so this runs
      // once per stop without depending on when the updater above ran.
      if (isAccessEndedOutcome(outcome)) hideAnswersFromEndedAccess(bundleId, token);
      if (changed && isAccessEndedOutcome(outcome)) {
        dispatchConsentStateChanged({
          source: "information_request_updated",
          origin: "chat_access_watch",
          bundleId,
          requestId: bundle.items[0]?.requestId ?? "",
          action: outcome === "expired" ? "TIMEOUT" : "CONSENT_REVOKED",
        });
      }
    };
    const releases = bundles.flatMap((bundleId) => [
      subscribeInformationRequest(bundleId, onReading(bundleId)),
      watchLiveAccess({ bundleId, vaultOwnerToken: token }),
    ]);
    const onConsentChanged = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail?.origin === "chat_access_watch") return;
      const bundleId = String(detail?.bundleId || "").toLowerCase();
      // A push or live event about one of these requests, or a consent change
      // that names none: check now and return to the fast cadence.
      if (!bundleId || bundles.includes(bundleId)) wakeLiveAccessWatch();
    };
    // A chat that opens on a live answer checks it at once.
    wakeLiveAccessWatch();
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
    return () => {
      active = false;
      releases.forEach((release) => release());
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
    };
  }, [hasChatAccess, hideAnswersFromEndedAccess, watchedAccessBundleKey, vaultOwnerToken]);

  // One Send per ask: while an ask card (or the card it became) is on screen
  // for that person, a staged "Request someone's information" bar would be a
  // second, duplicate send affordance.
  const pendingAppActionDuplicatesAskCard = useMemo(() => Boolean(pendingAppAction)
    && consentRequestDirectiveDuplicatesAskCard({
      actionId: pendingAppAction?.event.actionId,
      slots: pendingAppAction?.event.slots,
      messages,
    }), [messages, pendingAppAction]);

  const redactedAnswerIds = useMemo(() => redactedConsentAnswers({
    tags: consentTags,
    liveOutcomes: liveBundleOutcomes,
    serverRedacted: new Set(messages
      .filter((message) => message.consentAccessEnded || message.consentAccess?.state === "ended")
      .map((message) => message.id)),
  }), [consentTags, liveBundleOutcomes, messages]);

  const outgoingRequestCardFor = (messageId: string) => {
    const tag = consentTags.get(messageId);
    return tag ? outgoingRequestCards.find((card) => card.bundleId === tag.bundleId) ?? null : null;
  };

  // The server's names and labels win (they survive a conversation that no
  // longer holds the card); the card this chat sent fills any gap.
  const accessEndedNoticeFor = (message: AgentMessage) => {
    const access = message.consentAccess;
    const card = outgoingRequestCardFor(message.id);
    const bundleId = (access?.bundleId ?? consentTags.get(message.id)?.bundleId ?? "").toLowerCase();
    const live = bundleId ? liveBundleOutcomes[bundleId] : null;
    return {
      personName: access?.personName || card?.personName || "",
      labels: access?.labels.length ? access.labels : card?.labels ?? [],
      reason: access?.outcome ?? (live === "expired" ? "expired" as const : "revoked" as const),
    };
  };

  // A shared chip whose sharing has since stopped or run out.
  const consentChipEnded = (message: AgentMessage): boolean => {
    const tag = consentTags.get(message.id);
    const live = tag ? liveBundleOutcomes[tag.bundleId] : null;
    return tag?.role === "chip" && isSharedOutcome(tag.continuedOutcome)
      && (isAccessEndedOutcome(live) || Boolean(message.consentAccessEnded));
  };

  // What a consent chip reports, so a decline draws the neutral mark, never
  // the check (localhost run 4, R6). A chip no card claimed still carries the
  // server's fixed label, which names its outcome.
  const consentChipOutcome = (message: AgentMessage) => {
    const tag = consentTags.get(message.id);
    if (tag?.role === "chip") return tag.continuedOutcome;
    return wireOutcomeForSentLabel(message.text.trim());
  };

  const consentChipLabel = (message: AgentMessage): string => {
    const tag = consentTags.get(message.id);
    const card = outgoingRequestCardFor(message.id);
    // Once that sharing ends, the chip says so too, beside answers that now
    // read "Access ended" ("Kushal stopped sharing Food preferences").
    const live = tag ? liveBundleOutcomes[tag.bundleId] : null;
    if (consentChipEnded(message)) {
      return consentAccessEndedChipText({
        reason: live === "expired" ? "expired" : "revoked",
        personName: card?.personName ? personFirstName(card.personName) : null,
        sharedLabels: card?.labels,
      });
    }
    if (message.consentChipText) return message.consentChipText;
    if (!tag || tag.role !== "chip") return message.text;
    return consentOutcomeDisplayText({
      outcome: tag.continuedOutcome,
      personName: card?.personName ? personFirstName(card.personName) : null,
      sharedLabels: card?.labels,
    });
  };

  // The other person answered a request this chat sent: the card reads
  // "reading" at once, a chip says what happened in words ("Kushal shared
  // Food preferences"), and One answers from it in view. The turn itself
  // sends the server's fixed label, which admission requires.
  const continueWithConsentOutcome: AgentConsentContinuationHandler["continueWithOutcome"] = async (input) => {
    const token = getVaultOwnerToken();
    const key = vaultKeyRef.current;
    const ownerId = user?.uid;
    if (!hasChatAccess || !ownerId || !token || !key) return false;
    setInformationRequestPhase(ownerId, input.bundleId, "reading");
    let prepared: Awaited<ReturnType<typeof prepareConsentContinuation>>;
    try {
      prepared = await prepareConsentContinuation({
        userId: ownerId,
        vaultKey: key,
        vaultOwnerToken: token,
        ...input,
      });
    } catch (error) {
      setInformationRequestPhase(ownerId, input.bundleId, null);
      throw error;
    }
    if (!prepared) {
      setInformationRequestPhase(ownerId, input.bundleId, null);
      return false;
    }
    const sent = prepared;
    const bundleId = input.bundleId.toLowerCase();
    revealConsentContinuationReply({
      userScrolled: transcriptUserScrollRef,
      scrollToSubmittedTurn: scrollToSubmittedTurnRef,
    });
    setMessages((current) => {
      const card = collectOutgoingRequestCards(current).find((entry) => entry.bundleId === bundleId);
      return [...current, {
        id: `msg-${crypto.randomUUID()}-consent-outcome`,
        role: "user",
        text: sent.message,
        consentBundleId: bundleId,
        consentChipText: consentOutcomeDisplayText({
          outcome: input.outcome,
          personName: card?.personName ? personFirstName(card.personName) : null,
          sharedLabels: sent.sharedLabels.length ? sent.sharedLabels : card?.labels,
        }),
        ...stampNow(),
        status: "done",
        kind: "selection",
      }];
    });
    enqueueWorkspaceOperation({
      id: `consent-${input.bundleId}`,
      run: async () => {
        revealConsentContinuationReply({
          userScrolled: transcriptUserScrollRef,
          scrollToSubmittedTurn: scrollToSubmittedTurnRef,
        });
        const settled = await sendFollowUpTurn(sent.message, { consentContinuation: sent.continuation });
        setInformationRequestPhase(ownerId, input.bundleId, settled === "failed" ? null : "answered");
      },
    });
    return true;
  };

  // "One has something for you": a fresh chat, the fixed status chip, then One
  // writes its message about that one update, grounded in it and in memory.
  useFeedAttentionTurn({
    ownerId: user?.uid ?? null,
    ready: hasChatAccess && Boolean(vaultKey),
    start: (itemId) => {
      // Same as a handoff: One is speaking, never behind the on-device Puppy
      // header, and the first history load must not replace this chat.
      setAgentSurface("one");
      const shouldSkipInitialHistoryLoad = historyLoadKeyRef.current === null;
      handleCreateNewChat();
      skipInitialHistoryLoadRef.current = shouldSkipInitialHistoryLoad;
      appendMessage({
        id: `msg-${crypto.randomUUID()}-feed-attention`,
        role: "user",
        text: FEED_ATTENTION_LABEL,
        ...stampNow(),
        status: "done",
        kind: "selection",
      });
      enqueueWorkspaceOperation({
        id: `feed-attention-${itemId}`,
        run: async () => {
          const userId = user?.uid;
          const token = getVaultOwnerToken();
          const key = vaultKeyRef.current;
          const memory = userId && token && key
            ? await loadAgentPkmContext({ userId, vaultOwnerToken: token, vaultKey: key, message: FEED_ATTENTION_LABEL })
              .catch(() => EMPTY_PKM_CONTEXT)
            : EMPTY_PKM_CONTEXT;
          await sendFollowUpTurn(FEED_ATTENTION_LABEL, {
            feedAttention: { itemId },
            pkmContext: memory.text || undefined,
          });
        },
      });
    },
  });

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
    // An opened attachment is edited in the composer itself, so the editor
    // text IS the attachment; otherwise the composer holds the typed message.
    const attachmentText = attachment?.isExpanded ? draftText : attachment?.text ?? null;
    const typedText = attachment?.isExpanded ? "" : draftText;
    if ((!typedText.trim() && !attachmentText?.trim()) || isVoiceConnecting || voiceActive) {
      return;
    }
    // Only after the person chose "Something else" for their name, and only
    // when it is name-shaped; anything else is an ordinary turn to One.
    if (!attachment && chatOnboarding.captureComposerText(typedText)) {
      setInput("");
      return;
    }
    // Enter (form submit) and the Send button both land here, so both bring
    // One's pending turn into view. The button used to call this directly
    // and skip the marking, which lived only in the form's submit handler.
    transcriptUserScrollRef.current = false;
    scrollToSubmittedTurnRef.current = true;
    const selectedDriveFile = pendingDriveSearchSelectionRef.current;
    const driveSearchSelection = selectedDriveFile &&
      selectedDriveFile.ownerUid === user?.uid && isVaultUnlocked &&
      isVaultSessionEpochCurrent(selectedDriveFile.vaultEpoch)
      ? { jobId: selectedDriveFile.jobId, position: selectedDriveFile.position }
      : undefined;
    setInput("");
    pendingDriveSearchSelectionRef.current = null;
    setPendingDriveSearchSelection(null);
    generatedDriveSearchDraftRef.current = false;
    setLongPromptAttachment(null);
    setComposerExpanded(false);
    enqueueGuardedTurn({
      typedText,
      // The paste leaves as its own attachment part: a chip in the transcript
      // and a separate document for One, never text folded into the message.
      attachments: attachmentText?.trim()
        ? [createAgentTextAttachment(attachmentText.trimEnd())]
        : [],
      fromPaste: attachment !== null,
      driveSearchSelection,
    });
  };

  /**
   * The card-number guard and the queue, shared by the composer and by
   * "Edit and send again" on a sent paste, so an edited copy is screened
   * exactly like a fresh one.
   */
  const enqueueGuardedTurn = ({
    typedText,
    attachments,
    fromPaste,
    driveSearchSelection,
  }: {
    typedText: string;
    attachments: AgentTextAttachment[];
    fromPaste: boolean;
    driveSearchSelection?: AgentRunTurnOptions["driveSearchSelection"];
  }) => {
    // A large paste is a dedicated browser-memory import lane. Redact payment
    // card numbers before the text can enter Chat, history, telemetry, or the
    // guarded background PKM proposal flow; ordinary typed PAN input remains a
    // hard block and is routed to the secure card form.
    const redactPaste =
      fromPaste &&
      detectLikelyPan([typedText, ...attachments.map((item) => item.text)].join("\n\n"));
    const submittedText = redactPaste ? redactLikelyPans(typedText) : typedText;
    const submittedAttachments = redactPaste
      ? attachments.map((item) => createAgentTextAttachment(redactLikelyPans(item.text), item.name))
      : attachments;
    if (
      detectLikelyPan(submittedText) ||
      submittedAttachments.some((item) => detectLikelyPan(item.text))
    ) {
      appendMessage({
        id: `msg-${Date.now()}-pan-blocked`,
        role: "assistant",
        text: "That looked like a full card number, so it was blocked on this device and never sent. Use the secure form to save a card.",
        ...stampNow(),
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
    enqueuePrompt(submittedText, undefined, {
      deferPkmContext: fromPaste,
      driveSearchSelection,
      attachments: submittedAttachments,
    });
  };

  /** A sent message stays as it was; its edited paste goes out as a new turn. */
  const resendTextAttachment = (message: AgentMessage, index: number, editedText: string) => {
    if (isVoiceConnecting || voiceActive) return false;
    const attachments = replaceTextAttachmentForResend(message.attachments ?? [], index, editedText);
    if (!attachments) return false;
    transcriptUserScrollRef.current = false;
    scrollToSubmittedTurnRef.current = true;
    enqueueGuardedTurn({ typedText: message.text, attachments, fromPaste: true });
    return true;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitComposerText();
  };

  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!shouldCaptureLargePaste(pasted)) return;
    event.preventDefault();
    if (longPromptAttachment?.isExpanded) {
      // The opened editor is the attachment itself: paste in place.
      const nextText = mergePastedText({
        currentText: input,
        pastedText: pasted,
        selectionStart: event.currentTarget.selectionStart,
        selectionEnd: event.currentTarget.selectionEnd,
      });
      setLongPromptAttachment(createPendingTextAttachment(nextText));
      setInput("");
      setComposerExpanded(false);
      return;
    }
    // What the person typed stays their message; the paste joins the
    // attachment, so the sent bubble shows their words beside the chip.
    const nextText = combineAttachmentAndComposerText({
      attachmentText: pasted,
      composerText: longPromptAttachment?.text ?? "",
    });
    setLongPromptAttachment(createPendingTextAttachment(nextText));
    setComposerExpanded(false);
  };

  const editLongPromptAttachment = (text: string) => {
    // An edit that empties the paste removes it; the typed message stays.
    if (!text.trim()) {
      setLongPromptAttachment(null);
      return;
    }
    setLongPromptAttachment(createPendingTextAttachment(text));
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
  const hasStartedConversation = messages.some(
    (message) => message.id !== "agent-greeting",
  );
  const visibleMessages = dedupeAdjacentAgentMessages(
    messages.filter((message) => {
      if (message.id === "agent-greeting") return false;
      if (
        pendingSpecialistDirective &&
        message.role === "assistant" &&
        !message.text.trim() &&
        // An ended answer arrives with empty text and renders "Access ended".
        !message.consentAccessEnded
      ) {
        return false;
      }
      return true;
    }),
  );
  const visibleMessageIds = visibleMessages.map((message) => message.id);
  const renderChatOnboarding = (slot: Parameters<typeof ChatOnboardingTurns>[0]["slot"]) => (
    <ChatOnboardingTurns
      controller={chatOnboarding}
      slot={slot}
      renderBubble={(message: ChatOnboardingBubbleMessage) => (
        <>
          {timeSeparators.has(message.id) ? (
            <ChatTimeSeparatorRow separator={timeSeparators.get(message.id)!} />
          ) : null}
          <AgentBubble message={message} />
        </>
      )}
      onConnect={(action, trigger) =>
        action.kind === "connector"
          ? openConnectorSurface(action.provider, trigger)
          : router.push(action.href)
      }
    />
  );
  const trailingSpecialistLoadingMessages = pendingSpecialistDirective
    ? messages.filter(
        (message) =>
          message.id !== "agent-greeting" &&
          message.role === "assistant" &&
          !message.text.trim(),
      )
    : [];
  // One timeline in the order the transcript renders it (onboarding turns sit
  // between real messages by their anchors), so a group spans both kinds.
  const onboardingTimelineItem = (turn: { id: string }): ChatTimelineItem => ({
    id: turn.id,
    atMs: chatOnboarding.shownTurnTimes.get(turn.id) ?? null,
    label: chatOnboarding.shownTurns.get(turn.id) ?? null,
  });
  const timelineItems: ChatTimelineItem[] = [
    ...turnsForSlot(chatOnboarding.turns, { kind: "top" }).map(onboardingTimelineItem),
  ];
  for (const message of visibleMessages) {
    timelineItems.push(
      ...turnsForSlot(chatOnboarding.turns, {
        kind: "before",
        messageId: message.id,
        visibleMessageIds,
      }).map(onboardingTimelineItem),
      // No label fallback: a restored row without `created_at` was stamped
      // with the restore time, which is not when it was sent.
      { id: message.id, atMs: message.sentAtMs ?? null },
    );
  }
  timelineItems.push(
    ...turnsForSlot(chatOnboarding.turns, { kind: "end", visibleMessageIds }).map(
      onboardingTimelineItem,
    ),
    ...trailingSpecialistLoadingMessages.map((message) => ({
      id: message.id,
      atMs: message.sentAtMs ?? null,
    })),
  );
  const timeSeparators = computeChatTimeSeparators(timelineItems);
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
          key={`email-draft-${emailDraftAnchorMessageId ?? "standalone"}`}
          initialInstruction={emailDraftInstruction}
          initialDraft={emailDraftInitialValue}
          autoDraft={emailDraftAutoDraft}
          getAuth={getEmailDeliveryAuth}
          onRequireVault={() => setVaultDialogOpen(true)}
          onDismiss={closeEmailDraft}
          onSendStarted={handleEmailSendStarted}
          onSent={handleEmailSent}
          onSendFailed={handleEmailSendFailed}
          sourceBoundEnvelope={gmailKycEmailDraftEnvelope}
          onDraftChange={handleEmailDraftChange}
          onOpenConnections={openConnectorSurface}
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
                    const sourceBoundDraft = {
                      ...draft,
                      sourceWorkflowId: workflowId,
                    };
                    const prepared = await EmailDeliveryService.prepare({
                      firebaseIdToken,
                      vaultOwnerToken,
                      draft: {
                        ...sourceBoundDraft,
                        body,
                        htmlBody: draft.htmlBody ?? draft.body,
                      },
                      idempotencyKey,
                    });
                    const sent = await EmailDeliveryService.send({
                      firebaseIdToken,
                      vaultOwnerToken,
                      actionId: prepared.actionId,
                      draft: {
                        ...sourceBoundDraft,
                        body,
                        htmlBody: draft.htmlBody ?? draft.body,
                      },
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
        (message) =>
          message.role === "user" &&
          (message.text.trim().length > 0 || Boolean(message.attachments?.length)),
      );
    const retryText = previousUserMessage?.text.trim() ?? "";
    const retryAttachments = previousUserMessage?.attachments ?? [];
    if (!previousUserMessage) {
      toast.error("No previous message found to retry.");
      return;
    }
    // A failed answer after someone shared retries as that continuation. Sent
    // as a plain turn, the fixed label ("Consent approved") reached One with
    // nothing shared attached, was answered blind, and was saved as if the
    // person had typed it.
    const continuationRetry = previousUserMessage.kind === "selection"
      ? consentTags.get(previousUserMessage.id) ?? null
      : null;
    if (continuationRetry && wireOutcomeForSentLabel(previousUserMessage.text)) {
      const ownerId = user?.uid;
      const card = outgoingRequestCards.find((entry) => entry.bundleId === continuationRetry.bundleId);
      if (!ownerId || !card) {
        toast.info("Open the request card above to try again.");
        return;
      }
      setMessages((current) => current.filter((item) =>
        item.id !== messageId && item.id !== previousUserMessage.id));
      releaseConsentContinuation(ownerId, card.bundleId);
      if (!claimConsentContinuation(ownerId, card.bundleId)) return;
      void continueWithConsentOutcome({
        bundleId: card.bundleId,
        subjectRef: card.subjectRef,
        outcome: continuationRetry.continuedOutcome,
        domainFor: () => undefined,
      }).then((started) => {
        if (!started) releaseConsentContinuation(ownerId, card.bundleId);
      }).catch(() => releaseConsentContinuation(ownerId, card.bundleId));
      return;
    }
    setWalletWidgets([]);
    const lostTurn = messages[assistantIndex]?.lostTurn;
    const retryFromConversation = conversationIdRef.current;
    const stillInSameChat = () => conversationIdRef.current === retryFromConversation;
    // Pre-vault / anonymous turns go through the informational intro tier, which
    // runAgentTurn early-returns on (no vault access). Route the retry to the
    // same tier the original turn used so the button is not a no-op there.
    enqueueWorkspaceOperation({
      id: `retry-${crypto.randomUUID()}`,
      run: async () => {
        if (!hasChatAccess) {
          await runIntroTurn(composeTurnSourceText(retryText, retryAttachments));
          return;
        }
        // Only the stream was lost: the server may have finished and saved
        // this turn, or still be running it. Never run it a second time.
        const token = getVaultOwnerToken();
        const plan = await planLostTurnRetry({
          lostTurn, retryText, vaultOwnerToken: token, vaultKey: vaultKeyRef.current,
        });
        if (!stillInSameChat()) return;
        if (plan === "restore" && lostTurn && token && user?.uid) {
          dispatchAgentChatHistoryInvalidated(user.uid);
          await restoreConversationMessages(lostTurn.conversationId, token, stillInSameChat);
          return;
        }
        if (plan === "reattach" && lostTurn && user?.uid) {
          // The settled-turn effect reloads the saved answer in place.
          updateConversationId(lostTurn.conversationId);
          updateMessage(messageId, (message) => ({
            ...message,
            status: "streaming",
            errorNotice: undefined,
            lostTurn: undefined,
          }));
          setIsChatLoading(true);
          setIsStreaming(true);
          watchDetachedAgentTurn({
            ownerId: user.uid,
            conversationId: lostTurn.conversationId,
            startedAtMs: lostTurn.startedAtMs,
          });
          return;
        }
        await runAgentTurn(retryText, {
          source: "typed",
          appendUserMessage: false,
          replaceAssistantMessageId: messageId,
          attachments: retryAttachments,
        });
      },
    });
  };
  const handleWelcomePromptSelect = useCallback((prompt: string) => {
    pendingDriveSearchSelectionRef.current = null;
    setPendingDriveSearchSelection(null);
    generatedDriveSearchDraftRef.current = false;
    setInput(prompt);
    window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
  }, []);
  const toggleHistoryDrawer = useCallback(() => {
    const next = transitionConnectionsDrawer(
      { open: isHistoryDrawerOpen, mode: drawerMode },
      { type: "toggle-chats" },
    );
    setIsHistoryDrawerOpen(next.open);
    setDrawerMode(next.mode);
    if (next.mode === "chats") setConnectorPanelInitialConnector(null);
    if (next.open && !isPuppySurface)
      void loadConversationList().catch(() => undefined);
  }, [drawerMode, isHistoryDrawerOpen, isPuppySurface, loadConversationList]);
  // "N messages" (as in the reference): while the reader is scrolled up, a
  // pill above the composer counts the messages not yet fully in view below
  // and jumps back to the latest on a tap.
  const [messagesBelow, setMessagesBelow] = useState(0);
  const messagesBelowFrameRef = useRef<number | null>(null);
  const countMessagesBelow = useCallback(() => {
    messagesBelowFrameRef.current = null;
    const transcript = transcriptRef.current;
    if (!transcript || isPuppySurface) {
      setMessagesBelow(0);
      return;
    }
    const distanceFromBottom =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
    if (distanceFromBottom <= 96) {
      setMessagesBelow(0);
      return;
    }
    // The composer floats over the transcript, so "in view" ends at its top.
    const visibleBottom =
      composerStackRef.current?.getBoundingClientRect().top ??
      transcript.getBoundingClientRect().bottom;
    let count = 0;
    transcript.querySelectorAll<HTMLElement>("[data-message-role]").forEach((row) => {
      if (row.getBoundingClientRect().bottom > visibleBottom + 4) count += 1;
    });
    setMessagesBelow(count);
  }, [isPuppySurface]);
  const scheduleMessagesBelowCount = useCallback(() => {
    if (messagesBelowFrameRef.current !== null) return;
    messagesBelowFrameRef.current = window.requestAnimationFrame(countMessagesBelow);
  }, [countMessagesBelow]);
  useEffect(() => {
    scheduleMessagesBelowCount();
  }, [messages, chatOnboarding.turns.length, scheduleMessagesBelowCount]);
  useEffect(() => () => {
    if (messagesBelowFrameRef.current !== null)
      window.cancelAnimationFrame(messagesBelowFrameRef.current);
  }, []);
  const jumpToLatestMessage = useCallback(() => {
    const transcript = transcriptRef.current;
    const end = messagesEndRef.current;
    if (!transcript || !end) return;
    transcriptUserScrollRef.current = false;
    // Straight to the latest message in one step (founder direction,
    // 2026-09-29): a smooth scroll counted down "2 messages, 1 message" on the
    // way. The very end of the transcript is past the composer's band.
    const top = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    beginTranscriptProgrammaticScroll(top);
    transcript.scrollTo({ top, behavior: "instant" });
    setMessagesBelow(0);
  }, [beginTranscriptProgrammaticScroll]);
  // The transcript's bottom band tracks the composer's real height, so a
  // draft that grows to several lines never covers the last message. A
  // reader already at the end stays at the end while it grows.
  useEffect(() => {
    const stack = composerStackRef.current;
    const transcript = transcriptRef.current;
    if (!stack || !transcript || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      const atEnd =
        transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 24;
      transcript.style.setProperty(
        "--agent-chat-composer-stack-height",
        `${Math.ceil(stack.getBoundingClientRect().height)}px`,
      );
      if (atEnd) transcript.scrollTop = transcript.scrollHeight;
      scheduleMessagesBelowCount();
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [isPuppySurface, scheduleMessagesBelowCount]);
  const openGetApp = useCallback((trigger: HTMLButtonElement) => {
    // The drawer is modal at every width. Close it before raising the sheet.
    getAppReturnFocusRef.current =
      historyDrawerTriggerRef.current ?? historyDrawerFallbackRef.current ?? trigger;
    handleHistoryDrawerOpenChange(false);
    setGetAppOpen(true);
  }, [handleHistoryDrawerOpenChange]);
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
      // The drawer now runs full height over the chat header (2026-09-28), so the
      // header's hamburger-to-cross sits under the panel; the panel carries its
      // own close control instead of leaving a modal with no visible way out.
      hideCloseButton={false}
      surface={agentSurface}
      onClose={onClose}
      onToggleCollapsed={toggleHistoryDrawer}
      onOpenConnectors={!isPuppySurface
        ? (trigger) => openConnectorSurface(undefined, trigger)
        : undefined}
      onGetApp={offerGetApp ? openGetApp : undefined}
      getAppOpen={getAppOpen}
      driveActivity={!isPuppySurface
        ? <DriveRecentSharing presentation="sidebar" onNeedsReviewChange={onDriveNeedsReviewChange} /> : null}
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
      {stoppableTurn && (isStreaming || isChatLoading) && !canSend ? (
        // While One works, an empty composer offers Stop in Send's place; any
        // text turns it back into Send, which queues the message.
        <ShellActionSurface
          type="button"
          rippleEffect="fill"
          data-testid="agent-chat-stop-turn"
          className="border-transparent bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
          aria-label="Stop One"
          title="Stop One"
          onClick={() => {
            void stopActiveTurnRef.current?.();
          }}
        >
          <StopSquare className="h-3.5 w-3.5" />
        </ShellActionSurface>
      ) : (
      <ShellActionSurface
        type="submit"
        rippleEffect="fill"
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
      )}
    </>
  );

  const renderDriveMemoryReview = (message: AgentMessage) => {
    const experiences = [...(message.structuredExperiences || []).map(item => item.experience),
      ...(message.structuredExperience ? [message.structuredExperience] : [])];
    if (!hasChatAccess || !user?.uid || !vaultKey || !vaultOwnerToken || message.role !== "assistant" ||
      !canReviewDriveMemory(message.status, message.text, experiences)) return undefined;
    const ownerId = user.uid;
    const threadId = conversationId;
    return <DriveReadMemoryAction key={`${ownerId}:${message.id}:${vaultSessionEpoch}:${threadId || "draft"}`}
      ownerId={ownerId} vaultKey={vaultKey} vaultOwnerToken={vaultOwnerToken} answer={message.text}
      scopeId={`${threadId || "draft"}:${message.id}`} getCurrentToken={getVaultOwnerToken}
      isScopeCurrent={() => workspaceOwnerIdRef.current === ownerId && conversationIdRef.current === threadId &&
        vaultKeyRef.current === vaultKey && isAgentPkmProcessingReady(pkmCaptureReadinessRef.current, vaultOwnerToken)} />;
  };

  return (
    <div
      className={cn(
        "agent-chat-workspace flex min-h-0 w-full flex-col text-foreground",
        // Chat is the canonical root workspace. In canonical mode it spans full
        // height and manages its internal scroll streams and composer clearance.
        "min-h-[420px] overflow-hidden bg-[color:var(--one-chat-canvas)]",
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
      data-one-chat-surface
    >
      <AgentPersonSelectionContext.Provider value={hasChatAccess && !isStreaming
        ? (handle, name, sourceTool) => enqueuePrompt(personSelectionPrompt(sourceTool, name), handle)
        : null}>
      <CustomConnectorChatContext.Provider value={customConnectorChat}>
      <AgentConsentContinuationContext.Provider value={hasChatAccess
        ? { conversationId, continueWithOutcome: continueWithConsentOutcome }
        : null}>
      <ConsentCardPhaseContext.Provider value={consentCardPhaseFor}>
      <AgentTranscriptRevealContext.Provider value={revealInTranscript}>
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
          fallbackFocusRef={historyDrawerFallbackRef}
          open={isHistoryDrawerOpen}
          onOpenChange={handleHistoryDrawerOpenChange}
          mode={drawerMode}
          externalModalOpen={connectorExternalModalOpen}
          chats={renderHistorySidebar(
            "h-full w-full",
            () => handleHistoryDrawerOpenChange(false),
            false,
            "mobile",
          )}
          connections={
            <ConnectorsPanel
              open={isHistoryDrawerOpen && drawerMode === "connections"}
              initialConnector={connectorPanelInitialConnector}
              onBack={() => setDrawerMode("chats")}
              onClose={() => handleHistoryDrawerOpenChange(false)}
              onExternalModalChange={setConnectorExternalModalOpen}
              onPrepareRecovery={prepareDriveChatRecovery}
              onClearRecovery={clearPreparedDriveChatRecovery}
            />
          }
        />

        <section
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[color:var(--one-chat-canvas)]",
          )}
        >
          <div
            className={cn(
              "agent-chat-header relative z-[540] flex shrink-0 touch-pan-y items-center justify-between gap-3 bg-[color:var(--one-chat-canvas)] px-4 pt-[var(--agent-chat-header-safe-top)] sm:px-5",
              "h-[var(--agent-chat-header-height)] lg:px-6",
            )}
          >
            {/*
              Three flex regions, and only the middle one may give way:
              [history] [identity: flex-1, clips] [actions: shrink-0].
              The identity region used to share a group with the history
              button and carried no clip, so on a 390px phone the actions
              (then 281px, with a fixed-width picker slot) squeezed it below
              its own minimum and the brand tile painted under the One | Puppy
              toggle while the agent's name collapsed to zero width. Clipping
              the identity horizontally makes that overlap impossible by
              construction: whatever does not fit is cut at its own edge and
              truncates, it never slides under a control.
            */}
            {/* The same overlay drawer on every width keeps the transcript and
                fixed navigation in place. */}
            <ShellActionSurface
              variant="icon"
              ref={historyDrawerFallbackRef}
              onClick={(event) => {
                historyDrawerTriggerRef.current = event.currentTarget;
                toggleHistoryDrawer();
              }}
              aria-label={`${isHistoryDrawerOpen ? "Close chat history" : "Open chat history"}${driveReviewsPending > 0 && !isHistoryDrawerOpen
                ? `, ${driveReviewsPending} Drive ${driveReviewsPending === 1 ? "review needs" : "reviews need"} you` : ""}`}
              title={isHistoryDrawerOpen ? "Close chat history" : "Open chat history"}
              aria-expanded={isHistoryDrawerOpen}
              className="relative z-[540]"
            >
              <AnimatedMenuCrossIcon isOpen={isHistoryDrawerOpen} />
              {driveReviewsPending > 0 && !isHistoryDrawerOpen && !isPuppySurface ?
                <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 size-2 rounded-full bg-[color:var(--app-warning)]" /> : null}
            </ShellActionSurface>
            <div
              data-agent-chat-header-region="identity"
              className="flex min-w-0 flex-1 items-center gap-3 overflow-x-clip"
            >
              {/* Hidden on phones: the title beside it and the toggle's active
                  segment already say which agent is on screen, and the 48px
                  this tile costs is better spent on the agent's name. */}
              <div
                data-agent-chat-brand-tile
                className="grid h-9 w-9 shrink-0 place-items-center max-sm:hidden"
              >
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
                    className="hushh-brand-mark select-none text-[24px] leading-none"
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
                <ChatAgentSubtitle text={chatHeaderSubtitle({
                  isPuppySurface,
                  activeToolCalls,
                  statusText,
                })} working={activeToolCalls.length > 0 || isVisiblePkmMemoryWorking} brand={activeToolCalls.at(-1)?.brand} />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/*
                Order is picker, toggle, profile, and it is load-bearing. The
                toggle is anchored to the profile button at the right edge, so
                the picker appearing (its async load on every One mount) or
                disappearing (it is One-only) cannot slide the toggle out from
                under the thumb that just pressed it. That used to be held by a
                fixed-width slot reserved for the picker, which cost ~70px of
                dead space beside the toggle at every width and, on a phone,
                was the width that pushed the identity under the toggle.
              */}
              {/* One's model picker names the CLOUD model and writes One's
                  preference. In Puppy One it would assert a Gemini is running
                  on the owner's machine, and choosing an item would silently
                  rewrite the other agent's model with no visible consequence
                  on the screen being looked at. Gated, not merely hidden: the
                  write must not stay reachable from the on-device surface. */}
              {canPickOneModel && modelPreference && !isPuppySurface ? (
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
                    className="h-8 w-auto max-w-[7.5rem] shrink-0 gap-1 rounded-full border-0 bg-foreground/[0.045] px-2.5 text-[11px] font-medium text-muted-foreground sm:max-w-[9.5rem]"
                  >
                    {/* "3.7 Flash", not "Gemini 3.7 Flash": every option is a
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

                On a phone it is icon-only (cloud: One, laptop: Puppy), which
                takes it from 113px to 84px at the same h-8. Each segment keeps
                its spoken name through `accessibleLabel`, so hiding the visible
                word removes nothing from a screen reader.
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
                    icon: Cloud,
                    accessibleLabel: "One, your cloud agent",
                  },
                  {
                    value: "puppy",
                    label: "Puppy",
                    icon: Laptop,
                    accessibleLabel:
                      "Puppy One, on your machine, with its own conversation",
                  },
                ]}
                iconClassName="sm:hidden"
                labelClassName="max-sm:hidden"
                className="w-auto shrink-0"
              />
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

          {/* One's transcript region is hidden as a WHOLE, not just the
              scroller inside it. This wrapper is `flex-1` beside Puppy's own
              `flex-1` surface, so leaving it displayed while only its child
              went display:none made the empty box take half the column and
              Puppy One rendered at half height with its composer mid-screen. */}
          <div
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden",
              isPuppySurface && "hidden",
            )}
            inert={isHistoryDrawerOpen}
          >
            <div
              ref={transcriptRef}
              onScroll={(event) => {
                // A display:none element fires no scroll events, so this only
                // ever records One's own position; the guard is belt and braces.
                if (!isPuppySurface) scheduleMessagesBelowCount();
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

                  // A smooth jump after Send emits intermediate scroll events
                  // far from the bottom. They are not reader gestures.
                  if (transcriptProgrammaticScrollRef.current && scrollTop >= previousScrollTop - 2) {
                    const target = transcriptProgrammaticTargetRef.current;
                    if (target === null || Math.abs(scrollTop - Math.min(target, maxScrollTop)) <= 3)
                      clearTranscriptProgrammaticScroll();
                    return;
                  }

                  // When the reader scrolls up or moves noticeably away from the bottom,
                  // immediately clear any programmatic lock and mark active reader control.
                  if (scrollTop < previousScrollTop - 2 || distanceFromBottom > 64) {
                    clearTranscriptProgrammaticScroll();
                    transcriptUserScrollRef.current = true;
                  } else if (distanceFromBottom <= 16) {
                    // Re-enable following when the reader returns to the latest message
                    transcriptUserScrollRef.current = false;
                  }

                  // Stay in follow mode when the reader returns to the end;
                  // setting this to true unconditionally made subsequent
                  // streamed updates stop following after any scroll event.
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
                "pb-[calc(var(--agent-chat-composer-bottom,5rem)+max(5.5rem,var(--agent-chat-composer-stack-height,0px)+1.75rem))] lg:px-8",
              )}
              tabIndex={0}
              role="region"
              aria-label="Agent conversation history"
            >
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5">
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

              {chatOnboarding.turns.length ? (
                renderChatOnboarding({ kind: "top" })
              ) : !hasStartedConversation ? (
                <>
                  <AgentWelcomePanel
                    name={displayName}
                    prompts={welcomePrompts}
                    disabled={isChatLoading || isStreaming}
                    onPromptSelect={handleWelcomePromptSelect}
                  />
                  {chatOnboarding.dailyTip ? (
                    <ChatOnboardingDailyTip
                      tip={chatOnboarding.dailyTip}
                      onUse={handleWelcomePromptSelect}
                      onDismiss={chatOnboarding.dismissDailyTip}
                    />
                  ) : null}
                </>
              ) : null}

              {visibleMessages.map((message) => (
                <Fragment key={message.id}>
                  {renderChatOnboarding({ kind: "before", messageId: message.id, visibleMessageIds })}
                  {timeSeparators.has(message.id) ? (
                    <ChatTimeSeparatorRow separator={timeSeparators.get(message.id)!} />
                  ) : null}
                  {message.role === "assistant" && redactedAnswerIds.has(message.id) ? (
                    <AccessEndedNotice variant="message" {...accessEndedNoticeFor(message)} />
                  ) : message.kind === "selection" ? (
                    <SelectionChip
                      label={consentChipLabel(message)}
                      ended={consentChipEnded(message)}
                      outcome={consentChipOutcome(message)}
                    />
                  ) : (
                    <AgentBubble
                      message={message}
                      driveMemoryReview={renderDriveMemoryReview(message)}
                      onResendAttachment={
                        message.role === "user" && message.attachments?.length
                          ? (index, editedText) => resendTextAttachment(message, index, editedText)
                          : undefined
                      }
                      onConfirmMemoryNeedsOwner={(reviewedCards) => confirmMemoryNeedsOwner(message.id, reviewedCards)}
                      pendingMemoryCards={pkmNeedsOwnerCardsRef.current.get(message.id)?.cards}
                      canConfirmMemoryNeedsOwner={isVaultUnlocked && Boolean(vaultKey && vaultOwnerToken)}
                      onUnlockVault={() => setVaultDialogOpen(true)}
                      onInformationRequestSubmitted={async (activityId, receipt) => {
                        const ownerUid = user?.uid;
                        const threadId = conversationIdRef.current;
                        const ownerToken = vaultOwnerToken;
                        const epoch = historyRestoreEpochRef.current;
                        // The request exists now: the card says "Request sent"
                        // from the request itself, whatever happens to its
                        // history receipt below.
                        const showSent = (review: AgentStructuredExperience) =>
                          setMessages((current) => current.map((item) => item.id !== message.id ? item : {
                            ...item,
                            structuredExperiences: (item.structuredExperiences ?? []).map((entry) =>
                              entry.id === activityId ? { ...entry, experience: review } : entry),
                          }));
                        showSent(receipt.review);
                        if (!ownerUid || !threadId || !ownerToken) {
                          if (ownerUid) markConsentContinuationUnavailable(ownerUid, receipt.bundleId);
                          console.warn("[one-chat] information request receipt not recorded", {
                            bundleId: receipt.bundleId, reason: "no_conversation",
                          });
                          return;
                        }
                        // Sent from this chat, now: watch for the answer even if
                        // the person leaves before the card's first status read.
                        watchSentInformationRequest({
                          ownerId: ownerUid,
                          bundleId: receipt.bundleId,
                          conversationId: threadId,
                          subjectRef: receipt.subjectRef,
                          personName: receipt.review.personName,
                        });
                        try {
                          const review = await recordAgentChatInformationRequestWithRetry({
                            conversationId: threadId,
                            sourceActivityId: activityId,
                            bundleId: receipt.bundleId,
                            idempotencyKey: receipt.idempotencyKey,
                            vaultOwnerToken: ownerToken,
                            vaultKey: vaultKeyRef.current ?? "",
                          });
                          if (review.type !== "one.information_request_review.v1"
                            || review.subjectRef !== receipt.subjectRef) {
                            throw new Error("Submitted request history did not match the recipient.");
                          }
                          clearAgentChatHistoryCache(ownerUid);
                          if (historyRestoreEpochRef.current !== epoch || conversationIdRef.current !== threadId) return;
                          showSent(review);
                        } catch (error) {
                          // Nothing scary for the person: the request was sent
                          // and its card stays true. Without a receipt the server
                          // refuses a follow-up turn (409), so this chat does not
                          // start one; the card still shows the answer when it lands.
                          markConsentContinuationUnavailable(ownerUid, receipt.bundleId);
                          console.warn("[one-chat] information request receipt not recorded", {
                            bundleId: receipt.bundleId,
                            status: error instanceof InformationRequestReceiptError ? error.status : null,
                          });
                        }
                      }}
                      onOpenConnections={openConnectorSurface}
                      onCompileDriveNotes={hasChatAccess && message.status === "done"
                        ? (query, window) => void compileOwnerDriveNotes(
                          message.id, query, window,
                        )
                        : undefined}
                      onDownloadDriveNotes={hasChatAccess && compiledDriveMarkdownRef.current.has(message.id)
                        ? () => void downloadCompiledDriveNotes(message.id)
                        : undefined}
                      gmailInformationRequestAttachment={
                        hasChatAccess && message.gmailInformationRequestWorkflowId ? (
                          <GmailInformationRequestAttachment
                            loadPreview={() =>
                              loadGmailInformationRequestPreview(
                                message.gmailInformationRequestWorkflowId!,
                              )
                            }
                          />
                        ) : undefined
                      }
                      retryDisabled={isChatLoading || isStreaming}
                      rating={messageRatings[message.serverMessageId ?? message.id] ?? null}
                      onRate={(next) =>
                        handleRateMessage(message.serverMessageId ?? message.id, next)
                      }
                      reported={reportedMessageIds.has(message.serverMessageId ?? message.id)}
                      onReport={(reason) =>
                        handleReportMessage(message.serverMessageId ?? message.id, reason)
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
                          // a toast over it. The shared bundle path decides
                          // every item (a few at a time) and rejects unless
                          // every one went through, so the card is only marked
                          // approved when every request in it was.
                          await consentActions.handleApproveBundle(targets, {
                            quiet: true,
                            bundleId: item.bundleId || item.id,
                          });
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
                          const setCardStatus = (status: PendingConsentCardStatus) =>
                            updateMessage(message.id, (current) => ({
                              ...current,
                              specialistDirective:
                                markPendingConsentRequestDirectiveStatus(
                                  current.specialistDirective,
                                  item.id,
                                  status,
                                ),
                            }));
                          const requestIds = targets.map((target) => target.id);
                          const bundleId = item.bundleId || item.id;
                          const deny = consentActions.handleDenyBundle;
                          // The card reads declined at once; nothing is sent
                          // until the Undo window closes, and Undo sends nothing.
                          setCardStatus("denied");
                          scheduleConsentDecline({
                            key: `chat:${bundleId}`,
                            message: declinedChatRequestMessage(item.requesterLabel),
                            onUndo: () => setCardStatus("pending"),
                            send: () => deny(requestIds, { quiet: true, bundleId }).catch(() => {
                              setCardStatus("pending");
                              addErrorMessage("Could not decline that request. Try again.");
                            }),
                          });
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
                      onEnableGmailSend={handleEnableGmailSend}
                      enablingGmailSend={gmailSendConnect.pending?.key === item.id}
                      onCancelEnableGmailSend={
                        gmailSendConnect.pending?.cancellable
                          ? gmailSendConnect.cancel
                          : undefined
                      }
                      onRetry={retryEmailDelivery}
                    />
                  ))}
                  <AgentFollowUpSuggestions
                    suggestions={visibleFollowUps(
                      message, visibleMessages.at(-1)?.id, isChatLoading || isStreaming,
                    )}
                    onSelect={handleWelcomePromptSelect}
                  />
                  {message.id === emailDraftAnchorMessageId
                    ? renderEmailDraftCard()
                    : null}
                </Fragment>
              ))}
              {renderChatOnboarding({ kind: "end", visibleMessageIds })}

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
                        ...stampNow(),
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

              <FirstConnectInsightsCard
                ownerId={user?.uid ?? null}
                vaultKey={vaultKey ?? null}
                vaultOwnerToken={vaultOwnerToken ?? null}
                enabled={hasChatAccess && !isPuppySurface}
              />

              {pendingMcpReviews.slice(0, 1).map((review) => (
                <McpCallReviewCard
                  key={review.reference.directiveId}
                  review={review}
                  vaultOwnerToken={vaultOwnerToken || ""}
                  onDismiss={() => setPendingMcpReviews((current) => current.filter((item) =>
                    item.reference.directiveId !== review.reference.directiveId))}
                />
              ))}

              {pendingAppAction && !pendingAppActionDuplicatesAskCard ? (
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
                          ...stampNow(),
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
                        ...stampNow(),
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
                          ...stampNow(),
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
                          ...stampNow(),
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
                        ...stampNow(),
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
                        // Opens Google's window synchronously, in this click;
                        // the chat window never navigates.
                        runDirectiveConnect("calendar");
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
                    busyLabel={
                      directiveConnectWaiting ? "Waiting for Google…" : undefined
                    }
                    cancelWhileBusy={directiveConnectWaiting}
                    onCancel={() => {
                      directiveConnect.cancel();
                      setPendingSpecialistDirective(null);
                      toast.info(
                        "Calendar change cancelled. Nothing was changed.",
                      );
                    }}
                  />
                ) : pendingSpecialistDirective.delegateAgentId ===
                  DRIVE_REVIEW_DELEGATE ? (
                  <SpecialistDirectiveCard
                    details={driveReviewDetails(
                      pendingSpecialistDirective.directive.payload as Record<
                        string,
                        unknown
                      >,
                    )}
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
                      ).confirmLabel ?? "Confirm",
                    )}
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      const token = getVaultOwnerToken();
                      if (!token || !user?.uid) {
                        addErrorMessage(
                          "Vault access expired. Unlock again to continue.",
                        );
                        return;
                      }
                      const payload = directive.directive.payload as Record<
                        string,
                        unknown
                      >;
                      setSpecialistBusy(true);
                      appendMessage({
                        id: `msg-${crypto.randomUUID()}-drive-confirm`,
                        role: "user",
                        text: String(payload.confirmLabel ?? "Confirm"),
                        ...stampNow(),
                        status: "done",
                        kind: "selection",
                      });
                      setPendingSpecialistDirective(null);
                      try {
                        const result = await runDriveReviewDirective(
                          directive.directive,
                          token,
                          user.uid,
                        );
                        appendMessage({
                          id: `msg-${crypto.randomUUID()}-drive-result`,
                          role: "assistant",
                          text: result.detail,
                          ...stampNow(),
                          status: "done",
                          renderAsPlainAssistantMessage: true,
                        });
                      } catch (error) {
                        addErrorMessage(
                          error instanceof Error
                            ? error.message
                            : "Unable to apply the Drive change.",
                        );
                      } finally {
                        setSpecialistBusy(false);
                      }
                    }}
                    onCancel={() => {
                      setPendingSpecialistDirective(null);
                      toast.info("Drive change cancelled. Nothing was changed.");
                    }}
                  />
                ) : pendingSpecialistDirective.delegateAgentId ===
                  "agent_email" ? (
                  <SpecialistDirectiveCard
                    summary={String(
                      (
                        pendingSpecialistDirective.directive.payload as Record<
                          string,
                          unknown
                        >
                      ).summary ?? pendingSpecialistDirective.message,
                    )}
                    items={gmailMailboxDetails(
                      pendingSpecialistDirective.directive.payload as Record<
                        string,
                        unknown
                      >,
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
                      if (type === "gmail.connect") {
                        // The restricted gmail.modify scope is requested only
                        // here, on first use, on top of existing grants, in a
                        // window opened synchronously by this click.
                        runDirectiveConnect("gmail_modify");
                        return;
                      }
                      if (type !== "gmail.execute_mailbox_proposal") {
                        setPendingSpecialistDirective(null);
                        addErrorMessage(
                          "That Gmail action is no longer available.",
                        );
                        return;
                      }
                      const vaultOwnerToken = getVaultOwnerToken();
                      if (!vaultOwnerToken || !user?.getIdToken) {
                        addErrorMessage(
                          "Vault access expired. Unlock again to continue.",
                        );
                        return;
                      }
                      enqueueGmailMailboxDirective(directive, {
                        firebaseIdToken: await user.getIdToken(),
                        vaultOwnerToken,
                      });
                    }}
                    busyLabel={
                      directiveConnectWaiting ? "Waiting for Google…" : undefined
                    }
                    cancelWhileBusy={directiveConnectWaiting}
                    onCancel={() => {
                      directiveConnect.cancel();
                      setPendingSpecialistDirective(null);
                      toast.info("Gmail change cancelled. Nothing was changed.");
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
                          ...stampNow(),
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
                        ...stampNow(),
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
                          ...stampNow(),
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
                        ...stampNow(),
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
                <Fragment key={message.id}>
                  {timeSeparators.has(message.id) ? (
                    <ChatTimeSeparatorRow separator={timeSeparators.get(message.id)!} />
                  ) : null}
                  <AgentBubble
                    message={message}
                    onOpenConnections={openConnectorSurface}
                    retryDisabled={isChatLoading || isStreaming}
                  />
                </Fragment>
              ))}
              {!emailDraftIsAnchored ? renderEmailDraftCard() : null}
              {emailDeliveryTimeline.trailingItems.map((item) => (
                <EmailDeliveryHistoryCard
                  key={item.id}
                  item={item}
                  onEnableGmailSend={handleEnableGmailSend}
                  enablingGmailSend={gmailSendConnect.pending?.key === item.id}
                  onCancelEnableGmailSend={
                    gmailSendConnect.pending?.cancellable
                      ? gmailSendConnect.cancel
                      : undefined
                  }
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
              "pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pt-3",
              "bg-transparent pb-[var(--agent-chat-composer-bottom)] focus-within:pb-[var(--agent-chat-composer-focused-bottom)]",
              // Puppy One has its own composer. Leaving One's on screen would
              // let a message meant for the on-device agent be sent to the
              // cloud one, which is exactly the confusion this mode prevents.
              isPuppySurface && "hidden",
            )}
          >
            {messagesBelow > 0 ? (
              <div className="pointer-events-none mx-auto mb-2 flex w-full justify-center">
                <button
                  type="button"
                  data-testid="agent-chat-messages-below"
                  onClick={jumpToLatestMessage}
                  aria-label={`Jump to latest, ${messagesBelow} ${messagesBelow === 1 ? "message" : "messages"} below`}
                  className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-[color:var(--app-accent)] pl-4 pr-3 text-[14px] font-semibold tabular-nums text-[color:var(--app-accent-fg)] shadow-[0_10px_28px_-12px_var(--app-accent-deep)] transition-colors hover:bg-[color:var(--app-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--one-chat-canvas)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
                >
                  {messagesBelow} {messagesBelow === 1 ? "message" : "messages"}
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <div
              ref={composerStackRef}
              className={cn(
                // Exactly the bottom navigation's width on Chat: the same
                // max-width token and the same 0.75rem gutters as its shell.
                "pointer-events-auto mx-auto w-full",
                isCanonicalChatRoute
                  ? "max-w-[var(--app-bottom-shell-max-width)]"
                  : "max-w-3xl",
              )}
            >
              <AgentQueuedStack
                prompts={queuedPrompts}
                deliveryUnconfirmed={queuedDeliveryUnconfirmed}
                editingId={editingQueuedPromptId}
                editingText={editingQueuedPromptText}
                onEditStart={(prompt) => {
                  setEditingQueuedPromptId(prompt.id);
                  setEditingQueuedPromptText(prompt.text);
                }}
                onEditChange={setEditingQueuedPromptText}
                onEditSave={(id) => {
                  void editQueuedPrompt(id, editingQueuedPromptText);
                }}
                onEditCancel={() => {
                  setEditingQueuedPromptId(null);
                  setEditingQueuedPromptText("");
                }}
                onRemove={(id) => {
                  void removeQueuedPrompt(id);
                }}
              />
              {queuedDeliveryUnconfirmed ? (
                <div role="status" className="mb-2 flex items-center justify-between gap-3 rounded-[16px] bg-foreground/[0.045] px-3 py-2 text-sm text-muted-foreground">
                  <span>Delivery is unconfirmed. New messages are held until it is checked.</span>
                  <Button type="button" variant="outline" size="sm" disabled={queuedDeliveryChecking} onClick={() => void recheckQueuedDelivery()}>
                    {queuedDeliveryChecking ? "Checking…" : "Check delivery"}
                  </Button>
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
                  {activeDriveSearchSelection ? (
                    <div className="mb-2 flex min-w-0 items-center gap-2 rounded-[18px] bg-foreground/[0.045] px-3 py-1.5 text-sm" aria-label="Selected Drive file">
                      <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{activeDriveSearchSelection.name}</span>
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove selected Drive file"
                        onClick={() => {
                          pendingDriveSearchSelectionRef.current = null;
                          setPendingDriveSearchSelection(null);
                          const generated = generatedDriveSearchDraftRef.current;
                          generatedDriveSearchDraftRef.current = false;
                          if (generated) setInput(current => clearGeneratedDriveSearchDraft(current, generated));
                        }}><X className="h-4 w-4" /></Button>
                    </div>
                  ) : null}
                  {longPromptAttachment ? (
                    <AgentComposerTextAttachment
                      attachment={longPromptAttachment}
                      onChange={editLongPromptAttachment}
                      onRemove={removeLongPromptAttachment}
                      onCollapse={collapseComposer}
                    />
                  ) : null}
                  {/* One composer, two sizes. The compact pill and the expanded
                   * editor used to be separate text boxes in separate trees, so
                   * React swapped one for the other when a long draft auto-
                   * expanded, and keystrokes landing in that frame were lost
                   * ("number 3 fopand" on a Galaxy S24 Ultra, 2026-09-22). The
                   * text box now stays the same element; only its size, the
                   * corner control and the labels change. */}
                  <div
                    ref={composerSurfaceRef}
                    data-testid={composerExpanded ? "agent-chat-composer-expanded" : "agent-chat-composer"}
                    className={cn(
                      composerExpanded
                        ? "agent-chat-composer-surface relative mb-2 overflow-hidden rounded-[24px]"
                        : "agent-chat-composer-surface flex min-h-[3.75rem] items-center gap-2 overflow-hidden rounded-[var(--app-input-radius)] px-2.5 pl-3.5",
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
                        onChange={(event) => { generatedDriveSearchDraftRef.current = false; setInput(event.target.value); }}
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
                          isVoiceConnecting
                        }
                        placeholder={
                          chatOnboarding.composerPlaceholder ??
                          (composerExpanded
                            ? "Write a longer message..."
                            : "Message One...")
                        }
                        rows={1}
                        className={
                          composerExpanded
                            ? "block h-[30dvh] w-full resize-none overscroll-contain overflow-y-auto bg-transparent px-4 pb-14 pr-32 pt-4 text-[16px] leading-6 text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 sm:px-5 sm:pb-16 sm:pr-36 sm:pt-5 sm:text-sm break-words [overflow-wrap:anywhere] [word-break:break-word]"
                                : "h-auto max-h-40 min-h-0 min-w-0 flex-1 resize-none overscroll-contain overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-0 bg-transparent px-0 py-3 text-[15px] leading-snug text-foreground caret-[color:var(--app-accent)] outline-none shadow-none focus-visible:border-transparent focus-visible:ring-0 placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60 sm:max-h-44 sm:text-sm break-words [overflow-wrap:anywhere] [word-break:break-word]"
                        }
                      />
                    </div>
                        <div
                          className={
                            composerExpanded
                              ? "absolute bottom-3 right-3 flex items-center gap-2 sm:bottom-4 sm:right-4"
                              : "flex shrink-0 items-center gap-1.5"
                          }
                        >
                          <div className="flex items-center gap-1 rounded-full border border-foreground/[0.08] bg-foreground/[0.045] p-1">
                            {composerActionRail}
                          </div>
                        </div>
                  </div>
                </>
              )}
            </div>
          </form>
        </div>
        </section>
      </div>
      {offerGetApp ? (
        <AgentGetAppPrompt
          open={getAppOpen}
          onOpenChange={setGetAppOpen}
          presentation="sheet"
          returnFocusRef={getAppReturnFocusRef}
        />
      ) : null}
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
      </AgentTranscriptRevealContext.Provider>
      </ConsentCardPhaseContext.Provider>
      </AgentConsentContinuationContext.Provider>
      </CustomConnectorChatContext.Provider>
      </AgentPersonSelectionContext.Provider>
    </div>
  );
}
