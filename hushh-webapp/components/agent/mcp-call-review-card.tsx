"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SurfaceCard, SurfaceCardContent, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import type { AgentChatStreamHandlers } from "@/lib/services/agent-chat-client";
import type { McpCallPreview } from "@/lib/agent/mcp-call-review";
import { hasServerClockOffset, serverNow } from "@/lib/agent/server-clock";
import { escapeReviewText } from "@/lib/agent/mcp-review-display";
import { ReviewArguments } from "@/components/agent/mcp-call-review-values";

export type McpChatReview = Parameters<NonNullable<AgentChatStreamHandlers["onMcpReview"]>>[0] & {
  /** Browser-only transcript message that owns the live Activity rows. */
  activityMessageId?: string;
};
type Phase = "loading" | "ready" | "busy" | "unavailable" | "unknown";
export type McpReviewActivityOutcome = "unavailable" | "expired" | "unknown";
// Why an unavailable review is gone: time ran out, or a newer turn / session took over.
type GoneReason = "expired" | "replaced";

// A real approval lives minutes; a far-future value would only be noise.
const COUNTDOWN_MAX_SECONDS = 3600;
const URGENT_SECONDS = 60;

/** Seconds left on the server's clock, using the review's own expiry. */
function countdownFor(expiresAt: string, now: number): { label: string; urgent: boolean } | null {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return null;
  const seconds = Math.max(0, Math.ceil((expires - now) / 1000));
  if (seconds > COUNTDOWN_MAX_SECONDS) return null;
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { label, urgent: seconds <= URGENT_SECONDS };
}

/** A transient authority-bearing review, deliberately excluded from chat history. */
export function McpCallReviewCard({ review, vaultOwnerToken, onDismiss, onActivityOutcome, onActionableChange, onDecidingChange }: {
  review: McpChatReview;
  vaultOwnerToken: string;
  onDismiss: () => void;
  /** Safe UI status only; it never contains provider output, arguments, or a receipt. */
  onActivityOutcome?: (outcome: McpReviewActivityOutcome) => void;
  /** True only while Allow once / Cancel can actually be pressed. */
  onActionableChange?: (actionable: boolean) => void;
  /** True from the moment Allow once / Cancel is pressed until its resume settles. */
  onDecidingChange?: (deciding: boolean) => void;
}) {
  const [preview, setPreview] = useState<McpCallPreview | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [gone, setGone] = useState<GoneReason | null>(null);
  const [now, setNow] = useState(() => serverNow());
  const lifetime = useRef<AbortController | null>(null);
  const attempted = useRef(false);
  // Set only once the resume has been handed to the chat. Before that nothing was sent,
  // so "could not verify the outcome" would be untrue.
  const dispatched = useRef(false);
  // The expiry timer. Once a decision starts it is moot (the server has consumed or
  // refused the receipt) and firing it would abort the approved resume mid-flight.
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportedOutcome = useRef<McpReviewActivityOutcome | null>(null);
  const outcomeListener = useRef(onActivityOutcome);
  useEffect(() => {
    outcomeListener.current = onActivityOutcome;
  }, [onActivityOutcome]);
  const reportOutcome = useCallback((outcome: McpReviewActivityOutcome) => {
    if (reportedOutcome.current) return;
    reportedOutcome.current = outcome;
    outcomeListener.current?.(outcome);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPreview(null);
    setGone(null);
    if (attempted.current) {
      setPhase(dispatched.current ? "unknown" : "unavailable");
      return () => controller.abort();
    }
    setPhase("loading");
    const remainingNow = () => Date.parse(review.reference.expiresAt) - serverNow();
    const remaining = remainingNow();
    const expire = (reason: GoneReason = "expired") => {
      // A decision already started: the time to decide has passed, but the outcome is
      // the resume's to report. Aborting here would cut off an approved write.
      if (attempted.current) return;
      controller.abort();
      setPreview(null);
      // Say why it is gone, rather than a generic failure or a wrong "expired".
      if (!attempted.current) {
        setGone(reason);
        reportOutcome(reason === "expired" ? "expired" : "unavailable");
      } else {
        // A confirmation may already have reached the server. Never imply that
        // the provider did not receive it when the page's acknowledgement dies.
        reportOutcome("unknown");
      }
      setPhase(attempted.current && dispatched.current ? "unknown" : "unavailable");
    };
    if (!review.isCurrent()) {
      expire("replaced");
      return () => controller.abort();
    }
    // Until a response has taught us the server's clock, a device clock that runs
    // ahead would expire this card without ever asking the server: fetch first.
    if (remaining <= 0 && hasServerClockOffset()) {
      expire();
      return () => controller.abort();
    }
    // Re-armed once the first response has taught us the server's clock.
    const arm = () => {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = setTimeout(
        () => expire(),
        Math.min(Math.max(remainingNow(), 0), 2_147_483_647),
      );
    };
    if (remaining > 0) arm();
    void (async () => ExternalConnectorService.reviewMcpCall({
      configuration: await review.loadConfiguration?.(),
      vaultOwnerToken, chatKey: review.chatKey, conversationId: review.conversationId,
      reference: review.reference, signal: controller.signal, isEffectCurrent: review.isCurrent,
    }))().then((value) => {
      if (controller.signal.aborted || !review.isCurrent()) return;
      // The response has aligned the clock, so this is now a fair expiry check.
      if (remainingNow() <= 0) {
        expire();
        return;
      }
      arm();
      setNow(serverNow());
      setPreview(value);
      setPhase("ready");
    }).catch(() => {
      if (!controller.signal.aborted) {
        reportOutcome("unavailable");
        setPhase("unavailable");
      }
    });
    return () => { clearTimeout(expiryTimer.current); controller.abort(); };
  }, [reportOutcome, review, vaultOwnerToken]);

  // The chat points a typed "yes" back at this card only while it can be used; a
  // dead card (unavailable, unknown, busy) has no buttons to point at.
  const actionableChange = useRef(onActionableChange);
  const decidingChange = useRef(onDecidingChange);
  useEffect(() => {
    actionableChange.current = onActionableChange;
    decidingChange.current = onDecidingChange;
  });
  // A card that unmounts mid-decision must not leave the chat believing one is in flight.
  useEffect(() => () => decidingChange.current?.(false), []);
  useEffect(() => {
    actionableChange.current?.(phase === "ready");
    return () => actionableChange.current?.(false);
  }, [phase]);

  // Tick only while the person can still act, so the card never re-renders idly.
  const ticking = phase === "loading" || phase === "ready";
  useEffect(() => {
    if (!ticking) return;
    setNow(serverNow());
    const timer = setInterval(() => {
      setNow(serverNow());
      if (!review.isCurrent()) {
        // Another turn or a reloaded history took this card over: it can never be
        // answered, so say so now (with a Close button) instead of when it expires.
        lifetime.current?.abort();
        setPreview(null);
        setGone("replaced");
        reportOutcome("unavailable");
        setPhase("unavailable");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [ticking, review, reportOutcome]);
  const countdown = ticking ? countdownFor(review.reference.expiresAt, now) : null;

  const decide = async (confirmed: boolean) => {
    const controller = lifetime.current;
    if (attempted.current || !preview || !controller || controller.signal.aborted || !review.isCurrent()) return;
    attempted.current = true;
    clearTimeout(expiryTimer.current);
    decidingChange.current?.(true);
    setPhase("busy");
    // Keep the reviewed arguments only in this operation's memory.
    setPreview(null);
    let resumeStarted = false;
    const operation = (async () => {
      const approval = confirmed ? await ExternalConnectorService.confirmMcpCall({
        configuration: await review.loadConfiguration?.(),
        vaultOwnerToken, chatKey: review.chatKey, conversationId: review.conversationId,
        reference: preview,
        signal: controller.signal, isEffectCurrent: review.isCurrent,
      }) : null;
      if (controller.signal.aborted || !review.isCurrent()) throw new Error("Review no longer active.");
      resumeStarted = true;
      dispatched.current = true;
      await review.resume(approval, controller.signal);
    })();
    morphyToast.promise(operation, {
      loading: confirmed ? "Continuing your connector request…" : "Cancelling this call…",
      success: confirmed ? "Review submitted." : "Call cancelled.",
      error: "The connector step could not be verified.",
    });
    try {
      await operation;
      decidingChange.current?.(false);
      if (!controller.signal.aborted && review.isCurrent()) onDismiss();
    } catch {
      decidingChange.current?.(false);
      if (!controller.signal.aborted && review.isCurrent()) {
        const outcome = resumeStarted ? "unknown" : "unavailable";
        reportOutcome(outcome);
        setPhase(outcome);
      }
    }
  };

  const visible = preview && review.isCurrent() ? preview : null;
  return (
    <SurfaceCard data-testid="mcp-call-review-card">
      <SurfaceCardHeader>
        <SurfaceCardTitle>Review connector call</SurfaceCardTitle>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {phase === "unknown" ? "We could not verify the outcome. Check the connector before trying again. This call will not be retried automatically."
            : phase === "unavailable" && gone === "expired" ? "This review expired. Ask One to prepare it again."
            : phase === "unavailable" && gone === "replaced" ? "This review was replaced. Ask One again."
            : phase === "unavailable" ? "This review is no longer available. Unlock or reconnect if needed, then ask One to prepare it again."
              : phase === "busy" ? "Waiting for the connector step to settle."
                : phase === "loading" ? "Checking the exact call for your review…"
                  : "Allow this exact call once. Content returned by a connector cannot approve another action."}
        </p>
        {countdown ? (
          <p
            role="timer"
            className={`text-xs tabular-nums ${countdown.urgent ? "font-medium text-foreground" : "text-muted-foreground"}`}
          >
            Expires in {countdown.label}
          </p>
        ) : null}
        {visible ? <>
          <p className="break-words text-sm font-medium">{escapeReviewText(visible.connectorLabel)} · {escapeReviewText(visible.toolLabel.replaceAll("_", " "))}</p>
          <ReviewArguments args={visible.arguments} />
          {Object.keys(visible.arguments).length === 0 ? <p className="text-sm">No additional inputs.</p> : null}
        </> : null}
        {phase === "unavailable" || phase === "unknown" ? (
          <Button size="standard" variant="none" effect="fade" onClick={onDismiss}>Close review</Button>
        ) : <FlowActionGroup
          primary={<Button size="standard" effect="fade" disabled={!visible || phase !== "ready"} onClick={() => void decide(true)}>Allow once</Button>}
          secondary={<Button size="standard" variant="none" effect="fade" disabled={!visible || phase !== "ready"} onClick={() => void decide(false)}>Cancel</Button>}
        />}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
