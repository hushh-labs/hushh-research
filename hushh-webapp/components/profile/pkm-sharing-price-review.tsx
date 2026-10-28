"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useCommerceSession } from "@/components/consent/use-commerce-session";
import { ScopeTariffEditor, type SharingPriceReviewRequest } from "@/components/consent/scope-tariff-editor";
import { PkmDomainSharing, type PkmSharingChange } from "@/components/profile/pkm-domain-sharing";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { canonicalActionBinding, useLocalOnboardingActionHandler, type LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { isConsumerBrowsablePkmDomain } from "@/lib/profile/pkm-profile-presentation";
import { matchesSharingPriceSection, parseSharingPriceProposal, sharingPriceTargets, type SharingPriceTarget } from "@/lib/profile/pkm-sharing-price-review";

const ACTION = "pkm.review_sharing_price";
type OpenReview = { target: SharingPriceTarget; proposal: SharingPriceReviewRequest; current: () => boolean };
type Bundle = { key: string; label: string; manifest: DomainManifest };
type BundleReview = { bundle: Bundle; proposal: SharingPriceReviewRequest; current: () => boolean };
type Prepared = { preparation: LocalActionPreparation; target?: SharingPriceTarget; bundle?: Bundle; proposal?: Omit<SharingPriceReviewRequest, "id">; current?: () => boolean };
const blocked = (summary: string): Prepared => ({ preparation: { status: "blocked", gate: "input", summary } });

/** Review-only bridge: the existing editor retains all payment and save authority. */
export function PkmSharingPriceReview() {
  const { user, userId, loading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken, getVaultOwnerToken, tokenExpiresAt } = useVault();
  const { capture } = useCommerceSession("pkm-sharing-price-review");
  const [review, setReview] = useState<OpenReview | null>(null);
  const [bundleReview, setBundleReview] = useState<BundleReview | null>(null);
  const [listingPending, setListingPending] = useState<string | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const active = useRef<OpenReview | null>(null);
  const activeBundle = useRef<BundleReview | null>(null);
  const choices = useRef(new Map<string, SharingPriceTarget>());
  const executing = useRef(false);
  const authorityRevision = useRef(0);
  const enabled = Boolean(user && userId && !loading && !sessionVerificationRequired && isVaultUnlocked && vaultOwnerToken);
  useLayoutEffect(() => {
    const offeredChoices = choices.current;
    authorityRevision.current += 1;
    active.current = null; activeBundle.current = null; offeredChoices.clear(); setReview(null); setBundleReview(null); setListingPending(null); setListingError(null);
    return () => { authorityRevision.current += 1; active.current = null; activeBundle.current = null; offeredChoices.clear(); };
  }, [user, userId, vaultOwnerToken, isVaultUnlocked, sessionVerificationRequired, loading, tokenExpiresAt]);

  function captureAuthority() {
    const owner = snapshotValidatedAuthSessionOwner();
    const viewCurrent = capture();
    const token = getVaultOwnerToken();
    const revision = authorityRevision.current;
    if (!enabled || !owner || owner.userId !== userId || token !== vaultOwnerToken || !token || tokenExpiresAt === null || tokenExpiresAt <= Date.now()) return null;
    return { owner, token, current: () => viewCurrent() && isValidatedAuthSessionOwnerCurrent(owner) &&
      authorityRevision.current === revision && getVaultOwnerToken() === token && tokenExpiresAt > Date.now() };
  }

  async function loadTargets(authority: NonNullable<ReturnType<typeof captureAuthority>>) {
    const { owner, token, current } = authority;
    const [metadata, discovery] = await Promise.all([
      PersonalKnowledgeModelService.getMetadata(owner.userId, true, token, { allowStaleFallback: false }),
      PersonalKnowledgeModelService.getAvailableScopes(owner.userId, token).catch(() => null),
    ]);
    if (!current() || metadata.userId !== owner.userId) throw new Error("Owner changed.");
    if (discovery && discovery.userId !== owner.userId) throw new Error("Owner changed.");
    const targets: SharingPriceTarget[] = [];
    const bundles: Bundle[] = [];
    for (const domain of metadata.domains.filter(isConsumerBrowsablePkmDomain)) {
      if (!current()) throw new Error("Owner changed.");
      const manifest = await PersonalKnowledgeModelService.getDomainManifest(owner.userId, domain.key, token, true);
      if (!current()) throw new Error("Owner changed.");
      if (!manifest) continue;
      if (manifest.domain !== domain.key || (manifest.user_id && manifest.user_id !== owner.userId)) throw new Error("Owner changed.");
      if (!Number.isSafeInteger(manifest.manifest_version) || manifest.manifest_version < 1) continue;
      bundles.push({ key: domain.key, label: domain.displayName || domain.key.replaceAll("_", " "), manifest });
      targets.push(...sharingPriceTargets(manifest, discovery?.scopeEntries));
    }
    return { targets, bundles };
  }

  async function prepare(slots: Record<string, unknown>): Promise<Prepared> {
    const authority = captureAuthority();
    if (!authority) return blocked("Sign in and unlock Memory before reviewing a sharing price.");
    if (active.current || activeBundle.current) return blocked("Finish or close the current sharing review first.");
    try {
      const proposal = parseSharingPriceProposal(slots);
      const { targets, bundles } = await loadTargets(authority);
      if (!authority.current()) return blocked("Your session changed. Open Memory again.");
      const domain = typeof slots.domain === "string" ? slots.domain.trim().toLowerCase() : "";
      const matchingDomains = domain ? bundles.filter(bundle => [bundle.key, bundle.label].some(label => label.toLowerCase() === domain)) : [];
      if (domain && matchingDomains.length !== 1) return blocked("Name the saved area to review its sharing and prices.");
      if (domain && !slots.section && !slots.scope_choice) {
        const bundle = matchingDomains[0]!;
        return { preparation: { status: "ready", summary: "Review this bundle's listing and prices; nothing changes.", binding: {
          ownerId: authority.owner.userId, domain: bundle.key, manifestVersion: bundle.manifest.manifest_version, ...proposal,
        } }, bundle, proposal, current: authority.current };
      }
      const choice = typeof slots.scope_choice === "string" ? slots.scope_choice : "";
      const previous = choice ? choices.current.get(choice) : undefined;
      const section = typeof slots.section === "string" ? slots.section : "";
      const allowedTargets = domain ? targets.filter(target => target.domain === matchingDomains[0]!.key) : targets;
      const matches = choice ? allowedTargets.filter(target => previous && canonicalActionBinding(target) === canonicalActionBinding(previous)) : allowedTargets.filter(target => section && matchesSharingPriceSection(target, section));
      if (choice && matches.length !== 1) return blocked("That section choice changed or expired. Choose it again in Memory.");
      if (matches.length === 1) return { preparation: { status: "ready", summary: "Review the exact section's sharing price; nothing is saved.", binding: { ownerId: authority.owner.userId, ...matches[0], ...proposal } }, target: matches[0], proposal, current: authority.current };
      const candidates = matches.length > 1 ? matches : allowedTargets;
      choices.current.clear();
      if (candidates.length < 2) return blocked(candidates.length ? "Name the exact saved sharing section before reviewing its price." : "Save a shareable section in Memory first.");
      const offered = candidates.map(target => {
        const id = crypto.randomUUID(); choices.current.set(id, target);
        return { id, label: target.label, detail: target.domain };
      });
      return { preparation: { status: "blocked", gate: "input", summary: "Which saved sharing section should we review?", choices: offered } };
    } catch {
      return blocked("The current sharing section or proposed terms could not be verified. Open Memory and review them again.");
    }
  }

  useLocalOnboardingActionHandler(ACTION, async (slots, context) => {
    if (executing.current) return { status: "blocked", summary: "A sharing price review is already being prepared." };
    executing.current = true;
    try {
      const result = await prepare(slots);
      const prepared = result.preparation;
      if (context?.signal?.aborted || !captureAuthority()) return { status: "blocked", summary: "Your session changed. Open Memory again." };
      if (prepared.status !== "ready" || (!result.target && !result.bundle) || !result.current?.()) {
        const offered = prepared.status === "blocked" ? prepared.choices : undefined;
        return { status: "blocked", summary: prepared.summary, data: offered ? { disambiguation: {
          actionId: ACTION, resolveSlot: "scope_choice", slots, prompt: prepared.summary,
          candidates: offered.map(candidate => ({ id: candidate.id, name: candidate.label, detail: candidate.detail, actionLabel: "Review price" })),
        } } : undefined };
      }
      if (context?.preparedBinding && canonicalActionBinding(prepared.binding) !== canonicalActionBinding(context.preparedBinding)) return { status: "blocked", summary: "The section changed. Review it again." };
      if (result.bundle) {
        const next = { bundle: result.bundle, proposal: { id: crypto.randomUUID(), ...result.proposal }, current: result.current };
        activeBundle.current = next; setBundleReview(next); setListingError(null);
        return { status: "succeeded", summary: "Bundle sharing and price review opened; nothing changed." };
      }
      if (!result.target) return { status: "blocked", summary: "Choose the sharing section again." };
      const next = { target: result.target, proposal: { id: crypto.randomUUID(), ...result.proposal }, current: result.current };
      active.current = next; setReview(next);
      return { status: "succeeded", summary: "Sharing price review opened; nothing saved." };
    } finally { executing.current = false; }
  }, { enabled, prepare: async slots => (await prepare(slots)).preparation });

  function closeBundle() {
    if (listingPending) return false;
    activeBundle.current = null; setBundleReview(null); return true;
  }
  useBackLayer("/one/pkm", bundleReview ? 10 : 0, () => { closeBundle(); return true; });
  useLocalOnboardingActionHandler("pkm.close_sharing_bundle_review", () => closeBundle()
    ? { status: "succeeded", summary: "Bundle review closed." } : { status: "blocked", summary: "Wait for the sharing change to finish." }, { enabled: Boolean(bundleReview) });
  usePublishVoiceSurfaceMetadata(bundleReview ? { title: "Bundle sharing and price", interactionLayer: {
    schemaVersion: "voice_interaction_layer.v1", id: "sharing_bundle_review", kind: "sharing_bundle_review", modality: "modal", lifecycle: "open", dismissible: !listingPending,
    dismissActionId: listingPending ? null : "pkm.close_sharing_bundle_review", visibleActionIds: listingPending ? [] : ["pkm.close_sharing_bundle_review"],
    visibleControlIds: ["pkm-close-sharing-bundle-review"], options: [], blocksUnderlyingActions: true, agentContinuity: listingPending ? "suppressed" : "interactive",
  } } : null, { role: "interaction_layer", routeKey: "/one/pkm" });

  async function updateListing(change: PkmSharingChange) {
    const currentReview = activeBundle.current;
    const authority = captureAuthority();
    if (!authority || !currentReview?.current() || listingPending || change.domain !== currentReview.bundle.key || change.manifest !== currentReview.bundle.manifest) return;
    setListingPending(`${change.domain}:${change.scopeHandles.join(",")}`); setListingError(null);
    try {
      const result = await PersonalKnowledgeModelService.updateScopeExposure({ userId: authority.owner.userId, domain: change.domain,
        expectedManifestVersion: change.manifest.manifest_version, vaultOwnerToken: authority.token,
        changes: change.scopeHandles.map(scopeHandle => ({ scopeHandle, visibilityPosture: change.enabled ? "consent_required" : "private" })),
      });
      if (!authority.current() || activeBundle.current !== currentReview) return;
      if (!result.manifest || result.manifest.domain !== change.domain || (result.manifest.user_id && result.manifest.user_id !== authority.owner.userId)) throw new Error("Refresh sharing choices.");
      const next = { ...currentReview, bundle: { ...currentReview.bundle, manifest: result.manifest } };
      activeBundle.current = next; setBundleReview(next);
    } catch { if (authority.current()) setListingError("Sharing choices could not be updated. Close and review the bundle again."); }
    finally { if (authority.current()) setListingPending(null); }
  }

  if (enabled && bundleReview?.current()) return <Dialog modal open onOpenChange={open => { if (!open) closeBundle(); }}><DialogContent data-pkm-overlay="true">
    <DialogHeader><DialogTitle>{bundleReview.bundle.label}: sharing and price</DialogTitle><DialogDescription>Listing lets people request information. Approval and payment remain separate.</DialogDescription></DialogHeader>
    <PkmDomainSharing userId={userId!} title={bundleReview.bundle.label} manifest={bundleReview.bundle.manifest}
      pendingKey={listingPending} onChange={updateListing} onPaymentsNavigate={closeBundle}
      proposal={bundleReview.proposal.proposedPriceCents !== undefined || bundleReview.proposal.proposedBaseHours !== undefined ? bundleReview.proposal : undefined} />
    {listingError ? <p role="status">{listingError}</p> : null}
    <Button variant="ghost" data-pkm-action="utility" data-voice-control-id="pkm-close-sharing-bundle-review" disabled={Boolean(listingPending)} onClick={closeBundle}>Close bundle review</Button>
  </DialogContent></Dialog>;

  if (!enabled || !review?.current()) return null;
  return <ScopeTariffEditor key={review.proposal.id} scopeHandle={review.target.scopeHandle} machineScope={review.target.machineScope}
    label={review.target.label} reviewRequest={review.proposal} onReviewClose={() => { active.current = null; setReview(null); }} />;
}
