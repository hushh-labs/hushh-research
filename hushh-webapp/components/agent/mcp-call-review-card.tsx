"use client";

import { useEffect, useRef, useState } from "react";
import { SurfaceCard, SurfaceCardContent, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import type { AgentChatStreamHandlers } from "@/lib/services/agent-chat-client";
import type { McpCallPreview } from "@/lib/agent/mcp-call-review";

export type McpChatReview = Parameters<NonNullable<AgentChatStreamHandlers["onMcpReview"]>>[0];
type Phase = "loading" | "ready" | "busy" | "unavailable" | "unknown";

/** A transient authority-bearing review, deliberately excluded from chat history. */
export function McpCallReviewCard({ review, vaultOwnerToken, onDismiss }: {
  review: McpChatReview;
  vaultOwnerToken: string;
  onDismiss: () => void;
}) {
  const [preview, setPreview] = useState<McpCallPreview | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const lifetime = useRef<AbortController | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPreview(null);
    if (attempted.current) {
      setPhase("unknown");
      return () => controller.abort();
    }
    setPhase("loading");
    const remaining = Date.parse(review.reference.expiresAt) - Date.now();
    const expire = () => {
      controller.abort();
      setPreview(null);
      setPhase(attempted.current ? "unknown" : "unavailable");
    };
    if (remaining <= 0 || !review.isCurrent()) {
      expire();
      return () => controller.abort();
    }
    const timeout = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    void (async () => ExternalConnectorService.reviewMcpCall({
      configuration: await review.loadConfiguration?.(),
      vaultOwnerToken, conversationId: review.conversationId, reference: review.reference,
      signal: controller.signal, isEffectCurrent: review.isCurrent,
    }))().then((value) => {
      if (controller.signal.aborted || !review.isCurrent()) return;
      setPreview(value);
      setPhase("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setPhase("unavailable");
    });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [review, vaultOwnerToken]);

  const decide = async (confirmed: boolean) => {
    const controller = lifetime.current;
    if (attempted.current || !preview || !controller || controller.signal.aborted || !review.isCurrent()) return;
    attempted.current = true;
    setPhase("busy");
    // Keep the reviewed arguments only in this operation's memory.
    setPreview(null);
    let resumeStarted = false;
    const operation = (async () => {
      const approval = confirmed ? await ExternalConnectorService.confirmMcpCall({
        configuration: await review.loadConfiguration?.(),
        vaultOwnerToken, conversationId: review.conversationId, reference: preview,
        signal: controller.signal, isEffectCurrent: review.isCurrent,
      }) : null;
      if (controller.signal.aborted || !review.isCurrent()) throw new Error("Review no longer active.");
      resumeStarted = true;
      await review.resume(approval, controller.signal);
    })();
    morphyToast.promise(operation, {
      loading: confirmed ? "Continuing your connector request…" : "Cancelling this call…",
      success: confirmed ? "Review submitted." : "Call cancelled.",
      error: "The connector step could not be verified.",
    });
    try {
      await operation;
      if (!controller.signal.aborted && review.isCurrent()) onDismiss();
    } catch {
      if (!controller.signal.aborted && review.isCurrent()) setPhase(resumeStarted ? "unknown" : "unavailable");
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
            : phase === "unavailable" ? "This review is no longer available. Unlock or reconnect if needed, then ask One to prepare it again."
              : phase === "busy" ? "Waiting for the connector step to settle."
                : phase === "loading" ? "Checking the exact call for your review…"
                  : "Allow this exact call once. Content returned by a connector cannot approve another action."}
        </p>
        {visible ? <>
          <p className="break-words text-sm font-medium">{visible.connectorLabel} · {visible.toolLabel.replaceAll("_", " ")}</p>
          <dl aria-label="Call details" className="max-h-[40vh] overflow-y-auto overscroll-contain divide-y">
            {Object.entries(visible.arguments).map(([key, value]) => (
              <div key={key} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-3">
                <dt className="break-words text-sm text-muted-foreground">{key.replaceAll("_", " ")}</dt>
                <dd className="whitespace-pre-wrap break-words text-sm">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd>
              </div>
            ))}
          </dl>
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
