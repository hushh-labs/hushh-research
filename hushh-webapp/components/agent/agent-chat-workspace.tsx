"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  LogIn,
  Menu,
  Maximize2,
  Mic,
  Minimize2,
  Minus,
  Pencil,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import {
  SpecialistConsentActionsCard,
  SpecialistConsentRequiredCard,
  SpecialistDirectiveCard,
  SpecialistFreeTextPromptCard,
  SpecialistPendingConsentRequestCard,
  SpecialistPromptCard,
  type SpecialistConsentActionItem,
  type SpecialistPendingConsentRequestItem,
} from "@/components/agent/specialist-directive-card";
import {
  ChatMarkdownLink,
  copyTextToClipboard,
} from "@/components/agent/chat-markdown-link";
import { SelectionChip } from "@/components/agent/selection-chip";
import {
  AgentTurnStreamPanel,
  agentToolEventToVisibleStreamEvent,
  type AgentVisibleStreamEvent,
  type AgentVisibleStreamStatus,
} from "@/components/agent/agent-turn-stream-panel";
import { describeSelection } from "@/lib/agent/describe-selection";
import {
  getWelcomePromptSetIndex,
  getWelcomePrompts,
} from "@/lib/agent/agent-welcome-prompts";
import type { ClientPrompt } from "@/lib/one-location/types";
import { AgentVoiceWaveInput } from "@/components/agent/agent-voice-wave-input";
import { useAuth } from "@/hooks/use-auth";
import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import {
  addToPKM,
  clearAgentPkmContext,
  formatAgentPkmSaveSummary,
  getPkmAutoSaveCards,
  getPkmConfirmationCards,
  getIgnoredPkmCards,
  loadAgentPkmContext,
  peekAgentPkmContext,
  previewAgentPkmMemory,
  warmAgentPkmContext,
  type AgentPkmContext,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import {
  DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
  loadAgentPkmAutoSavePolicy,
  type AgentPkmAutoSavePolicy,
} from "@/lib/agent/agent-pkm-auto-save-policy";
import {
  loadAgentChatConversationHistory,
  peekAgentChatHistoryCache,
  warmAgentChatHistoryCache,
} from "@/lib/agent/agent-chat-history-cache";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { toDurationBucket, trackEvent } from "@/lib/observability/client";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import {
  isAgentGeminiVoiceEnabled,
  requestAgentConversation,
} from "@/lib/agent/agent-voice-settings";
import {
  cancelAgentChatAction,
  confirmAgentChatAction,
  consumeAgentChatAction,
  deleteAgentChatConversation,
  renameAgentChatConversation,
  settleAgentChatAction,
  streamAgentChat,
  streamAgentIntro,
  type AgentChatConversation,
  type AgentChatMessage as StoredAgentChatMessage,
  type AgentChatToolEvent,
  type SpecialistDirectiveEvent,
  type AgentSource,
} from "@/lib/services/agent-chat-client";
import { runConnectedSystemDirective } from "@/lib/agent/connected-system-directive-runtime";
import { runCalendarDirective } from "@/lib/agent/calendar-directive-runtime";
import { clearCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import { runLocationDirective, type DelegateResult } from "@/lib/agent/specialist-directive-runtime";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { cn } from "@/lib/utils";
import { useConsentActions, type PendingConsent } from "@/lib/consent/use-consent-actions";
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
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { resolveGeminiRuntimeConnection } from "@/lib/connections/gemini-runtime-configuration";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  useOneConversationSession,
  type AgentChatHandoff,
} from "@/lib/agent/one-conversation-session";
import {
  dedupeAdjacentAgentMessages,
} from "@/lib/agent/agent-chat-turn-safety";
import {
  editQueuedAgentPrompt,
  removeQueuedAgentPrompt,
  SerialAgentOperationQueue,
  type QueuedAgentPrompt,
} from "@/lib/agent/agent-chat-prompt-queue";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { buildOneVoiceStructuredScreenContext } from "@/lib/voice/screen-context-builder";

type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  status?: "streaming" | "done" | "error";
  ephemeral?: boolean;
  kind?: "selection";
  specialistDirective?: SpecialistDirectiveEvent | null;
  streamEvents?: AgentVisibleStreamEvent[];
  thought?: string;
  sources?: AgentSource[];
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
  event: AgentVisibleStreamEvent
): AgentVisibleStreamEvent[] {
  const current = events ?? [];
  const existingIndex = current.findIndex((item) => item.id === event.id);
  if (existingIndex >= 0) {
    return current.map((item, index) => (index === existingIndex ? event : item));
  }
  return [...current, event].slice(-10);
}

type AgentPkmReview = {
  id: string;
  turnId: string;
  sourceMessage: string;
  cards: AgentPkmPreviewCard[];
  saving: boolean;
};

type AgentPkmActivity = {
  id: string;
  text: string;
  status: "streaming" | "done" | "error";
};

type AgentTurnSource = "typed";
type AgentRunTurnOptions = {
  source: AgentTurnSource;
  appendUserMessage?: boolean;
  replaceAssistantMessageId?: string | null;
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

export type AgentChatWorkspaceVariant = "page" | "popover";

type AgentChatWorkspaceProps = {
  variant?: AgentChatWorkspaceVariant;
  className?: string;
  handoff?: AgentChatHandoff | null;
  windowControls?: ReactNode;
  onMinimize?: () => void;
  onNavigationActionComplete?: (result: AgentActionRuntimeResult) => void;
  /** The owning popover has started closing; preserve history, stop capture. */
  isSurfaceClosing?: boolean;
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

function toPkmFactCountBucket(count: number):
  | "none"
  | "1_9"
  | "10_49"
  | "50_249"
  | "250_plus" {
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
    agentId: typeof payload.agentId === "string" ? payload.agentId : event.delegateAgentId,
    requiredScope: typeof payload.requiredScope === "string" ? payload.requiredScope : "",
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
  };
}

function getConsentActionsPayload(
  event: SpecialistDirectiveEvent | null,
): ConsentActionsDirectivePayload | null {
  if (!event || event.directive.kind !== "prompt") return null;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "consent_actions") return null;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
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

function getPendingConsentRequestPayload(
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
  const status =
    rawItem.status === "approved" || rawItem.status === "denied"
      ? rawItem.status
      : "pending";
  return {
    kind: "pending_consent_request",
    item: {
      id,
      requesterLabel:
        typeof rawItem.requesterLabel === "string" && rawItem.requesterLabel.trim()
          ? rawItem.requesterLabel
          : "An agent",
      requesterImageUrl:
        typeof rawItem.requesterImageUrl === "string" ? rawItem.requesterImageUrl : null,
      requesterWebsiteUrl:
        typeof rawItem.requesterWebsiteUrl === "string" ? rawItem.requesterWebsiteUrl : null,
      scope: typeof rawItem.scope === "string" ? rawItem.scope : "",
      scopeDescription:
        typeof rawItem.scopeDescription === "string" ? rawItem.scopeDescription : null,
      requestedAt:
        typeof rawItem.requestedAt === "number" || typeof rawItem.requestedAt === "string"
          ? rawItem.requestedAt
          : null,
      approvalTimeoutAt:
        typeof rawItem.approvalTimeoutAt === "number" ||
        typeof rawItem.approvalTimeoutAt === "string"
          ? rawItem.approvalTimeoutAt
          : null,
      expiryHours:
        typeof rawItem.expiryHours === "number" || typeof rawItem.expiryHours === "string"
          ? rawItem.expiryHours
          : null,
      reason: typeof rawItem.reason === "string" ? rawItem.reason : null,
      additionalAccessSummary:
        typeof rawItem.additionalAccessSummary === "string"
          ? rawItem.additionalAccessSummary
          : null,
      status,
    },
  };
}

function pendingConsentLookupItemToCardItem(
  item: PendingConsentLookupItem,
): SpecialistPendingConsentRequestItem | null {
  const id = String(item.request_id || "").trim();
  if (!id) return null;
  const requesterLabel =
    item.requester_label ||
    item.agent_id ||
    item.developer ||
    "An agent";
  return {
    id,
    requesterLabel,
    requesterImageUrl: item.requester_image_url ?? null,
    requesterWebsiteUrl: item.requester_website_url ?? null,
    scope: item.scope || "",
    scopeDescription: item.scope_description ?? null,
    requestedAt: item.issued_at ?? null,
    approvalTimeoutAt: item.poll_timeout_at ?? null,
    reason: item.reason ?? null,
    additionalAccessSummary: item.additional_access_summary ?? null,
    status: "pending",
  };
}

function pendingConsentCardItemToPendingConsent(
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
      typeof approvalTimeoutAt === "number" && Number.isFinite(approvalTimeoutAt)
        ? approvalTimeoutAt
        : undefined,
    expiryHours:
      typeof expiryHours === "number" && Number.isFinite(expiryHours)
        ? expiryHours
        : undefined,
    reason: item.reason || undefined,
    additionalAccessSummary: item.additionalAccessSummary || undefined,
  };
}

function agentMessagePendingConsentRequestId(message: AgentMessage): string | null {
  const payload = getPendingConsentRequestPayload(message.specialistDirective ?? null);
  return payload?.item.id ?? null;
}

function markPendingConsentRequestDirectiveStatus(
  event: SpecialistDirectiveEvent | null | undefined,
  itemId: string,
  status: "approved" | "denied",
): SpecialistDirectiveEvent | null | undefined {
  if (!event || event.directive.kind !== "prompt") return event;
  const payload = event.directive.payload as Record<string, unknown>;
  if (payload.kind !== "pending_consent_request") return event;
  const item = payload.item && typeof payload.item === "object"
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
    ? item.actions.filter((action): action is string => typeof action === "string")
    : [];
  const metadata =
    item.metadata && typeof item.metadata === "object"
      ? (item.metadata as Record<string, unknown>)
      : {};
  const id = typeof item.id === "string" ? item.id : "";
  const scope = typeof item.scope === "string" ? item.scope : "";
  const requestSource =
    typeof metadata.request_source === "string" ? metadata.request_source.trim() : "";
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
  if (payload.kind !== "consent_actions" || !Array.isArray(payload.items)) return event;

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
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.offsetParent !== null
  );
}

function trapFocusWithin(event: ReactKeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== "Tab") return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function formatAgentDisplayName(displayName?: string | null, email?: string | null): string {
  const rawName = displayName?.trim() || email?.split("@")[0]?.trim() || "";
  const firstName = rawName
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .find(Boolean);
  if (!firstName) return "there";
  return firstName.charAt(0).toUpperCase() + firstName.slice(1);
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
      <div className="mx-auto w-full max-w-2xl text-center flex flex-col items-center">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-black/10 bg-black/[0.035] px-3 py-1.5 text-xs font-medium text-[rgba(0,0,0,0.56)] dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
          One workspace
        </div>
        <h2 className="text-[34px] font-medium leading-[1.08] tracking-normal text-foreground max-sm:font-[family-name:var(--font-app-display)] max-sm:font-semibold max-sm:tracking-[-0.5px] sm:text-[38px]">
          Hi {name}
        </h2>
        <p className="mt-3 max-w-xl text-[16px] leading-7 text-muted-foreground max-sm:font-[family-name:var(--font-app-body)] sm:text-[17px] mx-auto text-center text-balance">
          Ask One about your markets, portfolio, memories, or consent workflows.
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={disabled}
              onClick={() => onPromptSelect(prompt)}
              className="group min-h-24 rounded-xl border border-border bg-card p-4 text-left text-sm font-medium text-foreground shadow-sm transition hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50 max-sm:rounded-2xl max-sm:font-[family-name:var(--font-app-body)] max-sm:hover:border-[color:var(--app-accent-ring)] max-sm:focus-visible:ring-[color:var(--app-accent-ring)]"
            >
              <span className="block leading-5">{prompt}</span>
              <span className="mt-4 flex items-center justify-between">
                <span className="block h-px w-10 bg-primary/50 transition group-hover:w-14 max-sm:bg-[color:var(--app-accent)] dark:max-sm:bg-[color:var(--app-accent)]" />
                <ChevronRight
                  className="hidden h-4 w-4 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-deep)] max-sm:block"
                  aria-hidden
                />
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-markdown min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2 className="mb-2 mt-1 text-base font-semibold leading-6 text-foreground">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="mb-2 mt-3 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mb-1.5 mt-3 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h4>
          ),
          h4: ({ children }) => (
            <h5 className="mb-1.5 mt-2 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h5>
          ),
          p: ({ children }) => (
            <p className="my-2 first:mt-0 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          a: ({ children, href }) => (
            <ChatMarkdownLink href={href}>{children}</ChatMarkdownLink>
          ),
          code: ({ children, className }) => {
            const inline = !className;
            if (inline) {
              return (
                <code className="rounded border border-border/70 bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              );
            }
            return <code className={cn("font-mono text-xs", className)}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-md border border-border/70 bg-muted/60 p-3 leading-5">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-primary/50 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-md border border-border/70">
              <table className="min-w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border/70 bg-muted/60 px-3 py-2 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/50 px-3 py-2 align-top last:border-b-0">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
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

      const elapsedMs = lastPaintAt ? Math.max(12, now - lastPaintAt) : AGENT_STREAM_RENDER_FRAME_MS;
      lastPaintAt = now;
      const backlog = target.length - current.length;
      const charsPerSecond = backlog > 900 ? 2600 : backlog > 260 ? 1500 : 620;
      const step = Math.max(
        1,
        Math.min(backlog, Math.ceil((charsPerSecond * elapsedMs) / 1000))
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
    if (target && (!target.startsWith(current) || current.length < target.length)) {
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
    <span className="inline-flex items-center gap-1 py-1 text-muted-foreground" aria-label="Agent is thinking">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-160ms] motion-reduce:animate-none" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-80ms] motion-reduce:animate-none" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
    </span>
  );
}

function AgentBubble({
  message,
  onRetry,
  retryDisabled = false,
  busyConsentItemId = null,
  turnPanelOpportunities,
  onConsentRevoke,
  onConsentDetails,
  onPendingConsentApprove,
  onPendingConsentDeny,
  onPendingConsentDetails,
}: {
  message: AgentMessage;
  onRetry?: () => void;
  retryDisabled?: boolean;
  busyConsentItemId?: string | null;
  turnPanelOpportunities?: ReactNode;
  onConsentRevoke?: (item: SpecialistConsentActionItem) => Promise<void> | void;
  onConsentDetails?: (item: SpecialistConsentActionItem) => void;
  onPendingConsentApprove?: (item: SpecialistPendingConsentRequestItem) => Promise<void> | void;
  onPendingConsentDeny?: (item: SpecialistPendingConsentRequestItem) => Promise<void> | void;
  onPendingConsentDetails?: (item: SpecialistPendingConsentRequestItem) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";
  const streamEvents = message.streamEvents ?? [];
  const hasStreamContent =
    streamEvents.length > 0 ||
    Boolean(message.thought?.trim()) ||
    Boolean(message.sources?.length) ||
    Boolean(message.text.trim());
  const shouldRenderStreamPanel =
    !isUser &&
    hasStreamContent;
  const animated = useAnimatedAssistantText(message.text, !isUser && isStreaming);
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
    !isUser && !message.ephemeral && !isStreaming && assistantText.trim().length > 0;
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
      className={cn(
        "motion-step-enter flex w-full",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "min-w-0",
          shouldRenderStreamPanel && !isUser
            ? "w-full max-w-none"
            : "max-w-[90%] sm:max-w-[min(82%,48rem)]",
          isUser && "order-first sm:max-w-[min(76%,42rem)]"
        )}
      >
        <div
          aria-live={!isUser && isStreaming ? "polite" : undefined}
          className={cn(
            "text-sm leading-6",
            isUser
              ? "rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground shadow-sm shadow-primary/10"
              : showAssistantBubble
                ? "rounded-2xl bg-muted/50 px-4 py-3 text-foreground"
                : "px-0 py-1 text-foreground",
            isError &&
              "rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-destructive"
          )}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap break-words">{message.text}</span>
          ) : shouldRenderStreamPanel ? (
            <AgentTurnStreamPanel
              streamEvents={streamEvents}
              thinkingText={message.thought}
              sources={message.sources}
              responseText={assistantText}
              isStreaming={isStreaming}
              isError={isError}
              opportunities={turnPanelOpportunities}
              response={assistantText ? <AgentMarkdown text={assistantText} /> : null}
            />
          ) : assistantText ? (
            <AgentMarkdown text={assistantText} />
          ) : canRenderConsentActions || canRenderPendingConsentRequest ? (
            null
          ) : (
            <AgentThinkingDots />
          )}
        </div>
        <div
          className={cn(
            "mt-1 flex items-center gap-2 text-[11px] text-[rgba(0,0,0,0.46)] dark:text-zinc-500",
            isUser && "justify-end text-right"
          )}
        >
          <span>{message.timestamp}</span>
          {showResponseActions ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleCopy}
                className="grid h-7 w-7 place-items-center rounded-md border border-transparent text-[rgba(0,0,0,0.46)] transition hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
                aria-label={copied ? "Response copied" : "Copy response"}
                title={copied ? "Copied" : "Copy response"}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextLiked = !liked;
                  setLiked(nextLiked);
                  if (nextLiked) setDisliked(false);
                }}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  liked
                    ? "border-black/10 bg-black/[0.06] text-[#1d1d1f] dark:border-white/15 dark:bg-zinc-800 dark:text-zinc-100"
                    : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
                )}
                aria-label="Like response"
                aria-pressed={liked}
                title="Like response"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextDisliked = !disliked;
                  setDisliked(nextDisliked);
                  if (nextDisliked) setLiked(false);
                }}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  disliked
                    ? "border-black/10 bg-black/[0.06] text-[#1d1d1f] dark:border-white/15 dark:bg-zinc-800 dark:text-zinc-100"
                    : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
                )}
                aria-label="Dislike response"
                aria-pressed={disliked}
                title="Dislike response"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
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
        <div className="mt-1 hidden h-7 w-7 shrink-0 place-items-center rounded-md border border-black/10 bg-black/[0.035] text-[rgba(0,0,0,0.56)] sm:grid dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400">
          <UserRound className="h-3.5 w-3.5" />
        </div>
      ) : null}
    </div>
  );
}

function AgentPkmActivityLine({ item }: { item: AgentPkmActivity }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 pl-11 pr-2 text-xs",
        item.status === "error" ? "text-destructive/80" : "text-muted-foreground"
      )}
      aria-live="polite"
    >
      {item.status === "streaming" ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
      )}
      <span className="min-w-0 break-words">{item.text}</span>
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
  return {
    id: message.id,
    role: message.role,
    text: displayText,
    timestamp:
      createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(createdAt)
        : formatNow(),
    status: message.status === "error" ? "error" : "done",
    ...(isSelection || isLegacySelectionSeed ? { kind: "selection" as const } : {}),
  };
}

function shouldMinimizeForNavigationResult(result: AgentActionRuntimeResult): boolean {
  return Boolean(
    result.routeAfter &&
      result.status !== "failed" &&
      result.status !== "invalid" &&
      result.status !== "noop"
  );
}

export function AgentChatWorkspace({
  variant = "page",
  className,
  handoff,
  windowControls,
  onMinimize,
  onNavigationActionComplete,
  isSurfaceClosing = false,
}: AgentChatWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isPopover = variant === "popover";
  const { user, loading: authLoading, phoneNumber } = useAuth();
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
    switchPersona,
  } = usePersonaState();
  const analysisParams = useKaiSession((state) => state.analysisParams);
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  // Shared single source of truth for the agent runtime snapshot. The chat
  // workspace consumes this base and overlays only the fields it uniquely owns
  // (background-task tracking and its local voice state) below.
  const sharedRuntime = useAgentRuntimeStateOptional();
  const [input, setInput] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerLong, setComposerLong] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedAgentPrompt[]>([]);
  const [editingQueuedPromptId, setEditingQueuedPromptId] = useState<string | null>(null);
  const [editingQueuedPromptText, setEditingQueuedPromptText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<AgentChatConversation[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>(() => [createGreetingMessage()]);
  const [queuedHandoffPrompt, setQueuedHandoffPrompt] = useState<string | null>(null);
  const consumeHandoff = useOneConversationSession((state) => state.consumeHandoff);
  const consumedHandoffIdRef = useRef<string | null>(null);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState(false);
  const [historyActionPendingId, setHistoryActionPendingId] = useState<string | null>(null);
  const [isVoiceConnecting, setIsVoiceConnecting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  // Just-in-time vault unlock: the agent prompts to unlock in place (the same
  // reusable VaultUnlockDialog used by Kai / consent / connected-systems)
  // instead of bouncing the user to /one/profile. Opened only when a vault-gated
  // operation is requested while the vault is locked.
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [activeFrontendToolCount, setActiveFrontendToolCount] = useState(0);
  const [activePkmToolCount, setActivePkmToolCount] = useState(0);
  const [pkmReviews, setPkmReviews] = useState<AgentPkmReview[]>([]);
  const [pkmActivity, setPkmActivity] = useState<AgentPkmActivity[]>([]);
  const [pkmAutoSavePolicy, setPkmAutoSavePolicy] = useState<AgentPkmAutoSavePolicy>(
    DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY
  );
  // A specialist (e.g. agent_location) can return a directive that must be
  // explicitly confirmed by the user before it runs. Stored here and rendered
  // as an inline card; never auto-fired for kind:"action".
  const [pendingSpecialistDirective, setPendingSpecialistDirective] =
    useState<SpecialistDirectiveEvent | null>(null);
  const [pendingAppAction, setPendingAppAction] = useState<{
    event: AgentChatToolEvent;
    receipt?: string;
    authorize?: () => Promise<string>;
    cancel?: () => Promise<void>;
    execute: (receipt?: string) => Promise<AgentActionRuntimeResult>;
  } | null>(null);
  const [appActionBusy, setAppActionBusy] = useState(false);
  const [specialistBusy, setSpecialistBusy] = useState(false);
  const [specialistBusyItemId, setSpecialistBusyItemId] = useState<string | null>(null);
  const voiceState = useAgentVoiceState((state) => state.status);
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [welcomePromptSetIndex, setWelcomePromptSetIndex] = useState(0);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState()
  );
  const activeActionRun = useActiveActionRun();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyDrawerRef = useRef<HTMLDivElement | null>(null);
  const historyDrawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const historyLoadKeyRef = useRef<string | null>(null);
  const welcomePromptSetInitializedRef = useRef(false);
  const historyRestoreEpochRef = useRef(0);
  const skipInitialHistoryLoadRef = useRef(false);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const operationQueueRef = useRef(new SerialAgentOperationQueue<QueuedWorkspaceOperation>());
  const calendarActionIdsRef = useRef<Set<string>>(new Set());
  const savingPkmReviewIdsRef = useRef<Set<string>>(new Set());
  const handoffPromptSubmitRef = useRef<((prompt: string) => Promise<void>) | null>(null);
  const pkmAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const latestVisibleTurnIdRef = useRef<string | null>(null);
  const inlineConsentRequestIdsRef = useRef<Set<string>>(new Set());
  const updateConversationId = useCallback((nextConversationId: string | null) => {
    conversationIdRef.current = nextConversationId;
    setConversationId(nextConversationId);
  }, []);
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
  const voiceMuted = voiceState === "muted";
  const voiceLevel = useAgentVoiceState((state) => state.level);
  const isToolWorking = activeFrontendToolCount > 0;
  const isPkmMemoryWorking = activePkmToolCount > 0;
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
  const agentVoiceEnabled = isAgentGeminiVoiceEnabled();
  const abortAgentTurnWork = useCallback(() => {
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    for (const controller of pkmAbortControllersRef.current) {
      controller.abort();
    }
    pkmAbortControllersRef.current.clear();
  }, []);

  useEffect(() => {
    if (user?.uid && isVaultUnlocked && vaultKey) {
      return;
    }
    clearAgentPkmContext(user?.uid);
  }, [isVaultUnlocked, user?.uid, vaultKey]);

  useEffect(() => {
    let cancelled = false;
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
        if (!cancelled) setPkmAutoSavePolicy(policy);
      })
      .catch(() => {
        if (!cancelled) setPkmAutoSavePolicy(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY);
      });
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken]);

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
  const pathnameWithQuery = routeQuery ? `${pathname || ""}?${routeQuery}` : pathname || "";
  const routeInfo = useMemo(
    () => deriveVoiceRouteScreen(pathname || "", routeQuery),
    [pathname, routeQuery]
  );
  const activeAnalysisTask = useMemo(() => {
    if (!user?.uid) return null;
    return (
      backgroundTaskState.tasks.find(
        (task) =>
          task.userId === user.uid &&
          task.kind === "stock_analysis_stream" &&
          task.status === "running" &&
          !task.dismissedAt
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
          !task.dismissedAt
      ) || null
    );
  }, [backgroundTaskState.tasks, user?.uid]);
  const activeAnalysisTicker = useMemo(() => {
    const ticker = activeAnalysisTask?.metadata?.ticker;
    return typeof ticker === "string" && ticker.trim() ? ticker.trim() : null;
  }, [activeAnalysisTask]);
  const hasChatAccess = Boolean(
    !authLoading && user?.uid && isVaultUnlocked && vaultOwnerToken && tokenIsFresh
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
          base.runtime.analysis_ticker || activeAnalysisTicker || analysisParams?.ticker || null,
        analysis_run_id: activeAnalysisTask?.taskId || base.runtime.analysis_run_id,
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
  const canSend =
    !isLoadingHistory &&
    !isVoiceConnecting &&
    !voiceActive &&
    input.trim().length > 0;
  const canToggleVoice =
    agentVoiceEnabled && !isVoiceConnecting;
  const historyInteractionDisabled =
    isLoadingHistory ||
    isChatLoading ||
    isToolWorking ||
    isVoiceConnecting ||
    isStreaming ||
    voiceActive ||
    specialistBusy ||
    queuedPrompts.length > 0;
  const statusText = useMemo(
    () => {
      if (authLoading) return "Checking access";
      if (!user?.uid) return "Sign in required";
      if (!isVaultUnlocked || !vaultOwnerToken || !tokenIsFresh) return "Vault locked";
      if (activeActionRun) return activeActionRun.message;
      if (!agentVoiceEnabled && voiceActive) return "Voice disabled";
      if (voiceState === "connecting") return "Voice connecting";
      if (voiceState === "listening") return "Listening";
      if (voiceState === "muted") return "Muted";
      if (voiceState === "transcribing") return "Transcribing";
      if (voiceState === "thinking") return "Thinking";
      if (voiceState === "speaking") return "Speaking";
      if (voiceState === "error") return "Voice error";
      if (isLoadingHistory) return "Loading";
      if (isVoiceConnecting) return "Voice connecting";
      if (isToolWorking) return "Working";
      if (isPkmMemoryWorking) return "Saving memory";
      if (queuedPrompts.length > 0) return `${queuedPrompts.length} queued`;
      if (isChatLoading) return "Thinking";
      if (isStreaming) return "Streaming";
      return "Ready";
    },
    [
      authLoading,
      activeActionRun,
      agentVoiceEnabled,
      isChatLoading,
      isLoadingHistory,
      isPkmMemoryWorking,
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
    ]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pkmReviews, pendingSpecialistDirective]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea || voiceActive) return;
    textarea.style.height = "0px";
    const nextHeight = textarea.scrollHeight;
    textarea.style.height = `${nextHeight}px`;
    // `scrollHeight` includes soft-wrapped text, which is the visual behavior
    // people notice. Reveal the larger editor after roughly four rendered rows.
    const long = input.trim().length > 0 && nextHeight > 96;
    setComposerLong(long);
    if (!long) setComposerExpanded(false);
  }, [input, voiceActive]);

  useEffect(() => {
    if (!isHistoryDrawerOpen) return;
    historyDrawerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsHistoryDrawerOpen(false);
      }
    };
    window.requestAnimationFrame(() => {
      getFocusableElements(historyDrawerRef.current)[0]?.focus();
    });
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isHistoryDrawerOpen]);

  useEffect(() => {
    if (isHistoryDrawerOpen) return;
    historyDrawerReturnFocusRef.current?.focus();
    historyDrawerReturnFocusRef.current = null;
  }, [isHistoryDrawerOpen]);

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
        cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(user.uid)) ??
        cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(user.uid, "financial"));
      const nestedPortfolio =
        cachedPortfolio?.portfolio &&
        typeof cachedPortfolio.portfolio === "object" &&
        !Array.isArray(cachedPortfolio.portfolio)
          ? (cachedPortfolio.portfolio as Record<string, unknown>)
          : null;
      const holdings =
        (Array.isArray(cachedPortfolio?.holdings) && cachedPortfolio.holdings) ||
        (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
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
    setIsChatLoading(false);
    setIsLoadingHistory(false);
    setIsVoiceConnecting(false);
    setIsStreaming(false);
    setActiveFrontendToolCount(0);
    setActivePkmToolCount(0);
    setPkmReviews([]);
    setPkmActivity([]);
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
  }, [abortAgentTurnWork, isVaultUnlocked, updateConversationId, user?.uid]);

  const handleCreateNewChat = useCallback(() => {
    abortAgentTurnWork();
    historyRestoreEpochRef.current += 1;
    latestVisibleTurnIdRef.current = null;
    updateConversationId(null);
    setMessages([createGreetingMessage()]);
    setInput("");
    setIsLoadingHistory(false);
    setPkmReviews([]);
    setPkmActivity([]);
    setPendingAppAction(null);
    setAppActionBusy(false);
    setPendingSpecialistDirective(null);
    setSpecialistBusy(false);
    operationQueueRef.current.replace([]);
    calendarActionIdsRef.current.clear();
    setQueuedPrompts([]);
    setEditingQueuedPromptId(null);
    setEditingQueuedPromptText("");
    setWelcomePromptSetIndex((current) => getWelcomePromptSetIndex(current));
  }, [abortAgentTurnWork, updateConversationId]);

  const updateMessage = (
    messageId: string,
    update: (message: AgentMessage) => AgentMessage
  ) => {
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? update(message) : message))
    );
  };

  const appendMessage = (message: AgentMessage) => {
    setMessages((current) => [...current, message]);
  };

  const upsertMessageStreamEvent = (
    messageId: string,
    event: AgentVisibleStreamEvent
  ) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              streamEvents: upsertVisibleStreamEvent(message.streamEvents, event),
            }
          : message
      )
    );
  };

  useEffect(() => {
    if (!handoff || consumedHandoffIdRef.current === handoff.id) return;
    consumedHandoffIdRef.current = handoff.id;
    const timestamp = formatNow();
    const nextMessages: AgentMessage[] = [];
    const transcript = handoff.transcript?.trim();
    const assistantText = handoff.assistantText?.trim();
    const resultSummary = handoff.resultSummary?.trim();
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
    const summaryText =
      assistantText ||
      resultSummary ||
      (handoff.actionId
        ? `One moved this ${handoff.actionId} request into chat for the governed action path.`
        : "One moved this live voice turn into chat.");
    nextMessages.push({
      id: `handoff-${handoff.id}-assistant`,
      role: "assistant",
      text: summaryText,
      timestamp,
      status: "done",
    });
    if (handoff.specialistDirective) {
      setPendingSpecialistDirective(handoff.specialistDirective);
    }
    setMessages((current) => [...current, ...nextMessages]);
    consumeHandoff(handoff.id);
  }, [consumeHandoff, handoff, handleCreateNewChat]);

  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked) return;

    let cancelled = false;

    const appendPendingConsentRequest = async (requestId: string) => {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId || inlineConsentRequestIdsRef.current.has(normalizedRequestId)) {
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
              (message) => agentMessagePendingConsentRequestId(message) === item.id,
            )
          ) {
            return current;
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
        console.warn("[AgentChatWorkspace] Failed to hydrate pending consent request:", error);
      }
    };

    const handleConsentMessage = (event: Event) => {
      const customEvent = event as CustomEvent<{ data?: Record<string, unknown> }>;
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
        const action = String(data.action || "").trim().toUpperCase();
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

    window.addEventListener(FCM_MESSAGE_EVENT, handleConsentMessage);
    return () => {
      cancelled = true;
      window.removeEventListener(FCM_MESSAGE_EVENT, handleConsentMessage);
    };
  }, [getVaultOwnerToken, isVaultUnlocked, user?.uid]);

  const appendDebugEvent = useCallback(
    (_turnId: string, _event: AgentDebugEvent["event"], _payload: AgentDebugEvent["payload"]) => {
      // Debug events are intentionally kept internal while the Agent debug UI is disabled.
    },
    []
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
    if (!hasChatAccess || !user?.uid || !vaultOwnerToken) return;
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
        setMessages([createGreetingMessage()]);
        return;
      }
      const restored = snapshot.latestMessages
        .map(storedMessageToAgentMessage)
        .filter((message): message is AgentMessage => Boolean(message));
      updateConversationId(snapshot.latestConversationId);
      setMessages(restored.length > 0 ? restored : [createGreetingMessage()]);
    };

    if (cached) applySnapshot(cached);

    const loadRecentConversation = async () => {
      if (skipInitialHistoryLoadRef.current) {
        skipInitialHistoryLoadRef.current = false;
        historyLoadKeyRef.current = loadKey;
        return;
      }
      historyLoadKeyRef.current = loadKey;
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
      }
    };

    // History is never on the workspace's critical open/render path. Unlock
    // warming usually makes this an immediate memory hit; cold sessions wait
    // for an idle beat so the composer and direct Ask One handoff stay usable.
    const timeoutId = window.setTimeout(() => {
      void loadRecentConversation();
    }, cached ? 0 : 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [hasChatAccess, updateConversationId, user?.uid, vaultOwnerToken]);

  const restoreConversationMessages = useCallback(
    async (nextConversationId: string, token: string) => {
      if (!user?.uid) return;
      const history = await loadAgentChatConversationHistory({
        userId: user.uid,
        conversationId: nextConversationId,
        vaultOwnerToken: token,
      });
      const restored = history
        .map(storedMessageToAgentMessage)
        .filter((message): message is AgentMessage => Boolean(message));
      latestVisibleTurnIdRef.current = null;
      updateConversationId(nextConversationId);
      setMessages(restored.length > 0 ? restored : [createGreetingMessage()]);
      setPkmActivity([]);
      setPkmReviews([]);
      setPendingSpecialistDirective(null);
      setSpecialistBusy(false);
    },
    [updateConversationId, user?.uid]
  );

  const loadConversationList = useCallback(async (force = false) => {
    if (!user?.uid) return [];
    const token = getVaultOwnerToken();
    if (!token) return [];
    const next = await warmAgentChatHistoryCache({
      userId: user.uid,
      vaultOwnerToken: token,
      force,
    });
    setConversations(next.conversations);
    return next.conversations;
  }, [getVaultOwnerToken, user?.uid]);

  const handleSelectConversation = useCallback(
    async (nextConversationId: string) => {
      if (nextConversationId === conversationId || historyInteractionDisabled) return;
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
    ]
  );

  const handleSidebarCreateNewChat = useCallback(() => {
    setIsHistoryDrawerOpen(false);
    handleCreateNewChat();
  }, [handleCreateNewChat]);

  const handleSidebarSelectConversation = useCallback(
    (nextConversationId: string) => {
      setIsHistoryDrawerOpen(false);
      void handleSelectConversation(nextConversationId);
    },
    [handleSelectConversation]
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
            conversation.id === targetConversationId ? renamed : conversation
          )
        );
        void loadConversationList(true).catch(() => undefined);
        toast.success("Agent chat renamed.");
      } catch {
        toast.error("Could not rename Agent chat.");
      } finally {
        setHistoryActionPendingId(null);
      }
    },
    [getVaultOwnerToken, loadConversationList]
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
    ]
  );

  const handleDismissPkmReview = useCallback(
    (reviewId: string) => {
      const review = pkmReviews.find((item) => item.id === reviewId);
      if (review) {
        appendDebugEvent(review.turnId, "pkm_review_dismissed", {
          review_id: review.id,
          candidate_count: review.cards.length,
        });
      }
      setPkmReviews((current) => current.filter((item) => item.id !== reviewId));
    },
    [appendDebugEvent, pkmReviews]
  );

  const handleSavePkmReview = useCallback(
    (reviewId: string) => {
      if (savingPkmReviewIdsRef.current.has(reviewId)) return;
      const review = pkmReviews.find((item) => item.id === reviewId);
      const token = getVaultOwnerToken();
      if (!review || !user?.uid || !vaultKey || !token) {
        toast.error("Unlock your vault before saving to Memory.");
        return;
      }

      savingPkmReviewIdsRef.current.add(reviewId);
      setPkmReviews((current) =>
        current.map((item) => (item.id === reviewId ? { ...item, saving: true } : item))
      );
      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(review.turnId, "pkm_review_save_start", {
        review_id: review.id,
        candidate_count: review.cards.length,
      });

      const saveInBackground = async () => {
        try {
          const result = await addToPKM({
            userId: user.uid,
            cards: review.cards,
            sourceMessage: review.sourceMessage,
            vaultKey,
            vaultOwnerToken: token,
            source: "agent_chat_review",
            confirmation: {
              confirmedByUser: true,
              surface: "chat",
              source: "agent_chat_review_button",
              sharingImpactAcknowledged: review.cards.some(
                (card) => (card.sharing_impact?.active_recipient_count || 0) > 0
              ),
            },
          });
          appendDebugEvent(review.turnId, "pkm_review_save_result", result);
          trackEvent("agent_pkm_save_confirmation_completed", {
            route_id: "agent",
            result: result.saved > 0 ? "success" : "expected_error",
            saved_count_bucket: toPkmFactCountBucket(result.saved),
            failed_count_bucket: toPkmFactCountBucket(result.failed),
            has_active_recipients: review.cards.some(
              (card) => (card.sharing_impact?.active_recipient_count || 0) > 0
            ),
          });
          if (result.saved > 0) {
            const saveReceipt = formatAgentPkmSaveSummary(result);
            setMessages((current) => [
              ...current,
              {
                id: `pkm-save-receipt-${Date.now()}`,
                role: "assistant",
                text: saveReceipt,
                timestamp: formatNow(),
                status: "done",
              },
            ]);
            setPkmReviews((current) => current.filter((item) => item.id !== reviewId));
            void loadAgentPkmContext({
              userId: user.uid,
              vaultOwnerToken: token,
              vaultKey,
              forceRefresh: true,
            }).catch(() => undefined);
            toast.success("Saved to Memory.");
            return;
          }

          setPkmReviews((current) =>
            current.map((item) => (item.id === reviewId ? { ...item, saving: false } : item))
          );
          toast.error(formatAgentPkmSaveSummary(result));
        } catch (error) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : "Failed to save this memory.";
          appendDebugEvent(review.turnId, "pkm_review_save_failed", { message });
          trackEvent("agent_pkm_save_confirmation_completed", {
            route_id: "agent",
            result: "error",
            saved_count_bucket: "none",
            failed_count_bucket: toPkmFactCountBucket(review.cards.length),
            has_active_recipients: review.cards.some(
              (card) => (card.sharing_impact?.active_recipient_count || 0) > 0
            ),
          });
          setPkmReviews((current) =>
            current.map((item) => (item.id === reviewId ? { ...item, saving: false } : item))
          );
          toast.error(message);
        } finally {
          savingPkmReviewIdsRef.current.delete(reviewId);
          setActivePkmToolCount((count) => Math.max(0, count - 1));
        }
      };

      window.setTimeout(() => {
        void saveInBackground();
      }, 0);
    },
    [appendDebugEvent, getVaultOwnerToken, pkmReviews, user?.uid, vaultKey]
  );

  const saveEligiblePkmCardsInBackground = useCallback(
    (params: {
      turnId: string;
      sourceMessage: string;
      cards: AgentPkmPreviewCard[];
      policy: AgentPkmAutoSavePolicy;
    }) => {
      const token = getVaultOwnerToken();
      const autoSavePolicyEnabledAt = params.policy.enabledAt;
      if (
        !user?.uid ||
        !vaultKey ||
        !token ||
        !params.policy.enabled ||
        !autoSavePolicyEnabledAt ||
        params.cards.length === 0
      ) {
        return;
      }
      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(params.turnId, "pkm_auto_save_start", {
        candidate_count: params.cards.length,
        policy_version: params.policy.version,
      });

      window.setTimeout(() => {
        void (async () => {
          try {
            const result = await addToPKM({
              userId: user.uid,
              cards: params.cards,
              sourceMessage: params.sourceMessage,
              vaultKey,
              vaultOwnerToken: token,
              source: "agent_chat_auto_save",
              confirmation: {
                authorizationMode: "owner_auto_save_policy",
                surface: "chat",
                source: "agent_chat_auto_save_policy",
                autoSavePolicyVersion: params.policy.version,
                autoSavePolicyEnabledAt,
              },
            });
            appendDebugEvent(params.turnId, "pkm_auto_save_result", result);
            trackEvent("agent_pkm_save_confirmation_completed", {
              route_id: "agent",
              result: result.saved > 0 ? "success" : "expected_error",
              saved_count_bucket: toPkmFactCountBucket(result.saved),
              failed_count_bucket: toPkmFactCountBucket(result.failed),
              has_active_recipients: false,
            });
            if (result.saved > 0) {
              setMessages((current) => [
                ...current,
                {
                  id: `pkm-auto-save-receipt-${Date.now()}`,
                  role: "assistant",
                  text: formatAgentPkmSaveSummary(result),
                  timestamp: formatNow(),
                  status: "done",
                },
              ]);
              void loadAgentPkmContext({
                userId: user.uid,
                vaultOwnerToken: token,
                vaultKey,
                forceRefresh: true,
              }).catch(() => undefined);
            }
            if (result.failed > 0) {
              const failedIds = new Set(
                result.results.filter((item) => !item.success).map((item) => item.cardId)
              );
              const failedCards = params.cards.filter((card) => failedIds.has(card.card_id));
              if (failedCards.length > 0) {
                setPkmReviews((current) => {
                  const existing = current.find((review) => review.turnId === params.turnId);
                  if (!existing) {
                    return [
                      ...current,
                      {
                        id: `${params.turnId}-pkm-review`,
                        turnId: params.turnId,
                        sourceMessage: params.sourceMessage,
                        cards: failedCards,
                        saving: false,
                      },
                    ];
                  }
                  const cards = [...existing.cards, ...failedCards].filter(
                    (card, index, all) =>
                      all.findIndex((candidate) => candidate.card_id === card.card_id) === index
                  );
                  return current.map((review) =>
                    review.id === existing.id ? { ...review, cards } : review
                  );
                });
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Automatic memory saving failed.";
            appendDebugEvent(params.turnId, "pkm_auto_save_failed", { message });
          } finally {
            setActivePkmToolCount((count) => Math.max(0, count - 1));
          }
        })();
      }, 0);
    },
    [appendDebugEvent, getVaultOwnerToken, user?.uid, vaultKey]
  );

  const runAgentTurn = async (
    textInput: string,
    options: AgentRunTurnOptions = { source: "typed" }
  ) => {
    const text = textInput.trim();
    if (!text || !hasChatAccess || !user?.uid) return;
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
    let toolStatusMessageId: string | null = null;
    let pkmStatusItemId: string | null = null;
    let turnPkmContext = EMPTY_PKM_CONTEXT;
    let pkmAddToolHandled = false;
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
        streamEvents: [],
      }));
      setIsChatLoading(false);
      setIsStreaming(false);
    };

    const upsertTurnStreamEvent = (event: AgentVisibleStreamEvent) => {
      upsertMessageStreamEvent(assistantMessageId, event);
    };

    const upsertToolStatusMessage = (
      messageText: string,
      status: AgentMessage["status"] = "streaming"
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
      status: AgentPkmActivity["status"] = "streaming"
    ) => {
      if (latestVisibleTurnIdRef.current !== debugTurnId) return;
      const cleanText = messageText.trim();
      if (!cleanText) {
        if (pkmStatusItemId) {
          setPkmActivity((current) => current.filter((item) => item.id !== pkmStatusItemId));
          pkmStatusItemId = null;
        }
        return;
      }
      if (pkmStatusItemId) {
        setPkmActivity((current) =>
          current.map((item) =>
            item.id === pkmStatusItemId
              ? {
                  ...item,
                  text: cleanText,
                  status,
                }
              : item
          )
        );
        return;
      }
      const nextStatusItemId = `pkm-status-${turnId}`;
      pkmStatusItemId = nextStatusItemId;
      setPkmActivity((current) => [
        ...current.slice(-4),
        {
          id: nextStatusItemId,
          text: cleanText,
          status,
        },
      ]);
    };

    const toolResultStatus = (result: AgentActionRuntimeResult): AgentMessage["status"] => {
      if (result.status === "blocked" || result.status === "failed" || result.status === "invalid") {
        return "error";
      }
      return "done";
    };

    const executePkmAddTool = async (toolEvent: AgentChatToolEvent) => {
      if (!vaultKey || !token) {
        appendDebugEvent(debugTurnId, "pkm_tool_skipped", {
          reason: !vaultKey ? "vault_key_unavailable" : "vault_owner_token_unavailable",
          tool: toolEvent,
        });
        upsertPkmStatusMessage("Unlock your vault before saving to Memory.", "error");
        return;
      }

      const sourceText =
        typeof toolEvent.slots.source_text === "string" && toolEvent.slots.source_text.trim()
          ? toolEvent.slots.source_text.trim()
          : text;

      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(debugTurnId, "pkm_tool_preview_start", {
        tool: "pkm.add",
        current_domains: turnPkmContext.domains,
        source_text: sourceText,
      });
      upsertPkmStatusMessage("Checking what belongs in Memory...", "streaming");

      try {
        const preview = await previewAgentPkmMemory({
          userId,
          message: sourceText,
          currentDomains: turnPkmContext.domains,
          vaultOwnerToken: token,
        });
        const confirmationCards = getPkmConfirmationCards(preview.cards);
        const ignoredCards = getIgnoredPkmCards(preview.cards);

        appendDebugEvent(debugTurnId, "pkm_tool_preview_result", {
          model: preview.model,
          used_fallback: preview.used_fallback,
          total_cards: preview.cards.length,
          confirmation_count: confirmationCards.length,
          ignored_count: ignoredCards.length,
          preview_summary: preview.preview_summary || null,
          cards: preview.cards,
        });

        if (confirmationCards.length > 0 && latestVisibleTurnIdRef.current === debugTurnId) {
          setPkmReviews((current) => [
            ...current.filter((review) => review.turnId !== debugTurnId),
            {
              id: `${debugTurnId}-pkm-review`,
              turnId: debugTurnId,
              sourceMessage: sourceText,
              cards: confirmationCards,
              saving: false,
            },
          ]);
          appendDebugEvent(debugTurnId, "pkm_tool_review_required", {
            candidate_count: confirmationCards.length,
            cards: confirmationCards,
          });
          upsertPkmStatusMessage(
            "One found a memory that needs your review before saving.",
            "done"
          );
        }

        if (confirmationCards.length === 0) {
          upsertPkmStatusMessage("I didn't find a memory to save from that.", "done");
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "One could not save that memory.";
        appendDebugEvent(debugTurnId, "pkm_tool_failed", {
          message,
          tool: toolEvent,
        });
        upsertPkmStatusMessage("One could not save that memory.", "error");
      } finally {
        setActivePkmToolCount((count) => Math.max(0, count - 1));
      }
    };

    const executeFrontendTool = async (
      toolEvent: AgentChatToolEvent,
    ): Promise<AgentActionRuntimeResult> => {
      if (!toolEvent.actionId) {
        throw new Error("The proposed action has no action ID.");
      }
      appendDebugEvent(debugTurnId, "frontend_execute_start", toolEvent);

      if (toolEvent.actionId === "pkm.add") {
        pkmAddToolHandled = true;
        await executePkmAddTool(toolEvent);
        return {
          status: "succeeded",
          actionId: toolEvent.actionId,
          label: toolEvent.label,
          routeBefore: pathname,
          resultSummary: "Memory review prepared.",
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
        appInteractionCoordinator.updateActionRun(actionRun.id, { phase: "executing" });
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
        if (shouldMinimizeForNavigationResult(result)) {
          onNavigationActionComplete?.(result);
        }
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
      const callKey = toolEvent.callId || `${toolEvent.actionId || "unknown"}-${turnId}`;
      if (executedToolCalls.has(callKey)) return;
      if (toolEvent.execution !== "frontend" || !toolEvent.actionId) return;
      const directiveId = toolEvent.directiveId;
      const conversationId = toolEvent.conversationId;
      const contextRevision = toolEvent.contextRevision;
      if (!directiveId || !conversationId || !contextRevision) return;
      setPendingAppAction({
        event: toolEvent,
        cancel: async () => {
          if (
            !toolEvent.directiveId ||
            !toolEvent.conversationId ||
            !toolEvent.contextRevision
          ) {
            return;
          }
          await cancelAgentChatAction({
            directiveId: toolEvent.directiveId,
            userId,
            conversationId: toolEvent.conversationId,
            actionId: toolEvent.actionId!,
            contextRevision: toolEvent.contextRevision,
            reasonCode: "user_cancelled",
            vaultOwnerToken: token!,
          });
        },
        authorize: async () => {
          if (executedToolCalls.has(callKey)) {
            throw new Error("This action was already consumed.");
          }
          const confirmation = await confirmAgentChatAction({
            directiveId,
            userId,
            conversationId,
            actionId: toolEvent.actionId!,
            contextRevision,
            trustedActivation: true,
            vaultOwnerToken: token!,
          });
          await consumeAgentChatAction({
            directiveId,
            userId,
            conversationId,
            actionId: toolEvent.actionId!,
            contextRevision,
            receipt: confirmation.receipt,
            vaultOwnerToken: token!,
          });
          return confirmation.receipt;
        },
        execute: async (receipt) => {
          if (!receipt) {
            throw new Error("This action needs a fresh confirmation before it can run.");
          }
          if (executedToolCalls.has(callKey)) {
            throw new Error("This action was already consumed.");
          }
          executedToolCalls.add(callKey);
          const result = await executeFrontendTool(toolEvent);
          const succeeded = ["succeeded", "started", "noop"].includes(result.status);
          await settleAgentChatAction({
            directiveId,
            userId,
            receipt,
            actionId: toolEvent.actionId!,
            contextRevision,
            status: succeeded ? "succeeded" : "failed",
            reasonCode: succeeded ? "completed" : result.reason || result.status,
            vaultOwnerToken: token!,
          });
          return result;
        },
      });
    };

    const runPkmMemoryCapture = async (
      pkmContext: AgentPkmContext,
      signal: AbortSignal
    ) => {
      if (signal.aborted) return;
      if (!vaultKey || !token) {
        appendDebugEvent(debugTurnId, "pkm_memory_skipped", {
          reason: !vaultKey ? "vault_key_unavailable" : "vault_owner_token_unavailable",
        });
        return;
      }

      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(debugTurnId, "pkm_memory_preview_start", {
        tool: "addToPKM",
        execution: "frontend",
        current_domains: pkmContext.domains,
      });
      upsertPkmStatusMessage("Checking whether this belongs in Memory...", "streaming");

      try {
        const preview = await previewAgentPkmMemory({
          userId,
          message: text,
          currentDomains: pkmContext.domains,
          vaultOwnerToken: token,
        });
        if (signal.aborted) return;
        const cards = preview.cards;
        const autoSaveCards = getPkmAutoSaveCards(cards);
        const confirmationCards = [
          ...getPkmConfirmationCards(cards),
          ...(pkmAutoSavePolicy.enabled ? [] : autoSaveCards),
        ].filter(
          (card, index, all) =>
            all.findIndex((candidate) => candidate.card_id === card.card_id) === index
        );
        const ignoredCards = getIgnoredPkmCards(cards);

        appendDebugEvent(debugTurnId, "pkm_memory_preview_result", {
          model: preview.model,
          used_fallback: preview.used_fallback,
          total_cards: cards.length,
          auto_save_count: autoSaveCards.length,
          auto_save_enabled: pkmAutoSavePolicy.enabled,
          confirmation_count: confirmationCards.length,
          ignored_count: ignoredCards.length,
          preview_summary: preview.preview_summary || null,
          cards,
        });

        if (confirmationCards.length > 0 && latestVisibleTurnIdRef.current === debugTurnId) {
          if (signal.aborted) return;
          setPkmReviews((current) => [
            ...current.filter((review) => review.turnId !== debugTurnId),
            {
              id: `${debugTurnId}-pkm-review`,
              turnId: debugTurnId,
              sourceMessage: text,
              cards: confirmationCards,
              saving: false,
            },
          ]);
          appendDebugEvent(debugTurnId, "pkm_memory_review_required", {
            candidate_count: confirmationCards.length,
            cards: confirmationCards,
          });
          upsertPkmStatusMessage(
            "One found a memory that needs your review before saving.",
            "done"
          );
        }

        if (confirmationCards.length === 0) {
          upsertPkmStatusMessage("", "done");
        }
        if (pkmAutoSavePolicy.enabled && autoSaveCards.length > 0) {
          saveEligiblePkmCardsInBackground({
            turnId: debugTurnId,
            sourceMessage: text,
            cards: autoSaveCards,
            policy: pkmAutoSavePolicy,
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        const message =
          error instanceof Error && error.message
            ? error.message
            : "One could not update Memory for this message.";
        appendDebugEvent(debugTurnId, "pkm_memory_failed", {
          message,
        });
        upsertPkmStatusMessage("One could not update Memory for this message.", "error");
      } finally {
        setActivePkmToolCount((count) => Math.max(0, count - 1));
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
      return [...current, ...(appendUserMessage ? [userMessage] : []), assistantMessage];
    });
    latestVisibleTurnIdRef.current = debugTurnId;
    setPkmActivity([]);
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
    let specialistDirectiveReceived = false;
    const pkmContextStartedAt = performance.now();

    const loadTurnPkmContext = async (): Promise<AgentPkmContext> => {
      if (!vaultKey) {
        throw new Error("Your vault must remain unlocked while One prepares your private memory.");
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
        throw new Error("One could not prepare your private memory for this turn. Please try again.");
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
            context_mode: agentPkmContext.mode === "broad" ? "broad" : "relevant",
            total_fact_count_bucket: toPkmFactCountBucket(coverage?.totalFactCount || 0),
            selected_fact_count_bucket: toPkmFactCountBucket(coverage?.selectedFactCount || 0),
            context_clipped: coverage?.clipped === true,
            inventory_only: coverage?.inventoryOnly === true,
            safety_omitted: (coverage?.safetyOmittedNodeCount || 0) > 0,
            duration_ms_bucket: toDurationBucket(performance.now() - pkmContextStartedAt),
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

      const runtimeConnection = await resolveGeminiRuntimeConnection({
        userId,
        vaultKey,
        vaultOwnerToken: token,
      });
      const streamResult = await streamAgentChat({
        userId,
        message: text,
        conversationId: conversationIdRef.current,
        vaultOwnerToken: token,
        pkmContext: agentPkmContext.text || undefined,
        screenContext: buildOneVoiceStructuredScreenContext({
          appRuntimeState: appRuntimeStateRef.current,
          state: useAgentVoiceState.getState().oneVoiceState,
          lastTransition: useAgentVoiceState.getState().lastTransition,
        }) as unknown as Record<string, unknown>,
        runtimeCredentialMode: runtimeConnection.mode,
        runtimeCredential: runtimeConnection.credential,
        runtimeCredentialTransport: runtimeConnection.transport,
        runtimeVertexProject: runtimeConnection.vertexProject,
        runtimeVertexLocation: runtimeConnection.vertexLocation,
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
            upsertTurnStreamEvent(agentToolEventToVisibleStreamEvent("start", toolEvent));
          },
          onToolWaiting: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_waiting", toolEvent);
            const visibleEvent = agentToolEventToVisibleStreamEvent("waiting", toolEvent);
            upsertTurnStreamEvent(visibleEvent);
            stageToolForConfirmation(toolEvent);
          },
          onToolResult: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_result", toolEvent);
            const visibleEvent = agentToolEventToVisibleStreamEvent("result", toolEvent);
            upsertTurnStreamEvent(visibleEvent);
          },
          onToken: (delta) => {
            if (streamAbortController.signal.aborted) return;
            queueAssistantDelta(delta);
          },
          onThought: (delta) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              thought: (message.thought ?? "") + delta,
            }));
          },
          onSources: (sources) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              sources,
            }));
          },
          onSpecialistDirective: (event) => {
            if (streamAbortController.signal.aborted) return;
            specialistDirectiveReceived = true;
            // Store the directive as a pending card in the current message
            // stream. Security-sensitive: never auto-run an "action"; require
            // an explicit click on the rendered card.
            appendDebugEvent(debugTurnId, "specialist_directive", event);
            flushAssistantDelta();
            setIsChatLoading(false);
            setIsStreaming(false);
            if (getConsentActionsPayload(event)) {
              updateMessage(assistantMessageId, (message) => ({
                ...message,
                text: message.text.trim() ? message.text : event.message || "",
                status: "done",
                specialistDirective: event,
                streamEvents: [],
              }));
              return;
            }
            setMessages((current) =>
              current.flatMap((message) => {
                if (message.id !== assistantMessageId) return [message];
                if (!message.text.trim()) return [];
                return [{ ...message, status: "done", streamEvents: [] }];
              })
            );
            setPendingSpecialistDirective(event);
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
              streamEvents: [],
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
              streamEvents: [],
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
      flushAssistantDelta();
      if (streamResult.conversationId) {
        updateConversationId(streamResult.conversationId);
      }
      updateMessage(assistantMessageId, (message) => {
        if (message.status === "error") return message;
        return {
          ...message,
          text: message.text || "I couldn't generate a response. Please try again.",
          status: "done",
          streamEvents: [],
        };
      });
      if (
        !specialistDirectiveReceived &&
        !pkmAddToolHandled
      ) {
        const pkmAbortController = new AbortController();
        pkmAbortControllersRef.current.add(pkmAbortController);
        void runPkmMemoryCapture(turnPkmContext, pkmAbortController.signal).finally(() => {
          pkmAbortControllersRef.current.delete(pkmAbortController);
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
        streamEvents: [],
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
      const runtimeConnection = await resolveGeminiRuntimeConnection({
        userId,
        vaultKey,
        vaultOwnerToken: token,
      });
      const streamResult = await streamAgentChat({
        userId,
        message: "",
        conversationId: conversationIdRef.current,
        vaultOwnerToken: token,
        delegateResult: result,
        screenContext: buildOneVoiceStructuredScreenContext({
          appRuntimeState: appRuntimeStateRef.current,
          state: useAgentVoiceState.getState().oneVoiceState,
          lastTransition: useAgentVoiceState.getState().lastTransition,
        }) as unknown as Record<string, unknown>,
        runtimeCredentialMode: runtimeConnection.mode,
        runtimeCredential: runtimeConnection.credential,
        runtimeCredentialTransport: runtimeConnection.transport,
        runtimeVertexProject: runtimeConnection.vertexProject,
        runtimeVertexLocation: runtimeConnection.vertexLocation,
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
          onThought: (delta) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              thought: (message.thought ?? "") + delta,
            }));
          },
          onSources: (sources) => {
            if (streamAbortController.signal.aborted) return;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              sources,
            }));
          },
          onSpecialistDirective: (event) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "specialist_directive", event);
            flushAssistantDelta();
            setIsChatLoading(false);
            setIsStreaming(false);
            if (getConsentActionsPayload(event)) {
              updateMessage(assistantMessageId, (message) => ({
                ...message,
                text: message.text.trim() ? message.text : event.message || "",
                status: "done",
                specialistDirective: event,
              }));
              return;
            }
            setMessages((current) =>
              current.flatMap((message) => {
                if (message.id !== assistantMessageId) return [message];
                if (!message.text.trim()) return [];
                return [{ ...message, status: "done" }];
              })
            );
            setPendingSpecialistDirective(event);
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
          appInteractionCoordinator.updateActionRun(actionRun.id, { phase: "executing" });
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
          appInteractionCoordinator.finishActionRunFromSettlement(actionRun.id, {
            status: result.status,
            summary: result.resultSummary,
            reason: result.reason,
            routeAfter: result.routeAfter,
            screenAfter: result.screenAfter,
          });
          if (shouldMinimizeForNavigationResult(result)) {
            onNavigationActionComplete?.(result);
          }
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

  const enqueuePrompt = (textInput: string) => {
    const text = textInput.trim();
    if (!text) return;
    const prompt: QueuedAgentPrompt = {
      id: crypto.randomUUID(),
      text,
      createdAtMs: Date.now(),
    };
    const operation: QueuedWorkspaceOperation = {
      id: prompt.id,
      prompt,
      run: async () => {
        if (hasChatAccess) {
          await runAgentTurn(operation.prompt?.text ?? "", { source: "typed" });
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
    operationQueueRef.current.replace(operationQueueRef.current.snapshot().map((operation) =>
      operation.prompt?.id === id
        ? { ...operation, prompt: { ...operation.prompt, text } }
        : operation,
    ));
    setQueuedPrompts((current) => editQueuedAgentPrompt(current, id, text));
    setEditingQueuedPromptId(null);
    setEditingQueuedPromptText("");
  };

  const removeQueuedPrompt = (id: string) => {
    operationQueueRef.current.replace(operationQueueRef.current.snapshot().filter(
      (operation) => operation.prompt?.id !== id,
    ));
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
    const actionKey = String(payload.proposalId ?? payload.id ?? directive.message);
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
    });
    setPendingSpecialistDirective(null);
    setSpecialistBusy(true);

    enqueueWorkspaceOperation({
      id: `calendar-${actionKey}`,
      run: async () => {
        try {
          const result = await runCalendarDirective(directive.directive, token, userId);
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || isLoadingHistory || isVoiceConnecting || voiceActive) return;
    setInput("");
    setComposerExpanded(false);
    enqueuePrompt(text);
  };

  handoffPromptSubmitRef.current = async (prompt: string) => {
    enqueuePrompt(prompt);
  };

  useEffect(() => {
    const prompt = queuedHandoffPrompt?.trim();
    if (!prompt) return;
    setQueuedHandoffPrompt(null);
    enqueuePrompt(prompt);
  }, [enqueuePrompt, queuedHandoffPrompt]);

  useEffect(() => {
    if (!isPopover || !isSurfaceClosing) return;
    setIsHistoryDrawerOpen(false);
  }, [isPopover, isSurfaceClosing]);

  // Agent Chat never owns audio. Its microphone affordance delegates to the
  // persistent Agent Bar, which is the sole owner of One Live and native audio.
  const startConversationalVoice = requestAgentConversation;

  // The single agent bar always works. Before the vault is unlocked it runs the
  // informational tier (help + navigation), so the access banner is a soft,
  // non-blocking affordance, not a wall. It only surfaces when the user is
  // signed in but the vault is locked, offering an in-place unlock to upgrade
  // to the full agent. Anonymous visitors get a quiet sign-in nudge instead.
  const needsVaultUnlock = Boolean(
    user?.uid && (!isVaultUnlocked || !vaultOwnerToken || !tokenIsFresh)
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
    [user?.displayName, user?.email]
  );
  const hasStartedConversation = messages.some((message) => message.id !== "agent-greeting");
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
    })
  );
  const trailingSpecialistLoadingMessages = pendingSpecialistDirective
    ? messages.filter(
        (message) =>
          message.id !== "agent-greeting" &&
          message.role === "assistant" &&
          !message.text.trim(),
      )
    : [];
  const latestRetryableAssistantId =
    [...visibleMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          !message.ephemeral &&
          message.status !== "streaming" &&
          message.text.trim().length > 0
      )?.id ?? null;
  const handleRetryAssistantResponse = (messageId: string) => {
    const assistantIndex = messages.findIndex((message) => message.id === messageId);
    if (assistantIndex < 0) return;
    const previousUserMessage = [...messages.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === "user" && message.text.trim().length > 0);
    const retryText = previousUserMessage?.text.trim();
    if (!retryText) {
      toast.error("No previous message found to retry.");
      return;
    }
    setPkmReviews([]);
    setPkmActivity([]);
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
  const swipeStartYRef = useRef<number | null>(null);
  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onMinimize || event.pointerType === "mouse") return;
    swipeStartYRef.current = event.clientY;
  };
  const handleHeaderPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onMinimize || swipeStartYRef.current === null) return;
    const deltaY = event.clientY - swipeStartYRef.current;
    swipeStartYRef.current = null;
    if (deltaY > 72) {
      onMinimize();
    }
  };
  const openHistoryDrawer = useCallback(() => {
    historyDrawerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsHistoryDrawerOpen(true);
    void loadConversationList().catch(() => undefined);
  }, [loadConversationList]);
  const handlePageMinimize = useCallback(() => {
    if (onMinimize) {
      onMinimize();
      return;
    }
    if (typeof window !== "undefined") {
      const referrer = document.referrer ? new URL(document.referrer) : null;
      const isSameOriginReferrer =
        referrer?.origin === window.location.origin && referrer.pathname !== ROUTES.AGENT;
      if (isSameOriginReferrer && window.history.length > 1) {
        router.back();
        return;
      }
    }
    router.push(ROUTES.PROFILE);
  }, [onMinimize, router]);
  const handleHistoryDrawerKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setIsHistoryDrawerOpen(false);
      return;
    }
    trapFocusWithin(event, historyDrawerRef.current);
  }, []);
  const renderHistorySidebar = (
    sidebarClassName?: string,
    onClose?: () => void,
    collapsed = false,
    mode: "desktop" | "mobile" = "desktop"
  ) => (
    <AgentHistorySidebar
      conversations={conversations}
      activeConversationId={conversationId}
      loading={isLoadingHistory && conversations.length === 0}
      disabled={!hasChatAccess || historyInteractionDisabled}
      actionPendingId={historyActionPendingId}
      className={sidebarClassName}
      collapsed={collapsed}
      mode={mode}
      onClose={onClose}
      onToggleCollapsed={() => setIsHistoryCollapsed((current) => !current)}
      onCreateNew={handleSidebarCreateNewChat}
      onSelectConversation={handleSidebarSelectConversation}
      onRenameConversation={handleRenameConversation}
      onDeleteConversation={handleDeleteConversation}
    />
  );

  return (
    <div
      className={cn(
        "agent-chat-workspace flex min-h-0 w-full flex-col text-foreground",
        isPopover
          ? "h-full overflow-hidden bg-background"
          : "h-[calc(100dvh-var(--app-top-content-offset,0px)-var(--app-bottom-fixed-ui,0px)-var(--app-safe-area-bottom-effective,0px))] min-h-[420px] overflow-hidden bg-background",
        className
      )}
      data-agent-chat-workspace={variant}
    >
      <div
        className={cn(
          "relative flex min-h-0 flex-1",
          // The popover and page both use one continuous workspace surface.
          // The outer popover owns its floating frame; no inner card is allowed.
          "overflow-hidden"
        )}
      >
        <div className="hidden h-full lg:flex">
          {renderHistorySidebar("h-full", undefined, isHistoryCollapsed)}
        </div>
        <div
          className={cn(
            "fixed inset-0 z-[520] bg-black/35 backdrop-blur-sm transition-opacity duration-200 dark:bg-black/55 lg:hidden",
            isHistoryDrawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
          )}
          aria-hidden="true"
          onClick={() => setIsHistoryDrawerOpen(false)}
        />
        <div
          ref={historyDrawerRef}
          className={cn(
            "fixed bottom-0 left-0 top-[var(--top-shell-reserved-height,var(--app-safe-area-top-effective,0px))] z-[530] w-[min(88vw,320px)] transform transition-transform duration-200 ease-out lg:hidden",
            isHistoryDrawerOpen ? "translate-x-0" : "-translate-x-full"
          )}
          role="dialog"
          aria-modal="true"
          aria-hidden={!isHistoryDrawerOpen}
          aria-label="Agent chat history"
          inert={!isHistoryDrawerOpen}
          onKeyDown={handleHistoryDrawerKeyDown}
        >
          {renderHistorySidebar(
            "h-full w-full",
            () => setIsHistoryDrawerOpen(false),
            false,
            "mobile"
          )}
        </div>

        <section
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
          )}
          inert={isHistoryDrawerOpen}
        >
          <div
            className={cn(
              "agent-chat-header flex shrink-0 touch-pan-y items-center justify-between gap-3 border-b border-border/70 bg-background/92 px-4 pt-[var(--agent-chat-header-safe-top)] backdrop-blur sm:px-5",
              isPopover
                ? "min-h-[calc(3.5rem+var(--agent-chat-header-safe-top))] sm:h-16 sm:min-h-16 sm:pt-0"
                : "min-h-[calc(3.75rem+var(--agent-chat-header-safe-top))] sm:min-h-[calc(4rem+var(--app-safe-area-top-effective,0px))] sm:pt-[var(--app-safe-area-top-effective,0px)]",
              !isPopover && "lg:px-6"
            )}
            onPointerDown={handleHeaderPointerDown}
            onPointerUp={handleHeaderPointerEnd}
            onPointerCancel={() => {
              swipeStartYRef.current = null;
            }}
          >
            <div className="flex min-w-0 items-center gap-3">
              {isPopover && onMinimize ? (
                <ShellActionSurface
                  variant="icon"
                  onClick={onMinimize}
                  aria-label="Back"
                  title="Back"
                  className="sm:hidden"
                >
                  <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
                </ShellActionSurface>
              ) : null}
              {!isPopover ? (
                <ShellActionSurface
                  variant="icon"
                  className="lg:hidden"
                  onClick={openHistoryDrawer}
                  aria-label="Open chat history"
                  title="Open chat history"
                >
                  <Menu className="h-4 w-4" />
                </ShellActionSurface>
              ) : null}
              <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted max-sm:h-11 max-sm:w-11 max-sm:rounded-[13px] max-sm:border-[color:var(--app-accent-border)]">
                <Image
                  src="/one-quiet-emoji.png"
                  alt="One"
                  width={762}
                  height={766}
                  unoptimized
                  draggable={false}
                  className="h-6 w-6 object-contain max-sm:h-8 max-sm:w-8"
                />
              </div>
              <div className="min-w-0">
                <div className="truncate text-base font-medium leading-5 text-foreground">
                  One
                </div>
                <p className="hidden truncate text-xs text-muted-foreground sm:block">
                  Your private agent
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground sm:inline-flex">
                {statusText}
              </span>
              {isPopover ? (
                <ShellActionSurface
                  variant="icon"
                  className="sm:hidden"
                  onClick={openHistoryDrawer}
                  aria-label="Open chat history"
                  title="Open chat history"
                >
                  <Menu className="h-4 w-4" />
                </ShellActionSurface>
              ) : null}
              {!isPopover ? (
                <ShellActionSurface
                  variant="icon"
                  className="lg:hidden"
                  onClick={handlePageMinimize}
                  aria-label="Minimize Agent"
                  title="Minimize Agent"
                >
                  <Minus className="h-4 w-4" />
                </ShellActionSurface>
              ) : null}
              {windowControls ? <div className="ml-1">{windowControls}</div> : null}
            </div>
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto scroll-smooth px-4 pt-5 scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent sm:px-6",
              isPopover ? "pb-4" : "pb-6 lg:px-8"
            )}
          >
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6">
              {accessMessage ? (
                <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/35 px-4 py-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>{accessMessage}</span>
                  {accessAction ? (
                    <Button
                      type="button"
                      size="sm"
                      className="w-full shrink-0 gap-2 rounded-lg sm:w-auto"
                      onClick={accessAction.onClick}
                    >
                      <accessAction.icon className="h-4 w-4" aria-hidden="true" />
                      {accessAction.label}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!hasStartedConversation ? (
                <AgentWelcomePanel
                  name={displayName}
                  prompts={welcomePrompts}
                  disabled={isChatLoading || isStreaming}
                  onPromptSelect={handleWelcomePromptSelect}
                />
              ) : null}

              {visibleMessages.map((message) =>
                message.kind === "selection" ? (
                  <SelectionChip key={message.id} label={message.text} />
                ) : (
                  <AgentBubble
                    key={message.id}
                    message={message}
                    retryDisabled={isChatLoading || isStreaming}
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
                          specialistDirective: markConsentDirectiveItemRevoked(
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
                      setSpecialistBusyItemId(item.id);
                      try {
                        await consentActions.handleApprove(
                          pendingConsentCardItemToPendingConsent(item),
                        );
                        updateMessage(message.id, (current) => ({
                          ...current,
                          specialistDirective: markPendingConsentRequestDirectiveStatus(
                            current.specialistDirective,
                            item.id,
                            "approved",
                          ),
                        }));
                      } finally {
                        setSpecialistBusyItemId(null);
                      }
                    }}
                    onPendingConsentDeny={async (item) => {
                      setSpecialistBusyItemId(item.id);
                      try {
                        await consentActions.handleDeny(item.id);
                        updateMessage(message.id, (current) => ({
                          ...current,
                          specialistDirective: markPendingConsentRequestDirectiveStatus(
                            current.specialistDirective,
                            item.id,
                            "denied",
                          ),
                        }));
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
                ),
              )}

              {pkmActivity.map((item) => (
                <AgentPkmActivityLine key={item.id} item={item} />
              ))}

              {pkmReviews.map((review) => (
                <AgentPkmReviewPanel
                  key={review.id}
                  cards={review.cards}
                  saving={review.saving}
                  onSave={() => void handleSavePkmReview(review.id)}
                  onDismiss={() => handleDismissPkmReview(review.id)}
                />
              ))}

              {pendingAppAction ? (
                <SpecialistDirectiveCard
                  summary={
                    pendingAppAction.event.message ||
                    `One is ready to ${pendingAppAction.event.label || "continue"}. Nothing runs until you confirm.`
                  }
                  confirmLabel={
                    pendingAppAction.authorize && !pendingAppAction.receipt
                      ? "Authorize"
                      : pendingAppAction.event.label || "Run"
                  }
                  busy={appActionBusy}
                  onConfirm={async () => {
                    const pending = pendingAppAction;
                    if (!pending || appActionBusy) return;
                    setAppActionBusy(true);
                    try {
                      if (pending.authorize && !pending.receipt) {
                        const receipt = await pending.authorize();
                        setPendingAppAction((current) =>
                          current === pending ? { ...current, receipt } : current,
                        );
                        toast.success("Authorized. Tap Run to execute.");
                        return;
                      }
                      await pending.execute(pending.receipt);
                      setPendingAppAction(null);
                    } catch {
                      setPendingAppAction(null);
                      addErrorMessage("The app could not complete the confirmed action.");
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
                      getConsentRequiredPayload(pendingSpecialistDirective)?.agentId ??
                      pendingSpecialistDirective.delegateAgentId
                    }
                    requiredScope={
                      getConsentRequiredPayload(pendingSpecialistDirective)?.requiredScope ?? ""
                    }
                    reason={getConsentRequiredPayload(pendingSpecialistDirective)?.reason}
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
                  pendingSpecialistDirective.delegateAgentId === "agent_connected_systems" &&
                  pendingSpecialistDirective.directive.payload.kind === "free_text" ? (
                  <SpecialistFreeTextPromptCard
                    question={String(
                      pendingSpecialistDirective.directive.payload.question ??
                        "What value should I use?",
                    )}
                    placeholder={String(
                      pendingSpecialistDirective.directive.payload.placeholder ?? "",
                    )}
                    confirmLabel={
                      typeof pendingSpecialistDirective.directive.payload.confirmLabel === "string"
                        ? pendingSpecialistDirective.directive.payload.confirmLabel
                        : null
                    }
                    cancelLabel={
                      typeof pendingSpecialistDirective.directive.payload.cancelLabel === "string"
                        ? pendingSpecialistDirective.directive.payload.cancelLabel
                        : null
                    }
                    busy={specialistBusy}
                    onSubmit={async (value) => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive.payload as Record<string, unknown>;
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
                      const prompt = evt.directive.payload as Record<string, unknown>;
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
                    prompt={pendingSpecialistDirective.directive.payload as unknown as ClientPrompt}
                    busy={specialistBusy}
                    onAnswer={async (refs) => {
                      const evt = pendingSpecialistDirective;
                      const prompt = evt.directive.payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, { selected: refs });
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
                          delegate_agent_id: evt.delegateAgentId as DelegateResult["delegate_agent_id"],
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
                      const prompt = evt.directive.payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, { confirmed: yes });
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
                          delegate_agent_id: evt.delegateAgentId as DelegateResult["delegate_agent_id"],
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
                      const prompt = evt.directive.payload as unknown as ClientPrompt;
                      const display = describeSelection(prompt, { status: "cancelled" });
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
                        delegate_agent_id: evt.delegateAgentId as DelegateResult["delegate_agent_id"],
                        kind: "selection",
                        id: prompt.id,
                        promptKind: prompt.kind,
                        status: "cancelled",
                        display,
                      });
                    }}
                  />
                ) : pendingSpecialistDirective.delegateAgentId === "agent_calendar" ? (
                  <SpecialistDirectiveCard
                    summary={String(
                      (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                        .summary ?? pendingSpecialistDirective.message,
                    )}
                    confirmLabel={String(
                      (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                        .confirmLabel ?? "Continue",
                    )}
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      const payload = directive.directive.payload as Record<string, unknown>;
                      const type = String(payload.type ?? "");
                      if (type === "calendar.connect") {
                        if (!user?.uid) {
                          addErrorMessage("Sign in again before connecting Google Calendar.");
                          return;
                        }
                        setSpecialistBusy(true);
                        try {
                          const accessLevel =
                            payload.accessLevel === "manage" ? "manage" : "read";
                          clearCalendarSetupOAuthReturn();
                          const start = await GoogleCalendarService.startConnect({
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
                        addErrorMessage("That Calendar action is no longer available.");
                        return;
                      }
                      const token = getVaultOwnerToken();
                      if (!token || !user?.uid) {
                        addErrorMessage("Vault access expired. Unlock again to continue.");
                        return;
                      }
                      enqueueCalendarDirective(directive, token, user.uid);
                    }}
                    onCancel={() => {
                      setPendingSpecialistDirective(null);
                      toast.info("Calendar change cancelled. Nothing was changed.");
                    }}
                  />
                ) : pendingSpecialistDirective.delegateAgentId === "agent_connected_systems" ? (
                  <SpecialistDirectiveCard
                    summary={String(
                      (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                        .summary ?? pendingSpecialistDirective.message,
                    )}
                    confirmLabel={String(
                      (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                        .confirmLabel ?? "Update",
                    )}
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      setSpecialistBusy(true);
                      try {
                        const token = getVaultOwnerToken();
                        if (!token) {
                          addErrorMessage("Vault access expired. Unlock again to continue.");
                          return;
                        }
                        const confirmLabel = String(
                          (directive.directive.payload as Record<string, unknown>)
                            .confirmLabel ?? "Update",
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
                          (directive.directive.payload as Record<string, unknown>).id ?? "",
                        ),
                        type: String(
                          (directive.directive.payload as Record<string, unknown>).type ?? "",
                        ),
                        status: "cancelled",
                      });
                    }}
                  />
                ) : (
                  // ── Action / crypto mode (existing path, unchanged) ───────
                  <SpecialistDirectiveCard
                    summary={String(
                      (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                        .summary ?? pendingSpecialistDirective.message,
                    )}
                    confirmLabel={
                      (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                        .type === "sos_panic"
                        ? "Send SMS"
                        : (pendingSpecialistDirective.directive.payload as Record<string, unknown>)
                              .type === "request_device_location_permission"
                          ? "Allow location"
                          : "Share"
                    }
                    busy={specialistBusy}
                    onConfirm={async () => {
                      const directive = pendingSpecialistDirective;
                      setSpecialistBusy(true);
                      const directivePayloadType = String(
                        (directive.directive.payload as Record<string, unknown>).type ?? "",
                      );
                      const confirmText =
                        directivePayloadType === "sos_panic"
                          ? "Send SMS"
                          : directivePayloadType === "request_device_location_permission"
                            ? "Allow location"
                            : "Share";
                      try {
                        // Source the vault owner token from the same place every
                        // other authed call uses (never hardcoded/invented).
                        const token = getVaultOwnerToken();
                        if (!token) {
                          addErrorMessage("Vault access expired. Unlock again to continue.");
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
                        if (directivePayloadType === "view_envelope" && result.status === "completed") {
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
                        delegate_agent_id: directive.delegateAgentId as DelegateResult["delegate_agent_id"],
                        kind: "action",
                        id: String(
                          (directive.directive.payload as Record<string, unknown>).id ?? "",
                        ),
                        // Include type so the backend renders the tailored cancel message.
                        type: String(
                          (directive.directive.payload as Record<string, unknown>).type ?? "",
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
                  retryDisabled={isChatLoading || isStreaming}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <form
            onSubmit={handleSubmit}
            className={cn(
              // CSS-only focus-within drives the padding shift in lockstep with
              // the native keyboard resize (no React state/rerender round-trip
              // in the path, which was the source of the visible lag on iOS).
              "shrink-0 border-t border-border/70 bg-background/92 px-3 pt-3 backdrop-blur transition-[padding-bottom] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)] motion-reduce:transition-none sm:px-5",
              isPopover
                ? "pb-[var(--agent-chat-composer-bottom)] sm:pb-3"
                : "pb-[var(--agent-chat-composer-bottom)] focus-within:pb-[var(--agent-chat-composer-focused-bottom)]"
            )}
          >
            <div className="mx-auto w-full max-w-4xl">
              {queuedPrompts.length > 0 ? (
                <div
                  className="mb-2 rounded-2xl border border-border/70 bg-muted/45 px-3 py-2"
                  data-testid="agent-chat-prompt-queue"
                  aria-live="polite"
                >
                  <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                    <span>{queuedPrompts.length} {queuedPrompts.length === 1 ? "message" : "messages"} queued</span>
                    <span>One will send these in order.</span>
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    {queuedPrompts.map((prompt, index) => (
                      <div
                        key={prompt.id}
                        className="flex min-w-0 items-center gap-2 rounded-xl bg-background/75 px-2 py-1.5 text-sm"
                      >
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                        {editingQueuedPromptId === prompt.id ? (
                          <input
                            autoFocus
                            aria-label="Edit queued message"
                            className="min-w-0 flex-1 bg-transparent outline-none"
                            value={editingQueuedPromptText}
                            onChange={(event) => setEditingQueuedPromptText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                editQueuedPrompt(prompt.id, editingQueuedPromptText);
                              }
                              if (event.key === "Escape") {
                                setEditingQueuedPromptId(null);
                                setEditingQueuedPromptText("");
                              }
                            }}
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate">{prompt.text}</span>
                        )}
                        {editingQueuedPromptId === prompt.id ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => editQueuedPrompt(prompt.id, editingQueuedPromptText)}
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
                <div className="rounded-[var(--app-card-radius-compact)] border border-border/70 bg-foreground/[0.04] p-2 shadow-[var(--app-card-shadow-standard)]">
                  <AgentVoiceWaveInput
                    status={voiceState}
                    level={voiceLevel}
                    muted={voiceMuted}
                    disabled={isVoiceConnecting}
                    onToggleMute={startConversationalVoice}
                    onCancel={startConversationalVoice}
                  />
                </div>
              ) : (
                <div
                  data-testid="agent-chat-composer"
                  className="flex min-h-14 items-end gap-2 rounded-[var(--app-radius-pill)] border border-border/70 bg-foreground/[0.04] px-3 py-2 shadow-[var(--app-card-shadow-standard)] transition-colors focus-within:border-primary/55 focus-within:ring-2 focus-within:ring-primary/20 max-sm:focus-within:border-[color:var(--app-accent)] max-sm:focus-within:ring-[color:var(--app-accent-ring)]"
                >
                  <div className="relative min-w-0 flex-1 self-stretch">
                    <textarea
                      ref={composerTextareaRef}
                      data-testid="agent-chat-composer-textarea"
                      aria-label="Message One"
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                          return;
                        }
                        event.preventDefault();
                        if (canSend) {
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      disabled={isLoadingHistory || isVoiceConnecting}
                      placeholder="Message One..."
                      rows={1}
                      className={cn(
                        "min-h-8 w-full resize-none overscroll-contain overflow-y-auto bg-transparent px-1 py-2 pr-9 text-[16px] leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm",
                        composerExpanded
                          ? "max-h-[min(40dvh,18rem)] sm:max-h-[min(48dvh,28rem)]"
                          : "max-h-28 sm:max-h-36",
                      )}
                    />
                    {composerLong ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid="agent-chat-composer-expand"
                        className="absolute right-0.5 top-0.5 h-8 w-8 rounded-lg text-muted-foreground"
                        aria-label={composerExpanded ? "Collapse message editor" : "Expand message editor"}
                        title={composerExpanded ? "Collapse" : "Expand"}
                        onClick={() => setComposerExpanded((expanded) => !expanded)}
                      >
                        {composerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                      </Button>
                    ) : null}
                  </div>
                  {agentVoiceEnabled ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-native-voice-control-id="one_voice_agent_chat_start"
                      data-testid="one-voice-agent-chat-start"
                      className="h-9 w-9 shrink-0 rounded-xl text-[rgba(0,0,0,0.50)] hover:bg-black/[0.04] hover:text-[#1d1d1f] focus-visible:ring-2 focus-visible:ring-primary/60 max-sm:text-[color:var(--app-accent-deep)] max-sm:focus-visible:ring-[color:var(--app-accent-ring)] dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100 dark:max-sm:text-[color:var(--app-accent-deep)]"
                      disabled={!canToggleVoice}
                      onClick={() => {
                        void startConversationalVoice();
                      }}
                      aria-label="Start voice mode"
                      title="Start voice mode"
                    >
                      <Mic className="h-4 w-4" />
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/60 max-sm:rounded-full max-sm:enabled:bg-[color:var(--app-accent)] max-sm:enabled:text-[color:var(--app-accent-fg)] max-sm:enabled:shadow-[var(--app-accent-ring)] max-sm:enabled:hover:bg-[color:var(--app-accent-hover)] max-sm:focus-visible:ring-[color:var(--app-accent-ring)] disabled:bg-black/[0.06] disabled:text-[rgba(0,0,0,0.36)] disabled:shadow-none dark:disabled:bg-white/[0.08] dark:disabled:text-zinc-500 dark:max-sm:enabled:bg-[color:var(--app-accent)] dark:max-sm:enabled:text-[color:var(--app-accent-fg)]"
                    disabled={!canSend}
                    aria-label="Send message"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </form>
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
    </div>
  );
}
