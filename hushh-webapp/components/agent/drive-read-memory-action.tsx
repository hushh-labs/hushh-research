"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, Loader2 } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { connectorMemorySharingImpact, prepareConnectorMemoryReview, saveConnectorMemoryReview } from "@/lib/agent/connector-memory-review";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import type { ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";

/** Source receipts, rather than answer keywords, decide whether content was read. */
export function canReviewDriveMemory(status: string | undefined, answer: string, experiences: readonly { type: string }[]): boolean {
  const reads = experiences.filter((item): item is ConnectorReadExperience => item.type === "one.connector_read.v1");
  return status === "done" && !!answer.trim() && reads.some(read =>
    read.connector === "drive" && read.status === "ok" && read.metadataOnly === false && Array.isArray(read.sourceRefs) && read.sourceRefs.length > 0,
  ) && !reads.some(read => read.connector === "mail");
}

type Context = { ownerId: string; vaultKey: string; vaultOwnerToken: string; answer: string; scopeId: string };
type Review = {
  context: Context;
  phase: "preparing" | "review" | "saving" | "saved" | "empty" | "error" | "partial";
  cards: AgentPkmPreviewCard[];
  selected: ReadonlySet<string>;
  incomplete?: boolean;
  saved?: number;
};

export function DriveReadMemoryAction({ ownerId, vaultKey, vaultOwnerToken, answer, scopeId,
  getCurrentToken, isScopeCurrent }: Context & {
  getCurrentToken: () => string | null;
  isScopeCurrent: () => boolean;
}) {
  const context = useMemo(() => ({ ownerId, vaultKey, vaultOwnerToken, answer, scopeId }),
    [ownerId, vaultKey, vaultOwnerToken, answer, scopeId]);
  const current = useRef(context);
  current.current = context;
  const ready = useRef({ getCurrentToken, isScopeCurrent });
  ready.current = { getCurrentToken, isScopeCurrent };
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<Review | null>(null);
  const [acknowledging, setAcknowledging] = useState<Context | null>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const review = state?.context === context ? state : null;
  const cards = review?.cards.filter(card => review.selected.has(card.card_id)) || [];
  const recipientCount = connectorMemorySharingImpact(cards);

  useEffect(() => {
    controller.current = new AbortController();
    busy.current = false;
    return () => { controller.current?.abort(); controller.current = null; };
  }, [context]);

  const session = () => createAgentPkmCaptureGuard({
    userId: context.ownerId,
    signal: controller.current?.signal ?? AbortSignal.abort(),
    isEnabled: () => current.current === context && ready.current.isScopeCurrent() &&
      ready.current.getCurrentToken() === context.vaultOwnerToken,
  });
  const prepare = async () => {
    if (busy.current) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    busy.current = true;
    setAcknowledging(null);
    setState({ context, phase: "preparing", cards: [], selected: new Set() });
    try {
      const next = await prepareConnectorMemoryReview({
        userId: ownerId, vaultKey, vaultOwnerToken, message: answer, source: "drive_read_review", ...guard,
      });
      await guard.assertCurrent();
      setState({ context, phase: next.cards.length ? "review" : next.incomplete ? "error" : "empty",
        cards: next.cards, selected: new Set(next.cards.map(card => card.card_id)), incomplete: next.incomplete });
    } catch {
      if (guard.isCurrent()) setState({ context, phase: "error", cards: [], selected: new Set() });
    } finally {
      if (guard.isCurrent()) { busy.current = false; notice.current?.focus(); }
    }
  };
  const save = async (sharingImpactAcknowledged = false) => {
    if (busy.current || review?.phase !== "review" || !cards.length) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    if (recipientCount > 0 && !sharingImpactAcknowledged) { setAcknowledging(context); return; }
    busy.current = true;
    setAcknowledging(null);
    setState({ ...review, phase: "saving" });
    try {
      const result = await saveConnectorMemoryReview({
        userId: ownerId, vaultKey, vaultOwnerToken, cards, message: answer,
        source: "drive_read_review", sharingImpactAcknowledged, ...guard,
      });
      if (!guard.isCurrent()) return;
      setState({ context, cards: [], selected: new Set(), saved: result?.saved ?? 0,
        phase: result && result.saved > 0 ? (result.failed > 0 ? "partial" : "saved") : "error" });
    } catch {
      if (guard.isCurrent()) setState({ context, phase: "error", cards: [], selected: new Set() });
    } finally {
      if (guard.isCurrent()) { busy.current = false; notice.current?.focus(); }
    }
  };
  const dismiss = () => {
    controller.current?.abort();
    controller.current = new AbortController();
    busy.current = false;
    setState(null); setAcknowledging(null);
  };

  const phase = review?.phase;
  return <section aria-label="Drive notes for memory" className="mt-3 min-w-0 space-y-2">
    {!phase || phase === "error" || phase === "partial" ? <Button type="button" variant="muted" size="compact" className="bg-muted/60"
      onClick={() => void prepare()}><Brain className="mr-2 h-4 w-4" aria-hidden="true" />
      {phase === "error" || phase === "partial" ? "Review notes again" : "Save to memory"}
    </Button> : null}
    {phase === "preparing" ? <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Preparing notes for your review…
      <Button type="button" variant="muted" size="compact" onClick={dismiss}>Cancel</Button>
    </div> : null}
    {review && (phase === "review" || phase === "saving") ? <>
      <HelperText>Save selected notes from this answer. Original documents stay in Drive.</HelperText>
      {review.incomplete ? <HelperText>Some notes could not be prepared. Only the notes you review here can be saved.</HelperText> : null}
      <AgentPkmReviewPanel cards={review.cards} selectedCardIds={review.selected} showSourceText
        saving={phase === "saving"} className="[&_button]:min-h-11 [&_label]:min-h-11"
        onToggleCard={(id, selected) => {
          if (busy.current) return;
          const next = new Set(review.selected); if (selected) next.add(id); else next.delete(id);
          setState({ ...review, selected: next }); setAcknowledging(null);
        }} onSave={() => void save()} onDismiss={dismiss} />
    </> : null}
    <p ref={notice} role="status" tabIndex={-1} className="text-sm leading-5 text-muted-foreground">
      {phase === "saved" ? <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4 text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]" aria-hidden="true" />
        {review?.saved} {review?.saved === 1 ? "note" : "notes"} saved to memory.</span> :
        phase === "partial" ? `${review?.saved} notes saved. Some notes still need review; check Memory before retrying.` :
        phase === "error" ? "Saving could not finish. Check Memory, then review again before retrying." :
        phase === "empty" ? "Nothing new to save from this answer." : null}
    </p>
    <AlertDialog open={acknowledging === context} onOpenChange={open => { if (!open) setAcknowledging(null); }}>
      <AlertDialogContent size="sm"><AlertDialogHeader>
        <AlertDialogTitle>Update shared memory?</AlertDialogTitle>
        <AlertDialogDescription>These notes would also update memory you already share. Save only if you want existing recipients to receive these updates.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter>
        <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
        <AlertDialogAction className="min-h-11" onClick={() => void save(true)}>Save and update sharing</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
}
