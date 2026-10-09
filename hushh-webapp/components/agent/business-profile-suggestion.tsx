"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { HelperText } from "@/components/app-ui/typography";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { BusinessSuggestionService } from "@/lib/services/business-suggestion-service";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { connectorMemorySharingImpact, prepareConnectorMemoryReview } from "@/lib/agent/connector-memory-review";
import { attachBusinessOrigin, buildSyntheticBusinessPreview, BusinessOriginValidationError, businessCandidateSnapshot, businessDraftMessage, createBusinessReviewJob, decideBusinessReview, loadBusinessReview, saveBusinessReview, type BusinessCandidate, type BusinessReviewJob } from "@/lib/agent/business-profile-review";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

type Props = {
  ownerId: string | null; vaultKey: string | null; vaultOwnerToken: string | null;
  tokenExpiresAt: number | null; enabled: boolean;
  /** The chat owns the assistant bubble; this capability owns only its card. */
  renderMessage?: (id: string, text: string, card: ReactNode) => ReactNode;
  onVisibleChange?: (visible: boolean) => void;
  /** Remove a saved candidate from the owning chat turn immediately. */
  onSaved?: (businessUid: string) => void;
  /** Candidates already saved in this session stay suppressed if discovery refreshes. */
  dismissedBusinessUids?: ReadonlySet<string>;
};
type Review = {
  candidate: BusinessCandidate; name: string; website: string; message: string;
  cards: AgentPkmPreviewCard[]; selected: string[]; job?: BusinessReviewJob;
  phase: "offer" | "preparing" | "review" | "saving";
};

/** On-demand discovery; each distinct business has an independent review. */
export function BusinessProfileSuggestion(props: Props) {
  const [discovery, setDiscovery] = useState<{ ownerId: string; token: string; key: string;
    candidates: BusinessCandidate[]; incomplete: boolean; status: string } | null>(null);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  const onCandidateVisible = useCallback((id: string, visible: boolean) => {
    setVisibleIds(current => {
      if (current.has(id) === visible) return current;
      const next = new Set(current);
      if (visible) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const visible = visibleIds.size > 0;
  const { onVisibleChange } = props;
  useEffect(() => {
    onVisibleChange?.(visible);
    return () => onVisibleChange?.(false);
  }, [onVisibleChange, visible]);
  const { ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt } = props;
  useEffect(() => {
    const abort = new AbortController();
    setDiscovery(null);
    const guard = createAgentPkmCaptureGuard({ userId: ownerId || "", signal: abort.signal,
      isEnabled: () => enabled && !!ownerId && !!vaultKey && !!vaultOwnerToken && tokenExpiresAt !== null && Date.now() < tokenExpiresAt });
    if (guard.isCurrent()) void (async () => {
      try {
        const result = await BusinessSuggestionService.get(vaultOwnerToken!, abort.signal);
        await guard.assertCurrent();
        setDiscovery({ ownerId: ownerId!, token: vaultOwnerToken!, key: vaultKey!, candidates: result.candidates,
          incomplete: result.coverageIncomplete === true, status: result.status });
      } catch {
        if (guard.isCurrent()) setDiscovery({ ownerId: ownerId!, token: vaultOwnerToken!, key: vaultKey!,
          candidates: [], incomplete: true, status: "unavailable" });
      }
    })();
    return () => abort.abort();
  }, [ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt]);
  if (!enabled || !ownerId || !vaultKey || !vaultOwnerToken || tokenExpiresAt === null || Date.now() >= tokenExpiresAt ||
    discovery?.ownerId !== ownerId || discovery.token !== vaultOwnerToken || discovery.key !== vaultKey) return null;
  const candidates = discovery.candidates.filter(candidate => !props.dismissedBusinessUids?.has(candidate.businessUid));
  // Ambient discovery offers a real candidate; an empty lookup is not a chat task.
  if (!candidates.length) return null;
  return <div className="space-y-[var(--app-form-section-gap)]">
    {candidates.length > 1 && <HelperText>I found several possible businesses. Review each one separately; you can save more than one.</HelperText>}
    {candidates.map(candidate => <BusinessCandidateReview key={candidate.businessUid} {...props} candidate={candidate} onCandidateVisible={onCandidateVisible} />)}
  </div>;
}

function BusinessCandidateReview(props: Props & { candidate: BusinessCandidate;
  onCandidateVisible: (id: string, visible: boolean) => void }) {
  const fieldId = useId();
  const { ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt } = props;
  const context = useMemo(() => ({ ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt }),
    // Expiry is checked at every effect, including while the UI is idle.
    [ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt]);
  const current = useRef(context);
  current.current = context;
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<{ context: typeof context; review: Review } | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const review = state?.context === context ? state.review : null;
  const reviewVisible = Boolean(review);
  const { onCandidateVisible } = props;
  useEffect(() => {
    onCandidateVisible(props.candidate.businessUid, reviewVisible);
    return () => onCandidateVisible(props.candidate.businessUid, false);
  }, [onCandidateVisible, props.candidate.businessUid, reviewVisible]);
  const eligible = () => current.current === context && context.enabled && !!context.ownerId &&
    !!context.vaultKey && !!context.vaultOwnerToken && context.tokenExpiresAt !== null && Date.now() < context.tokenExpiresAt;
  const session = () => createAgentPkmCaptureGuard({ userId: context.ownerId || "",
    signal: controller.current?.signal ?? AbortSignal.abort(), isEnabled: eligible });

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; busy.current = false;
    setState(null); setRecoveryError(false); setAcknowledging(false); setOpen(false); setEditing(false); setSaved(false);
    const guard = createAgentPkmCaptureGuard({ userId: context.ownerId || "", signal: abort.signal, isEnabled: eligible });
    if (guard.isCurrent()) void (async () => {
      try {
        const candidate = props.candidate;
        const checkpoint = await loadBusinessReview(context.ownerId!, context.vaultKey!, candidate.businessUid);
        await guard.assertCurrent();
        if (checkpoint?.decision === "not_me" || checkpoint?.decision === "saved" ||
          (checkpoint?.decision === "later" && (checkpoint.until || 0) > Date.now())) return;
        const job = checkpoint?.job;
        const reviewedCandidate = job?.candidate || candidate;
        setState({ context, review: { candidate: reviewedCandidate,
          name: job?.reviewedName ?? reviewedCandidate.draft.name,
          website: job?.reviewedWebsite ?? reviewedCandidate.draft.website,
          message: job?.message || "", cards: job?.cards || [], selected: job?.cards.map(card => card.card_id) || [],
          job, phase: job ? "review" : "offer" } });
        setOpen(true);
      } catch {
        // Optional discovery must not block chat or expose provider diagnostics.
        if (guard.isCurrent()) { setState(null); setRecoveryError(true); }
      }
    })();
    return () => { abort.abort(); };
    // Each authority change creates a new owner-bound attempt, including StrictMode replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, recoveryAttempt]);

  const freshCandidate = async (guard: ReturnType<typeof session>) => {
    await guard.assertCurrent();
    const fresh = await BusinessSuggestionService.get(context.vaultOwnerToken!, controller.current?.signal);
    await guard.assertCurrent();
    const refreshedCandidate = review && fresh.candidates.find(candidate => candidate.businessUid === review.candidate.businessUid);
    const originalSnapshot = review?.job ? review.job.candidateSnapshot : review && businessCandidateSnapshot(review.candidate);
    if (!review || !refreshedCandidate || !originalSnapshot || originalSnapshot !== businessCandidateSnapshot(refreshedCandidate))
      throw new Error("The suggestion is no longer available. Nothing new was saved.");
  };
  const update = (next: Review) => setState({ context, review: next });
  const refresh = async () => {
    if (!review || review.job || busy.current) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    busy.current = true;
    try {
      const result = await BusinessSuggestionService.get(context.vaultOwnerToken!, controller.current?.signal);
      await guard.assertCurrent();
      const candidate = result.candidates.find(row => row.businessUid === review.candidate.businessUid);
      if (!candidate) throw new Error("Unavailable");
      update({ candidate, name: candidate.draft.name, website: candidate.draft.website,
        message: "", cards: [], selected: [], phase: "offer" });
      setEditing(false);
    } catch { if (guard.isCurrent()) morphyToast.error("The listing could not be refreshed. Your review is unchanged."); }
    finally { if (guard.isCurrent()) busy.current = false; }
  };
  const prepare = async () => {
    if (!review || busy.current || review.job) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    busy.current = true;
    update({ ...review, phase: "preparing" });
    let stage: "lookup" | "preview" | "coverage" | "origin" = "lookup";
    try {
      await freshCandidate(guard);
      const message = businessDraftMessage(review.candidate, review.name, review.website);
      stage = "preview";
      // Keep older isolated test/module mocks compatible while the real
      // implementation supplies the deterministic UAT card builder.
      const syntheticCards = buildSyntheticBusinessPreview?.(review.candidate, review.name, review.website) ?? [];
      const result = syntheticCards.length
        ? { cards: syntheticCards, incomplete: false, alreadySaved: false }
        : await prepareConnectorMemoryReview({ ...guard, userId: context.ownerId!,
          vaultKey: context.vaultKey!, vaultOwnerToken: context.vaultOwnerToken!, message, source: "business_profile_review" });
      await guard.assertCurrent();
      stage = "coverage";
      if (result.incomplete || !result.cards.length) throw new Error("The details could not be fully prepared. Please try again.");
      // Ensure source identity can follow the actual semantic entity before offering Save.
      stage = "origin";
      result.cards.forEach(card => attachBusinessOrigin(card, review.candidate));
      update({ ...review, message, cards: result.cards, selected: result.cards.map(card => card.card_id), phase: "review" });
    } catch (error) {
      if (guard.isCurrent()) {
        // Bounded diagnostics only: never log source details, keys or preview payloads.
        const originReason = error instanceof BusinessOriginValidationError ? error.reason : stage === "origin" && error instanceof Error
          ? error.message === "The proposed detail needs a fresh review before saving." ? "entity-shape"
            : error.message === "The proposed destination changed. Review the details again." ? "entity-destination" : "source-identity"
          : "unavailable";
        console.warn(`[BusinessReview] Preparation failed at ${stage}: ${originReason}`);
        update({ ...review, phase: "offer" });
        morphyToast.error("The details could not be prepared. Try again.");
      }
    } finally { if (guard.isCurrent()) busy.current = false; }
  };
  const chosen = review?.cards.filter(card => review.selected.includes(card.card_id)) || [];
  const sharingCount = connectorMemorySharingImpact(chosen);
  const save = async (sharingImpactAcknowledged = false) => {
    if (!review || review.phase !== "review" || busy.current || !chosen.length) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    if (sharingCount && !sharingImpactAcknowledged) { setAcknowledging(true); return; }
    busy.current = true; setAcknowledging(false); update({ ...review, phase: "saving" });
    let attemptedJob = review.job;
    const action = (async () => {
      if (!review.job) await freshCandidate(guard);
      const job = review.job || createBusinessReviewJob(context.ownerId!, review.candidate, review.message, chosen,
        { name: review.name, website: review.website });
      attemptedJob = job;
      update({ ...review, job, phase: "saving" });
      const result = await saveBusinessReview({ ...guard, job, vaultKey: context.vaultKey!,
        vaultOwnerToken: context.vaultOwnerToken!, sharingImpactAcknowledged,
        assertListingFresh: () => freshCandidate(guard) });
      await guard.assertCurrent();
      if (!result || result.remaining) {
        const checkpoint = await loadBusinessReview(context.ownerId!, context.vaultKey!, review.candidate.businessUid);
        await guard.assertCurrent();
        update({ ...review, job: checkpoint?.job || job, cards: job.cards,
          selected: job.cards.map(card => card.card_id), phase: "review" });
        throw new Error("Some details still need saving. Retry this review.");
      }
      // Persisted PKM state is authoritative, but also suppress this mounted
      // card immediately. The parent callback covers a discovery refresh that
      // would otherwise recreate the same ephemeral chat message.
      setSaved(true);
      props.onSaved?.(review.candidate.businessUid);
      setState(null); setOpen(false);
      return result;
    })();
    morphyToast.promise(action, { loading: "Saving approved details…", success: "Business details saved to private memory.",
      error: "Some details could not be confirmed. Reopen this review to retry." });
    try { await action; }
    catch {
      if (guard.isCurrent()) {
        // The checkpoint may exist even if a transport response was lost.
        try {
          const checkpoint = await loadBusinessReview(context.ownerId!, context.vaultKey!, review.candidate.businessUid);
          await guard.assertCurrent();
          if (checkpoint?.decision === "saved") {
            setSaved(true);
            props.onSaved?.(review.candidate.businessUid);
            setState(null); setOpen(false);
            return;
          }
          const job = checkpoint?.job || attemptedJob;
          update({ ...review, job, cards: job?.cards || review.cards,
            selected: job?.cards.map(card => card.card_id) || review.selected, phase: "review" });
        } catch { if (guard.isCurrent()) update({ ...review, job: attemptedJob,
          cards: attemptedJob?.cards || review.cards, selected: attemptedJob?.cards.map(card => card.card_id) || review.selected, phase: "review" }); }
      }
    } finally { if (guard.isCurrent()) busy.current = false; }
  };
  const defer = async (decision: "later" | "not_me") => {
    if (!review || busy.current) return;
    const guard = session(); if (!guard.isCurrent()) return;
    busy.current = true;
    try {
      await guard.assertCurrent();
      const result = await decideBusinessReview({ ownerId: context.ownerId!, vaultKey: context.vaultKey!, decision, businessUid: review.candidate.businessUid,
        assertCurrent: guard.assertCurrent });
      if (result === null) throw new Error("A review is already being saved.");
      await guard.assertCurrent(); setState(null); setOpen(false);
    } catch { if (guard.isCurrent()) morphyToast.error("Your choice could not be saved. Try again."); }
    finally { if (guard.isCurrent()) busy.current = false; }
  };

  if (recoveryError && eligible()) return <div role="status" className="space-y-2">
    <HelperText>Your saved business review could not be opened. Nothing has been changed.</HelperText>
    <Button variant="muted" size="standard" onClick={() => setRecoveryAttempt(value => value + 1)}>Retry saved review</Button>
  </div>;
  if (saved || !review || !eligible()) return null;
  const pending = review.phase === "preparing" || review.phase === "saving";
  const introduction = "I found a business you may be connected to. Check the public details below—is this yours?";
  const card = <section aria-label="Is this your business?"
    className="min-w-0 space-y-[var(--app-form-section-gap)]">
    {!open && <Button variant="muted" size="standard" onClick={() => setOpen(true)}>Review business details</Button>}
    {open && <div className="min-w-0 space-y-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-3 sm:p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
          <h3 className="ui-text-row-title break-words text-foreground">{review.name || review.candidate.draft.name}</h3>
          <HelperText>Suggested profile · ownership unverified</HelperText>
          {(review.name !== review.candidate.draft.name || review.website !== review.candidate.draft.website) &&
            <HelperText>Your correction · ownership still unverified</HelperText>}
          </div>
          {!review.job && <Button variant="link" size="standard" disabled={pending} aria-expanded={editing}
            onClick={() => setEditing(value => !value)}>{editing ? "Done editing" : "Edit details"}</Button>}
        </div>
        <div className="space-y-1">
          {review.candidate.synthetic && <HelperText className="font-semibold text-foreground">UAT test suggestion</HelperText>}
          <HelperText className="leading-relaxed text-foreground/80">Why this appeared: {review.candidate.synthetic ? "your verified email domain matches the UAT test business" :
            review.candidate.matchEvidence.map(item => item.kind === "verified_phone" ? "your linked phone matches the directory phone" : item.kind === "verified_email_identity" ? "your verified email matches this directory record" : "your verified email domain matches the business website").join("; ")}. Business ownership has not been verified.</HelperText>
          {!review.candidate.synthetic && <HelperText>Public directory · {review.candidate.sourceIdentity.vertical}</HelperText>}
        </div>
        <dl className="divide-y divide-[color:var(--app-separator)]">
          {Object.entries({ ...review.candidate.draft, name: review.name, website: review.website })
            .filter(([key, value]) => key !== "name" && Boolean(value)).map(([key, value]) => <div key={key}
              className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
              <dt className="ui-text-helper capitalize text-muted-foreground">{key === "name" ? "Business name" : key.replaceAll("_", " ")}</dt>
              <dd className="ui-text-row-description min-w-0 break-words text-foreground [overflow-wrap:anywhere]">{value}</dd>
            </div>)}
        </dl>
        {editing && !review.job && <div className="space-y-[var(--app-form-section-gap)]">
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor={`${fieldId}-name`}>Business name</Label>
            <Input id={`${fieldId}-name`} maxLength={160} value={review.name} disabled={pending}
              onChange={event => update({ ...review, name: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor={`${fieldId}-website`}>Website</Label>
            <Input id={`${fieldId}-website`} type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={512} value={review.website} disabled={pending}
              onChange={event => update({ ...review, website: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
          <HelperText>Website is optional. Use an HTTPS address or clear it before reviewing.</HelperText>
        </div>}
        <HelperText className="leading-relaxed text-foreground/80">Review first, then choose what to save. Nothing is published and no ownership claim is created.</HelperText>
        {review.job && <HelperText>Resuming your original reviewed details. Newer directory fields do not replace a pending save.</HelperText>}
        {!review.job && <Button variant="link" size="standard" disabled={pending} onClick={() => void refresh()}>Refresh listing and restart review</Button>}
        {pending && <p role="status" className="text-sm">{review.phase === "preparing" ? "Preparing details for review…" : "Saving approved details…"}</p>}
        {(review.phase === "review" || review.phase === "saving") && <AgentPkmReviewPanel
          cards={review.cards} selectedCardIds={new Set(review.selected)} saving={pending} showSourceText className="[&_button]:min-h-11"
          onToggleCard={review.job ? undefined : id => update({ ...review, selected: review.selected.includes(id)
            ? review.selected.filter(value => value !== id) : [...review.selected, id] })}
          onSave={() => void save()} onDismiss={() => setOpen(false)} />}
        {(review.phase === "offer" || review.phase === "preparing") ? <FlowActionGroup separateSecondary={false}
          primary={<Button size="standard" loading={review.phase === "preparing"}
            disabled={pending || !review.name.trim()}
            onClick={() => void prepare()}>Review details</Button>}
          secondary={<Button variant="muted" size="standard" disabled={pending} onClick={() => void defer("later")}>Later</Button>}
          tertiary={<Button variant="link" size="standard" disabled={pending} onClick={() => void defer("not_me")}>Not my business</Button>} />
          : <div className="flex flex-wrap justify-end gap-2">
            {!review.job && <Button variant="link" size="standard" disabled={pending} onClick={() => void defer("not_me")}>Not my business</Button>}
            <Button variant="link" size="standard" disabled={pending} onClick={() => void defer("later")}>Later</Button>
          </div>}
      </div>}
    <AlertDialog open={acknowledging && open} onOpenChange={setAcknowledging}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Update shared memory?</AlertDialogTitle>
        <AlertDialogDescription>These details affect memory already shared with {sharingCount} {sharingCount === 1 ? "person" : "people"}.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => void save(true)}>Save and update sharing</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
  return props.renderMessage
    ? props.renderMessage(review.candidate.businessUid, introduction, card)
    : <div data-message-role="assistant" className="space-y-3"><p>{introduction}</p>{card}</div>;
}
