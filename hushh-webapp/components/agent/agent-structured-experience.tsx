"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonInformationRequest } from "@/lib/consent/use-person-information-request";
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { DEFAULT_REQUEST_DURATION_HOURS } from "@/lib/agent/action-directive-summary";
import { PersonProfileService, mergePersonScopePage, type ViewerPersonProfile } from "@/lib/services/person-profile-service";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import { ConsentScopeList } from "@/components/consent/consent-scope-list";
import {
  domainLabelFor,
  scopeItemsFromRequestable,
} from "@/lib/consent/consent-scope-items";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileCheck2,
  FolderLock,
  Link2,
  ShieldCheck,
  UserRound,
} from "@/components/icons";

import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import type {
  AgentStructuredExperience,
  EvidenceBriefExperience,
  InformationRequestReviewExperience,
  KycReadinessExperience,
  MemoryImportReviewExperience,
  ScopeDiscoveryExperience,
} from "@/lib/agent/agui-structured-experiences";

export const AgentPersonSelectionContext = createContext<((handle: string, name: string) => void) | null>(null);

export function AgentStructuredExperienceView({
  experience,
}: {
  experience: AgentStructuredExperience;
}) {
  const selectPerson = useContext(AgentPersonSelectionContext);
  switch (experience.type) {
    case "one.person_selection.v1":
      return <ExperienceShell label="Choose a person" title="Who do you mean?"
        summary="Choose the right person before we check what you can ask for." icon={<UserRound className="size-5" />}>
        <div className="flex flex-col gap-2">
          {experience.candidates.map((candidate) => <div key={candidate.selectionHandle} className="flex items-center gap-2">
            <button type="button" disabled={!selectPerson}
            className="min-h-11 cursor-pointer rounded-xl px-3 py-2 text-left hover:bg-accent disabled:cursor-default disabled:opacity-50"
            onClick={() => selectPerson?.(candidate.selectionHandle, candidate.displayName)}>
            <span className="block font-medium">{candidate.displayName}</span>
            {candidate.detail ? <span className="block text-sm text-muted-foreground">{candidate.detail}</span> : null}
          </button>
          <Link className="ml-auto inline-flex min-h-11 shrink-0 items-center text-sm text-primary underline-offset-4 hover:underline"
            href={candidate.profilePath} aria-label={`View ${candidate.displayName}'s profile`}>View profile</Link>
          </div>)}
        </div>
      </ExperienceShell>;
    case "one.scope_discovery.v1":
      return <ScopeDiscoveryView experience={experience} />;
    case "one.information_request_review.v1":
      return <InformationRequestReviewView experience={experience} />;
    case "one.kyc_readiness.v1":
      return <KycReadinessView experience={experience} />;
    case "one.memory_import_review.v1":
      return <MemoryImportReviewView experience={experience} />;
    case "one.evidence_brief.v1":
      return <EvidenceBriefView experience={experience} />;
  }
}

function ExperienceShell({
  label,
  title,
  summary,
  icon,
  children,
}: {
  label: string;
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[24px] bg-[linear-gradient(145deg,var(--app-accent-surface),color-mix(in_srgb,var(--background)_94%,var(--app-accent-soft)))] shadow-[0_18px_55px_-38px_var(--app-accent-deep)]">
      <header className="flex items-start gap-3 px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-accent-strong text-white shadow-sm">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="ui-text-section-label text-accent-strong">{label}</p>
          <h3 className="mt-1 text-base font-semibold tracking-[-0.015em] text-foreground">{title}</h3>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{summary}</p>
        </div>
      </header>
      <div className="bg-background/72 px-4 py-4 backdrop-blur-xl sm:px-5">{children}</div>
    </section>
  );
}

function sensitivityLabel(
  sensitivity: ScopeDiscoveryExperience["scopes"][number]["sensitivity"],
): string | null {
  if (sensitivity === "restricted") return "Highly sensitive";
  if (sensitivity === "sensitive") return "Sensitive";
  return null;
}

/**
 * The person's name as they would write it.
 *
 * Directory records arrive however they were typed, often shouted
 * ("JHUMMA KUMARI"). Shouting someone's name back at the owner reads as a
 * database row, not a person.
 */
function personName(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "this person";
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_match, boundary, letter) => `${boundary}${letter.toUpperCase()}`);
}

function ScopeDiscoveryView({
  experience,
}: {
  experience: ScopeDiscoveryExperience;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked } = useVault();
  const personRef = experience.person.profilePath.split("/")[2] || "";
  const request = usePersonInformationRequest(personRef);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [durationHours, setDurationHours] = useState(DEFAULT_REQUEST_DURATION_HOURS);
  const [sent, setSent] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [current, setCurrent] = useState<{ owner: string; profile: ViewerPersonProfile } | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const profile = isVaultUnlocked && current && current.owner === user?.uid && current.profile.personRef === personRef
    ? current.profile : null;

  useEffect(() => {
    const run = ++generation.current;
    inFlight.current = false;
    setCurrent(null);
    setSelectedIds(new Set());
    setReviewing(false);
    setPurpose("");
    setDurationHours(DEFAULT_REQUEST_DURATION_HOURS);
    setSent(false);
    setUnavailable(false);
    setLoading(Boolean(user && isVaultUnlocked));
    if (user && isVaultUnlocked) {
      void user.getIdToken().then(token => PersonProfileService.getViewer(personRef, token, {
        domain: experience.domainFilter || "",
      })).then(value => {
        if (run === generation.current) setCurrent({ owner: user.uid, profile: value });
      }).catch(() => {
        if (run === generation.current) setUnavailable(true);
      }).finally(() => {
        if (run === generation.current) setLoading(false);
      });
    }
    return () => { generation.current += 1; };
  }, [user, isVaultUnlocked, personRef, experience.domainFilter, retry]);

  async function loadMore() {
    if (!user || !profile?.scopeCatalog?.nextPage || inFlight.current) return;
    const run = generation.current;
    inFlight.current = true;
    setLoading(true);
    setUnavailable(false);
    try {
      const token = await user.getIdToken();
      const next = await PersonProfileService.getViewer(personRef, token, {
        page: profile.scopeCatalog.nextPage,
        revision: profile.scopeCatalog.catalogRevision,
        domain: experience.domainFilter || "",
      });
      if (run !== generation.current) return;
      if (next.scopeCatalog?.paginationReset || next.scopeCatalog?.catalogRevision !== profile.scopeCatalog.catalogRevision) {
        setSelectedIds(new Set());
        setReviewing(false);
      }
      setCurrent({ owner: user.uid, profile: mergePersonScopePage(profile, next) });
    } catch {
      if (run === generation.current) setUnavailable(true);
    } finally {
      if (run === generation.current) { setLoading(false); inFlight.current = false; }
    }
  }
  // Retained cards are descriptors, never current authority. Refresh them
  // without replaying their original tool or any request/approval mutation.
  const scopes = profile?.requestableScopes || [];
  const grantedIds = new Set(profile?.grants.map(grant => grant.scopeRef) || []);
  const selectedScopes = scopes.filter(scope => selectedIds.has(scope.scopeRef) && !grantedIds.has(scope.scopeRef));
  const total = profile?.scopeCatalog?.totalCount ?? scopes.length;
  // Profile and Chat deliberately consume the same adapter and recursive
  // selector. Opaque refs stay leaves; only authored attr paths can create
  // hierarchy.
  const items = scopeItemsFromRequestable(
    scopes.map((scope) => ({
      scopeRef: scope.scopeRef,
      pathSegments: scope.pathSegments,
      label: scope.label,
      description: scope.description,
      domain: scope.domain,
      sensitivity: scope.sensitivity,
      wildcard: scope.wildcard,
    })),
  );

  return (
    <section
      aria-label={`Information available from ${experience.person.displayName}`}
      className="space-y-4"
    >
      <header className="flex items-start gap-3 px-1">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-surface text-accent-strong">
          <UserRound className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            What {personName(profile?.displayName || experience.person.displayName)} can share with you
          </h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {!profile ? !user ? "Sign in to check what is available." : !isVaultUnlocked ? "Unlock your vault to continue here." : "Checking what is currently available to request."
              : total === 0
              ? "Nothing is currently available to request."
              : `${total} ${total === 1 ? "thing" : "things"} you can ask for. They decide what to share, and for how long.`}
          </p>
        </div>
      </header>

      {items.length > 0 ? (
        <div className="px-1">
          <ConsentScopeNestedList
            items={items}
            rootLabel="All information"
            testIdPrefix="scope-discovery-scopes"
            selection={!reviewing && !request.pending ? {
              selectedIds,
              onToggleMany: (ids, select) => {
                setSent(false);
                setSelectedIds(currentIds => {
                  const next = new Set(currentIds);
                  ids.forEach(id => { if (select && !grantedIds.has(id)) next.add(id); else next.delete(id); });
                  return next;
                });
              },
            } : undefined}
          />
        </div>
      ) : null}

      {unavailable ? <p role="alert" className="text-sm text-muted-foreground">We couldn’t check available information. Please try again.</p> : null}
      {profile?.scopeCatalog?.hasMore ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="text-muted-foreground">{scopes.length} of {total} loaded. Search checks loaded information.</p>
        <MorphyButton type="button" size="sm" disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading more…" : unavailable ? "Try loading more again" : "Load more information"}
        </MorphyButton>
      </div> : unavailable ? <MorphyButton type="button" size="sm" onClick={() => setRetry(value => value + 1)}>Try again</MorphyButton> : null}

      {reviewing && profile ? <section aria-label="Review information request" className="space-y-3 rounded-2xl border border-border p-4">
        <h4 className="font-semibold">Request information from {profile.displayName}</h4>
        <p className="text-sm text-muted-foreground">They will see exactly what you asked for, why, and for how long. Nothing is sent until you confirm.</p>
        <InformationRequestReviewFields scopes={selectedScopes} purpose={purpose} durationHours={durationHours}
          onPurposeChange={setPurpose} onDurationChange={setDurationHours} disabled={request.pending} testIdPrefix="chat-request" />
        {request.error ? <p role="alert" className="text-sm text-destructive">{request.error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <MorphyButton type="button" size="sm" disabled={request.pending} onClick={() => setReviewing(false)}>Edit information</MorphyButton>
          <MorphyButton type="button" size="sm" disabled={!request.available || request.pending || purpose.trim().length < 8 || !selectedScopes.length || selectedScopes.length > 50}
            onClick={() => void request.submit({ scopeRefs: selectedScopes.map(scope => scope.scopeRef), purpose, durationHours }).then(success => {
              if (!success) return;
              setSent(true); setReviewing(false); setSelectedIds(new Set()); setPurpose("");
            })}>{request.pending ? "Sending…" : "Send request"}</MorphyButton>
        </div>
      </section> : items.length ? <MorphyButton type="button" size="sm" disabled={!selectedScopes.length || loading}
        onClick={() => setReviewing(true)}>Review request</MorphyButton> : null}
      {sent ? <p role="status" className="text-sm">Request sent. They can now review your choices; access is not granted yet.</p> : null}
      <Link href={experience.person.profilePath} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">View profile</Link>
    </section>
  );
}

function InformationRequestReviewView({ experience }: { experience: InformationRequestReviewExperience }) {
  // Every field becomes a row in the one list every scope surface uses, so this
  // reads the same as Memory and the same as the pending-request card.
  const items = experience.fields.map((field, index) => ({
    id: `${field.domain}:${field.label}:${index}`,
    label: field.label,
    description: null,
    domainKey: field.domain || "other",
    // Flat on purpose, and not a shortcut: `ReviewField` carries only label,
    // domain and sensitivity (lib/agent/agui-structured-experiences.ts:34-38).
    // There is no scope reference in this payload, so there is no path to nest
    // by, and inventing one from the label would name a scope that does not
    // exist. This stays one level until the experience carries `scopeRef`.
    pathSegments: [],
    domainLabel: domainLabelFor(field.domain),
    badge: sensitivityLabel(field.sensitivity),
    searchText: `${field.label} ${field.domain || ""}`.toLowerCase(),
  }));

  return (
    <ExperienceShell
      // Not "Consent review", not "N fields", and the raw domain key no longer
      // sits beside every row. agent.yaml:62-70 bans this vocabulary in
      // owner-facing speech; the chrome used to reintroduce all of it.
      label="Waiting on you"
      title={`${experience.personName} asked to see some of your information`}
      summary={`${items.length} ${items.length === 1 ? "thing" : "things"} · ${experience.durationLabel}`}
      icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
    >
      <p className="text-sm leading-6 text-foreground">{experience.purpose}</p>
      <div className="mt-3">
        <ConsentScopeList
          items={items}
          groupByDomain={items.length > 1}
          collapsible={false}
          testIdPrefix="information-request-review-scopes"
        />
      </div>
    </ExperienceShell>
  );
}

const KYC_STATUS_LABEL: Record<KycReadinessExperience["items"][number]["status"], string> = {
  available: "Available",
  ask_first: "Ask first",
  verify: "Verify",
  not_available: "Not available",
};

function KycReadinessView({ experience }: { experience: KycReadinessExperience }) {
  return (
    <ExperienceShell label="Readiness" title={experience.workflowName} summary={experience.summary} icon={<FileCheck2 className="h-5 w-5" aria-hidden="true" />}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">For {experience.subjectName}</p>
      <ul className="divide-y divide-border/35">
        {experience.items.map((item) => (
          <li key={`${item.domain}:${item.label}`} className="flex items-center justify-between gap-3 py-2.5">
            <div><p className="text-sm font-medium text-foreground">{item.label}</p><p className="text-xs text-muted-foreground">{item.domain}</p></div>
            <span className={item.status === "available" ? "text-xs font-semibold text-emerald-600" : "text-xs font-semibold text-accent-strong"}>{KYC_STATUS_LABEL[item.status]}</span>
          </li>
        ))}
      </ul>
      {experience.legalReviewRequired ? <p className="mt-3 flex gap-2 text-xs leading-5 text-muted-foreground"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />Employment authorization and visa eligibility require qualified human review.</p> : null}
    </ExperienceShell>
  );
}

function MemoryImportReviewView({ experience }: { experience: MemoryImportReviewExperience }) {
  const complete = experience.sourceBlockCount === experience.accountedBlockCount;
  const total = experience.groups.reduce((count, group) => count + group.candidates.length, 0);
  return (
    <ExperienceShell label="Memory review" title={`${total} memories ready to review`} summary={`${experience.accountedBlockCount} of ${experience.sourceBlockCount} source sections accounted for`} icon={<FolderLock className="h-5 w-5" aria-hidden="true" />}>
      <p className={complete ? "mb-3 flex items-center gap-2 text-xs font-semibold text-emerald-600" : "mb-3 flex items-center gap-2 text-xs font-semibold text-destructive"}>{complete ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}{complete ? "Complete coverage" : "Review required before saving"}</p>
      <div className="space-y-4">
        {experience.groups.map((group) => <section key={group.domain}><h4 className="ui-text-section-label text-muted-foreground">{group.domain}</h4><ul className="mt-1 divide-y divide-border/35">{group.candidates.map((candidate) => <li key={candidate.candidateRef} className="py-2.5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-foreground">{candidate.label}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{candidate.preview}</p></div><span className="shrink-0 text-[11px] font-semibold text-accent-strong">{candidate.sharingPosture.replace("_", " ")}</span></div></li>)}</ul></section>)}
      </div>
    </ExperienceShell>
  );
}

function EvidenceBriefView({ experience }: { experience: EvidenceBriefExperience }) {
  return (
    <ExperienceShell label={`${experience.confidence} confidence`} title={experience.title} summary={experience.summary} icon={<Link2 className="h-5 w-5" aria-hidden="true" />}>
      <ul className="space-y-3">{experience.findings.map((finding) => <li key={finding.label}><p className="text-sm font-semibold text-foreground">{finding.label}</p><p className="mt-0.5 text-sm leading-5 text-muted-foreground">{finding.detail}</p></li>)}</ul>
      {experience.sources.length ? <div className="mt-4 flex flex-wrap gap-2">{experience.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-accent-surface px-3 py-1.5 text-xs font-semibold text-accent-strong hover:bg-accent-soft">{source.label}<ArrowUpRight className="h-3 w-3" /></a>)}</div> : null}
      {experience.unresolved.length ? <div className="mt-4"><p className="ui-text-section-label text-muted-foreground">Still unresolved</p><ul className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">{experience.unresolved.map((item) => <li key={item}>• {item}</li>)}</ul></div> : null}
    </ExperienceShell>
  );
}
