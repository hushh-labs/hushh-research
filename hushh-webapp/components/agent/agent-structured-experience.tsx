"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonInformationRequest } from "@/lib/consent/use-person-information-request";
import { selectedRequestScopes, toggleRequestScopes } from "@/lib/consent/request-scope-selection";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { readInformationRequest, subscribeInformationRequest } from "@/lib/consent/information-request-reads";
import {
  informationRequestOutcome,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import {
  claimConsentContinuation,
  isConsentContinuationArmed,
  mountInformationRequestCard,
  releaseConsentContinuation,
  watchSentInformationRequest,
} from "@/lib/agent/consent-continuation";
import { getAgentChatConsentOutcomes } from "@/lib/services/agent-chat-client";
import { ConsentCardPhaseContext, RequesterProgressBody } from "@/components/agent/consent/requester-consent-card";
import { AskProposalCard, type AskProposalDraft } from "@/components/agent/consent/ask-proposal-card";
import { SharedWithYouCard } from "@/components/agent/consent/shared-with-you-card";
import { AgentTranscriptRevealContext } from "@/components/agent/agent-transcript-reveal";
import { humanSharedLabel, type SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { isAccessEnded, joinLabels, parseRequestProgress, type RequestProgress } from "@/components/agent/consent/request-progress";
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { DEFAULT_REQUEST_DURATION_HOURS, requestDurationLabel } from "@/lib/agent/action-directive-summary";
import { PersonProfileService, mergePersonScopePage, type InformationRequestBundle, type RequestablePersonScope, type ViewerPersonProfile } from "@/lib/services/person-profile-service";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import {
  ConnectorReadReceipt,
  WorkspaceConnectorSetupCard,
} from "@/components/agent/connector-read-receipt";
import { CustomConnectorProbeCard } from "@/components/agent/custom-connector-probe-card";
import type { DriveCompilationUiState } from "@/lib/agent/drive-batch-progress";
import type { DriveOwnerCompileWindow } from "@/lib/agent/connector-read-receipt";
import { DocumentRequestButton } from "@/components/consent/document-request-button";
import { DriveOwnerShareCard } from "@/components/consent/drive-owner-share-card";
import { DriveCircleShareCard } from "@/components/consent/drive-circle-share-card";
import { DriveBulkShareCard } from "@/components/agent/drive-background-search";
import { ConsentScopeList } from "@/components/consent/consent-scope-list";
import {
  domainLabelFor,
  scopeItemsFromRequestable,
} from "@/lib/consent/consent-scope-items";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EditRowIcon } from "@/components/icons/agents";
import { ROUTES } from "@/lib/navigation/routes";
import { describeOwnerStyleProposal, stageOwnerStyleProposal } from "@/lib/agent/owner-style-settings";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  ConsentAgentIcon,
  FileCheck2,
  FolderLock,
  Link2,
  UserRound,
} from "@/components/icons";

import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import type {
  AgentStructuredExperience,
  EvidenceBriefExperience,
  InformationRequestReviewExperience,
  DocumentRequestReviewExperience,
  KycReadinessExperience,
  MemoryImportReviewExperience,
  PersonSelectionSourceTool,
  ScopeDiscoveryExperience,
  StyleSettingsOfferExperience,
} from "@/lib/agent/agui-structured-experiences";
import { parseAgentActivityExperience } from "@/lib/agent/agui-structured-experiences";
import type { WorkspaceConnectorProvider } from "@/lib/agent/connector-read-receipt";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

export const AgentPersonSelectionContext = createContext<
  ((handle: string, name: string, sourceTool: PersonSelectionSourceTool) => void) | null
>(null);

/**
 * The chat that shows an information request card, and how it continues once
 * the other person answers. Null outside a live chat workspace, where a card
 * only shows status.
 */
export type AgentConsentContinuationHandler = {
  conversationId: string | null;
  continueWithOutcome: (input: {
    bundleId: string;
    subjectRef: string;
    outcome: ConsentOutcome;
    domainFor: (requestId: string) => string | null | undefined;
  }) => Promise<boolean>;
};

export const AgentConsentContinuationContext = createContext<AgentConsentContinuationHandler | null>(null);

export type InformationRequestSubmissionReceipt = {
  bundleId: string;
  subjectRef: string;
  idempotencyKey: string;
  /**
   * The sent card, built from the created request itself. The chat shows it
   * at once, whether or not its history receipt is recorded: the request
   * exists either way, so "Request sent" is the truth.
   */
  review: InformationRequestReviewExperience;
};

export { AgentTranscriptRevealContext };

export function AgentStructuredExperienceView({
  experience,
  onOpenConnections,
  onInformationRequestSubmitted,
  onCompileDriveNotes,
  onDownloadDriveNotes,
  driveCompilation,
}: {
  experience: AgentStructuredExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
  onInformationRequestSubmitted?: (receipt: InformationRequestSubmissionReceipt) => Promise<void>;
  onCompileDriveNotes?: (query: string, window: DriveOwnerCompileWindow) => void;
  onDownloadDriveNotes?: () => void;
  driveCompilation?: DriveCompilationUiState;
}) {
  const selectPerson = useContext(AgentPersonSelectionContext);
  switch (experience.type) {
    case "one.shared_with_me_card.v1":
      return <div className="space-y-3">
        {experience.cards.map((card) => (
          <SharedWithYouCard key={card.person.personRef} person={card.person} items={card.items} variant="chat" />
        ))}
      </div>;
    case "one.connector_read.v1":
      return <ConnectorReadReceipt experience={experience} onOpenConnections={onOpenConnections}
        onCompileDriveNotes={onCompileDriveNotes} onDownloadDriveNotes={onDownloadDriveNotes}
        driveCompilation={driveCompilation} />;
    case "one.workspace_connector_setup.v1":
      return <WorkspaceConnectorSetupCard experience={experience} onOpenConnections={onOpenConnections} />;
    case "one.custom_connector_probe.v1":
      return <CustomConnectorProbeCard experience={experience} onOpenConnections={onOpenConnections} />;
    case "one.person_selection.v1":
      return <ExperienceShell experienceType={experience.type} label="Choose a person" title="Who do you mean?"
        summary="Choose the right person to continue." icon={<UserRound className="size-5" />}>
        <div className="flex flex-col gap-2">
          {experience.candidates.map((candidate) => <div key={candidate.selectionHandle} className="flex items-center gap-2">
            <button type="button" disabled={!selectPerson}
            className="relative min-h-11 cursor-pointer rounded-xl px-3 py-2 text-left hover:bg-accent disabled:cursor-default disabled:opacity-50"
            onClick={() => selectPerson?.(candidate.selectionHandle, candidate.displayName, experience.sourceTool)}>
            <span className="block font-medium">{candidate.displayName}</span>
            {candidate.detail ? <span className="block text-sm text-muted-foreground">{candidate.detail}</span> : null}
            <MaterialRipple variant="none" effect="glass" disabled={!selectPerson} />
          </button>
          <Link className="ml-auto inline-flex min-h-11 shrink-0 items-center text-sm text-primary underline-offset-4 hover:underline"
            href={candidate.profilePath} aria-label={`View ${candidate.displayName}'s profile`}>View profile</Link>
          </div>)}
          {experience.candidatesIncomplete ? (
            <p className="px-3 text-sm text-muted-foreground">
              There are more matches than shown. Narrow the name or provide an email address to continue safely.
            </p>
          ) : null}
        </div>
      </ExperienceShell>;
    case "one.scope_discovery.v1":
      return <ScopeDiscoveryView experience={experience} onInformationRequestSubmitted={onInformationRequestSubmitted} />;
    case "one.information_request_review.v1":
      return <InformationRequestReviewView experience={experience} />;
    case "one.document_request_review.v1":
      return <DocumentRequestReviewView experience={experience} />;
    case "one.drive_share_review.v1":
      return experience.audience === "trusted_circle" || !experience.personRef || !experience.personName
        ? <ExperienceShell experienceType={experience.type} label="Drive sharing"
            title="Share Drive files with your Trusted circle"
            summary="" icon={<FileCheck2 className="size-5" />}>
            <DriveCircleShareCard clientRequestId={experience.clientRequestId}
              filesRequest={experience.filesRequest} />
          </ExperienceShell>
        : <ExperienceShell experienceType={experience.type} label="Drive sharing"
            title={`Share Drive files with ${experience.personName}`}
            summary="Find the files, choose, then share." icon={<FileCheck2 className="size-5" />}>
            <DriveOwnerShareCard personRef={experience.personRef} personName={experience.personName}
              clientRequestId={experience.clientRequestId} filesRequest={experience.filesRequest} />
          </ExperienceShell>;
    case "one.drive_bulk_share_review.v1":
      return <ExperienceShell experienceType={experience.type} label="Drive sharing"
        title="Share saved Drive search" summary=""
        icon={<FileCheck2 className="size-5" />}>
        <DriveBulkShareCard searchJobId={experience.searchJobId} clientRequestId={experience.clientRequestId} />
      </ExperienceShell>;
    case "one.kyc_readiness.v1":
      return <KycReadinessView experience={experience} />;
    case "one.memory_import_review.v1":
      return <MemoryImportReviewView experience={experience} />;
    case "one.evidence_brief.v1":
      return <EvidenceBriefView experience={experience} />;
    case "one.style_settings_offer.v1":
      return <StyleSettingsOfferView experience={experience} />;
  }
}

/**
 * One's offer to change how it writes. It names the values and opens Settings;
 * the proposal travels in memory, never in the URL, and nothing changes until
 * the owner saves there.
 */
function StyleSettingsOfferView({ experience }: { experience: StyleSettingsOfferExperience }) {
  const { user } = useAuth();
  const router = useRouter();
  const ownerId = user?.uid ?? null;
  return (
    <ExperienceShell experienceType={experience.type} label="Writing style" title="Change how One writes to you"
      summary="Review it in Settings. Nothing changes until you save." icon={<EditRowIcon size={24} aria-hidden="true" />}>
      <dl className="divide-y divide-border/35" data-testid="style-offer-values">
        {describeOwnerStyleProposal(experience.proposed).map((row) => (
          <div key={row.label} className="flex min-h-11 items-center justify-between gap-4 py-2">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate text-sm font-medium text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <MorphyButton type="button" size="sm" className="mt-4" disabled={!ownerId} onClick={() => {
        if (!ownerId) return;
        stageOwnerStyleProposal(ownerId, experience.proposed);
        router.push(ROUTES.PROFILE_PREFERENCES);
      }}>Review in Settings</MorphyButton>
    </ExperienceShell>
  );
}

function DocumentRequestReviewView({ experience }: { experience: DocumentRequestReviewExperience }) {
  return <ExperienceShell experienceType={experience.type} label="Drive question" title={`Ask ${experience.personName} about their Drive`}
    summary="Check the question, then send it." icon={<FileCheck2 className="size-5" />}><DocumentRequestButton
      personRef={experience.personRef} personName={experience.personName}
      draft={{clientRequestId: experience.clientRequestId, purpose: experience.purpose,
        periodStart: experience.periodStart, periodEnd: experience.periodEnd}}
    /></ExperienceShell>;
}

function ExperienceShell({
  experienceType,
  label,
  title,
  summary,
  icon,
  children,
}: {
  experienceType: AgentStructuredExperience["type"];
  label: string;
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-experience-type={experienceType} className="overflow-hidden rounded-[24px] bg-[linear-gradient(145deg,var(--app-accent-surface),color-mix(in_srgb,var(--background)_94%,var(--app-accent-soft)))] shadow-[0_18px_55px_-38px_var(--app-accent-deep)]">
      <header className="flex items-start gap-3 px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
        {/* /one iconography: a bare duotone glyph on a transparent well. A
            registry capability glyph keeps its own colour; a utility glyph
            takes the accent. Never a filled tile with a white glyph. */}
        <span data-slot="card-header-icon" className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-accent-strong">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="ui-text-section-label text-accent-strong">{label}</p>
          <h3 className="mt-1 text-base font-semibold tracking-[-0.015em] text-foreground">{title}</h3>
          {summary ? <p className="mt-1 text-sm leading-5 text-muted-foreground">{summary}</p> : null}
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

function submittedReviewFromBundle(input: {
  bundle: InformationRequestBundle;
  subjectRef: string;
  personName: string;
  purpose: string;
  durationHours: number;
  scopes: RequestablePersonScope[];
}): InformationRequestReviewExperience | null {
  const { bundle, subjectRef, personName, purpose, durationHours, scopes } = input;
  if (bundle.personRef !== subjectRef || bundle.purpose !== purpose.trim()
    || bundle.durationSeconds !== durationHours * 3600
    || !Array.isArray(bundle.items) || bundle.items.length !== scopes.length) return null;
  const byRef = new Map(scopes.map((scope) => [scope.scopeRef, scope]));
  if (byRef.size !== scopes.length || new Set(bundle.items.map((item) => item.scopeRef)).size !== scopes.length
    || bundle.items.some((item) => !byRef.has(item.scopeRef))) return null;
  // Reuse the same safe descriptor parser as restored Chat history. The bundle
  // and subject are display references only; the submitted card rereads both.
  const review = parseAgentActivityExperience("one.information_request_review.v1", {
    personName,
    purpose: bundle.purpose,
    durationLabel: requestDurationLabel(durationHours),
    direction: "outgoing",
    phase: "submitted",
    subjectRef,
    bundleId: bundle.bundleId,
    requestId: null,
    status: "pending",
    fields: bundle.items.map((item) => {
      const scope = byRef.get(item.scopeRef)!;
      return {
        requestId: item.requestId,
        label: item.label,
        domain: scope.domain || "Information",
        sensitivity: scope.sensitivity || item.sensitivity || "standard",
      };
    }),
  });
  return review?.type === "one.information_request_review.v1"
    && review.phase === "submitted" && review.subjectRef === subjectRef
    && review.bundleId === bundle.bundleId && review.fields.length === scopes.length
    ? review : null;
}

function ScopeDiscoveryView({
  experience,
  onInformationRequestSubmitted,
}: {
  experience: ScopeDiscoveryExperience;
  onInformationRequestSubmitted?: (receipt: InformationRequestSubmissionReceipt) => Promise<void>;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked } = useVault();
  const revealInTranscript = useContext(AgentTranscriptRevealContext);
  const personRef = experience.person.personRef;
  const request = usePersonInformationRequest(personRef ?? "");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [durationHours, setDurationHours] = useState(DEFAULT_REQUEST_DURATION_HOURS);
  const [sent, setSent] = useState(false);
  const [submitted, setSubmitted] = useState<{
    ownerUid: string;
    subjectRef: string;
    review: InformationRequestReviewExperience;
  } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [current, setCurrent] = useState<{ owner: string; profile: ViewerPersonProfile } | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const profile = personRef && isVaultUnlocked && current && current.owner === user?.uid && current.profile.personRef === personRef
    ? current.profile : null;

  useEffect(() => { setSubmitted(null); }, [personRef, user?.uid]);

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
    setLoading(Boolean(user && isVaultUnlocked && personRef));
    if (user && isVaultUnlocked && personRef) {
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
    if (!personRef || !user || !profile?.scopeCatalog?.nextPage || inFlight.current) return;
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
  // Retained/live cards are safe descriptors, never current authority. Show
  // the validated descriptor immediately so a person is not left with an
  // empty "checking" surface, then replace it with the current Profile
  // catalog as soon as that authority refresh completes. Selection and
  // mutation remain unavailable until the current catalog is loaded.
  const authorityScopes = profile?.requestableScopes || [];
  const displayScopes = profile?.requestableScopes || experience.scopes;
  const grantedIds = new Set(profile?.grants.map(grant => grant.scopeRef) || []);
  const selectedScopes = selectedRequestScopes(authorityScopes, selectedIds)
    .filter(scope => !grantedIds.has(scope.scopeRef));
  const total = profile?.scopeCatalog?.totalCount
    ?? experience.scopeCatalog?.totalCount
    ?? displayScopes.length;
  // Profile and Chat deliberately consume the same adapter and recursive
  // selector. Opaque refs stay leaves; only authored attr paths can create
  // hierarchy.
  const items = scopeItemsFromRequestable(
    displayScopes.map((scope) => ({
      scopeRef: scope.scopeRef,
      pathSegments: scope.pathSegments,
      label: scope.label,
      description: scope.description,
      domain: scope.domain,
      sensitivity: scope.sensitivity,
      wildcard: "wildcard" in scope ? scope.wildcard : false,
    })),
  );

  // The one send path for both the catalog review and One's proposal (C4).
  function sendRequest(draft: AskProposalDraft) {
    const { scopes, purpose: draftPurpose, durationHours: draftHours } = draft;
    if (!profile) return;
    void request.submitWithReceipt({ scopeRefs: scopes.map(scope => scope.scopeRef), purpose: draftPurpose, durationHours: draftHours }).then(receipt => {
      if (!receipt || !user || !personRef) return;
      const { bundle, idempotencyKey } = receipt;
      const review = submittedReviewFromBundle({
        bundle, subjectRef: personRef, personName: profile.displayName,
        purpose: draftPurpose, durationHours: draftHours, scopes,
      });
      if (review) {
        setSubmitted({ ownerUid: user.uid, subjectRef: personRef, review });
        void onInformationRequestSubmitted?.({ bundleId: bundle.bundleId, subjectRef: personRef, idempotencyKey, review });
      }
      else setSent(true);
      setReviewing(false); setSelectedIds(new Set()); setPurpose("");
    });
  }

  const activeSubmitted = isVaultUnlocked && submitted && submitted.ownerUid === user?.uid
    && submitted.subjectRef === personRef ? submitted.review : null;
  if (activeSubmitted) return <InformationRequestReviewView experience={activeSubmitted} />;

  // One picked the information from the question; the person confirms. The
  // catalog stays behind Change (server search). Anything already shared is
  // not asked for again, and no usable proposal falls back to the catalog.
  const proposal = experience.proposal && personRef
    && experience.proposal.proposed.some(item => !grantedIds.has(item.scopeRef))
    ? { ...experience.proposal, proposed: experience.proposal.proposed.filter(item => !grantedIds.has(item.scopeRef)) }
    : null;
  if (proposal && personRef && !sent) {
    return <AskProposalCard
      revealActions={revealInTranscript ?? undefined}
      catalog={authorityScopes}
      personName={personName(profile?.displayName || experience.person.displayName)}
      proposal={proposal}
      ready={Boolean(profile) && request.available}
      sending={request.pending}
      error={request.error}
      onSend={sendRequest}
      searchCatalog={async (query, page, signal) => {
        if (!user) throw new Error("Sign in to search.");
        const idToken = await user.getIdToken();
        return PersonProfileService.searchScopeCatalog({ personRef, idToken, query, page, signal });
      }}
    />;
  }

  return (
    <section
      aria-label={`Information available from ${experience.person.displayName}`}
      data-experience-type={experience.type}
      className="space-y-3"
    >
      <header className="flex items-start gap-3 px-1">
        <span data-slot="card-header-icon" className="inline-flex h-9 w-9 shrink-0 items-center justify-center">
          <ConsentAgentIcon className="h-7 w-7" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            What {personName(profile?.displayName || experience.person.displayName)} can share with you
          </h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {!profile ? !personRef ? "This saved card cannot be used to make a request. Ask One to check again." : !user ? "Sign in to check what is available." : !isVaultUnlocked ? "Unlock your vault to continue here." : "Checking what is currently available to request."
              : total === 0
              ? "Nothing is currently available to request."
              : `${total} ${total === 1 ? "item" : "items"} you can ask for. They decide what to share, and for how long.`}
          </p>
        </div>
      </header>

      {items.length > 0 ? (
        <div className="px-1">
          <ConsentScopeNestedList
            items={items}
            rootLabel="All information"
            testIdPrefix="scope-discovery-scopes"
            selection={profile && !reviewing && !request.pending ? {
              selectedIds,
              onToggleMany: (ids, select) => {
                setSent(false);
                setSelectedIds(currentIds => {
                  const allowedIds = ids.filter(id => authorityScopes.some(scope => scope.scopeRef === id) && !grantedIds.has(id));
                  return toggleRequestScopes(authorityScopes, currentIds, allowedIds, select);
                });
              },
            } : undefined}
          />
        </div>
      ) : null}

      {unavailable ? <p role="alert" className="text-sm text-muted-foreground">We couldn’t check available information. Please try again.</p> : null}
      {profile?.scopeCatalog?.hasMore ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="text-muted-foreground">{displayScopes.length} of {total} loaded. Search checks loaded information.</p>
        <MorphyButton type="button" size="sm" disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading more…" : unavailable ? "Try loading more again" : "Load more information"}
        </MorphyButton>
      </div> : unavailable ? <MorphyButton type="button" size="sm" onClick={() => setRetry(value => value + 1)}>Try again</MorphyButton> : null}

      {reviewing && profile ? <section aria-label="Review information request" className="space-y-3 rounded-2xl border border-border p-3 sm:p-4">
        <h4 className="font-semibold">Request information from {profile.displayName}</h4>
        <p className="text-sm text-muted-foreground">They will see exactly what you asked for, why, and for how long. Nothing is sent until you confirm.</p>
        <InformationRequestReviewFields scopes={selectedScopes} purpose={purpose} durationHours={durationHours}
          onPurposeChange={setPurpose} onDurationChange={setDurationHours} disabled={request.pending} testIdPrefix="chat-request" />
        {request.error ? <p role="alert" className="text-sm text-destructive">{request.error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <MorphyButton type="button" size="sm" disabled={request.pending} onClick={() => setReviewing(false)}>Edit information</MorphyButton>
          <MorphyButton type="button" size="sm" disabled={!request.available || request.pending || purpose.trim().length < 8 || !selectedScopes.length || selectedScopes.length > 50}
            onClick={() => sendRequest({ scopes: selectedScopes, purpose, durationHours })}>{request.pending ? "Sending…" : "Send request"}</MorphyButton>
        </div>
      </section> : null}
      {!reviewing ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
        {items.length ? <MorphyButton type="button" size="sm" disabled={!selectedScopes.length || loading}
          onClick={() => setReviewing(true)}>Review request</MorphyButton> : null}
        <Link href={experience.person.profilePath} className="inline-flex min-h-11 shrink-0 items-center text-sm text-primary underline-offset-4 hover:underline">View profile</Link>
      </div> : <Link href={experience.person.profilePath} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">View profile</Link>}
      {sent ? <p role="status" className="text-sm">Request sent. They can now review your choices; access is not granted yet.</p> : null}
    </section>
  );
}

function informationRequestStatusLabel(
  status: NonNullable<InformationRequestReviewExperience["fields"][number]["status"]>,
): string {
  return status === "pending"
    ? "Pending"
    : status === "granted"
      ? "Granted"
      : status === "denied"
        ? "Declined"
        : status === "cancelled"
          ? "Withdrawn"
          : status === "expired"
            ? "Expired"
            : "Revoked";
}

function InformationRequestReviewView({ experience }: { experience: InformationRequestReviewExperience }) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [latest, setCurrent] = useState<{
    /** The request this reading is for; a different card never shows it. */
    bundleId: string;
    status: InformationRequestReviewExperience["status"];
    fields: InformationRequestReviewExperience["fields"];
    /** Contract C1 progress; null on an older backend, which keeps the pre-C1 card. */
    progress: RequestProgress | null;
  } | null>(null);
  // The last reading stays on screen while the next one loads: a refresh
  // never blanks the card or drops it back to "Request sent" for a frame.
  const current = latest && latest.bundleId === experience.bundleId ? latest : null;
  const phaseFor = useContext(ConsentCardPhaseContext);
  const phase = experience.bundleId && phaseFor ? phaseFor(experience.bundleId) : null;
  const [refreshState, setRefreshState] = useState<"idle" | "checking" | "loaded" | "unavailable">("idle");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [answer, setAnswer] = useState<ConsentOutcome | null>(null);
  const continuation = useContext(AgentConsentContinuationContext);
  // A reading another surface just made (the doorbell, the live-access watch)
  // applies at once, with no read of this card's own: measured 2026-09-29, the
  // chat knew "Reading…" at 19.1s while this card, waiting on its own read of
  // a starved pool, still said "Seen" until 33.5s.
  const publishedRef = useRef<InformationRequestBundle | null>(null);
  const eventRefreshRef = useRef(false);
  useEffect(() => {
    if (!experience.bundleId || experience.phase !== "submitted") return;
    return subscribeInformationRequest(experience.bundleId, (bundle) => {
      publishedRef.current = bundle;
      setRefreshRevision((revision) => revision + 1);
    });
  }, [experience.bundleId, experience.phase]);

  useEffect(() => {
    if (!experience.bundleId || experience.phase !== "submitted") return;
    const refresh = () => {
      eventRefreshRef.current = true;
      setRefreshState("checking");
      setRefreshRevision((revision) => revision + 1);
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const onConsentChanged = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      // A doorbell for another request says nothing about this one.
      if (detail?.source === "information_request_updated"
        && String(detail.bundleId ?? "").toLowerCase() !== String(experience.bundleId).toLowerCase()) return;
      refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [experience.bundleId, experience.phase]);

  useEffect(() => {
    let active = true;
    if (experience.phase !== "submitted" || !experience.bundleId) {
      setCurrent(null);
      setRefreshState("idle");
      return () => { active = false; };
    }
    if (!isVaultUnlocked || !vaultOwnerToken) {
      setCurrent(null);
      setRefreshState("unavailable");
      return () => { active = false; };
    }
    const published = publishedRef.current;
    publishedRef.current = null;
    const fromEvent = eventRefreshRef.current;
    eventRefreshRef.current = false;
    if (!published) setRefreshState("checking");
    // A status-change event must not reuse a read that began before the
    // change. The shared reader suppresses older results after this read.
    void (published ? Promise.resolve(published) : readInformationRequest({
      bundleId: experience.bundleId,
      vaultOwnerToken,
      ...(fromEvent ? { fresh: true } : {}),
    })).then((bundle) => {
      if (!active) return;
      // A restored descriptor is only a display reference. If the current
      // authority lookup resolves a different person, reject it without
      // rendering any of its status and settle the card into a recoverable
      // state instead of leaving the reader on an endless "Checking...".
      if (!experience.subjectRef || bundle.personRef !== experience.subjectRef || bundle.bundleId !== experience.bundleId) {
        setCurrent(null);
        setRefreshState("unavailable");
        return;
      }
      if (!bundle.items.length) {
        setCurrent(null);
        setRefreshState("unavailable");
        return;
      }
      const statuses = bundle.items.map((item) => item.status);
      const firstStatus = statuses[0]!;
      const status = statuses.every((itemStatus) => itemStatus === firstStatus)
        ? firstStatus
        : "mixed" as const;
      // The bundle is the role-authorized source of truth. A restored card's
      // labels are display hints, never keys for assigning a current status.
      const byRequestId = new Map(experience.fields.filter((field) => field.requestId).map((field) => [field.requestId, field]));
      const fields = bundle.items.map((item) => {
        // The ledger's own reading (C7); nothing said is sensitive.
        const ledger = String(item.sensitivity ?? "").trim().toLowerCase();
        return {
        label: item.label,
        domain: byRequestId.get(item.requestId)?.domain || "Information",
        sensitivity: ledger === "standard" ? "standard" as const : ledger === "restricted" ? "restricted" as const : "sensitive" as const,
        requestId: item.requestId,
        status: item.status,
        };
      });
      const progress = parseRequestProgress(bundle.progress);
      setCurrent({ bundleId: bundle.bundleId, status, fields, progress });
      setAnswer(informationRequestOutcome(bundle));
      setRefreshState("loaded");
    }).catch(() => {
      if (active) setRefreshState("unavailable");
    });
    return () => { active = false; };
  }, [experience.bundleId, experience.fields, experience.phase, experience.subjectRef, isVaultUnlocked, vaultOwnerToken, refreshRevision]);

  // A request this person sent from this chat: while it waits, the app shell
  // watches it; once it is answered, this chat continues exactly once.
  const isOutgoingSubmitted = experience.direction === "outgoing" && experience.phase === "submitted";
  useEffect(() => {
    if (!isOutgoingSubmitted || !user?.uid || !experience.bundleId || !continuation) return;
    return mountInformationRequestCard(user.uid, experience.bundleId);
  }, [continuation, experience.bundleId, isOutgoingSubmitted, user?.uid]);

  useEffect(() => {
    // A restored card registers only once the ledger confirms it is still
    // waiting; a card sent in this tab is registered at Send by the workspace.
    if (!isOutgoingSubmitted || !user?.uid || !experience.bundleId || !experience.subjectRef
      || !continuation?.conversationId || refreshState !== "loaded" || current?.status !== "pending") return;
    watchSentInformationRequest({
      ownerId: user.uid,
      bundleId: experience.bundleId,
      conversationId: continuation.conversationId,
      subjectRef: experience.subjectRef,
      personName: experience.personName,
    });
  }, [isOutgoingSubmitted, user?.uid, experience.bundleId, experience.subjectRef, experience.personName,
    continuation?.conversationId, refreshState, current?.status]);

  // One attempt at a time, and a re-render never cancels it. Measured
  // 2026-09-29 (R3): every refetch re-ran this effect and dropped the attempt
  // before its (slow) ledger check returned, so the answer never continued
  // until the person left the chat and came back. Claiming is the guard
  // against a second continuation; the server marker is the last word.
  const continuingRef = useRef<string | null>(null);
  const fieldsRef = useRef(current?.fields);
  fieldsRef.current = current?.fields;
  useEffect(() => {
    const ownerId = user?.uid;
    const bundleId = experience.bundleId;
    const subjectRef = experience.subjectRef;
    const conversationId = continuation?.conversationId;
    if (!isOutgoingSubmitted || !ownerId || !bundleId || !subjectRef || !conversationId || !answer
      || !vaultKey || !vaultOwnerToken || !isVaultUnlocked || refreshState !== "loaded") return;
    // Only an answer this tab was waiting for, or one the person opened from
    // its notice, continues; an old chat never replays by itself.
    if (!isConsentContinuationArmed(ownerId, bundleId)) return;
    if (continuingRef.current === bundleId) return;
    continuingRef.current = bundleId;
    void (async () => {
      try {
        const done = await getAgentChatConsentOutcomes({ conversationId, vaultOwnerToken, vaultKey })
          .catch(() => null);
        if (!done || bundleId.toLowerCase() in done) return;
        if (!claimConsentContinuation(ownerId, bundleId)) return;
        const started = await continuation.continueWithOutcome({
          bundleId,
          subjectRef,
          outcome: answer,
          domainFor: (requestId) => fieldsRef.current?.find((field) => field.requestId === requestId)?.domain
            ?? experience.fields.find((field) => field.requestId === requestId)?.domain,
        }).catch(() => false);
        if (!started) releaseConsentContinuation(ownerId, bundleId);
      } finally {
        if (continuingRef.current === bundleId) continuingRef.current = null;
      }
    })();
  }, [answer, continuation, experience.bundleId, experience.fields, experience.subjectRef,
    isOutgoingSubmitted, isVaultUnlocked, refreshRevision, refreshState, user?.uid, vaultKey, vaultOwnerToken]);

  const displayFields = current?.fields || experience.fields;
  const displayStatus = current?.status || experience.status;
  // What is shared right now opens at once in the secure card (CONTRACT-2
  // decision 2), for sensitive items too: the model only ever had their
  // outline. The card owns opening, the unlock prompt and ended access.
  const sharedItems: SharedWithMeCardItem[] = experience.direction === "outgoing" && experience.phase === "submitted"
    && experience.bundleId && (refreshState === "loaded" || refreshState === "checking")
    ? (current?.fields ?? []).flatMap((field) => field.status === "granted" && field.requestId ? [{
      key: field.requestId,
      grantRef: field.requestId,
      bundleId: experience.bundleId,
      requestId: field.requestId,
      label: humanSharedLabel(field.label) ?? field.label,
      sensitivity: field.sensitivity === "standard" ? "standard" as const : "sensitive" as const,
      domain: field.domain,
      fieldOutline: [],
      sharedAt: current?.progress?.decidedAt ?? null,
      accessEndsAt: current?.progress?.accessEndsAt ?? null,
      purpose: null,
      status: "granted" as const,
    }] : [])
    : [];
  // Every field becomes a row in the one list every scope surface uses, so this
  // reads the same as Memory and the same as the pending-request card.
  const items = displayFields.map((field, index) => ({
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
    badge: [
      sensitivityLabel(field.sensitivity),
      field.status ? informationRequestStatusLabel(field.status) : null,
    ].filter(Boolean).join(" · ") || undefined,
    searchText: `${field.label} ${field.domain || ""}`.toLowerCase(),
  }));

  const isIncoming = experience.direction === "incoming";
  const isOutgoingDraft = experience.direction === "outgoing" && experience.phase === "draft";
  const label = isIncoming ? "Waiting on you" : isOutgoingDraft ? "Draft request" : experience.direction === "outgoing" ? "Request sent" : "Information request";
  const title = isIncoming
    ? `${experience.personName} asked to see some of your information`
    : isOutgoingDraft
      ? `Requesting information from ${experience.personName}`
      : experience.direction === "outgoing"
        ? `Request sent to ${experience.personName}`
        : `Information request involving ${experience.personName}`;
  const statusText = refreshState === "unavailable" && experience.phase === "submitted"
    ? "Current status unavailable · last recorded status is shown below"
    : refreshState === "checking"
      ? "Checking current status…"
      : experience.phase === "historical"
    ? "Historical preview · current status was not checked"
    : displayStatus === "awaiting_review"
      ? "Not sent yet"
      : experience.direction === "incoming" && displayStatus === "pending"
        ? "Waiting for your decision"
        : experience.direction === "outgoing" && displayStatus === "pending"
          ? `Waiting for ${experience.personName}'s approval`
          : displayStatus === "granted"
            ? experience.direction === "outgoing" ? "Consent approved" : "Access granted"
            : displayStatus === "mixed"
              ? "Mixed outcomes; see each item below"
            : displayStatus === "denied"
              ? "Request declined"
              : displayStatus === "cancelled"
                ? "Request withdrawn"
                : displayStatus === "expired"
                  ? "Request expired"
                  : displayStatus === "revoked"
                    ? "Access revoked"
                    : "Status unavailable";

  const sharedCard = sharedItems.length && experience.subjectRef ? (
    <SharedWithYouCard
      person={{ personRef: experience.subjectRef, displayName: experience.personName }}
      items={sharedItems}
      variant="chat"
    />
  ) : null;

  // C1: the living card, when the server reports progress for this request.
  // It keeps its last reading through a refetch (and a failed one).
  const progress = isOutgoingSubmitted ? current?.progress ?? null : null;
  if (progress) {
    const progressLabels = progress.fields.length ? progress.fields.map((field) => field.label) : displayFields.map((field) => field.label);
    const ended = isAccessEnded(progress);
    const progressLabel = ended ? "Access ended"
      : progress.outcome === "pending" ? "Request sent"
        : progress.outcome === "denied" ? "Declined"
          : progress.outcome === "expired" ? "Request expired"
            : progress.outcome === "partially_granted" ? "Partly shared" : "Shared with you";
    return (
      <div className="space-y-3">
        <ExperienceShell
          experienceType={experience.type}
          label={progressLabel}
          title={`${joinLabels(progressLabels)} from ${experience.personName}`}
          summary={experience.durationLabel}
          icon={<ConsentAgentIcon className="h-7 w-7" aria-hidden="true" />}
        >
          <RequesterProgressBody progress={progress} phase={phase} personName={experience.personName}
            purpose={experience.purpose} />
        </ExperienceShell>
        {ended ? null : sharedCard}
      </div>
    );
  }

  return (
    <div className="space-y-3">
    <ExperienceShell
      experienceType={experience.type}
      label={label}
      title={title}
      summary={`${items.length} ${items.length === 1 ? "item" : "items"} · ${experience.durationLabel}`}
      icon={<ConsentAgentIcon className="h-7 w-7" aria-hidden="true" />}
    >
      <p className="text-sm leading-6 text-foreground">{experience.purpose}</p>
      <p role="status" className="mt-2 text-xs font-medium text-muted-foreground">{statusText}</p>
      <div className="mt-3">
        <ConsentScopeList
          items={items}
          groupByDomain={items.length > 1}
          collapsible={false}
          testIdPrefix="information-request-review-scopes"
        />
      </div>
    </ExperienceShell>
    {sharedCard}
    </div>
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
    <ExperienceShell experienceType={experience.type} label="Readiness" title={experience.workflowName} summary={experience.summary} icon={<FileCheck2 className="h-5 w-5" aria-hidden="true" />}>
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
  const complete = experience.sourceBlockCount === experience.accountedBlockCount && !experience.presentationIncomplete;
  const total = experience.groups.reduce((count, group) => count + group.candidates.length, 0);
  return (
    <ExperienceShell experienceType={experience.type} label="Memory review" title={`${total} memories ready to review`} summary={`${experience.accountedBlockCount} of ${experience.sourceBlockCount} source sections accounted for`} icon={<FolderLock className="h-5 w-5" aria-hidden="true" />}>
      <p className={complete ? "mb-3 flex items-center gap-2 text-xs font-semibold text-emerald-600" : "mb-3 flex items-center gap-2 text-xs font-semibold text-destructive"}>{complete ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}{complete ? "Complete coverage" : "Review required before saving"}</p>
      <div className="space-y-4">
        {experience.groups.map((group) => <section key={group.domain}><h4 className="ui-text-section-label text-muted-foreground">{group.domain}</h4><ul className="mt-1 divide-y divide-border/35">{group.candidates.map((candidate) => <li key={candidate.candidateRef} className="py-2.5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-foreground">{candidate.label}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{candidate.preview}</p></div><span className="shrink-0 text-[11px] font-semibold text-accent-strong">{candidate.sharingPosture.replace("_", " ")}</span></div></li>)}</ul></section>)}
      </div>
    </ExperienceShell>
  );
}

function EvidenceBriefView({ experience }: { experience: EvidenceBriefExperience }) {
  return (
    <ExperienceShell experienceType={experience.type} label={`${experience.confidence} confidence`} title={experience.title} summary={experience.summary} icon={<Link2 className="h-5 w-5" aria-hidden="true" />}>
      <ul className="space-y-3">{experience.findings.map((finding) => <li key={finding.label}><p className="text-sm font-semibold text-foreground">{finding.label}</p><p className="mt-0.5 text-sm leading-5 text-muted-foreground">{finding.detail}</p></li>)}</ul>
      {experience.sources.length ? <div className="mt-4 flex flex-wrap gap-2">{experience.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-accent-surface px-3 py-1.5 text-xs font-semibold text-accent-strong hover:bg-accent-soft">{source.label}<ArrowUpRight className="h-3 w-3" /></a>)}</div> : null}
      {experience.unresolved.length ? <div className="mt-4"><p className="ui-text-section-label text-muted-foreground">Still unresolved</p><ul className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">{experience.unresolved.map((item) => <li key={item}>• {item}</li>)}</ul></div> : null}
    </ExperienceShell>
  );
}
