"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { toast } from "sonner";
import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerChoice, NativeDrawerRow, NativeProfilePage, NativeWorldModelPageId } from "@/lib/capacitor/native-drawers";
import type { WorldModelForm } from "@/lib/capacitor/native-profile-world-model-scene";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { PWM_AZURE_RESEARCH_DISCLOSURE } from "@/components/onboarding/setup/pwm-research-disclosure";
import { PROFILE_SECTION_LABELS, type ProfileResearchResult } from "@/lib/services/profile-research-service";
import { formatMaskedPhoneNumber } from "@/lib/services/phone-display";
import { useProfileResearchModel } from "@/components/agent/profile-research-card";
import type { PersonalWorldModelModel } from "./personal-world-model-page";
import type { WorldModelFactDetail } from "./world-model-fact-sheet";
import { maskEmail } from "./world-model-progress";
import { nativeSearchSuggestions } from "./world-model-search-suggestions";
import { useWorldModelSources } from "./world-model-sources";
import { useWorldModelInvitations } from "./world-model-invitations";
import { useWorldModelClaimInvitation } from "./world-model-claim-invitation";
import { NativeWorldModelForm, type NativeWorldModelFormModel } from "./native-world-model-form";
import { nativeMemoryText } from "./use-native-memory";

type OfferedSource = Extract<ProfileResearchResult, { status: "offered" }>;
type ReviewTarget = { report: OfferedSource; id: string; fact: OfferedSource["report"]["sections"][number]["facts"][number] };
type Form = { id: string; revision: number; value: WorldModelForm; original: string; review?: ReviewTarget; fact?: WorldModelFactDetail; error: string | null; busy: boolean };
function currentReviewTarget(target: ReviewTarget, report: ProfileResearchResult | null) {
  if (report !== target.report) return false;
  const [kind, index] = target.id.split(":");
  return target.report.report.sections.find(section => section.kind === kind)?.facts[Number(index)] === target.fact;
}
type Local = { panel: "research" | "sources" | "invitations" | null; remove: boolean; reviewFact: string | null;
  pagination: Partial<Record<NativeWorldModelPageId, number>>; form: Form | null };
const initial = (): Local => ({ panel: null, remove: false, reviewFact: null, pagination: {}, form: null });
class WorldModelVisit {
  live = false; pending = false; private handles = new Map<string, string>();
  constructor(readonly owner: string, readonly active: boolean) {}
  handle(key: string) { let value = this.handles.get(key); if (!value) { value = crypto.randomUUID(); this.handles.set(key, value); } return value; }
  current() { const p = nativePrivacyObservation().state; return this.live && p?.appIsActive === true && !p.shielded; }
  retire() { this.live = false; this.handles.clear(); }
}
const nav = (text: string, max = 256) => text.length <= max ? text || "Details" : `${nativeMemoryText(text, max - 1)[0]}…`;
const statement = (fact: WorldModelFactDetail) => fact.kind === "draft" ? fact.statement : fact.claim.text;

/** One native rendering of the existing World Model controllers. All decisions,
 * encrypted writes, invitation delivery and source reviews retain their owners. */
export function useNativeWorldModel({ active, owner, model, onAccount, onMemory }: {
  active: boolean; owner: string; model: PersonalWorldModelModel; onAccount: () => void; onMemory: () => void;
}) {
  const visit = useMemo(() => new WorldModelVisit(owner, active), [owner, active]);
  const [publicProfilesSupported, setPublicProfilesSupported] = useState(false);
  useEffect(() => {
    let current = true;
    setPublicProfilesSupported(false);
    if (active) void nativeDrawers.getCapabilities().then(capability => {
      if (current) setPublicProfilesSupported(capability.profileWorldModelPublicProfiles === true);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [active]);
  const [stored, setStored] = useState<{ visit: WorldModelVisit; local: Local } | null>(null);
  const local = stored?.visit === visit ? stored.local : initial();
  const searchSuggestions = useMemo(() => active ? (model.offered?.search_suggestions ?? []).map(nativeSearchSuggestions) : [], [active, model.offered]);
  useLayoutEffect(() => { visit.live = active; return () => visit.retire(); }, [visit, active]);
  useLayoutEffect(() => { setStored(previous => previous?.visit === visit ? previous : null); }, [visit]);
  const change = useCallback((update: (value: Local) => Local) => {
    if (visit.current()) setStored(previous => visit.current() ? { visit, local: update(previous?.visit === visit ? previous.local : initial()) } : previous);
  }, [visit]);
  const session = { ownerId: model.user?.uid ?? "", vaultKey: model.vaultKey ?? "", vaultOwnerToken: model.vaultOwnerToken ?? "" };
  const source = useWorldModelSources({ ...session, name: model.user?.displayName ?? "", present: active && model.ready && local.panel === "sources" });
  const invitations = useWorldModelInvitations({ ...session, enabled: active && model.ready && local.panel === "invitations" });
  const claim = useWorldModelClaimInvitation({ ...session, enabled: active && model.ready,
    onClaimed: () => model.setClaims(value => value + 1), onCompleted: () => undefined });
  const shownClaims = useRef({ owner, count: model.claims });
  useEffect(() => {
    const previous = shownClaims.current;
    shownClaims.current = { owner, count: model.claims };
    if (!active || previous.owner !== owner || model.claims === previous.count) return;
    change(value => ({ ...value, panel: "sources", reviewFact: null, form: null }));
  }, [active, model.claims, owner, change]);
  const sourceReview = useProfileResearchModel({ ...session, ownerId: active && model.ready ? session.ownerId : null,
    initialResult: source.result ?? undefined, enabled: active && model.ready && local.panel === "sources",
    pathname: model.pathname, sourceReview: true, embedded: true, present: active && local.panel === "sources", backQuery: { profile_pane: "1" },
    onSaved: () => { source.setResult(null); model.setReadRevision(value => value + 1); }, onDiscarded: () => source.setResult(null) });
  // Latest private snapshots stay with the same visit. Form callbacks cannot
  // retarget another statement merely because compatible content refreshed.
  const current = useRef({ visit, local, model, source, invitations, sourceReview });
  useLayoutEffect(() => { current.current = { visit, local, model, source, invitations, sourceReview }; });
  const navigationBlocked = () => visit.pending || current.current.sourceReview.operationPending() || current.current.local.form?.busy === true;
  const rows = new Map<string, (choice: NativeDrawerChoice) => void | Promise<void>>();
  const pages: NativeProfilePage[] = [];
  const back = () => {
    if (!visit.current()) return true;
    if (navigationBlocked() || invitations.busy) return true;
    if (local.form) change(value => ({ ...value, form: null }));
    else if (local.remove) change(value => ({ ...value, remove: false }));
    else if (model.detail) model.closeDetail();
    else if (sourceReview.sharingOpen) sourceReview.setSharingOpen(false);
    else if (local.reviewFact) change(value => ({ ...value, reviewFact: null }));
    else if (local.panel) change(value => ({ ...value, panel: null }));
    else return false;
    return true;
  };
  const blocking = local.form?.busy === true || source.busy || invitations.busy || claim.busy || model.preferenceBusy || model.pending.size > 0 || sourceReview.busy || sourceReview.saveStarted;
  if (!active) return { pages, rows, back, ancestor: () => false, nested: false, blocking: false, navigationBlocked: () => false, editor: (_destinationId: string) => null };
  const bind = (key: string, action: () => void | Promise<void>) => {
    const id = visit.handle(key); rows.set(id, () => { if (visit.current() && !visit.pending) return action(); }); return id;
  };
  const action = (key: string, label: string, callback: () => void | Promise<void>, extras: Partial<NativeDrawerRow> = {}): NativeDrawerRow =>
    ({ id: bind(key, callback), label: nav(label, 4096), enabled: true, ...extras });
  const read = (key: string, text: string): NativeDrawerRow[] => nativeMemoryText(text).map((label, index) => ({ id: visit.handle(`${key}:${index}`), label, enabled: true, readOnly: true }));
  const link = (key: string, label: string, url: string) => action(key, label, async () => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) return;
    openExternalUrl(target.href);
  }, { symbol: "arrow.up.right" });
  const page = (id: NativeWorldModelPageId, title: string, content: NativeDrawerRow[]) => {
    const index = Math.min(local.pagination[id] ?? 0, Math.max(0, Math.ceil(content.length / 40) - 1));
    const entries = content.slice(index * 40, (index + 1) * 40);
    if (index) entries.push(action(`${id}-previous`, "Previous details", () => change(value => ({ ...value, pagination: { ...value.pagination, [id]: index - 1 } }))));
    if ((index + 1) * 40 < content.length) entries.push(action(`${id}-more`, "More details", () => change(value => ({ ...value, pagination: { ...value.pagination, [id]: index + 1 } }))));
    pages.push({ id, title, sections: [{ id: `section-${id}`, rows: entries }] });
  };
  const run = async (operation: () => Promise<void>) => {
    if (!visit.current() || visit.pending) return;
    visit.pending = true;
    try { await operation(); }
    catch { if (visit.current()) toast.error("Couldn’t finish. Please try again."); }
    finally { visit.pending = false; }
  };
  const openForm = (value: WorldModelForm, original = "", review?: ReviewTarget) => change(local => ({ ...local,
    form: { id: crypto.randomUUID(), revision: 0, value, original, review, ...(model.detail ? { fact: model.detail } : {}), error: null, busy: false } }));
  const choosePanel = (panel: Local["panel"]) => { model.closeDetail(); change(value => ({ ...value, panel, remove: false, reviewFact: null, form: null })); };
  const root = [...read("status", [model.status.title, model.status.body, model.status.detail, model.freshness?.text].filter(Boolean).join("\n"))];
  if (claim.accountSwitchHandoff) root.push(...read("claim-other-account", "This invitation was opened with another account."),
    action("claim-account-switch", "Review invitation with this account", claim.reviewOtherAccount));
  if (claim.claimToken) {
    root.push(...read("claim-description", "Someone invited you to prepare your Personal World Model. Claim it to review your own research here, or decline. Nothing is shared back with them."));
    const preview = claim.receivedPreview;
    if (preview && "subject_name" in preview && preview.subject_name) root.push(...read("claim-name", `Invitation for ${preview.subject_name}`));
    if (preview && "report" in preview) {
      root.push(...read("claim-introduction", `${preview.introduction}\nPrepared by the person who invited you`));
      for (const [i, section] of preview.report.sections.entries()) for (const [j, fact] of section.facts.entries()) root.push(...read(`claim-${i}-${j}`, fact.statement),
        ...fact.sources.map((source, k) => link(`claim-cite-${i}-${j}-${k}`, source.title, source.url)));
    }
    if (claim.offerResearch) {
      const on = bind("claim-research-on", () => claim.setResearchConsent(true)), off = bind("claim-research-off", () => claim.setResearchConsent(false));
      root.push({ id: visit.handle("claim-research"), label: "Turn public research back on after claiming", enabled: !claim.busy, toggle: true,
        options: [{ id: on, label: "On", selected: claim.researchConsent }, { id: off, label: "Off", selected: !claim.researchConsent }] });
    }
    if (claim.azureResearchOff) root.push(...read("claim-azure", "Azure public research stays off after claiming. Open Research and email in your Personal World Model to review Bing search use before turning it on."));
    root.push(action("claim", "Claim my model", async () => { await claim.claim(); }, { enabled: !claim.busy }),
      action("claim-decline", "Decline", async () => { await claim.decline(); }, { enabled: !claim.busy }));
  }
  if (claim.message) root.push(...read("claim-outcome", claim.message));
  if (model.namesakeNotice) root.push(...read("namesake-notice", model.namesakeNotice));
  if (model.namesakesFound) root.push(...read("namesakes", "Some people share your name. We couldn’t link a public page to your account."));
  if (model.matchStatus === "uncertain") root.push(...read("match-uncertain", "Possible match. Confirm only what’s yours."));
  const checkpoint = model.shownProgress ?? model.checkpoint;
  if (checkpoint) root.push(...read("checkpoint", `${checkpoint.searches_used} of ${checkpoint.searches_total} searches · ${checkpoint.sources_found} sources found · ${checkpoint.topics_checked.length} topics checked`),
    ...checkpoint.recent_sources.flatMap((value, i) => [link(`recent:${i}`, value.title, value.url)]));
  if (model.retry || model.readFailed || model.stalled || model.status.kind === "outage") root.push(action("retry", "Try again", () => {
    if (model.readFailed) model.setReadRevision(value => value + 1); if (model.retry || model.stalled || model.retryDue) model.reload();
  }, { enabled: model.status.kind !== "outage" || model.retryDue }));
  if (model.status.kind === "off") {
    root.push(...read("off", "Nothing is looked up while it’s off."));
    if (model.preferences?.research_provider === "azure_openai_web_search") root.push(...read("azure-off", PWM_AZURE_RESEARCH_DISCLOSURE));
    root.push(action("turn-on", "Turn on", () => model.turnOn(), { enabled: !model.preferenceBusy, pending: model.preferenceBusy }));
  }
  if (model.preferenceFailed) root.push(...read("preference-error", "Couldn’t save. Try again."));
  if (model.ready) {
    root.push(...read("identity-title", model.identityLabel), ...read("identity-name", `Name\n${model.identity.name || "Not added"}`),
      ...read("identity-email", `Email\n${model.identity.email ? maskEmail(model.identity.email) : "Not added"}${model.identity.email ? model.identity.emailVerified ? " · Verified" : " · Not verified" : ""}`),
      ...read("identity-phone", `Phone\n${model.identity.phone ? formatMaskedPhoneNumber(model.identity.phone) : "Not added"}`));
    if (model.status.kind === "insufficient") root.push(action("account", "Open your account", onAccount, { chevron: true, artworkId: "account" }));
    for (const [i, fact] of model.provisionalFacts.entries()) root.push(...read(`provisional-${i}`, `${fact.statement}\nThese findings await the full review and are not saved details.`),
      ...fact.sources.map((source, j) => link(`provisional-${i}-${j}`, source.title, source.url)));
    for (const section of model.sections) {
      root.push(...read(`section-${section.id}`, section.label));
      for (const fact of section.drafts) root.push(action(`draft-${fact.key}`, fact.statement, () => model.setDetail(fact),
        { chevron: true, detail: fact.matchStatus === "matched" && fact.confidence === "supported" ? "Review before saving" : "Possible match · check the sources", pending: model.pending.has(fact.key), enabled: !model.pending.has(fact.key) }));
      for (const claim of section.saved) root.push(action(`saved-${claim.key}`, claim.text, () => model.setDetail({ kind: "saved", claim }), { chevron: true, detail: "Confirmed by you" }));
    }
    if (model.sourcedFacts.length) {
      root.push(...read("sourced-heading", "From pages you added"));
      for (const [i, fact] of model.sourcedFacts.entries()) root.push(...read(`sourced-${i}`, fact.statement), ...fact.sources.map((source, j) => link(`sourced-${i}-${j}`, source.title, source.url)));
      root.push(action("memory", "Edit or remove these details", onMemory, { chevron: true, artworkId: "my-data" }));
    }
    for (const [i, answer] of (model.offered?.grounded_answers ?? []).entries()) {
      root.push(...read(`answer-${i}`, `Bing web research\n${answer.answer}`));
      for (const [j, citation] of (answer.citations ?? []).entries()) root.push(link(`citation-${i}-${j}`, citation.title, citation.url));
    }
    for (const [i, suggestion] of searchSuggestions.entries()) root.push(...read(`suggestion-${i}`, `Related Google searches\n${suggestion.text}`),
      ...suggestion.links.map((source, j) => link(`suggestion-${i}-${j}`, source.title, source.url)));
    if (model.usable) root.push(action("invitations", "Invite someone", () => choosePanel("invitations"), { artworkId: "invite", chevron: true }));
    root.push(action("sources", "Add a public source", () => choosePanel("sources"), { symbol: "link", chevron: true }));
    if (model.preferences || model.retry || model.spent) root.push(action("research", "Research and email", () => choosePanel("research"), { symbol: "magnifyingglass", chevron: true }));
  }
  page("world-model", "Personal World Model", root);
  const detail = model.detail ?? local.form?.fact;
  if (detail) {
    const fact = detail, text = statement(fact), content = [...read("fact-statement", text)];
    if (fact.kind === "draft") {
      content.push(...read("fact-certainty", fact.matchStatus !== "matched" ? "Possible match. This may be about someone else with your name." : fact.evidenceScore !== undefined && fact.evidenceScore <= 5 ? "The public evidence is limited. Check this before you say yes." : fact.confidence === "conflicting" ? "The sources disagree. Check before you say yes." : fact.confidence === "uncertain" ? "Possible match. The sources only hint at this." : "Check the linked page before saving this statement."));
      if (fact.reason) content.push(...read("fact-reason", fact.reason));
      if (fact.evidenceReason) content.push(...read("fact-evidence", fact.evidenceReason));
      content.push(...fact.sources.map((source, i) => link(`fact-source-${i}`, source.title, source.url)),
        action("fact-yes", "Yes, this is mine", () => run(() => model.actions.confirm(fact)), { enabled: !model.pending.has(fact.key) }),
        action("fact-no", "No, not me", () => run(() => model.actions.reject(fact)), { enabled: !model.pending.has(fact.key) }));
    } else content.push(...read("fact-confirmed", `Confirmed on ${new Date(fact.claim.decided_at).toLocaleDateString()}`));
    content.push(action("fact-edit", "Correct wording", () => openForm({ scene: "world-model-fact-edit", draft: { text } }, text), { chevron: true }));
    if (fact.kind === "saved") content.push(action("fact-remove", "Remove detail", () => change(value => ({ ...value, remove: true })), { destructive: true, chevron: true }));
    page("world-model-fact", model.detailTitle, content);
    if (local.remove && fact.kind === "saved") page("world-model-remove", "Remove this detail?", [
      ...read("remove-statement", text), action("remove-confirm", "Remove", () => run(async () => { await model.actions.remove(fact.claim); if (visit.current()) { model.closeDetail(); change(value => ({ ...value, remove: false })); } }), { destructive: true }),
      action("remove-cancel", "Cancel", () => change(value => ({ ...value, remove: false }))) ]);
  } else if (local.panel === "research") {
    const p = model.preferences, content: NativeDrawerRow[] = [];
    if (p) {
      content.push(...read("research-disclosure", p.research_provider === "azure_openai_web_search" ? PWM_AZURE_RESEARCH_DISCLOSURE : "Uses your name and verified email or phone to find pages about you with Google Search through Vertex AI."));
      const toggle = (key: "enabled" | "email_enabled", label: string) => {
        const on = bind(`research-${key}-on`, () => run(() => model.updatePreferences({ enabled: p.enabled, email_enabled: p.email_enabled, [key]: true })));
        const off = bind(`research-${key}-off`, () => run(() => model.updatePreferences({ enabled: p.enabled, email_enabled: p.email_enabled, [key]: false })));
        return { id: visit.handle(`research-${key}`), label, enabled: !model.preferenceBusy, pending: model.preferenceBusy, toggle: true,
          options: [{ id: on, label: "On", selected: p[key] }, { id: off, label: "Off", selected: !p[key] }] };
      };
      content.push(toggle("enabled", "Research public pages"), toggle("email_enabled", "Email me when it’s ready"));
      if (p.enabled && model.result?.status !== "pending" && model.result?.status !== "paused" && (!model.spent || model.status.kind === "exhausted")) content.push(action("refresh", "Check for updates", () => { model.refresh(); choosePanel(null); }));
    } else content.push(...read("research-loading", "Checking your settings…"));
    if (model.preferenceFailed) content.push(...read("research-error", "Couldn’t save. Try again."));
    page("world-model-research", "Research and email", content);
  } else if (local.panel === "sources") {
    const content = [...read("sources-name", `Your name\n${model.user?.displayName?.trim() || "Not added"}`),
      action("sources-edit", "Add public pages", () => openForm({ scene: "world-model-sources", draft: { urls: source.urls, permitted: source.permitted } }),
        { chevron: true, enabled: !sourceReview.busy && !sourceReview.saveStarted })];
    if (publicProfilesSupported && model.preferences?.research_provider === "azure_openai_web_search" && model.preferences.enabled &&
      model.result?.status !== "pending" && model.result?.status !== "paused" && (!model.spent || model.status.kind === "exhausted")) {
      content.push(...read("public-profile-disclosure", "Use these profiles as starting links for GPT-5 mini research. Azure and Bing receive the public links. You review findings before saving."),
        action("public-profile-research", "Research your profiles", () => openForm({ scene: "world-model-public-profiles", draft: { urls: source.urls, permitted: source.permitted } }), { chevron: true }));
    }
    if (source.message) content.push(...read("sources-error", source.message));
    if (source.result && source.result.status !== "offered") content.push(...read("sources-result", source.result.status === "unavailable"
      ? "Public pages couldn’t be opened right now. Try again later."
      : source.result.status === "low_confidence" ? "Couldn’t reliably connect those pages to you. Check the links or your verified contact."
        : source.result.status === "saved" ? "These pages have already been reviewed."
          : source.result.status === "insufficient_identity" ? "Add a name and verify an email or phone in your account to begin."
            : "Research is not available for this account yet."));
    page("world-model-sources", "Pages you choose", content);
    if (sourceReview.result?.status === "offered" && sourceReview.visible && !["saved", "skipped"].includes(sourceReview.phase) && local.form?.value.scene !== "world-model-sources" && local.form?.value.scene !== "world-model-public-profiles") {
      const report = sourceReview.result.report, content = [...read("review-summary", `${report.name}\n${report.summary}`)];
      if (sourceReview.result.research) content.push(...read("review-identity", sourceReview.result.research.identity.reason),
        ...sourceReview.result.research.gaps.flatMap((gap, i) => read(`review-gap-${i}`, gap)));
      if (report.match_status === "uncertain") content.push(...read("review-uncertain", "Possible match. Confirm only what’s yours."));
      if (sourceReview.saveStarted) content.push(...read("review-save-state", sourceReview.partiallySaved ? "Some details saved. Retry to finish." : "Save wasn’t confirmed. Try again."));
      for (const section of report.sections) {
        content.push(...read(`review-section-${section.kind}`, PROFILE_SECTION_LABELS[section.kind]));
        for (const [i, fact] of section.facts.entries()) {
          const id = `${section.kind}:${i}`;
          content.push(action(`review-fact-${id}`, sourceReview.edits[id] ?? fact.statement, () => change(value => ({ ...value, reviewFact: id })), { chevron: true, selected: sourceReview.selected.has(id) }));
        }
      }
      if (sourceReview.sharingOpen) content.push(...read("review-sharing", "Update shared details? These changes can affect what people with active sharing permissions receive."),
        action("review-share-confirm", "Confirm and save", () => sourceReview.save(true), { enabled: !sourceReview.busy }), action("review-share-cancel", "Cancel", () => sourceReview.setSharingOpen(false)));
      else content.push(action("review-save", sourceReview.saveStarted ? "Retry save" : "Save selected details", () => sourceReview.save(), { enabled: !sourceReview.busy && sourceReview.selected.size > 0, pending: sourceReview.busy }),
        action("review-discard", "Discard", sourceReview.dismiss, { enabled: !sourceReview.busy && !sourceReview.saveStarted, destructive: true }));
      page("world-model-review", "Review public details", content);
      const [kind, ordinal] = local.reviewFact?.split(":") ?? [], group = report.sections.find(section => section.kind === kind), fact = group?.facts[Number(ordinal)];
      if (local.reviewFact && fact) {
        const id = local.reviewFact, checked = sourceReview.selected.has(id);
        const content = [...read("review-fact-text", sourceReview.edits[id] ?? fact.statement), ...fact.sources.map((source, i) => link(`review-cite-${i}`, source.title, source.url)),
          action("review-fact-keep", checked ? "Don’t save this detail" : "Keep this detail", () => {
            sourceReview.setReview(null); sourceReview.setSelected(previous => { const next = new Set(previous); if (checked) next.delete(id); else next.add(id); return next; });
          }, { enabled: !sourceReview.busy && !sourceReview.saveStarted }),
          action("review-fact-edit", "Correct wording", () => openForm({ scene: "world-model-fact-edit", draft: { text: sourceReview.edits[id] ?? fact.statement } }, sourceReview.edits[id] ?? fact.statement, { report: sourceReview.result as OfferedSource, id, fact }), { enabled: !sourceReview.busy && !sourceReview.saveStarted, chevron: true })];
        if (fact.confidence !== "supported") content.push(...read("review-fact-uncertain", fact.confidence === "conflicting" ? "Sources disagree" : "Possible match"));
        page("world-model-review-fact", "Review detail", content);
      }
    }
  } else if (local.panel === "invitations") {
    const content = [...read("invite-copy", "Invite someone by name and contact. They can claim the link using a verified email or phone, then their own model prepares for their review."),
      action("invite-create", "Create invitation", () => openForm({ scene: "world-model-invitation", draft: { name: invitations.name, email: invitations.email, phone: invitations.phone } }), { chevron: true, enabled: !invitations.busy })];
    if (invitations.link) content.push(action("invite-share", "Share invitation", async () => { await invitations.share(); }, { enabled: !invitations.busy }));
    for (const [i, invitation] of invitations.rows.entries()) content.push(...read(`invitation-${i}`, `Invitation ${i + 1} · ${invitation.state === "claimed" ? "Claimed" : "Not claimed yet"}`),
      action(`revoke-${invitation.id}`, "Revoke", async () => { await invitations.revoke(invitation.id); }, { enabled: !invitations.busy, destructive: true }));
    if (invitations.message) content.push(...read("invite-message", invitations.message));
    page("world-model-invitations", "Invite someone", content);
  }
  const form = local.form;
  const editor = (destinationId: string) => {
    if (!form) return null;
    const d = form.value;
    const staleReview = form.review && !currentReviewTarget(form.review, sourceReview.result);
    const canSave = d.scene === "world-model-fact-edit" ? !staleReview && !!d.draft.text.trim() && d.draft.text.trim() !== form.original.trim() :
      (d.scene === "world-model-sources" || d.scene === "world-model-public-profiles") ? !!model.user?.displayName?.trim() && !!d.draft.urls.trim() && d.draft.permitted :
        !!d.draft.name.trim() && (!!d.draft.email.trim() || !!d.draft.phone.trim()) && (!d.draft.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.draft.email.trim())) && (!d.draft.phone.trim() || /^\+[1-9]\d{7,14}$/.test(d.draft.phone.trim()));
    const scene: NativeWorldModelFormModel = { id: form.id, owner: session.ownerId, ready: model.ready && active,
      form: d, revision: form.revision, busy: form.busy || source.busy || invitations.busy,
      error: staleReview ? "These source details changed. Cancel and reopen this editor." : form.error || (d.scene === "world-model-sources" ? source.message : d.scene === "world-model-invitation" ? invitations.message : null) || null, canSave,
      change: next => {
        if (next.scene !== d.scene) return;
        if (next.scene === "world-model-sources" || next.scene === "world-model-public-profiles") { source.setUrls(next.draft.urls); source.setPermitted(next.draft.permitted); }
        if (next.scene === "world-model-invitation") { invitations.setName(next.draft.name); invitations.setEmail(next.draft.email); invitations.setPhone(next.draft.phone); }
        change(value => !value.form || value.form.id !== form.id ? value : ({ ...value, form: { ...value.form, value: { scene: next.scene, draft: { ...next.draft } } as WorldModelForm, revision: value.form.revision + 1, error: null } }));
      },
      commit: async () => {
        const latest = current.current;
        if (latest.visit !== visit || !visit.current() || latest.local.form?.id !== form.id || visit.pending) return false;
        const value = latest.local.form.value;
        visit.pending = true; change(local => ({ ...local, form: local.form ? { ...local.form, busy: true } : null }));
        try {
          if (value.scene === "world-model-fact-edit") {
            const text = value.draft.text.trim(); if (!text || text.length > 600) return false;
            if (form.review) {
              if (!currentReviewTarget(form.review, latest.sourceReview.result) || latest.sourceReview.busy || latest.sourceReview.saveStarted) return false;
              const id = form.review.id;
              latest.sourceReview.setReview(null); latest.sourceReview.setEdits(previous => ({ ...previous, [id]: text }));
            }
            else if (form.fact) await latest.model.actions.edit(form.fact, text);
            else return false;
            return visit.current();
          }
          if (value.scene === "world-model-public-profiles") {
            const m = latest.model;
            if (!value.draft.permitted || !value.draft.urls.trim() || m.preferences?.research_provider !== "azure_openai_web_search" ||
                !m.preferences.enabled || m.result?.status === "pending" || m.result?.status === "paused" || (m.spent && m.status.kind !== "exhausted")) return false;
            m.researchPublicProfiles(value.draft.urls.split("\n").map(url => url.trim()).filter(Boolean));
            return true;
          }
          if (value.scene === "world-model-sources") return await latest.source.prepare(value.draft);
          return await latest.invitations.create(value.draft);
        } catch { change(local => ({ ...local, form: local.form ? { ...local.form, error: "Couldn’t save. Try again." } : null })); return false; }
        finally { visit.pending = false; change(local => ({ ...local, form: local.form ? { ...local.form, busy: false } : null })); }
      },
      close: () => change(value => ({ ...value, form: null })),
      completed: () => { if (d.scene === "world-model-public-profiles") choosePanel(null); if (form.fact && !form.review) model.closeDetail(); change(value => ({ ...value, form: null })); },
      fallback: () => { change(value => ({ ...value, form: null })); toast.error("This editor couldn’t open. Please try again."); },
    };
    return <NativeWorldModelForm key={form.id} model={scene} destinationId={destinationId} />;
  };
  return { pages, rows, back, nested: pages.length > 1 || form !== null, blocking, navigationBlocked, editor,
    ancestor: (choice: NativeDrawerChoice) => {
      if (!visit.current() || navigationBlocked() || blocking) return false;
      if (choice.rowId === "world-model") { model.closeDetail(); change(() => initial()); return true; }
      if (choice.rowId === "world-model-sources") { sourceReview.setSharingOpen(false); change(value => ({ ...value, reviewFact: null, form: null })); return true; }
      return false;
    } };
}
