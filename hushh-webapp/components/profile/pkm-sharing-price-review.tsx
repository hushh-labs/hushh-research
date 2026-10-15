"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useCommerceSession } from "@/components/consent/use-commerce-session";
import { ScopeTariffEditor, type SharingPriceReviewRequest } from "@/components/consent/scope-tariff-editor";
import { canonicalActionBinding, useLocalOnboardingActionHandler, type LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { isConsumerBrowsablePkmDomain } from "@/lib/profile/pkm-profile-presentation";
import { matchesSharingPriceSection, parseSharingPriceProposal, sharingPriceTargets, type SharingPriceTarget } from "@/lib/profile/pkm-sharing-price-review";

const ACTION = "pkm.review_sharing_price";
type OpenReview = { target: SharingPriceTarget; proposal: SharingPriceReviewRequest; current: () => boolean };
type Prepared = { preparation: LocalActionPreparation; target?: SharingPriceTarget; proposal?: Omit<SharingPriceReviewRequest, "id">; current?: () => boolean };
const blocked = (summary: string): Prepared => ({ preparation: { status: "blocked", gate: "input", summary } });

/** Review-only bridge: the existing editor retains all payment and save authority. */
export function PkmSharingPriceReview() {
  const { user, loading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken, getVaultOwnerToken, tokenExpiresAt } = useVault();
  const { capture } = useCommerceSession("pkm-sharing-price-review");
  const [review, setReview] = useState<OpenReview | null>(null);
  const active = useRef<OpenReview | null>(null);
  const choices = useRef(new Map<string, SharingPriceTarget>());
  const executing = useRef(false);
  const authorityRevision = useRef(0);
  const enabled = Boolean(user && !loading && !sessionVerificationRequired && isVaultUnlocked && vaultOwnerToken);
  useLayoutEffect(() => {
    const offeredChoices = choices.current;
    authorityRevision.current += 1;
    active.current = null; offeredChoices.clear(); setReview(null);
    return () => { authorityRevision.current += 1; active.current = null; offeredChoices.clear(); };
  }, [user, vaultOwnerToken, isVaultUnlocked, sessionVerificationRequired, loading, tokenExpiresAt]);

  function captureAuthority() {
    const owner = snapshotValidatedAuthSessionOwner();
    const viewCurrent = capture();
    const token = getVaultOwnerToken();
    const revision = authorityRevision.current;
    if (!enabled || !owner || owner.userId !== user?.uid || token !== vaultOwnerToken || !token || tokenExpiresAt === null || tokenExpiresAt <= Date.now()) return null;
    return { owner, token, current: () => viewCurrent() && isValidatedAuthSessionOwnerCurrent(owner) &&
      authorityRevision.current === revision && getVaultOwnerToken() === token && tokenExpiresAt > Date.now() };
  }

  async function loadTargets(authority: NonNullable<ReturnType<typeof captureAuthority>>) {
    const { owner, token, current } = authority;
    const metadata = await PersonalKnowledgeModelService.getMetadata(owner.userId, true, token, { allowStaleFallback: false });
    if (!current() || metadata.userId !== owner.userId) throw new Error("Owner changed.");
    const targets: SharingPriceTarget[] = [];
    for (const domain of metadata.domains.filter(isConsumerBrowsablePkmDomain)) {
      if (!current()) throw new Error("Owner changed.");
      const manifest = await PersonalKnowledgeModelService.getDomainManifest(owner.userId, domain.key, token, true);
      if (!current()) throw new Error("Owner changed.");
      if (!manifest) continue;
      if (manifest.domain !== domain.key || (manifest.user_id && manifest.user_id !== owner.userId)) throw new Error("Owner changed.");
      targets.push(...sharingPriceTargets(manifest));
    }
    return targets;
  }

  async function prepare(slots: Record<string, unknown>): Promise<Prepared> {
    const authority = captureAuthority();
    if (!authority) return blocked("Sign in and unlock Memory before reviewing a sharing price.");
    if (active.current) return blocked("Finish or close the current sharing price review first.");
    try {
      const proposal = parseSharingPriceProposal(slots);
      const targets = await loadTargets(authority);
      if (!authority.current()) return blocked("Your session changed. Open Memory again.");
      const choice = typeof slots.scope_choice === "string" ? slots.scope_choice : "";
      const previous = choice ? choices.current.get(choice) : undefined;
      const section = typeof slots.section === "string" ? slots.section : "";
      const matches = choice ? targets.filter(target => previous && canonicalActionBinding(target) === canonicalActionBinding(previous)) : targets.filter(target => section && matchesSharingPriceSection(target, section));
      if (choice && matches.length !== 1) return blocked("That section choice changed or expired. Choose it again in Memory.");
      if (matches.length === 1) return { preparation: { status: "ready", summary: "Review the exact section's sharing price; nothing is saved.", binding: { ownerId: authority.owner.userId, ...matches[0], ...proposal } }, target: matches[0], proposal, current: authority.current };
      const candidates = matches.length > 1 ? matches : targets;
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
      if (prepared.status !== "ready" || !result.target || !result.current?.()) {
        const offered = prepared.status === "blocked" ? prepared.choices : undefined;
        return { status: "blocked", summary: prepared.summary, data: offered ? { disambiguation: {
          actionId: ACTION, resolveSlot: "scope_choice", slots, prompt: prepared.summary,
          candidates: offered.map(candidate => ({ id: candidate.id, name: candidate.label, detail: candidate.detail, actionLabel: "Review price" })),
        } } : undefined };
      }
      if (context?.preparedBinding && canonicalActionBinding(prepared.binding) !== canonicalActionBinding(context.preparedBinding)) return { status: "blocked", summary: "The section changed. Review it again." };
      const next = { target: result.target, proposal: { id: crypto.randomUUID(), ...result.proposal }, current: result.current };
      active.current = next; setReview(next);
      return { status: "succeeded", summary: "Sharing price review opened; nothing saved." };
    } finally { executing.current = false; }
  }, { enabled, prepare: async slots => (await prepare(slots)).preparation });

  if (!enabled || !review?.current()) return null;
  return <ScopeTariffEditor key={review.proposal.id} scopeHandle={review.target.scopeHandle} machineScope={review.target.machineScope}
    label={review.target.label} reviewRequest={review.proposal} onReviewClose={() => { active.current = null; setReview(null); }} />;
}
