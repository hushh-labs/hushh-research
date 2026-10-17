"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { previewAgentPkmMemory, addToPKM, resolveCardTargetDomain, type AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PublicProfileDiscoveryService, type PublicProfileDiscoveryJob, type PublicProfileReview } from "@/lib/services/public-profile-discovery-service";
import { decryptData, encryptData } from "@/lib/vault/encrypt";
import { useVault } from "@/lib/vault/vault-context";

type PrivateReviewDraft = {
  schema_version: "public_profile_private_draft.v1";
  profile_revision: number;
  operation_key: string;
  claim_started?: boolean;
  owner_corrections: string[];
  cards: AgentPkmPreviewCard[];
  selected_card_ids: string[];
  sharing_impact_acknowledged: boolean;
};

function newDraft(revision: number): PrivateReviewDraft {
  return {
    schema_version: "public_profile_private_draft.v1",
    profile_revision: revision,
    operation_key: crypto.randomUUID(),
    owner_corrections: [],
    cards: [],
    selected_card_ids: [],
    sharing_impact_acknowledged: false,
  };
}

function parseDraft(value: string, revision: number): PrivateReviewDraft | null {
  try {
    const candidate = JSON.parse(value) as Partial<PrivateReviewDraft>;
    if (
      candidate.schema_version !== "public_profile_private_draft.v1" ||
      candidate.profile_revision !== revision ||
      typeof candidate.operation_key !== "string" ||
      !Array.isArray(candidate.owner_corrections) ||
      !Array.isArray(candidate.cards) ||
      !Array.isArray(candidate.selected_card_ids)
    ) return null;
    return {
      schema_version: "public_profile_private_draft.v1",
      profile_revision: revision,
      operation_key: candidate.operation_key,
      claim_started: candidate.claim_started === true,
      owner_corrections: candidate.owner_corrections.filter((item): item is string => typeof item === "string"),
      cards: candidate.cards as AgentPkmPreviewCard[],
      selected_card_ids: candidate.selected_card_ids.filter((item): item is string => typeof item === "string"),
      sharing_impact_acknowledged: candidate.sharing_impact_acknowledged === true,
    };
  } catch {
    return null;
  }
}

function collectedDate(value: string | null | undefined): string {
  if (!value) return "Collection date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Collection date unavailable" : "Collected " + date.toLocaleDateString();
}

function sourceHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return "Source"; }
}

function summarizeCard(card: AgentPkmPreviewCard): string {
  const payload = card.candidate_payload;
  if (!payload || typeof payload !== "object") return "Suggested detail";
  const values = Object.values(payload).filter((value) => typeof value === "string" || typeof value === "number");
  return values.slice(0, 3).map(String).join(" · ") || "Suggested detail";
}

export function PublicProfileReviewWorkspace() {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [job, setJob] = useState<PublicProfileDiscoveryJob | null>(null);
  const [profile, setProfile] = useState<PublicProfileReview | null>(null);
  const [draft, setDraft] = useState<PrivateReviewDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingToPkm, setSavingToPkm] = useState(false);
  const [correction, setCorrection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [writeErrors, setWriteErrors] = useState<string[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const loadKey = useRef("");
  const draftRef = useRef<PrivateReviewDraft | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const commitDraft = useCallback((next: PrivateReviewDraft) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const persistDraft = useCallback(async (next: PrivateReviewDraft) => {
    if (!vaultOwnerToken || !vaultKey) throw new Error("Unlock your private vault to save review changes.");
    const operation = saveQueue.current.catch(() => undefined).then(async () => {
      const encrypted = await encryptData(JSON.stringify(next), vaultKey);
      await PublicProfileDiscoveryService.saveEncryptedDraft(vaultOwnerToken, {
        ...encrypted,
        profileRevision: next.profile_revision,
      });
      setSavedAt(new Date().toISOString());
    });
    saveQueue.current = operation;
    await operation;
  }, [vaultKey, vaultOwnerToken]);

  const prepareProfile = useCallback(async (source: PublicProfileReview, corrections: string[], existingCards: AgentPkmPreviewCard[]) => {
    if (!user || !vaultOwnerToken) throw new Error("Unlock your private vault to prepare the review.");
    setPreparing(true);
    setError(null);
    try {
      const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, false, vaultOwnerToken);
      const manifests = await Promise.all(metadata.domains.map(async (domain) =>
        PersonalKnowledgeModelService.getDomainManifest(user.uid, domain.key, vaultOwnerToken).catch(() => null),
      ));
      const message = [
        "Create reviewable personal knowledge candidates from the following unverified public-web findings.",
        "Treat each finding as evidence to assess, preserve source URLs in the proposed record, and do not treat a match as certain identity when the evidence is ambiguous.",
        "Public findings: " + JSON.stringify(source.facts),
        "Public profile summary: " + source.summary,
        "Return the complete revised draft. Keep unrelated details and their card IDs unchanged; replace corrected details rather than append contradictory copies. Existing draft: " + JSON.stringify(existingCards),
        ...corrections.map((item) => "Owner-provided correction (not a public source): " + item),
      ].join("\n\n");
      const preview = await previewAgentPkmMemory({
        userId: user.uid,
        message,
        currentDomains: metadata.domains.map((domain) => domain.key),
        currentManifests: manifests,
        vaultOwnerToken,
        ingestionId: "public-profile-" + source.revision,
        memoryProfile: "general",
      });
      return preview.cards;
    } finally {
      setPreparing(false);
    }
  }, [user, vaultOwnerToken]);

  useEffect(() => {
    if (!user || !vaultKey || !vaultOwnerToken) return;
    const key = user.uid + ":profile-discovery-review";
    if (loadKey.current === key) return;
    loadKey.current = key;
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const current = await PublicProfileDiscoveryService.getReview(vaultOwnerToken);
        if (!active) return;
        setJob(current);
        if (!current?.profile || current.status !== "ready") {
          setProfile(current?.profile || null);
          return;
        }
        setProfile(current.profile);
        const revision = current.profile.revision;
        let loadedDraft: PrivateReviewDraft | null = null;
        if (current.encrypted_draft?.profile_revision === revision) {
          const plaintext = await decryptData({ ...current.encrypted_draft, encoding: "base64" }, vaultKey);
          loadedDraft = parseDraft(plaintext, revision);
        }
        if (!loadedDraft) {
          loadedDraft = newDraft(revision);
          commitDraft(loadedDraft);
          const generated = await prepareProfile(current.profile, [], []);
          loadedDraft = { ...loadedDraft, cards: generated };
          if (active) {
            commitDraft(loadedDraft);
            await persistDraft(loadedDraft);
          }
        } else if (active) {
          commitDraft(loadedDraft);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "We couldn’t open this review.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [commitDraft, persistDraft, prepareProfile, user, vaultKey, vaultOwnerToken]);

  const hasSharingImpact = useMemo(() => Boolean(draft?.cards.some((card) =>
    draft.selected_card_ids.includes(card.card_id) && (card.sharing_impact?.active_recipient_count || 0) > 0,
  )), [draft]);

  const updateDraft = async (next: PrivateReviewDraft) => {
    commitDraft(next);
    setSaving(true);
    setError(null);
    try {
      await persistDraft(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review changes could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const revise = async () => {
    if (!profile || !draft || draft.claim_started || !correction.trim()) return;
    const nextCorrections = [...draft.owner_corrections, correction.trim()];
    setSaving(true);
    setError(null);
    try {
      const additions = await prepareProfile(profile, nextCorrections, draft.cards);
      if (!additions.length) throw new Error("The redraft returned no reviewable details. Your existing draft is preserved.");
      const next = { ...draft, owner_corrections: nextCorrections, cards: additions,
        selected_card_ids: draft.selected_card_ids.filter(id => additions.some(card => card.card_id === id)) };
      await persistDraft(next);
      commitDraft(next);
      setCorrection("");
      setSavedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft could not be revised.");
    } finally {
      setSaving(false);
    }
  };

  const setSelected = (cardId: string, selected: boolean) => {
    const current = draftRef.current;
    if (!current || current.claim_started) return;
    const ids = new Set(current.selected_card_ids);
    if (selected) ids.add(cardId); else ids.delete(cardId);
    void updateDraft({ ...current, selected_card_ids: [...ids] });
  };

  const completeClaim = async (rejectAll: boolean) => {
    if (!user || !profile || !draft || !vaultKey || !vaultOwnerToken || savingToPkm) return;
    const chosen = rejectAll ? [] : draft.cards.filter((card) => draft.selected_card_ids.includes(card.card_id));
    if (!rejectAll && chosen.length === 0) {
      setError("Choose at least one detail, or discard the whole profile.");
      return;
    }
    setSavingToPkm(true);
    setError(null);
    setWriteErrors([]);
    try {
      if (!rejectAll) {
        if (!draft.claim_started) {
          const frozen = { ...draft, claim_started: true };
          await persistDraft(frozen);
          commitDraft(frozen);
        }
        const receipts = await PublicProfileDiscoveryService.prepareClaim(vaultOwnerToken, {
          profileRevision: profile.revision, operationKey: draft.operation_key,
          cards: chosen.map(card => ({ card_id: card.card_id, domain: resolveCardTargetDomain(card) })),
        });
        const pending = chosen.filter(card => !receipts.committed_card_ids.includes(card.card_id));
        const sourceMessage = [
          "One-time public profile claim.",
          ...profile.facts.map((fact) => fact.claim + (fact.source_urls.length ? " Sources: " + fact.source_urls.join(", ") : "")),
          ...draft.owner_corrections.map((item) => "Owner-provided correction (not a public source): " + item),
        ].join("\n");
        const result = pending.length ? await addToPKM({
          userId: user.uid,
          cards: pending,
          sourceMessage,
          vaultKey,
          vaultOwnerToken,
          source: "public_profile_discovery",
          idempotencyScope: draft.operation_key,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "public_profile_claim",
            sharingImpactAcknowledged: hasSharingImpact && draft.sharing_impact_acknowledged,
          },
        }) : { results: [], failed: 0, saved: 0 };
        const failures = result.results.filter((item) => !item.success).map((item) => item.message || "A selected detail could not be saved.");
        if (failures.length) {
          setWriteErrors(failures);
          setError("Some selected details are still pending. Retry to safely finish the save.");
          return;
        }
      }
      const finished = await PublicProfileDiscoveryService.completeClaim(vaultOwnerToken, {
        profileRevision: profile.revision,
        idempotencyKey: draft.operation_key,
        rejectAll,
        acceptedCount: chosen.length,
      });
      setJob(finished);
      if (finished?.status === "claimed") router.replace(ROUTES.ONE_HOME);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff did not finish. Retry to continue safely.");
    } finally {
      setSavingToPkm(false);
    }
  };

  if (loading) return <p className="py-8 text-sm text-muted-foreground" role="status">Opening your profile review…</p>;
  if (!profile || !job) return (
    <section className="rounded-[var(--app-card-radius)] border border-border/70 bg-card p-5">
      <h1 className="text-xl font-semibold">Your public profile</h1>
      <p className="mt-2 text-sm text-muted-foreground">There isn’t a completed public profile to review yet. You can keep using One while discovery runs.</p>
      <Link className="mt-4 inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={ROUTES.ONE_HOME}>Return to One</Link>
    </section>
  );
  if (job.status === "claimed") return (
    <section className="rounded-[var(--app-card-radius)] border border-border/70 bg-card p-5" role="status">
      <h1 className="text-xl font-semibold">This review is complete</h1>
      <p className="mt-2 text-sm text-muted-foreground">This one-time handoff is finished. Public information will not be imported again automatically.</p>
      <Link className="mt-4 inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={ROUTES.ONE_HOME}>Return to One</Link>
    </section>
  );
  if (!draft) return <p className="py-8 text-sm text-muted-foreground" role="status">Preparing your private review…</p>;

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm text-muted-foreground">One-time public profile review</p>
        <h1 className="mt-1 text-2xl font-semibold">{profile.display_name}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{profile.summary || "Review these public findings and choose what, if anything, to save."}</p>
        <p className="mt-2 text-xs text-muted-foreground">Profile revision {profile.revision} · {collectedDate(profile.collected_at)}</p>
      </header>

      <section className="space-y-3" aria-labelledby="public-findings-title">
        <h2 id="public-findings-title" className="text-lg font-semibold">Public findings</h2>
        {profile.facts.map((fact, index) => (
          <article key={index} className="rounded-[var(--app-card-radius-compact)] border border-border/70 bg-card p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{fact.category}</span><span>·</span><span>{fact.confidence ? fact.confidence + " confidence" : "Unverified"}</span><span>·</span><span>{fact.observed_at ? "Observed " + new Date(fact.observed_at).toLocaleDateString() : collectedDate(fact.collected_at)}</span></div>
            <p className="mt-2 text-sm leading-6">{fact.claim}</p>
            {fact.support ? <p className="mt-1 text-sm text-muted-foreground">{fact.support}</p> : null}
            {fact.source_urls.map((url) => <a className="mt-2 mr-4 inline-flex min-h-11 items-center break-all text-xs underline underline-offset-4" key={url} href={url} target="_blank" rel="noreferrer">Source: {sourceHostname(url)}</a>)}
          </article>
        ))}
      </section>

      {profile.conflicts.length || profile.warnings.length ? (
        <section className="rounded-[var(--app-card-radius-compact)] border border-amber-500/30 bg-amber-500/5 p-4" aria-labelledby="profile-review-notes">
          <h2 id="profile-review-notes" className="font-semibold">Uncertainty and conflicts</h2>
          {[...profile.conflicts, ...profile.warnings].map((item, index) => <p key={index} className="mt-2 text-sm leading-6">{item}</p>)}
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="draft-title">
        <div><h2 id="draft-title" className="text-lg font-semibold">Draft for your private knowledge model</h2><p className="mt-1 text-sm text-muted-foreground">The AI prepared these suggestions. Select only what you want to save. Changes and corrections are encrypted with your vault key.</p></div>
        {preparing ? <p className="text-sm text-muted-foreground" role="status">Preparing an updated draft…</p> : null}
        {draft.cards.map((card) => {
          const selectable = card.write_mode === "can_save" || card.write_mode === "confirm_first";
          return <article key={card.card_id} className="rounded-[var(--app-card-radius-compact)] border border-border/70 bg-card p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input className="mt-1 size-4 accent-primary" type="checkbox" checked={draft.selected_card_ids.includes(card.card_id)} disabled={draft.claim_started || !selectable || saving || savingToPkm} onChange={(event) => setSelected(card.card_id, event.target.checked)} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{card.target_domain || "Suggested information"}</span>
                <span className="mt-1 block text-sm leading-6">{card.source_text || summarizeCard(card)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{summarizeCard(card)}{selectable ? " · Review before saving" : " · This suggestion cannot be saved"}</span>
                {card.sharing_impact?.active_recipient_count ? <span className="mt-2 block text-xs text-amber-700 dark:text-amber-300">May update information already shared with {card.sharing_impact.active_recipient_count} recipient(s).</span> : null}
              </span>
            </label>
          </article>;
        })}
        <div className="rounded-[var(--app-card-radius-compact)] border border-border/70 p-4">
          <label htmlFor="profile-owner-correction" className="text-sm font-medium">Correct or add something</label>
          <p className="mt-1 text-xs text-muted-foreground">Your correction is marked as owner-provided, not attributed to a public source.</p>
          <Textarea id="profile-owner-correction" className="mt-3" value={correction} onChange={(event) => setCorrection(event.target.value)} placeholder="For example: I no longer work there; I joined…" maxLength={2000} />
          <Button className="mt-3" type="button" variant="none" effect="fade" disabled={draft.claim_started || !correction.trim() || preparing || saving || savingToPkm} onClick={() => void revise()}>Redraft with correction</Button>
          {draft.owner_corrections.length ? <div className="mt-3 space-y-2"><p className="text-xs font-medium">Owner-provided corrections</p>{draft.owner_corrections.map((item, index) => <p key={index} className="text-sm">{item}</p>)}</div> : null}
        </div>
        {hasSharingImpact ? <label className="flex min-h-11 items-start gap-3 py-2 text-sm leading-5"><input className="mt-1 size-4 accent-primary" type="checkbox" checked={draft.sharing_impact_acknowledged} onChange={(event) => void updateDraft({ ...draft, sharing_impact_acknowledged: event.target.checked })} /><span>I understand selected information may change the encrypted records already shared with the recipients shown above.</span></label> : null}
        <p className="text-xs text-muted-foreground" role="status">{saving ? "Saving encrypted review changes…" : savedAt ? "Encrypted review saved." : "Review changes are kept in your private vault."}</p>
      </section>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {writeErrors.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-destructive" role="alert">{writeErrors.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
      {confirmDiscard ? <div className="rounded-[var(--app-card-radius-compact)] border border-border p-4" role="group" aria-label="Confirm profile discard"><p className="text-sm">Discard all public findings from this one-time handoff? This will add nothing to your private knowledge model.</p><div className="mt-3 flex gap-2"><Button type="button" variant="blue" effect="fill" disabled={savingToPkm} onClick={() => void completeClaim(true)}>Confirm discard</Button><Button type="button" variant="none" effect="fade" onClick={() => setConfirmDiscard(false)}>Keep reviewing</Button></div></div> : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button type="button" variant="blue" effect="fill" disabled={savingToPkm || saving || preparing || draft.selected_card_ids.length === 0 || (hasSharingImpact && !draft.sharing_impact_acknowledged)} onClick={() => void completeClaim(false)}>{savingToPkm ? "Saving selected information…" : "Save selected information"}</Button>
        {!confirmDiscard ? <Button type="button" variant="none" effect="fade" disabled={draft.claim_started || savingToPkm} onClick={() => setConfirmDiscard(true)}>Discard this profile</Button> : null}
        <span className="text-xs text-muted-foreground">After either choice, this flow ends and will not re-import later.</span>
      </div>
    </div>
  );
}
