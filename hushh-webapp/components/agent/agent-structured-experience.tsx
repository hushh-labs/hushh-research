"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonInformationRequest } from "@/lib/consent/use-person-information-request";
import { isCurrentPersonExport } from "@/lib/consent/person-export-binding";
import { selectedRequestScopes, toggleRequestScopes } from "@/lib/consent/request-scope-selection";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { projectGrantPayload } from "@/lib/consent/project-grant-payload";
import { DecryptedRecordContent } from "@/components/connections/decrypted-grant-card";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { DEFAULT_REQUEST_DURATION_HOURS } from "@/lib/agent/action-directive-summary";
import { PersonProfileService, mergePersonScopePage, type ViewerPersonProfile } from "@/lib/services/person-profile-service";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import { ConnectorReadReceipt } from "@/components/agent/connector-read-receipt";
import { DocumentRequestButton } from "@/components/consent/document-request-button";
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
  DocumentRequestReviewExperience,
  KycReadinessExperience,
  MemoryImportReviewExperience,
  PersonSelectionSourceTool,
  ScopeDiscoveryExperience,
} from "@/lib/agent/agui-structured-experiences";

export const AgentPersonSelectionContext = createContext<
  ((handle: string, name: string, sourceTool: PersonSelectionSourceTool) => void) | null
>(null);

export function AgentStructuredExperienceView({
  experience,
  onOpenConnections,
}: {
  experience: AgentStructuredExperience;
  onOpenConnections?: (trigger: HTMLButtonElement) => void;
}) {
  const selectPerson = useContext(AgentPersonSelectionContext);
  switch (experience.type) {
    case "one.connector_read.v1":
      return <ConnectorReadReceipt experience={experience} onOpenConnections={onOpenConnections} />;
    case "one.person_selection.v1":
      return <ExperienceShell experienceType={experience.type} label="Choose a person" title="Who do you mean?"
        summary="Choose the right person to continue." icon={<UserRound className="size-5" />}>
        <div className="flex flex-col gap-2">
          {experience.candidates.map((candidate) => <div key={candidate.selectionHandle} className="flex items-center gap-2">
            <button type="button" disabled={!selectPerson}
            className="min-h-11 cursor-pointer rounded-xl px-3 py-2 text-left hover:bg-accent disabled:cursor-default disabled:opacity-50"
            onClick={() => selectPerson?.(candidate.selectionHandle, candidate.displayName, experience.sourceTool)}>
            <span className="block font-medium">{candidate.displayName}</span>
            {candidate.detail ? <span className="block text-sm text-muted-foreground">{candidate.detail}</span> : null}
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
      return <ScopeDiscoveryView experience={experience} />;
    case "one.information_request_review.v1":
      return <InformationRequestReviewView experience={experience} />;
    case "one.document_request_review.v1":
      return <DocumentRequestReviewView experience={experience} />;
    case "one.kyc_readiness.v1":
      return <KycReadinessView experience={experience} />;
    case "one.memory_import_review.v1":
      return <MemoryImportReviewView experience={experience} />;
    case "one.evidence_brief.v1":
      return <EvidenceBriefView experience={experience} />;
  }
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
  const personRef = experience.person.personRef;
  const request = usePersonInformationRequest(personRef ?? "");
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
  const profile = personRef && isVaultUnlocked && current && current.owner === user?.uid && current.profile.personRef === personRef
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

  return (
    <section
      aria-label={`Information available from ${experience.person.displayName}`}
      data-experience-type={experience.type}
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
            {!profile ? !personRef ? "This saved card cannot be used to make a request. Ask One to check again." : !user ? "Sign in to check what is available." : !isVaultUnlocked ? "Unlock your vault to continue here." : "Checking what is currently available to request."
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
  const [current, setCurrent] = useState<{
    status: InformationRequestReviewExperience["status"];
    fields: InformationRequestReviewExperience["fields"];
  } | null>(null);
  const [refreshState, setRefreshState] = useState<"idle" | "checking" | "loaded" | "unavailable">("idle");
  const [revealState, setRevealState] = useState<"idle" | "opening" | "unavailable">("idle");
  const [autoRevealRequestId, setAutoRevealRequestId] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [revealed, setRevealed] = useState<{
    viewerUid: string;
    ownerToken: string;
    bundleId: string;
    expiresAtMs: number;
    values: Array<{ requestId: string; label: string; data: Record<string, unknown> }>;
  } | null>(null);
  const revealGeneration = useRef(0);

  useEffect(() => {
    revealGeneration.current += 1;
    setRevealed(null);
    setRevealState("idle");
    setAutoRevealRequestId(null);
  }, [experience.bundleId, experience.subjectRef, isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    if (!experience.bundleId || experience.phase !== "submitted") return;
    const refresh = () => {
      revealGeneration.current += 1;
      setRevealed(null);
      setCurrent(null);
      setRefreshState("checking");
      setRefreshRevision((revision) => revision + 1);
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const onConsentChanged = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail?.source === "information_request_updated") {
        if (detail.bundleId !== experience.bundleId || typeof detail.requestId !== "string") return;
        if (detail.action === "CONSENT_GRANTED") setAutoRevealRequestId(detail.requestId);
        else setAutoRevealRequestId((pending) => pending === detail.requestId ? null : pending);
      }
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
    if (!revealed) return;
    const remainingMs = revealed.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      setRevealed(null);
      return;
    }
    const timer = window.setTimeout(() => setRevealed(null), Math.min(remainingMs, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const revealGrantedInformation = useCallback(async () => {
    if (!user || !vaultKey || !vaultOwnerToken || !isVaultUnlocked || !experience.bundleId || !experience.subjectRef) return;
    const generation = ++revealGeneration.current;
    setRevealed(null);
    setRevealState("opening");
    try {
      const bundle = await PersonProfileService.getInformationRequest({ bundleId: experience.bundleId, vaultOwnerToken });
      if (generation !== revealGeneration.current) return;
      if (bundle.bundleId !== experience.bundleId || bundle.personRef !== experience.subjectRef) throw new Error("Mismatched request");
      const granted = bundle.items.filter((item) => item.status === "granted");
      if (!granted.length) throw new Error("No current grant");
      const connector = await OneKycClientZkService.readStoredConnector({ userId: user.uid, vaultKey, vaultOwnerToken });
      if (generation !== revealGeneration.current) return;
      if (!connector) throw new Error("Connection unavailable");
      const exports = await PersonProfileService.getInformationRequestExports({ bundleId: bundle.bundleId, vaultOwnerToken });
      if (generation !== revealGeneration.current) return;
      const values: Array<{ requestId: string; label: string; data: Record<string, unknown> }> = [];
      let expiresAtMs = Number.MAX_SAFE_INTEGER;
      for (const item of granted) {
        if (generation !== revealGeneration.current) return;
        const exact = exports.find((entry) => entry.requestId === item.requestId);
        if (!exact || !isCurrentPersonExport({ item, scopeRef: exact.scopeRef, exportPackage: exact.encryptedExport, nowMs: Date.now() })) {
          throw new Error("Export unavailable or changed");
        }
        const payload = await OneKycClientZkService.decryptScopedExport({ exportPackage: exact.encryptedExport, connector });
        if (generation !== revealGeneration.current) return;
        const domain = current?.fields.find((field) => field.requestId === item.requestId)?.domain;
        values.push({ requestId: item.requestId, label: item.label, data: projectGrantPayload(payload, domain) });
        expiresAtMs = Math.min(expiresAtMs, exact.encryptedExport.export_envelope.aad.expires_at_ms);
      }
      const latest = await PersonProfileService.getInformationRequest({ bundleId: bundle.bundleId, vaultOwnerToken });
      if (generation !== revealGeneration.current) return;
      if (latest.bundleId !== bundle.bundleId || latest.personRef !== experience.subjectRef
        || !values.every((value) => latest.items.some((item) => item.requestId === value.requestId && item.status === "granted"))) {
        throw new Error("Grant changed while opening information");
      }
      if (generation !== revealGeneration.current) return;
      setRevealed({ viewerUid: user.uid, ownerToken: vaultOwnerToken, bundleId: bundle.bundleId, expiresAtMs, values });
      setRevealState("idle");
    } catch {
      if (generation === revealGeneration.current) setRevealState("unavailable");
    }
  }, [user, vaultKey, vaultOwnerToken, isVaultUnlocked, experience.bundleId, experience.subjectRef, current?.fields]);

  useEffect(() => {
    if (!autoRevealRequestId || refreshState !== "loaded" || !isVaultUnlocked
      || !current?.fields.some((field) => field.requestId === autoRevealRequestId && field.status === "granted")) return;
    setAutoRevealRequestId(null);
    void revealGrantedInformation();
  }, [autoRevealRequestId, refreshState, isVaultUnlocked, current, revealGrantedInformation]);

  useEffect(() => {
    let active = true;
    setCurrent(null);
    if (experience.phase !== "submitted" || !experience.bundleId) {
      setRefreshState("idle");
      return () => { active = false; };
    }
    if (!isVaultUnlocked || !vaultOwnerToken) {
      setRefreshState("unavailable");
      return () => { active = false; };
    }
    setRefreshState("checking");
    void PersonProfileService.getInformationRequest({
      bundleId: experience.bundleId,
      vaultOwnerToken,
    }).then((bundle) => {
      if (!active) return;
      // A restored descriptor is only a display reference. If the current
      // authority lookup resolves a different person, reject it without
      // rendering any of its status and settle the card into a recoverable
      // state instead of leaving the reader on an endless "Checking...".
      if (!experience.subjectRef || bundle.personRef !== experience.subjectRef || bundle.bundleId !== experience.bundleId) {
        setRefreshState("unavailable");
        return;
      }
      if (!bundle.items.length) {
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
      const fields = bundle.items.map((item) => ({
        label: item.label,
        domain: byRequestId.get(item.requestId)?.domain || "Information",
        sensitivity: byRequestId.get(item.requestId)?.sensitivity || "standard" as const,
        requestId: item.requestId,
        status: item.status,
      }));
      setCurrent({ status, fields });
      setRevealed((previous) => previous && previous.values.every((value) =>
        bundle.items.some((item) => item.requestId === value.requestId && item.status === "granted"),
      ) ? previous : null);
      setRefreshState("loaded");
    }).catch(() => {
      if (active) setRefreshState("unavailable");
    });
    return () => { active = false; };
  }, [experience.bundleId, experience.fields, experience.phase, experience.subjectRef, isVaultUnlocked, vaultOwnerToken, refreshRevision]);

  const displayFields = current?.fields || experience.fields;
  const displayStatus = current?.status || experience.status;
  const visibleValues = isVaultUnlocked && revealed && revealed.viewerUid === user?.uid
    && revealed.ownerToken === vaultOwnerToken
    && revealed.bundleId === experience.bundleId
    && revealed.expiresAtMs > Date.now() ? revealed.values : null;
  const canReveal = experience.direction === "outgoing" && experience.phase === "submitted"
    && refreshState === "loaded" && Boolean(current?.fields.some((field) => field.status === "granted"));
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
          ? "Waiting for their decision"
          : displayStatus === "granted"
            ? "Access granted"
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

  return (
    <ExperienceShell
      experienceType={experience.type}
      label={label}
      title={title}
      summary={`${items.length} ${items.length === 1 ? "thing" : "things"} · ${experience.durationLabel}`}
      icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
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
      {canReveal ? (
        <div className="mt-4 space-y-3">
          <MorphyButton type="button" size="sm" disabled={revealState === "opening" || !isVaultUnlocked}
            onClick={() => void revealGrantedInformation()}>
            {revealState === "opening" ? "Opening…" : visibleValues ? "Refresh shared information" : "View shared information"}
          </MorphyButton>
          {revealState === "unavailable" ? <p role="alert" className="text-sm text-muted-foreground">Shared information could not be opened. Check your vault and try again.</p> : null}
          {visibleValues ? (
            <div className="max-h-[28rem] space-y-4 overflow-y-auto rounded-xl border border-border/60 p-4" data-testid="chat-shared-information">
              {visibleValues.map((value) => (
                <section key={value.requestId} className="space-y-2 border-b border-border/40 pb-4 last:border-0 last:pb-0">
                  <h4 className="text-sm font-semibold">{value.label}</h4>
                  <DecryptedRecordContent data={value.data} />
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
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
