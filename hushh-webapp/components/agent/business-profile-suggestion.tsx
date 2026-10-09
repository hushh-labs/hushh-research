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
import { businessReviewFields, businessReviewItems, initialBusinessFieldSelection, selectBusinessReviewFields, type BusinessFieldSelection, type BusinessReviewItem } from "@/lib/agent/business-profile-fields";

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
  fields?: BusinessFieldSelection;
  error?: string;
  phase: "offer" | "preparing" | "review" | "saving";
};

/** On-demand discovery; each distinct business has an independent review. */
export function BusinessProfileSuggestion(props: Props) {
  const [discovery, setDiscovery] = useState<{ ownerId: string; token: string; key: string;
    candidates: BusinessCandidate[]; incomplete: boolean; status: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
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
  }, [ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt, attempt]);
  if (!enabled || !ownerId || !vaultKey || !vaultOwnerToken || tokenExpiresAt === null || Date.now() >= tokenExpiresAt ||
    discovery?.ownerId !== ownerId || discovery.token !== vaultOwnerToken || discovery.key !== vaultKey) return null;
  const candidates = discovery.candidates.filter(candidate => !props.dismissedBusinessUids?.has(candidate.businessUid));
  const retryableStatus = discovery.status === "unavailable" || discovery.incomplete;
  if (!candidates.length && !retryableStatus && discovery.status !== "insufficient_signals") return null;
  return <div className="space-y-[var(--app-form-section-gap)]">
    {retryableStatus && <div className="space-y-[var(--app-form-field-gap)]">
      <HelperText>{discovery.status === "unavailable"
        ? "Business lookup is temporarily unavailable. Nothing was saved; try again when the directory is reachable."
        : "Business lookup is incomplete. Available suggestions may not include every business."}</HelperText>
      <Button variant="link" size="standard" onClick={() => setAttempt(value => value + 1)}>Retry business lookup</Button>
    </div>}
    {discovery.status === "insufficient_signals" && <HelperText>Your verified contacts could not be used for business lookup yet. Nothing has been saved.</HelperText>}
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
  const [operation, setOperation] = useState<"refresh" | "later" | "not_me" | null>(null);
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
    setState(null); setRecoveryError(false); setAcknowledging(false); setOpen(false); setEditing(false); setSaved(false); setOperation(null);
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
          fields: initialBusinessFieldSelection(job?.cards || []), job, phase: job ? "review" : "offer" } });
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
    setOperation("refresh");
    try {
      const result = await BusinessSuggestionService.get(context.vaultOwnerToken!, controller.current?.signal);
      await guard.assertCurrent();
      const candidate = result.candidates.find(row => row.businessUid === review.candidate.businessUid);
      if (!candidate) throw new Error("Unavailable");
      update({ candidate, name: candidate.draft.name, website: candidate.draft.website,
        message: "", cards: [], selected: [], phase: "offer" });
      setEditing(false);
    } catch { if (guard.isCurrent()) morphyToast.error("The listing could not be refreshed. Your review is unchanged."); }
    finally { if (guard.isCurrent()) { busy.current = false; setOperation(null); } }
  };
  const prepare = async () => {
    if (!review || busy.current || review.job) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    busy.current = true;
    update({ ...review, error: undefined, phase: "preparing" });
    let stage: "lookup" | "details" | "preview" | "coverage" | "origin" = "lookup";
    try {
      await freshCandidate(guard);
      stage = "details";
      const message = businessDraftMessage(review.candidate, review.name, review.website);
      stage = "preview";
      // Keep older isolated test/module mocks compatible while the real
      // implementation supplies the deterministic UAT card builder.
      const syntheticCards = buildSyntheticBusinessPreview?.(review.candidate, review.name, review.website) ?? [];
      const result = syntheticCards.length
        ? { cards: syntheticCards, incomplete: false, alreadySaved: false }
        : await prepareConnectorMemoryReview({ ...guard, userId: context.ownerId!,
          vaultKey: context.vaultKey!, vaultOwnerToken: context.vaultOwnerToken!, message, source: "business_profile_review",
          businessUid: review.candidate.businessUid });
      await guard.assertCurrent();
      stage = "coverage";
      if (result.alreadySaved && !result.incomplete && !result.cards.length) {
        // Exact duplicate evidence is not a new save or an ownership claim.
        setSaved(true);
        props.onSaved?.(review.candidate.businessUid);
        setState(null); setOpen(false);
        morphyToast.success("Details already saved");
        return;
      }
      if (result.incomplete || !result.cards.length) throw new Error("The details could not be fully prepared. Please try again.");
      // Ensure source identity can follow the actual semantic entity before offering Save.
      stage = "origin";
      result.cards.forEach(card => attachBusinessOrigin(card, review.candidate));
      update({ ...review, error: undefined, message, cards: result.cards, selected: result.cards.map(card => card.card_id),
        fields: initialBusinessFieldSelection(result.cards), phase: "review" });
    } catch (error) {
      if (guard.isCurrent()) {
        // Bounded diagnostics only: never log source details, keys or preview payloads.
        const originReason = error instanceof BusinessOriginValidationError ? error.reason : stage === "origin" && error instanceof Error
          ? error.message === "The proposed detail needs a fresh review before saving." ? "entity-shape"
            : error.message === "The proposed destination changed. Review the details again." ? "entity-destination" : "source-identity"
          : "unavailable";
        console.warn(`[BusinessReview] Preparation failed at ${stage}: ${originReason}`);
        const failure = error instanceof Error && error.name === "PkmBackendContractMismatch"
          ? "Review is unavailable until the backend update finishes."
          : stage === "lookup" ? "Listing changed. Edit details, then refresh."
          : stage === "details" ? "Check the name and website."
          : "Details couldn’t be prepared. Try again.";
        update({ ...review, error: failure, phase: "offer" });
        morphyToast.error(stage === "lookup" ? "Listing changed or unavailable. Edit details, then refresh."
          : stage === "details" ? "Check the name and website in Edit details."
          : "Couldn’t prepare details. Try Review details again.");
      }
    } finally { if (guard.isCurrent()) busy.current = false; }
  };
  const chosen = review?.cards.filter(card => review.selected.includes(card.card_id)).flatMap(card => {
    // Frozen jobs replay exactly what was approved; never change a retry scope.
    if (review.job) return [card];
    const selected = selectBusinessReviewFields(card, review.fields?.[card.card_id] || []);
    return selected ? [selected] : [];
  }) || [];
  const fieldCount = businessReviewItems(chosen).length;
  const reviewItems = review ? businessReviewItems(review.cards) : [];
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
      const job = review.job || createBusinessReviewJob(context.ownerId!, review.candidate, chosen.map(card => card.source_text).join("\n\n"), chosen,
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
          selected: job.cards.map(card => card.card_id), fields: initialBusinessFieldSelection(job.cards), phase: "review" });
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
            selected: job?.cards.map(card => card.card_id) || review.selected,
            fields: job ? initialBusinessFieldSelection(job.cards) : review.fields, phase: "review" });
        } catch { if (guard.isCurrent()) update({ ...review, job: attemptedJob,
          cards: attemptedJob?.cards || review.cards, selected: attemptedJob?.cards.map(card => card.card_id) || review.selected,
          fields: attemptedJob ? initialBusinessFieldSelection(attemptedJob.cards) : review.fields, phase: "review" }); }
      }
    } finally { if (guard.isCurrent()) busy.current = false; }
  };
  const defer = async (decision: "later" | "not_me") => {
    if (!review || busy.current) return;
    const guard = session(); if (!guard.isCurrent()) return;
    busy.current = true;
    setOperation(decision);
    try {
      await guard.assertCurrent();
      const result = await decideBusinessReview({ ownerId: context.ownerId!, vaultKey: context.vaultKey!, decision, businessUid: review.candidate.businessUid,
        assertCurrent: guard.assertCurrent });
      if (result === null) throw new Error("A review is already being saved.");
      await guard.assertCurrent(); setState(null); setOpen(false);
    } catch { if (guard.isCurrent()) morphyToast.error("Your choice could not be saved. Try again."); }
    finally { if (guard.isCurrent()) { busy.current = false; setOperation(null); } }
  };

  if (recoveryError && eligible()) return <div role="status" className="space-y-2">
    <HelperText>Your saved business review could not be opened. Nothing has been changed.</HelperText>
    <Button variant="muted" size="standard" onClick={() => setRecoveryAttempt(value => value + 1)}>Retry saved review</Button>
  </div>;
  if (saved || !review || !eligible()) return null;
  const pending = review.phase === "preparing" || review.phase === "saving" || operation !== null;
  const introduction = "Is this your business?";
  const draft = review.candidate.draft;
  const overview = {
    category: draft.category,
    address: draft.formatted_address || [draft.address_line1 || draft.street1, draft.city,
      [draft.state, draft.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    website: review.website.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  };
  const renderReviewItem = (item: BusinessReviewItem) => {
    const selectedCount = item.fields.filter(field => review.selected.includes(field.cardId) && review.fields?.[field.cardId]?.includes(field.fieldId)).length;
    const mixed = selectedCount > 0 && selectedCount < item.fields.length;
    return <label key={item.id} className="flex min-h-11 cursor-pointer items-start gap-3 py-3">
      <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--app-accent)]"
        checked={selectedCount === item.fields.length} aria-checked={mixed ? "mixed" : selectedCount === item.fields.length}
        ref={node => { if (node) node.indeterminate = mixed; }}
        disabled={pending || Boolean(review.job)} aria-label={`Save ${item.label.toLowerCase()}`}
        onChange={event => {
          if (review.job || pending) return;
          const fields = { ...review.fields };
          for (const field of item.fields) {
            const next = new Set(fields[field.cardId] || []);
            if (event.target.checked) next.add(field.fieldId); else next.delete(field.fieldId);
            fields[field.cardId] = [...next];
          }
          update({ ...review, fields, selected: review.cards.filter(item => fields[item.card_id]?.length).map(item => item.card_id) });
        }} />
      <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{item.label}</span>
        <span className="block whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">{item.text}</span>
        {new Set(reviewItems.map(detail => detail.destination)).size > 1 && <span className="block text-xs text-muted-foreground">{item.destination}</span>}
      </span>
    </label>;
  };
  const card = <section aria-label="Is this your business?"
    className="min-w-0 space-y-[var(--app-form-section-gap)]">
    {!open && <Button variant="muted" size="standard" onClick={() => setOpen(true)}>Review business details</Button>}
    {open && <div className="min-w-0 space-y-5 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-4 sm:p-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
          <h3 className="ui-text-row-title break-words text-foreground">{review.name || review.candidate.draft.name}</h3>
          <HelperText>Suggested profile · unverified</HelperText>
          </div>
          {!review.job && <Button variant="link" size="standard" disabled={pending} aria-expanded={editing}
            onClick={() => setEditing(value => !value)}>{editing ? "Done editing" : "Edit details"}</Button>}
        </div>
        <details className="ui-text-helper text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3">Why this match</summary>
          {review.candidate.synthetic && <HelperText className="font-semibold text-foreground">UAT test suggestion</HelperText>}
          <HelperText>{review.candidate.synthetic ? "Email domain matches this test business." :
            [...new Set(review.candidate.matchEvidence.map(item => item.kind === "verified_phone" ? "Verified phone matches." : item.kind === "verified_email_identity" ? "Verified email matches." : "Email domain matches."))].join(" ")}</HelperText>
          {!review.candidate.synthetic && <HelperText>Public directory · {review.candidate.sourceIdentity.vertical}</HelperText>}
        </details>
        {review.phase !== "review" && review.phase !== "saving" && <dl className="space-y-2">
          {Object.entries(overview).filter(([, value]) => Boolean(value)).map(([key, value]) => <div key={key}
              className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
              <dt className="ui-text-helper capitalize text-muted-foreground">{key}</dt>
              <dd className="ui-text-row-description min-w-0 break-words text-foreground [overflow-wrap:anywhere]">{value}</dd>
            </div>)}
        </dl>}
        {editing && !review.job && <div className="space-y-[var(--app-form-section-gap)]">
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor={`${fieldId}-name`}>Business name</Label>
            <Input id={`${fieldId}-name`} maxLength={160} value={review.name} disabled={pending}
              onChange={event => update({ ...review, name: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor={`${fieldId}-website`}>Website</Label>
            <Input id={`${fieldId}-website`} type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={512} value={review.website} disabled={pending}
              onChange={event => update({ ...review, website: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
          <HelperText>Website is optional.</HelperText>
        </div>}
        <HelperText>Only selected details are saved privately. This does not verify ownership.</HelperText>
        {review.job && <HelperText>Resuming your approved selection.</HelperText>}
        {editing && !review.job && <Button variant="link" size="standard" disabled={pending} onClick={() => void refresh()}>Refresh listing</Button>}
        {review.error && <p role="alert" className="text-sm">{review.error}</p>}
        {pending && <p role="status" className="text-sm">{operation === "refresh" ? "Refreshing listing…" : operation ? "Saving your choice…" : review.phase === "preparing" ? "Preparing details for review…" : "Saving approved details…"}</p>}
        {(review.phase === "review" || review.phase === "saving") && <AgentPkmReviewPanel
          cards={review.cards} selectedCardIds={new Set(chosen.map(card => card.card_id))} saving={pending} compact showDismissAction={false} className="[&_button]:min-h-11"
          saveLabel={`Save ${fieldCount} ${fieldCount === 1 ? "detail" : "details"}`}
          reviewContent={<div className="min-w-0">
            <fieldset disabled={pending || Boolean(review.job)}>
              <legend className="sr-only">Choose business details</legend>
              <div className="divide-y divide-[color:var(--app-separator)]">{reviewItems.filter(item => !item.recordDetail).map(renderReviewItem)}</div>
              {reviewItems.some(item => item.recordDetail) && <details className="mt-3">
                <summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">Record details · {reviewItems.filter(item => item.recordDetail && item.fields.some(field => review.selected.includes(field.cardId) && review.fields?.[field.cardId]?.includes(field.fieldId))).length} selected</summary>
                {reviewItems.filter(item => item.recordDetail).map(renderReviewItem)}
              </details>}
            </fieldset>
            <HelperText>Unchecked details won’t be added or changed.</HelperText>
            {review.cards.some(card => card.validation_hints?.includes("possible_duplicate")) && <HelperText>Some details may already be in your memory.</HelperText>}
            {sharingCount > 0 && <HelperText>Selected details affect memory shared with {sharingCount} {sharingCount === 1 ? "person" : "people"}.</HelperText>}
          </div>}
          onToggleCard={review.job ? undefined : id => {
            const selected = review.selected.includes(id);
            update({ ...review, selected: selected ? review.selected.filter(value => value !== id) : [...review.selected, id],
              fields: { ...review.fields, [id]: selected ? [] : businessReviewFields(review.cards.find(card => card.card_id === id)!).map(field => field.id) } });
          }}
          onSave={() => void save()} onDismiss={() => setOpen(false)} />}
        {(review.phase === "offer" || review.phase === "preparing") ? <FlowActionGroup separateSecondary={false}
          primary={<Button size="standard" loading={review.phase === "preparing"}
            disabled={pending || !review.name.trim()}
            onClick={() => void prepare()}>Review details</Button>}
          secondary={<div className="flex items-center gap-2">
            <Button variant="link" size="standard" disabled={pending} onClick={() => void defer("not_me")}>Not my business</Button>
            <Button variant="muted" size="standard" disabled={pending} onClick={() => void defer("later")}>Later</Button>
          </div>} />
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
