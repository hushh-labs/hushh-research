"use client";

import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Mail,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from "@/components/icons";
import { openProfilePane } from "@/lib/navigation/profile-pane";
import { ownerPodTurnRecoveryPanel } from "@/lib/agent/owner-pod-turn-errors";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { isAndroid } from "@/lib/capacitor/platform";
import { cn } from "@/lib/utils";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import type { InformationRequestSubmissionReceipt } from "@/components/agent/agent-structured-experience";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";
import type { DriveOwnerCompileWindow } from "@/lib/agent/connector-read-receipt";
import {
  SpecialistConsentActionsCard,
  SpecialistPendingConsentRequestCard,
  type SpecialistConsentActionItem,
  type SpecialistPendingConsentRequestItem,
} from "@/components/agent/specialist-directive-card";
import { copyTextToClipboard } from "@/components/agent/chat-markdown-link";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import type { ConnectorBrand } from "@/components/agent/connector-brand-mark";
import { AgentResponseReportButton } from "@/components/agent/agent-response-report";
import type { AgentResponseReportReason } from "@/lib/services/agent-chat-client";
import {
  ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME,
  OneChatBubble,
  OneChatTimeSeparator,
} from "@/components/agent/chat-message-styles";
import {
  AgentTurnStreamPanel,
  AgentActivityMark,
  type AgentActivityIcon,
} from "@/components/agent/agent-turn-stream-panel";
import type { ChatTimeSeparator } from "@/lib/agent/chat-time-separators";
import { AgentMessageReactionBadge } from "../agent-message-reaction";
import { QueuedJoinedCaption } from "@/components/agent/agent-queued-stack";
import { AgentMemoryCaptureStatus } from "@/components/agent/agent-memory-capture-status";
import { AgentMessageAttachments } from "@/components/agent/agent-message-attachments";
import { SecretPlaceholderText } from "@/components/secrets/secret-placeholder-text";
import type { GmailInformationRequestSourcePreview } from "@/lib/services/gmail-information-requests-service";
import {
  AGENT_STREAM_RENDER_FRAME_MS,
  getConsentActionsPayload,
  getPendingConsentRequestPayload,
  type AgentMessage,
} from "./agent-message-transforms";

function useAnimatedAssistantText(targetText: string, active: boolean) {
  const [displayedText, setDisplayedText] = useState(active ? "" : targetText);
  const displayedTextRef = useRef(displayedText);
  const targetTextRef = useRef(targetText);

  useEffect(() => {
    targetTextRef.current = targetText;

    // Completed answers must remain readable when a background tab suspends frames.
    if (!active) {
      displayedTextRef.current = targetText;
      setDisplayedText(targetText);
    }
  }, [active, targetText]);

  useEffect(() => {
    if (!active) return;
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
    displayedText: active ? displayedText : targetText,
    isAnimating: active,
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

export const AgentBubble = memo(function AgentBubble({
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
  onRetryMemorySave,
  pendingMemoryCards,
  canConfirmMemoryNeedsOwner,
  onUnlockVault,
  ephemeralCard,
  businessProfileCard,
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
  onResendAttachment?: (index: number, editedText: string) => boolean | void | Promise<boolean | void>;
  onConfirmMemoryNeedsOwner?: (reviewedCards: readonly AgentPkmPreviewCard[]) => Promise<void>;
  /** Continue a paused or gapped memory save job for this message. */
  onRetryMemorySave?: () => Promise<void>;
  pendingMemoryCards?: readonly AgentPkmPreviewCard[];
  canConfirmMemoryNeedsOwner?: boolean;
  onUnlockVault?: () => void;
  /** App-owned background card, never model HTML or persisted chat content. */
  ephemeralCard?: ReactNode;
  /** Compatibility for the existing Business Intelligence card. */
  businessProfileCard?: ReactNode;
}) {
  const backgroundCard = ephemeralCard ?? businessProfileCard;
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
    (event) => event.label !== "Memory" && event.label !== "Add to Memory",
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
  const backgroundOnly = Boolean(backgroundCard) && Boolean(message.ephemeral) &&
    !isUser && !isStreaming && !isError && !shouldRenderStreamPanel &&
    assistantText.trim().length === 0;
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
    !backgroundOnly &&
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
        className="relative grid h-7 w-7 place-items-center rounded-md border border-transparent text-[rgba(0,0,0,0.46)] transition-[background-color,border-color,color,opacity] duration-[120ms] ease-[var(--ease-out)] motion-reduce:transition-none active:enabled:opacity-80 [@media(hover:hover)_and_(pointer:fine)]:hover:border-black/10 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-black/[0.04] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-zinc-500 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:border-white/10 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:bg-white/[0.06] [@media(hover:hover)_and_(pointer:fine)]:dark:hover:text-zinc-200"
        aria-label={copied ? "Response copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
      >
        <Copy
          className={cn(
            "col-start-1 row-start-1 h-3.5 w-3.5 transition-[transform,opacity] duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none",
            copied ? "scale-75 opacity-0" : "scale-100 opacity-100",
          )}
        />
        <Check
          className={cn(
            "col-start-1 row-start-1 h-3.5 w-3.5 text-[color:var(--app-accent)] transition-[transform,opacity] duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none",
            copied ? "scale-100 opacity-100" : "scale-75 opacity-0",
          )}
        />
        <MaterialRipple variant="none" effect="glass" />
      </button>
      <button
        type="button"
        onClick={() => onRate?.(liked ? null : "up")}
        className={cn(
          "relative grid h-7 w-7 place-items-center rounded-md border transition-[background-color,border-color,color,opacity] duration-[120ms] ease-[var(--ease-out)] motion-reduce:transition-none active:enabled:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          liked
            ? "border-transparent bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]"
            : "border-transparent text-[rgba(0,0,0,0.46)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-black/10 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-black/[0.04] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[#1d1d1f] dark:text-zinc-500 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:border-white/10 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:bg-white/[0.06] [@media(hover:hover)_and_(pointer:fine)]:dark:hover:text-zinc-200",
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
          "relative grid h-7 w-7 place-items-center rounded-md border transition-[background-color,border-color,color,opacity] duration-[120ms] ease-[var(--ease-out)] motion-reduce:transition-none active:enabled:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          disliked
            ? "border-transparent bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]"
            : "border-transparent text-[rgba(0,0,0,0.46)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-black/10 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-black/[0.04] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[#1d1d1f] dark:text-zinc-500 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:border-white/10 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:bg-white/[0.06] [@media(hover:hover)_and_(pointer:fine)]:dark:hover:text-zinc-200",
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
          className="relative ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 text-xs font-medium text-[rgba(0,0,0,0.46)] transition-[background-color,border-color,color,opacity] duration-[120ms] ease-[var(--ease-out)] motion-reduce:transition-none active:enabled:opacity-80 [@media(hover:hover)_and_(pointer:fine)]:hover:border-black/10 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-black/[0.04] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:border-white/10 [@media(hover:hover)_and_(pointer:fine)]:dark:hover:bg-white/[0.06] [@media(hover:hover)_and_(pointer:fine)]:dark:hover:text-zinc-200"
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
      data-message-id={message.id}
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
          (shouldRenderStreamPanel || backgroundOnly) && !isUser
            ? "w-full max-w-none"
            : isUser
              ? "max-w-[90%] sm:max-w-[min(76%,42rem)]"
              : "w-full max-w-[90%] sm:max-w-[min(82%,48rem)]",
        )}
      >
        <OneChatBubble
          aria-live={!isUser && isStreaming ? "polite" : undefined}
          data-agent-streaming={!isUser && isStreaming ? "true" : undefined}
          tone={isUser ? "user" : showAssistantBubble ? "assistant" : "plain"}
          className={cn(
            (isUser || showAssistantBubble) && "relative",
            isError &&
              "rounded-2xl border border-destructive/20 bg-destructive/[0.06] px-4 py-2.5 text-foreground",
          )}
        >
          {isUser ? (
            <>
              {message.text ? (
                <span className="whitespace-pre-wrap break-words"><SecretPlaceholderText text={message.text} /></span>
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
              {message.reaction && <AgentMessageReactionBadge reaction={message.reaction} />}
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
                    className={cn(ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME, "relative w-full min-w-0 max-w-full break-words")}
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
          ) : backgroundOnly || canRenderConsentActions ||
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
          {!isUser && isError ? (() => {
            const recoveryPanel = ownerPodTurnRecoveryPanel(assistantText || message.errorNotice);
            if (!recoveryPanel) return null;
            return (
              <div className="mt-2.5">
                <button
                  type="button"
                  data-testid="agent-message-pod-recovery-action"
                  onClick={() => {
                    if (typeof window === "undefined") return;
                    openProfilePane(
                      window.location.pathname,
                      window.location.search,
                      { panel: recoveryPanel, detail: null },
                      { returnsToOrigin: true },
                    );
                  }}
                  className="inline-flex h-8 touch-manipulation items-center rounded-full border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] px-3 text-xs font-semibold text-foreground transition-[background-color,opacity] duration-[120ms] ease-[var(--ease-out)] motion-reduce:transition-none active:opacity-[0.84] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color:var(--app-shell-surface-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
                >
                  {recoveryPanel === "software-updates" ? "Open Agent updates" : "Open Hosting"}
                </button>
              </div>
            );
          })() : null}
          {!isUser && backgroundCard ? <div className={backgroundOnly ? undefined : "mt-3"}>{backgroundCard}</div> : null}
        </OneChatBubble>
        {isUser && message.queuedPlacement === "joined" ? <QueuedJoinedCaption /> : null}
        {!isUser && message.memoryCapture ? <AgentMemoryCaptureStatus status={message.memoryCapture} onConfirmNeedsOwner={onConfirmMemoryNeedsOwner} onRetry={onRetryMemorySave} pendingCards={pendingMemoryCards} canConfirmNeedsOwner={canConfirmMemoryNeedsOwner} onUnlock={onUnlockVault} /> : null}
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
});

/** The centered date/time line that opens a group of messages. */
export function ChatTimeSeparatorRow({ separator }: { separator: ChatTimeSeparator }) {
  return (
    <div data-testid="agent-chat-time-separator">
      <OneChatTimeSeparator
        accessibleLabel={separator.accessibleLabel}
        dateTime={separator.dateTime}
        label={separator.text}
      />
    </div>
  );
}

export function ChatAgentSubtitle({ text, working, brand, icon }: { text: string; working: boolean; brand?: ConnectorBrand | null; icon?: AgentActivityIcon }) {
  const [display, setDisplay] = useState({ text, working, brand, icon });
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (display.text === text && display.working === working && display.brand === brand && display.icon === icon) {
      setVisible(true);
      return;
    }
    setVisible(false);
    // The mark and label are one projection, including during the fade.
    const timer = window.setTimeout(() => { setDisplay({ text, working, brand, icon }); setVisible(true); }, 90);
    return () => window.clearTimeout(timer);
  }, [display, text, working, brand, icon]);
  if (!display.text) return null;
  return <p aria-live="polite" className="flex max-w-48 items-center gap-1.5 truncate text-xs text-muted-foreground sm:max-w-64">
    <span className={`flex min-w-0 items-center gap-1.5 transition-opacity duration-100 motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}>
      {display.brand || display.icon ? <AgentActivityMark brand={display.brand} icon={display.icon} /> : display.working ? <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
      <span className="truncate">{display.text}</span>
    </span>
  </p>;
}

export type ActiveToolCall = { id: string; label: string; activity?: string; brand?: ConnectorBrand | null; icon?: AgentActivityIcon };

export const IDLE_AGENT_SUBTITLE = "";

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
  if (input.isPuppySurface) return "";
  const current = input.activeToolCalls.at(-1);
  if (current) return `${current.activity || current.label}…`;
  return input.statusText || IDLE_AGENT_SUBTITLE;
}
