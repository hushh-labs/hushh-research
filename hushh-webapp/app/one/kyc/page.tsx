"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  Clock3,
  Eye,
  FileText,
  Inbox,
  Loader2,
  MailPlus,
  PenLine,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import { AsyncActionStatus } from "@/components/system/async-action-status";
import { CapabilityExploreCard } from "@/components/onboarding/setup/capability-explore-card";
import { PkmSectionPreview } from "@/components/profile/pkm-section-preview";
import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import {
  isKycIdentityPrefaceComplete,
  KycIdentityProfileDraftService,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useAuth, useRequireAuth } from "@/hooks/use-auth";
import { isApplePrivateRelayEmail } from "@/lib/auth/private-relay";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import { useConsentActions, type PendingConsent } from "@/lib/consent";
import { ROUTES } from "@/lib/navigation/routes";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { cn } from "@/lib/utils";
import {
  hasApprovedKycWorkflowAccess,
  isKycClientDraftReady,
  needsKycWorkflowAccessApproval,
  removeKycWorkflowLocalState,
  retainReadyKycWorkflowLocalState,
  scopeCandidates,
  selectedScopeLabels,
  selectedScopesForWorkflow,
} from "@/lib/one-kyc/workflow-state";
import {
  AccountService,
  type AccountEmailAlias,
} from "@/lib/services/account-service";
import {
  buildPkmSectionPreviewPresentation,
  type PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
import { ApiError } from "@/lib/services/api-client";
import {
  ConsentCenterService,
  type PendingConsentLookupItem,
} from "@/lib/services/consent-center-service";
import {
  buildKycWorkflowArtifact,
  hashKycWorkflowArtifact,
  KYC_WORKFLOW_PKM_DOMAIN,
  KycWorkflowPkmService,
  type KycWorkflowCheck,
  type KycWorkflowCheckKey,
  type KycWorkflowSentReplySnapshot,
  type KycWorkflowStatus,
} from "@/lib/services/kyc-pkm-write-service";
import {
  effectiveOneKycRequiredFields,
  OneKycClientZkService,
  runFullRedraft,
  type KycDraftBuildResult,
} from "@/lib/services/one-kyc-client-zk-service";
import {
  OneKycService,
  type OneKycScopeCandidate,
  type OneKycWorkflow,
  type OneKycWorkflowStatus,
} from "@/lib/services/one-kyc-service";
import { loadEmailDraftingEnabled } from "@/lib/onboarding/email-drafting-preference";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { useVault } from "@/lib/vault/vault-context";
import {
  usePublishVoiceSurfaceMetadata,
  type VoiceSurfacePublisherRole,
} from "@/lib/voice/voice-surface-metadata";
import {
  BTN_OUTLINE,
  BTN_PRIMARY,
  SELECT_CIRCLE_BASE,
  SELECT_CIRCLE_OFF,
  SELECT_CIRCLE_ON,
} from "./tokens";

const STATUS_LABELS: Record<OneKycWorkflowStatus, string> = {
  needs_client_connector: "Needs vault setup",
  needs_scope: "Needs access",
  needs_documents: "Needs documents",
  needs_confirm: "Needs confirmation",
  drafting: "Drafting",
  waiting_on_user: "Needs review",
  waiting_on_counterparty: "Sent",
  completed: "Completed",
  blocked: "Blocked",
};

function statusVariant(
  status: OneKycWorkflowStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "blocked") return "destructive";
  if (
    status === "waiting_on_user" ||
    status === "needs_scope" ||
    status === "needs_confirm"
  )
    return "default";
  if (status === "completed" || status === "waiting_on_counterparty")
    return "secondary";
  return "outline";
}

function statusIcon(status: OneKycWorkflowStatus): LucideIcon {
  if (status === "blocked") return Ban;
  if (status === "completed" || status === "waiting_on_counterparty")
    return BadgeCheck;
  if (
    status === "needs_scope" ||
    status === "needs_client_connector" ||
    status === "needs_confirm"
  )
    return ShieldCheck;
  if (status === "waiting_on_user") return Send;
  return Clock3;
}

function workflowConsentRequestIds(workflow: OneKycWorkflow): string[] {
  const ids = new Set<string>();
  if (workflow.consent_request_id) ids.add(workflow.consent_request_id);
  for (const request of workflow.consent_requests || []) {
    if (request.request_id) ids.add(request.request_id);
  }
  return Array.from(ids);
}

/** Returns only the request IDs that still need approval (not yet granted). */
function workflowPendingConsentRequestIds(workflow: OneKycWorkflow): string[] {
  const ids = new Set<string>();
  for (const request of workflow.consent_requests || []) {
    if (request.request_id && request.status !== "granted") {
      ids.add(request.request_id);
    }
  }
  // Fallback: single-request workflows use the top-level consent_request_id and
  // may not carry a per-entry status; include it only if there is no per-entry list.
  if (
    ids.size === 0 &&
    (!workflow.consent_requests || workflow.consent_requests.length === 0) &&
    workflow.consent_request_id
  ) {
    ids.add(workflow.consent_request_id);
  }
  return Array.from(ids);
}

function workflowEffectiveRequiredFields(workflow: OneKycWorkflow): string[] {
  return effectiveOneKycRequiredFields({
    requiredFields: workflow.required_fields,
    scopes:
      workflow.selected_scopes ||
      workflow.requested_scopes ||
      (workflow.requested_scope ? [workflow.requested_scope] : []),
    fallbackScope: workflow.requested_scope,
  });
}

function consentEntryTimestamp(
  value: number | string | null | undefined,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) return dateMs;
  }
  return undefined;
}

function pendingLookupItemToPendingConsent(
  item: PendingConsentLookupItem,
): PendingConsent {
  const requestedAt = consentEntryTimestamp(item.issued_at) || Date.now();
  return {
    id: item.request_id,
    developer: item.requester_label || item.developer || item.agent_id || "One",
    developerImageUrl: item.requester_image_url || undefined,
    developerWebsiteUrl: item.requester_website_url || undefined,
    scope: item.scope,
    scopeDescription: item.scope_description || undefined,
    requestedAt,
    approvalTimeoutAt: consentEntryTimestamp(item.poll_timeout_at),
    requestUrl: item.request_url || undefined,
    reason: item.reason || undefined,
    bundleId: item.bundle_id || undefined,
    isScopeUpgrade: Boolean(item.is_scope_upgrade),
    existingGrantedScopes: item.existing_granted_scopes || undefined,
    additionalAccessSummary: item.additional_access_summary || undefined,
    metadata: item.metadata || undefined,
  };
}

function emailWorkflowBusyLabel(busy: string | null): string | null {
  if (!busy) return null;
  if (busy === "draft") return "Preparing draft...";
  if (busy === "refresh") return "Refreshing request state...";
  if (busy === "consent-approve") return "Approving access...";
  if (busy === "consent-deny") return "Denying access...";
  if (busy === "approve") return "Sending approved reply...";
  if (busy === "reject") return "Rejecting request...";
  if (busy === "redraft") return "Redrafting reply...";
  if (busy === "alias") return "Updating verified address...";
  if (busy === "confirm-proposal") return "Confirming proposal...";
  return "Working...";
}

function scopeCandidateDescription(candidate: OneKycScopeCandidate): string {
  const description = candidate.description || dataLabelForCandidate(candidate);
  const reason = candidate.reason || "Detected from this request.";
  if (!reason || reason === description) return description;
  return `${description} ${reason}`;
}

function dataLabelForCandidate(candidate: OneKycScopeCandidate): string {
  if (candidate.label?.trim()) return candidate.label.trim();
  const parsed = parseAttrScope(candidate.scope);
  if (parsed) {
    const pieces = [parsed.domain, parsed.topLevelScopePath]
      .filter(Boolean)
      .join(" ")
      .replaceAll("_", " ");
    return `${titleCase(pieces)} data`;
  }
  return "Selected information";
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shouldShowProposal(workflow: OneKycWorkflow): boolean {
  return (
    workflow.status === "needs_confirm" &&
    Boolean(workflow.metadata?.kyc_proposal)
  );
}

function shouldSyncWorkflowOnLoad(workflow: OneKycWorkflow): boolean {
  if (
    workflow.status === "needs_scope" ||
    workflow.status === "needs_documents"
  ) {
    return (
      workflowConsentRequestIds(workflow).length > 0 ||
      scopeCandidates(workflow).length > 0
    );
  }
  return (
    workflow.status === "waiting_on_user" && workflow.draft_status === "ready"
  );
}

function isSentWorkflow(workflow: OneKycWorkflow): boolean {
  return (
    workflow.status === "waiting_on_counterparty" ||
    workflow.draft_status === "sent" ||
    workflow.send_status === "sent"
  );
}

function shouldShowDataSelection(workflow: OneKycWorkflow): boolean {
  if (isSentWorkflow(workflow)) return false;
  return [
    "needs_scope",
    "waiting_on_user",
    "needs_documents",
    "blocked",
  ].includes(workflow.status);
}

function mergeWorkflows(
  baseWorkflows: OneKycWorkflow[],
  updates: OneKycWorkflow[],
): OneKycWorkflow[] {
  if (!updates.length) return baseWorkflows;
  const byId = new Map(
    updates.map((workflow) => [workflow.workflow_id, workflow]),
  );
  const merged = baseWorkflows.map(
    (workflow) => byId.get(workflow.workflow_id) || workflow,
  );
  for (const update of updates) {
    if (
      !baseWorkflows.some(
        (workflow) => workflow.workflow_id === update.workflow_id,
      )
    ) {
      merged.unshift(update);
    }
  }
  return merged;
}

export default function OneKycPage({
  onSetupReadinessChange,
  voicePublisherRole = "route",
}: {
  onSetupReadinessChange?: (ready: boolean) => void;
  voicePublisherRole?: VoiceSurfacePublisherRole;
} = {}) {
  const auth = useAuth();

  return (
    <>
      <NativeTestBeacon
        routeId={ROUTES.ONE_KYC}
        marker="native-route-one-kyc"
        authState={
          auth.user ? "authenticated" : auth.loading ? "pending" : "public"
        }
        dataState={auth.user ? "loaded" : "loading"}
      />
      <VaultLockGuard>
        <CapabilityVaultPrerequisite
          capabilityLabel="KYC"
          routeKey={ROUTES.ONE_KYC}
        >
          <OneKycWorkspace
            onSetupReadinessChange={onSetupReadinessChange}
            voicePublisherRole={voicePublisherRole}
          />
        </CapabilityVaultPrerequisite>
      </VaultLockGuard>
    </>
  );
}

export function OneKycWorkspace({
  onSetupReadinessChange,
  voicePublisherRole = "route",
}: {
  onSetupReadinessChange?: (ready: boolean) => void;
  voicePublisherRole?: VoiceSurfacePublisherRole;
}) {
  const auth = useRequireAuth();
  const isPrivateRelay = isApplePrivateRelayEmail(auth.user?.email);
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [identityPrefaceComplete, setIdentityPrefaceComplete] = useState(false);
  const [checkingIdentity, setCheckingIdentity] = useState(true);

  useEffect(() => {
    if (!auth.user?.uid) {
      setCheckingIdentity(false);
      return;
    }
    if (!vaultKey || !vaultOwnerToken) {
      setCheckingIdentity(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await PkmDomainResourceService.getStaleFirst({
          userId: auth.user?.uid || "",
          domain: "identity",
          vaultKey,
          vaultOwnerToken,
        });
        const profile = snapshot?.data?.identity_profile as any;
        if (!cancelled && isKycIdentityPrefaceComplete(profile)) {
          setIdentityPrefaceComplete(true);
        }
      } catch (err) {
        console.warn(
          "[OneKycWorkspace] Failed to load existing identity profile:",
          err,
        );
        // A coherent snapshot failure is not evidence that KYC is incomplete.
        // Do not trap a completed owner in onboarding while recovery runs.
        if (!cancelled) setIdentityPrefaceComplete(true);
      } finally {
        if (!cancelled) {
          setCheckingIdentity(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [auth.user, vaultKey, vaultOwnerToken]);
  const { handleApprove, handleApproveBundle, handleDeny, handleDenyBundle } =
    useConsentActions({ userId: auth.userId });
  const [workflows, setWorkflows] = useState<OneKycWorkflow[]>([]);
  const workflowsRef = useRef<OneKycWorkflow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreWorkflows, setHasMoreWorkflows] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [aliasPanelOpen, setAliasPanelOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<OneKycWorkflow | null>(
    null,
  );
  const [archivingWorkflowId, setArchivingWorkflowId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [redraftInstructions, setRedraftInstructions] = useState("");
  const [localDrafts, setLocalDrafts] = useState<
    Record<string, KycDraftBuildResult>
  >({});
  const [sentReplySnapshots, setSentReplySnapshots] = useState<
    Record<string, KycWorkflowSentReplySnapshot>
  >({});
  // Memory-only cache of exact approved decrypted exports. Redraft reuses this
  // context so it can revise intelligently without another decrypt or any PKM read.
  const [localExportPayloads, setLocalExportPayloads] = useState<
    Record<
      string,
      Array<{
        scope?: string | null;
        exportRevision?: number;
        payload: Record<string, unknown>;
      }>
    >
  >({});
  const [draftRecoveryAttempts, setDraftRecoveryAttempts] = useState<
    Record<string, string>
  >({});
  const [draftFailedAttemptKeys, setDraftFailedAttemptKeys] = useState<
    Record<string, string>
  >({});
  const [selectedScopesByWorkflow, setSelectedScopesByWorkflow] = useState<
    Record<string, string[]>
  >({});
  const [autoSyncedNeedsScopeIds, setAutoSyncedNeedsScopeIds] = useState<
    Record<string, true>
  >({});
  const [confirmSelection, setConfirmSelection] = useState<string[]>([]);
  const [connectorReady, setConnectorReady] = useState(false);
  const [
    automaticResponsePreparationEnabled,
    setAutomaticResponsePreparationEnabled,
  ] = useState<boolean | null>(null);
  const [emailAliases, setEmailAliases] = useState<AccountEmailAlias[]>([]);
  const [aliasEmail, setAliasEmail] = useState("");
  const [aliasCode, setAliasCode] = useState("");
  const [aliasChallenge, setAliasChallenge] = useState<{
    email: string;
    reviewCode?: string | null;
  } | null>(null);
  const [scopePreview, setScopePreview] = useState<{
    open: boolean;
    title: string;
    description: string;
    loading: boolean;
    error: string | null;
    presentation: PkmSectionPreviewPresentation | null;
  }>({
    open: false,
    title: "Shared information",
    description: "Review what this request can use.",
    loading: false,
    error: null,
    presentation: null,
  });

  useEffect(() => {
    workflowsRef.current = workflows;
  }, [workflows]);

  const selected = useMemo(
    () =>
      workflows.find((workflow) => workflow.workflow_id === selectedId) ||
      workflows[0] ||
      null,
    [selectedId, workflows],
  );
  const selectedDraft = selected
    ? localDrafts[selected.workflow_id] || null
    : null;
  const selectedSentReply = selected
    ? sentReplySnapshots[selected.workflow_id] || null
    : null;
  const selectedEffectiveRequiredFields = selected
    ? workflowEffectiveRequiredFields(selected)
    : [];
  const selectedIsSent = selected ? isSentWorkflow(selected) : false;
  const selectedNeedsAccessApproval = selected
    ? needsKycWorkflowAccessApproval(selected)
    : false;
  const selectedAccessApproved = selected
    ? hasApprovedKycWorkflowAccess(selected)
    : false;
  const selectedScopeSelection = selected
    ? selectedScopesForWorkflow(selected, selectedScopesByWorkflow)
    : [];
  const selectedScopeSelectionChanged = selected
    ? selectedScopeSelection.join("|") !==
      selectedScopesForWorkflow(selected, {}).join("|")
    : false;
  const selectedCanReviewDraft = Boolean(
    selected &&
    selected.status === "waiting_on_user" &&
    selected.draft_status === "ready" &&
    selectedDraft,
  );

  // Reset confirm-proposal selection when the selected workflow changes
  useEffect(() => {
    if (!selected || !shouldShowProposal(selected)) return;
    const proposal = selected.metadata?.kyc_proposal;
    const scopes = proposal?.requested_items?.map((item) => item.scope) ?? [];
    setConfirmSelection(scopes);
    // Intentionally depends only on identity/status change to avoid resetting mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.workflow_id, selected?.status]);

  const busyLabel = emailWorkflowBusyLabel(busy);
  const showInitialLoading = loading && workflows.length === 0;
  const listRefreshLabel =
    loading && workflows.length > 0 ? "Checking for new requests..." : null;
  const verifiedAliases = useMemo(
    () =>
      emailAliases.filter((alias) => alias.verification_status === "verified"),
    [emailAliases],
  );
  useEffect(() => {
    // Sending remains optional. A verified invocation identity and initialized
    // client connector are the operational boundary for first-run setup.
    onSetupReadinessChange?.(connectorReady && verifiedAliases.length > 0);
  }, [connectorReady, onSetupReadinessChange, verifiedAliases.length]);
  useEffect(() => {
    const userId = auth.userId;
    const user = auth.user;
    if (!userId || !user) {
      setAutomaticResponsePreparationEnabled(null);
      return;
    }
    let cancelled = false;
    void user
      .getIdToken()
      .then((idToken) => loadEmailDraftingEnabled({ userId, idToken }))
      .then((enabled) => {
        if (!cancelled) setAutomaticResponsePreparationEnabled(enabled);
      })
      .catch(() => {
        if (!cancelled) setAutomaticResponsePreparationEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.user, auth.userId]);
  const pendingAliases = useMemo(
    () =>
      emailAliases.filter((alias) => alias.verification_status === "pending"),
    [emailAliases],
  );
  const voiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "one_kyc",
      title: "KYC",
      purpose: "Approval-gated review of information requests.",
      sections: [
        {
          id: "one_kyc_inbox",
          title: "Requests",
        },
        {
          id: "one_kyc_detail",
          title: "Selected request",
        },
        {
          id: "one_kyc_aliases",
          title: "Verified addresses",
        },
      ],
      controls: [
        {
          id: "one-kyc-open",
          label: "Open KYC",
          type: "route",
          actionId: "route.one_kyc",
        },
        {
          id: "one-kyc-aliases",
          label: "Manage verified addresses",
          type: "button",
          actionId: "kyc.aliases.manage",
          state: aliasPanelOpen ? "open" : "closed",
        },
        {
          id: "one-kyc-sync-status",
          label: "Sync status",
          type: "button",
          actionId: "kyc.workflow.sync_status",
          state: selected ? selected.status : "empty",
        },
        {
          id: "one-kyc-approve-access",
          label: "Approve access",
          type: "button",
          actionId: "kyc.workflow.approve_access",
          state: selectedNeedsAccessApproval ? "available" : "disabled",
        },
        {
          id: "one-kyc-deny-access",
          label: "Deny access",
          type: "button",
          actionId: "kyc.workflow.deny_access",
          state: selected?.status === "needs_scope" ? "available" : "disabled",
        },
        {
          id: "one-kyc-draft-review",
          label: "Review draft",
          type: "region",
          actionId: "kyc.draft.review",
          state: selected
            ? localDrafts[selected.workflow_id]
              ? "available"
              : "empty"
            : "empty",
        },
        {
          id: "one-kyc-redraft",
          label: "Redraft",
          type: "button",
          actionId: "kyc.draft.request_redraft",
          state: selectedCanReviewDraft ? "available" : "disabled",
        },
        {
          id: "one-kyc-approve-send",
          label: "Approve send",
          type: "button",
          actionId: "kyc.draft.approve_send",
          state: selectedCanReviewDraft ? "available" : "disabled",
        },
        {
          id: "one-kyc-reject",
          label: "Reject draft",
          type: "button",
          actionId: "kyc.draft.reject",
          state:
            selected?.status === "waiting_on_user" ? "available" : "disabled",
        },
      ],
      visibleModules: ["workflow inbox", "workflow detail"],
      screenMetadata: {
        workflow_count: workflows.length,
        selected_workflow_status: selected?.status || null,
        vault_unlocked: Boolean(isVaultUnlocked && vaultKey && vaultOwnerToken),
        connector_ready: connectorReady,
        automatic_response_preparation_enabled:
          automaticResponsePreparationEnabled,
        loading,
      },
    }),
    [
      aliasPanelOpen,
      automaticResponsePreparationEnabled,
      connectorReady,
      isVaultUnlocked,
      loading,
      localDrafts,
      selected,
      selectedNeedsAccessApproval,
      selectedCanReviewDraft,
      vaultKey,
      vaultOwnerToken,
      workflows.length,
    ],
  );
  usePublishVoiceSurfaceMetadata(voiceSurfaceMetadata, {
    role: voicePublisherRole,
  });

  const clearLocalWorkflowState = useCallback((workflowId: string) => {
    setLocalDrafts((current) =>
      removeKycWorkflowLocalState(current, workflowId),
    );
    setLocalExportPayloads((current) =>
      removeKycWorkflowLocalState(current, workflowId),
    );
  }, []);

  const retainReadyLocalWorkflowState = useCallback(
    (nextWorkflows: OneKycWorkflow[]) => {
      setLocalDrafts((current) =>
        retainReadyKycWorkflowLocalState(current, nextWorkflows),
      );
      setLocalExportPayloads((current) =>
        retainReadyKycWorkflowLocalState(current, nextWorkflows),
      );
    },
    [],
  );

  const loadSentReplySnapshots = useCallback(async () => {
    if (!auth.userId || !vaultKey || !vaultOwnerToken) return;
    const data = await PersonalKnowledgeModelService.loadDomainData({
      userId: auth.userId,
      domain: KYC_WORKFLOW_PKM_DOMAIN,
      vaultKey,
      vaultOwnerToken,
    }).catch(() => null);
    const artifact = KycWorkflowPkmService.readWorkflowArtifact(data).artifact;
    setSentReplySnapshots(artifact?.sent_replies || {});
  }, [auth.userId, vaultKey, vaultOwnerToken]);

  const updateWorkflow = useCallback(
    (next: OneKycWorkflow) => {
      setWorkflows((current) => {
        const index = current.findIndex(
          (workflow) => workflow.workflow_id === next.workflow_id,
        );
        if (index === -1) return [next, ...current];
        const copy = [...current];
        copy[index] = next;
        return copy;
      });
      setSelectedId(next.workflow_id);
      if (!isKycClientDraftReady(next)) {
        clearLocalWorkflowState(next.workflow_id);
      }
    },
    [clearLocalWorkflowState],
  );

  const refreshWorkflowState = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (!auth.userId || !vaultOwnerToken) return workflow;
      const next = await OneKycService.refreshWorkflow({
        userId: auth.userId,
        vaultOwnerToken,
        workflowId: workflow.workflow_id,
      });
      updateWorkflow(next);
      return next;
    },
    [auth.userId, updateWorkflow, vaultOwnerToken],
  );

  const load = useCallback(
    async (options?: { syncMailbox?: boolean }) => {
      if (!auth.user || !auth.userId || !vaultKey || !vaultOwnerToken) return;
      const userId = auth.userId;
      const hadCachedWorkflows = workflowsRef.current.length > 0;
      setLoading(true);
      setError(null);
      try {
        await OneKycClientZkService.ensureConnector({
          userId,
          vaultKey,
          vaultOwnerToken,
        });
        setConnectorReady(true);
        if (options?.syncMailbox) {
          await OneKycService.syncRecentEmails({
            userId,
            vaultOwnerToken,
          }).catch((err) => {
            toast.error(
              err instanceof Error
                ? err.message
                : "One could not check recent requests.",
            );
          });
        }
        const response = await OneKycService.listWorkflows({
          userId,
          vaultOwnerToken,
          limit: 25,
        });
        const aliasResponse = await AccountService.listEmailAliases(
          vaultOwnerToken,
        ).catch(() => null);
        if (aliasResponse) {
          setEmailAliases(aliasResponse.aliases);
        }
        const syncCandidates = response.workflows
          .filter(shouldSyncWorkflowOnLoad)
          .slice(0, 10);
        const syncResults = syncCandidates.length
          ? await Promise.allSettled(
              syncCandidates.map((workflow) =>
                OneKycService.refreshWorkflow({
                  userId,
                  vaultOwnerToken,
                  workflowId: workflow.workflow_id,
                }),
              ),
            )
          : [];
        const syncedWorkflows = syncResults
          .filter(
            (result): result is PromiseFulfilledResult<OneKycWorkflow> =>
              result.status === "fulfilled",
          )
          .map((result) => result.value);
        const cachedWorkflows = workflowsRef.current;
        const listedWorkflows = cachedWorkflows.length
          ? mergeWorkflows(cachedWorkflows, response.workflows)
          : response.workflows;
        const nextWorkflows = mergeWorkflows(listedWorkflows, syncedWorkflows);
        setWorkflows(nextWorkflows);
        setNextCursor(response.next_cursor || null);
        setHasMoreWorkflows(Boolean(response.has_more && response.next_cursor));
        retainReadyLocalWorkflowState(nextWorkflows);
        await loadSentReplySnapshots();
        const initialId = new URLSearchParams(window.location.search).get(
          "workflowId",
        );
        setSelectedId(
          (current) =>
            current || initialId || nextWorkflows[0]?.workflow_id || null,
        );
      } catch (err) {
        setConnectorReady(false);
        const message =
          err instanceof Error ? err.message : "Unable to load requests.";
        if (hadCachedWorkflows) {
          toast.error(message);
        } else {
          setError(message);
        }
      } finally {
        setLoading(false);
      }
    },
    [
      auth.user,
      auth.userId,
      loadSentReplySnapshots,
      retainReadyLocalWorkflowState,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  const loadMore = useCallback(async () => {
    if (!auth.user || !auth.userId || !vaultOwnerToken || !nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await OneKycService.listWorkflows({
        userId: auth.userId,
        vaultOwnerToken,
        limit: 25,
        cursor: nextCursor,
      });
      setWorkflows((current) => mergeWorkflows(current, response.workflows));
      setNextCursor(response.next_cursor || null);
      setHasMoreWorkflows(Boolean(response.has_more && response.next_cursor));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load more requests.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [auth.user, auth.userId, nextCursor, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    async function prepareClientDraft() {
      if (automaticResponsePreparationEnabled !== true) return;
      if (!auth.userId || !vaultKey || !vaultOwnerToken || !selected) return;
      const userId = auth.userId;
      if (
        selected.status !== "waiting_on_user" ||
        selected.draft_status !== "ready"
      )
        return;
      if (localDrafts[selected.workflow_id]) return;
      const attemptKey = workflowDraftAttemptKey(selected);
      if (draftFailedAttemptKeys[selected.workflow_id] === attemptKey) return;
      try {
        setBusy((current) => current || "draft");
        const connector = await OneKycClientZkService.ensureConnector({
          userId,
          vaultKey,
          vaultOwnerToken,
        });
        const exportResponse = await OneKycService.getWorkflowConsentExports({
          userId,
          vaultOwnerToken,
          workflowId: selected.workflow_id,
        });
        const exportPayloads = await Promise.all(
          exportResponse.exports.map(async (exportPackage) => ({
            scope: exportPackage.scope,
            exportRevision: exportPackage.export_revision,
            payload: await OneKycClientZkService.decryptScopedExport({
              exportPackage,
              connector,
            }),
          })),
        );
        // Private KYC draft context is exclusively sourced from exact approved
        // encrypted exports. Public-profile resources never authorize PKM reads.
        const draftPayloads = exportPayloads;
        // Deterministic draft — used as-is or as fallback if LLM Pass 2 fails.
        let draft = await OneKycClientZkService.buildDraft({
          workflow: selected,
          exportPayloads: draftPayloads,
        });
        // Pass 2: send the decrypted approved domain data to the LLM endpoint and
        // replace the draft with the LLM-composed version. On any error, log a
        // non-fatal message and leave the deterministic draft intact so the user
        // still gets a valid draft to approve.
        try {
          const decryptedDomains = exportPayloads.map((ep) => ({
            domain:
              String(ep.scope ?? "identity")
                .replace(/^attr\./, "")
                .replace(/\.\*$/, "")
                .split(".")[0] ?? "identity",
            scope: ep.scope ?? null,
            data: ep.payload,
          }));
          const approvedScopes =
            selected.selected_scopes ??
            selected.requested_scopes ??
            (selected.requested_scope ? [selected.requested_scope] : []);
          const requestText = [selected.subject, selected.snippet]
            .filter(Boolean)
            .join("\n\n");
          draft = await OneKycClientZkService.buildDraftViaLlm({
            workflow: selected,
            input: { userId, vaultOwnerToken },
            decryptedDomains,
            approvedScopes,
            requestText,
          });
        } catch (llmErr) {
          if (!cancelled) {
            setError(
              oneKycErrorMessage(
                llmErr,
                "LLM draft unavailable; using deterministic draft.",
              ),
            );
          }
        }
        if (!cancelled) {
          setLocalDrafts((current) => ({
            ...current,
            [selected.workflow_id]: draft,
          }));
          setLocalExportPayloads((current) => ({
            ...current,
            [selected.workflow_id]: draftPayloads,
          }));
          setDraftRecoveryAttempts((current) =>
            removeKycWorkflowLocalState(current, selected.workflow_id),
          );
          setDraftFailedAttemptKeys((current) =>
            removeKycWorkflowLocalState(current, selected.workflow_id),
          );
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && !cancelled) {
          clearLocalWorkflowState(selected.workflow_id);
          if (draftRecoveryAttempts[selected.workflow_id] !== attemptKey) {
            setDraftRecoveryAttempts((current) => ({
              ...current,
              [selected.workflow_id]: attemptKey,
            }));
            await refreshWorkflowState(selected).catch(() => undefined);
            return;
          }
          setDraftFailedAttemptKeys((current) => ({
            ...current,
            [selected.workflow_id]: attemptKey,
          }));
          setError(
            "One could not prepare this draft yet. Sync this request once after access finishes refreshing.",
          );
          return;
        }
        if (!cancelled) {
          setError(
            oneKycErrorMessage(err, "Unable to prepare the response draft."),
          );
        }
      } finally {
        if (!cancelled) {
          setBusy((current) => (current === "draft" ? null : current));
        }
      }
    }

    void prepareClientDraft();

    return () => {
      cancelled = true;
      // Clear the background draft-prep flag when this run is superseded or
      // unmounted. The in-flight run's `finally` skips the reset while
      // `cancelled`, and a follow-up run can early-return before the `try`
      // (e.g. the failed-attempt/recovery guards on a 409), which would leave
      // `busy` stuck at "draft" and disable every action button. Only "draft"
      // is cleared, so a concurrent user action's busy state is never touched;
      // the next run re-sets it if it actually starts preparing.
      setBusy((current) => (current === "draft" ? null : current));
    };
  }, [
    auth.userId,
    automaticResponsePreparationEnabled,
    clearLocalWorkflowState,
    draftFailedAttemptKeys,
    draftRecoveryAttempts,
    localDrafts,
    refreshWorkflowState,
    selected,
    selectedScopesByWorkflow,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!detailOpen || !selected || busy) return;
    const canRefreshAccessState =
      selected.status === "needs_scope" ||
      (selected.status === "blocked" &&
        selected.last_error_code === "consent_not_granted");
    if (!canRefreshAccessState) return;
    if (autoSyncedNeedsScopeIds[selected.workflow_id]) return;
    setAutoSyncedNeedsScopeIds((current) => ({
      ...current,
      [selected.workflow_id]: true,
    }));
    setBusy("refresh");
    void refreshWorkflowState(selected)
      .then((next) => {
        if (
          next.status === "waiting_on_user" &&
          next.draft_status === "ready"
        ) {
          toast.success("Access is approved. Preparing draft.");
        }
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy((current) => (current === "refresh" ? null : current));
      });
  }, [
    autoSyncedNeedsScopeIds,
    busy,
    detailOpen,
    refreshWorkflowState,
    selected,
  ]);

  const refreshAliases = useCallback(async () => {
    if (!vaultOwnerToken) return;
    const response = await AccountService.listEmailAliases(vaultOwnerToken);
    setEmailAliases(response.aliases);
  }, [vaultOwnerToken]);

  const startAliasVerification = useCallback(async () => {
    if (!vaultOwnerToken || !aliasEmail.trim()) return;
    setBusy("alias");
    setError(null);
    try {
      const response = await AccountService.startEmailAliasVerification(
        vaultOwnerToken,
        aliasEmail.trim(),
      );
      await refreshAliases().catch(() => undefined);
      setAliasChallenge({
        email: response.alias.email_normalized,
        reviewCode: response.review_verification_code,
      });
      if (response.review_verification_code) {
        setAliasCode(response.review_verification_code);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Email alias verification failed.",
      );
    } finally {
      setBusy(null);
    }
  }, [aliasEmail, refreshAliases, vaultOwnerToken]);

  const confirmAliasVerification = useCallback(async () => {
    if (!vaultOwnerToken || !aliasChallenge?.email || !aliasCode.trim()) return;
    setBusy("alias");
    setError(null);
    try {
      await AccountService.confirmEmailAliasVerification(
        vaultOwnerToken,
        aliasChallenge.email,
        aliasCode.trim(),
      );
      await refreshAliases();
      setAliasEmail("");
      setAliasCode("");
      setAliasChallenge(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Email alias confirmation failed.",
      );
    } finally {
      setBusy(null);
    }
  }, [aliasChallenge?.email, aliasCode, refreshAliases, vaultOwnerToken]);

  const runAction = useCallback(
    async (
      action: "refresh" | "approve" | "reject" | "redraft",
      workflow: OneKycWorkflow,
    ) => {
      if (!auth.user || !auth.userId || !vaultKey || !vaultOwnerToken) return;
      if (action === "redraft" && !redraftInstructions.trim()) {
        setError(
          "Add redraft instructions before asking One to revise this draft.",
        );
        return;
      }
      const localDraft = localDrafts[workflow.workflow_id];
      if (action === "approve" && !localDraft) {
        setError("Prepare the response draft before approving send.");
        return;
      }
      setBusy(action);
      setError(null);
      try {
        const input = {
          userId: auth.userId,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
        };
        if (action === "redraft") {
          if (!localDraft) {
            setError("Prepare the response draft before revising it.");
            return;
          }
          try {
            const result = await runFullRedraft({
              localDraft,
              instruction: redraftInstructions.trim(),
              workflow,
              exportPayloads: localExportPayloads[workflow.workflow_id] ?? [],
              input,
            });
            if (!result.ok) {
              setError("Redraft failed — please try again.");
              return;
            }
            setLocalDrafts((current) => ({
              ...current,
              [workflow.workflow_id]: result.draft,
            }));
            setRedraftInstructions("");
            toast.success("Draft revised.");
          } catch (err) {
            setError(
              oneKycErrorMessage(err, "Redraft failed — please try again."),
            );
          }
          return;
        }

        let next: OneKycWorkflow;
        if (action === "approve") {
          if (!localDraft) {
            setError("Prepare the response draft before approving send.");
            return;
          }
          const checks = {
            identity: {
              status:
                localDraft.missingFields.length === 0 ? "verified" : "pending",
              updated_at: new Date().toISOString(),
              method: "one_email_kyc_consent_export",
              source_domain: "identity",
            },
            address: emptyKycCheck(),
            bank: emptyKycCheck(),
            email: emptyKycCheck(),
          } satisfies Record<KycWorkflowCheckKey, KycWorkflowCheck>;
          const overallStatus: KycWorkflowStatus =
            localDraft.missingFields.length === 0 ? "verified" : "pending";
          const sentReplySnapshot = buildSentReplySnapshot(
            workflow,
            localDraft,
          );
          const artifact = buildKycWorkflowArtifact({
            checks,
            overall_status: overallStatus,
            counterparty:
              workflow.counterparty_label || workflow.sender_email || null,
            request_summary: workflow.subject || null,
            pending_requirements: localDraft.missingFields,
            completed_requirements: workflow.required_fields.filter(
              (field) =>
                workflowEffectiveRequiredFields(workflow).includes(field) &&
                !localDraft.missingFields.includes(field),
            ),
            sent_replies: {
              [workflow.workflow_id]: sentReplySnapshot,
            },
          });
          const artifactHash = await hashKycWorkflowArtifact(artifact);
          next = await OneKycService.sendApprovedReply({
            ...input,
            approvedSubject: localDraft.subject || workflow.draft_subject,
            approvedBody: localDraft.body,
            approvedHtml: localDraft.htmlBody,
            clientDraftHash: localDraft.draftHash,
            consentExportRevision:
              Array.isArray(workflow.consent_exports) &&
              workflow.consent_exports.length > 1
                ? null
                : typeof workflow.consent_export?.export_revision === "number"
                  ? workflow.consent_export.export_revision
                  : typeof workflow.metadata?.consent_export === "object" &&
                      workflow.metadata.consent_export !== null &&
                      typeof (
                        workflow.metadata.consent_export as Record<
                          string,
                          unknown
                        >
                      ).export_revision === "number"
                    ? ((
                        workflow.metadata.consent_export as Record<
                          string,
                          unknown
                        >
                      ).export_revision as number)
                    : null,
            pkmWritebackArtifactHash: artifactHash,
          });

          let writeback;
          try {
            writeback = await KycWorkflowPkmService.writeWorkflowArtifact({
              userId: auth.userId,
              vaultKey,
              vaultOwnerToken,
              artifact,
            });
          } catch (writebackError) {
            const message = errorMessage(writebackError);
            next = await OneKycService.writebackComplete({
              ...input,
              artifactHash,
              status: "failed",
              errorMessage: message,
            }).catch(() => next);
            updateWorkflow(next);
            clearLocalWorkflowState(workflow.workflow_id);
            setError(
              `Approved reply sent, but encrypted PKM writeback failed: ${message}`,
            );
            return;
          }

          next = await OneKycService.writebackComplete({
            ...input,
            artifactHash,
            status: writeback.success ? "succeeded" : "failed",
            errorMessage: writeback.success
              ? null
              : writeback.message || "PKM writeback failed.",
          });
          setSentReplySnapshots((current) => ({
            ...current,
            [workflow.workflow_id]: sentReplySnapshot,
          }));
          if (!writeback.success) {
            updateWorkflow(next);
            clearLocalWorkflowState(workflow.workflow_id);
            setError(
              `Approved reply sent, but encrypted PKM writeback failed: ${
                writeback.message || "PKM writeback failed."
              }`,
            );
            return;
          }
        } else if (action === "reject") {
          next = await OneKycService.rejectDraft({
            ...input,
            reason: "Rejected from KYC.",
          });
        } else {
          next = await refreshWorkflowState(workflow);
        }
        updateWorkflow(next);
      } catch (err) {
        setError(oneKycErrorMessage(err, "KYC action failed."));
      } finally {
        setBusy(null);
      }
    },
    [
      auth.user,
      auth.userId,
      clearLocalWorkflowState,
      localDrafts,
      localExportPayloads,
      redraftInstructions,
      refreshWorkflowState,
      updateWorkflow,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  const handleAgentRedraft = useCallback(
    async (slots: Record<string, unknown>) => {
      const instruction =
        typeof slots.instruction === "string" ? slots.instruction.trim() : "";
      if (!instruction || instruction.length > 1000) {
        return {
          status: "blocked" as const,
          summary: "Add a redraft instruction between 1 and 1000 characters.",
        };
      }
      if (
        !selected ||
        !selectedCanReviewDraft ||
        !auth.userId ||
        !vaultKey ||
        !vaultOwnerToken
      ) {
        return {
          status: "blocked" as const,
          summary: "A reviewable draft and an unlocked vault are required.",
        };
      }
      const localDraft = localDrafts[selected.workflow_id];
      const exportPayloads = localExportPayloads[selected.workflow_id] ?? [];
      if (!localDraft || exportPayloads.length === 0) {
        return {
          status: "blocked" as const,
          summary: "The approved draft information is not mounted for redraft.",
        };
      }
      setBusy("redraft");
      setError(null);
      try {
        const result = await runFullRedraft({
          localDraft,
          instruction,
          workflow: selected,
          exportPayloads,
          input: {
            userId: auth.userId,
            vaultOwnerToken,
            workflowId: selected.workflow_id,
          },
        });
        if (!result.ok) {
          return {
            status: "failed" as const,
            summary: "Redraft failed. Try again.",
          };
        }
        setLocalDrafts((current) => ({
          ...current,
          [selected.workflow_id]: result.draft,
        }));
        setRedraftInstructions("");
        toast.success("Draft revised.");
        return {
          status: "succeeded" as const,
          summary: "The current response draft was revised for review.",
        };
      } catch (err) {
        const message = oneKycErrorMessage(err, "Redraft failed. Try again.");
        setError(message);
        return { status: "failed" as const, summary: message };
      } finally {
        setBusy(null);
      }
    },
    [
      auth.userId,
      localDrafts,
      localExportPayloads,
      selected,
      selectedCanReviewDraft,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  useLocalOnboardingActionHandler(
    "kyc.draft.request_redraft",
    handleAgentRedraft,
    {
      enabled: Boolean(
        selectedCanReviewDraft &&
        selected &&
        localDrafts[selected.workflow_id] &&
        (localExportPayloads[selected.workflow_id]?.length ?? 0) > 0 &&
        auth.userId &&
        vaultKey &&
        vaultOwnerToken,
      ),
    },
  );

  const ensureConsentRequestsForWorkflow = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (workflowConsentRequestIds(workflow).length > 0) return workflow;
      if (!auth.userId || !vaultOwnerToken) {
        throw new Error("Vault owner token required.");
      }
      const selectedScopes = selectedScopesForWorkflow(
        workflow,
        selectedScopesByWorkflow,
      );
      if (!selectedScopes.length) {
        throw new Error(
          "Choose at least one information type before approving access.",
        );
      }
      const next = await OneKycService.selectScopes({
        userId: auth.userId,
        vaultOwnerToken,
        workflowId: workflow.workflow_id,
        selectedScopes,
      });
      updateWorkflow(next);
      return next;
    },
    [auth.userId, selectedScopesByWorkflow, updateWorkflow, vaultOwnerToken],
  );

  const loadPendingConsentsForWorkflow = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (!auth.userId || !vaultOwnerToken) {
        throw new Error("Sign in again to approve access.");
      }
      // Use only PENDING request IDs — already-granted ones are satisfied and
      // will not appear in the pending-requests lookup, which would produce a
      // false "missing" error for MIXED consent bundles.
      const requestIds = workflowPendingConsentRequestIds(workflow);
      if (requestIds.length === 0) {
        // All consent requests are already granted; nothing left to approve.
        return [];
      }
      const lookup = await ConsentCenterService.lookupPendingRequests({
        vaultOwnerToken,
        userId: auth.userId,
        requestIds,
      });
      if (lookup.missing_request_ids.length > 0) {
        throw new Error(
          "One could not find the linked access request. Sync this request once so access can refresh.",
        );
      }
      return lookup.items.map(pendingLookupItemToPendingConsent);
    },
    [auth.userId, vaultOwnerToken],
  );

  const approveWorkflowConsent = useCallback(
    async (workflow: OneKycWorkflow) => {
      setBusy("consent-approve");
      setError(null);
      try {
        const withRequests = await ensureConsentRequestsForWorkflow(workflow);
        if (
          withRequests.status === "waiting_on_user" &&
          withRequests.draft_status === "ready"
        ) {
          toast.success("Access already approved. Preparing draft.");
          return;
        }
        const consents = await loadPendingConsentsForWorkflow(withRequests);
        if (consents.length === 0) {
          // All consent requests were already granted; refresh so the backend
          // advances the workflow to draft without re-approving.
          await refreshWorkflowState(withRequests);
          toast.success("Access already approved. Preparing draft.");
          return;
        } else if (consents.length === 1) {
          const consent = consents[0];
          if (!consent) {
            throw new Error("No access request is ready for this request yet.");
          }
          const promise = handleApprove(consent, { quiet: true });
          toast.promise(promise, {
            id: consent.id,
            loading: "Approving access...",
            success: "Access approved",
            error: (err) => err.message || "Unable to approve access",
            duration: 3000,
          });
          await promise;
        } else {
          await handleApproveBundle(consents, {
            bundleId: withRequests.consent_bundle_id || undefined,
            bundleLabel: "One access request",
          });
        }
        const refreshed = await refreshWorkflowState(withRequests);
        if (refreshed.status === "waiting_on_user") {
          toast.success("Access approved. Preparing draft.");
        } else if (refreshed.status === "needs_documents") {
          toast.info(
            "Access approved. More information is needed before One can draft.",
          );
        }
      } catch (err) {
        setError(oneKycErrorMessage(err, "Unable to approve access."));
      } finally {
        setBusy(null);
      }
    },
    [
      ensureConsentRequestsForWorkflow,
      handleApprove,
      handleApproveBundle,
      loadPendingConsentsForWorkflow,
      refreshWorkflowState,
    ],
  );

  const denyWorkflowConsent = useCallback(
    async (workflow: OneKycWorkflow) => {
      setBusy("consent-deny");
      setError(null);
      try {
        const withRequests = await ensureConsentRequestsForWorkflow(workflow);
        const requestIds = workflowConsentRequestIds(withRequests);
        if (requestIds.length === 1) {
          const requestId = requestIds[0];
          if (!requestId) {
            throw new Error("No access request is ready for this request yet.");
          }
          const promise = handleDeny(requestId, { quiet: true });
          toast.promise(promise, {
            id: requestId,
            loading: "Denying access...",
            success: "Access denied",
            error: (err) => err.message || "Unable to deny access",
            duration: 3000,
          });
          await promise;
        } else {
          await handleDenyBundle(requestIds, {
            bundleId: withRequests.consent_bundle_id || undefined,
            bundleLabel: "One access request",
          });
        }
        await refreshWorkflowState(withRequests);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to deny access.");
      } finally {
        setBusy(null);
      }
    },
    [
      ensureConsentRequestsForWorkflow,
      handleDeny,
      handleDenyBundle,
      refreshWorkflowState,
    ],
  );

  const applyScopeSelection = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (!auth.userId || !vaultOwnerToken) return;
      const selectedScopes = selectedScopesForWorkflow(
        workflow,
        selectedScopesByWorkflow,
      );
      if (!selectedScopes.length) {
        setError("Choose the information One should use for this reply.");
        return;
      }
      setBusy("refresh");
      setError(null);
      try {
        const selectedWorkflow = await OneKycService.selectScopes({
          userId: auth.userId,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
          selectedScopes,
        });
        updateWorkflow(selectedWorkflow);
        const refreshed = await refreshWorkflowState(selectedWorkflow);
        if (refreshed.status === "waiting_on_user") {
          toast.success("Information updated. Preparing draft.");
        } else if (refreshed.status === "needs_scope") {
          toast.info(
            "Information updated. Approve access to prepare the draft.",
          );
        }
      } catch (err) {
        setError(
          oneKycErrorMessage(err, "Unable to update selected information."),
        );
      } finally {
        setBusy(null);
      }
    },
    [
      auth.userId,
      refreshWorkflowState,
      selectedScopesByWorkflow,
      updateWorkflow,
      vaultOwnerToken,
    ],
  );

  const archiveWorkflow = useCallback(async () => {
    const workflow = archiveTarget;
    if (!auth.userId || !vaultOwnerToken) return;
    if (!workflow || archivingWorkflowId) return;
    const workflowId = workflow.workflow_id;
    setArchivingWorkflowId(workflowId);
    try {
      await OneKycService.archiveWorkflow({
        userId: auth.userId,
        vaultOwnerToken,
        workflowId,
      });
      setWorkflows((current) =>
        current.filter((item) => item.workflow_id !== workflowId),
      );
      clearLocalWorkflowState(workflowId);
      setSentReplySnapshots((current) =>
        removeKycWorkflowLocalState(current, workflowId),
      );
      setSelectedId((current) => (current === workflowId ? null : current));
      if (selectedId === workflowId) setDetailOpen(false);
      setArchiveTarget(null);
      toast.success("Request removed.");
    } catch (err) {
      toast.error(oneKycErrorMessage(err, "Unable to remove this request."));
    } finally {
      setArchivingWorkflowId(null);
    }
  }, [
    archiveTarget,
    archivingWorkflowId,
    auth.userId,
    clearLocalWorkflowState,
    selectedId,
    vaultOwnerToken,
  ]);

  const previewScopeCandidate = useCallback(
    async (candidate: {
      scope: string;
      domain: string;
      label?: string;
      description?: string;
    }) => {
      if (!auth.userId || !vaultKey || !vaultOwnerToken) {
        setError("Unlock your vault to preview saved information.");
        return;
      }
      const parsed = parseAttrScope(candidate.scope);
      if (!parsed) {
        setError("This information section could not be previewed.");
        return;
      }
      const title = dataLabelForCandidate(candidate);
      const description =
        candidate.description ||
        "Saved values that One can use after access is approved.";
      setScopePreview({
        open: true,
        title,
        description,
        loading: true,
        error: null,
        presentation: null,
      });
      try {
        const data = await PersonalKnowledgeModelService.loadDomainData({
          userId: auth.userId,
          domain: parsed.domain,
          vaultKey,
          vaultOwnerToken,
          segmentIds: parsed.topLevelScopePath
            ? [parsed.topLevelScopePath]
            : undefined,
        });
        setScopePreview({
          open: true,
          title,
          description,
          loading: false,
          error: null,
          presentation: buildPkmSectionPreviewPresentation({
            domain: parsed.domain,
            domainTitle: candidate.domain || parsed.domain,
            permissionLabel: title,
            permissionDescription: description,
            topLevelScopePath: parsed.topLevelScopePath || parsed.domain,
            value: data,
          }),
        });
      } catch (previewError) {
        setScopePreview({
          open: true,
          title,
          description,
          loading: false,
          error:
            previewError instanceof Error
              ? previewError.message
              : "Could not load saved information for this section.",
          presentation: null,
        });
      }
    },
    [auth.userId, vaultKey, vaultOwnerToken],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleConsentMutation = () => {
      if (busy) return;
      if (!selected || selected.status !== "needs_scope") return;
      if (workflowConsentRequestIds(selected).length === 0) return;
      void refreshWorkflowState(selected).then((next) => {
        if (next.status === "waiting_on_user") {
          toast.success("Access approved. Preparing draft.");
        }
      });
    };
    window.addEventListener(
      CONSENT_ACTION_COMPLETE_EVENT,
      handleConsentMutation,
    );
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleConsentMutation);
    return () => {
      window.removeEventListener(
        CONSENT_ACTION_COMPLETE_EVENT,
        handleConsentMutation,
      );
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        handleConsentMutation,
      );
    };
  }, [busy, refreshWorkflowState, selected]);

  const toggleScope = useCallback((workflow: OneKycWorkflow, scope: string) => {
    setSelectedScopesByWorkflow((current) => {
      const selectedScopes = selectedScopesForWorkflow(workflow, current);
      const nextScopes = selectedScopes.includes(scope)
        ? selectedScopes.filter((item) => item !== scope)
        : [...selectedScopes, scope];
      return { ...current, [workflow.workflow_id]: nextScopes };
    });
  }, []);

  const toggleConfirmScope = useCallback((scope: string) => {
    setConfirmSelection((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }, []);

  const confirmProposal = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (!auth.userId || !vaultOwnerToken) return;
      setBusy("confirm-proposal");
      setError(null);
      try {
        const next = await OneKycService.confirmProposal({
          userId: auth.userId,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
          approvedScopes: confirmSelection,
        });
        updateWorkflow(next);
      } catch (err) {
        setError(oneKycErrorMessage(err, "Unable to confirm proposal."));
      } finally {
        setBusy(null);
      }
    },
    [auth.userId, confirmSelection, updateWorkflow, vaultOwnerToken],
  );

  if (checkingIdentity) {
    return (
      <AppPageShell
        as="main"
        width="reading"
        className="flex min-h-0 flex-1 flex-col pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      >
        <AppPageContentRegion>
          <div className="flex h-[50vh] flex-col items-center justify-center space-y-4">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  if (!identityPrefaceComplete) {
    return (
      <div className="flex-1 w-full h-full min-h-[70vh]">
        <KycIdentityPreface
          onComplete={() => setIdentityPrefaceComplete(true)}
        />
      </div>
    );
  }

  return (
    <AppPageShell
      width="content"
      className="space-y-4 px-4 py-4 sm:px-6 sm:py-5 lg:px-8"
      nativeTest={{
        routeId: ROUTES.ONE_KYC,
        marker: "native-route-one-kyc",
        authState: auth.user ? "authenticated" : "pending",
        dataState: showInitialLoading ? "loading" : error ? "error" : "loaded",
      }}
    >
      <CapabilityExploreCard capabilityId="email" />
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One"
          title="KYC"
          description="Review and approve each request."
          icon={ShieldCheck}
          accent="neutral"
          actions={
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={cn(BTN_PRIMARY)}
                onClick={() => void load({ syncMailbox: true })}
                disabled={loading}
              >
                <RefreshCw
                  className={loading ? "size-4 animate-spin" : "size-4"}
                />
                Refresh
              </button>
            </div>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="w-full space-y-3">
        {error || busyLabel || listRefreshLabel ? (
          <div>
            {error ? (
              <div className="rounded-[var(--app-card-radius-standard)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : busyLabel ? (
              <AsyncActionStatus state="loading" label={busyLabel} compact />
            ) : listRefreshLabel ? (
              <AsyncActionStatus
                state="loading"
                label={listRefreshLabel}
                compact
              />
            ) : null}
          </div>
        ) : null}

        <div className="w-full">
          {(!vaultKey || !vaultOwnerToken) ? (
            <SettingsGroup title="Vault required" description="Set up your vault to use KYC.">
              <SettingsRow
                icon={AlertTriangle}
                title="Vault missing"
                description="Set up your vault first."
              />
            </SettingsGroup>
          ) : (
            <div className="min-w-0 space-y-4">
              <SettingsGroup title="Requests">
                {isPrivateRelay ? (
                  <SettingsRow
                    icon={AlertTriangle}
                    title="Unsupported Account"
                    description="Private Relay addresses are not supported."
                  />
                ) : showInitialLoading ? (
                  <SettingsRow
                    icon={Inbox}
                    title="Checking requests"
                    description="Looking for requests matched to your verified addresses."
                    trailing={
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    }
                    stackTrailingOnMobile
                  />
                ) : workflows.length === 0 ? (
                  <SettingsRow
                    icon={Inbox}
                    title="No matched requests"
                    description="Matched requests appear here."
                  />
                ) : (
                  workflows.map((workflow) => (
                    <SettingsRow
                      key={workflow.workflow_id}
                      icon={statusIcon(workflow.status)}
                      title={workflow.subject || "Information request"}
                      description={[
                        workflow.counterparty_label ||
                          workflow.sender_email ||
                          "Counterparty",
                        selectedScopeLabels(workflow).join(", ") ||
                          "Information pending",
                      ].join(" / ")}
                      trailing={
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant(workflow.status)}>
                            {STATUS_LABELS[workflow.status] || workflow.status}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label="Remove request"
                            // Removing a request only opens the confirm dialog and is
                            // its own action; it must not be blocked by a background
                            // draft-prep (busy === "draft"), or a stuck/looping draft
                            // prep would trap the user with no way to delete the
                            // workflow. Guard only against an in-flight archive.
                            disabled={Boolean(archivingWorkflowId)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setArchiveTarget(workflow);
                            }}
                          >
                            {archivingWorkflowId === workflow.workflow_id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </Button>
                        </div>
                      }
                      chevron
                      onClick={() => {
                        setSelectedId(workflow.workflow_id);
                        setDetailOpen(true);
                      }}
                      voiceControlId={`one-kyc-workflow-${workflow.workflow_id}`}
                    />
                  ))
                )}
              </SettingsGroup>
              {hasMoreWorkflows ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    className={cn(BTN_OUTLINE)}
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {loadingMore ? "Loading..." : "Load more"}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <SettingsDetailPanel
          open={detailOpen && Boolean(selected)}
          onOpenChange={setDetailOpen}
          title={selected?.subject || "Information request"}
          description={
            selected?.counterparty_label ||
            selected?.sender_email ||
            "Review the selected request."
          }
          desktopMaxWidthClassName="sm:!max-w-[960px]"
          desktopMaxWidth="min(960px, calc(100vw - 3rem))"
        >
          {!selected ? null : (
            <div className="space-y-4">
              <SettingsGroup embedded title="Information request">
                <SettingsRow
                  icon={statusIcon(selected.status)}
                  title="Status"
                  description={
                    STATUS_LABELS[selected.status] || selected.status
                  }
                  trailing={
                    <Badge variant={statusVariant(selected.status)}>
                      {STATUS_LABELS[selected.status]}
                    </Badge>
                  }
                />
                <SettingsRow
                  icon={BriefcaseBusiness}
                  title="From"
                  description={
                    selected.counterparty_label || selected.sender_email || "-"
                  }
                />
                <SettingsRow
                  icon={ShieldCheck}
                  title="Information"
                  description={
                    selectedScopeLabels(selected).join(", ") ||
                    "Information pending"
                  }
                />
                <SettingsRow
                  icon={Clock3}
                  title="Updated"
                  description={
                    selected.updated_at
                      ? new Date(selected.updated_at).toLocaleString()
                      : "-"
                  }
                />
              </SettingsGroup>

              <SettingsGroup embedded title="Information needed">
                <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                  {(selectedEffectiveRequiredFields.length
                    ? selectedEffectiveRequiredFields
                    : ["selected information"]
                  ).map((field) => (
                    <Badge key={field} variant="outline">
                      {field.replaceAll("_", " ")}
                    </Badge>
                  ))}
                </div>
              </SettingsGroup>

              {selected.status === "needs_client_connector" ? (
                <SettingsGroup embedded title="Vault connector">
                  <SettingsRow
                    icon={AlertTriangle}
                    title="Sync required"
                    description="Sync to prepare access."
                  />
                </SettingsGroup>
              ) : null}

              {shouldShowProposal(selected)
                ? (() => {
                    const proposal = selected.metadata?.kyc_proposal;
                    if (!proposal) return null;
                    return (
                      <SettingsGroup
                        embedded
                        title="What One will share"
                        description={proposal.reasoning}
                      >
                        {proposal.requested_items.map((item) => {
                          const checked = confirmSelection.includes(item.scope);
                          return (
                            <SettingsRow
                              key={item.scope}
                              icon={ShieldCheck}
                              title={item.label}
                              description={item.rationale}
                              trailing={
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={checked}
                                  aria-label={`Select ${item.label}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleConfirmScope(item.scope);
                                  }}
                                  className="flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-1"
                                >
                                  <span
                                    className={cn(
                                      SELECT_CIRCLE_BASE,
                                      checked
                                        ? SELECT_CIRCLE_ON
                                        : SELECT_CIRCLE_OFF,
                                    )}
                                  >
                                    {checked ? (
                                      <Check
                                        className="h-3.5 w-3.5"
                                        strokeWidth={3}
                                      />
                                    ) : null}
                                  </span>
                                </button>
                              }
                              onClick={() => toggleConfirmScope(item.scope)}
                              stackTrailingOnMobile
                            />
                          );
                        })}
                        <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                          <button
                            type="button"
                            className={cn(BTN_PRIMARY)}
                            onClick={() => void confirmProposal(selected)}
                            disabled={
                              Boolean(busy) || confirmSelection.length === 0
                            }
                          >
                            {busy === "confirm-proposal" ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <ShieldCheck className="size-4" />
                            )}
                            {busy === "confirm-proposal"
                              ? "Confirming..."
                              : "Confirm"}
                          </button>
                          <button
                            type="button"
                            className={cn(BTN_OUTLINE)}
                            onClick={() => setArchiveTarget(selected)}
                            disabled={Boolean(archivingWorkflowId)}
                          >
                            {archivingWorkflowId === selected.workflow_id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <XCircle className="size-4" />
                            )}
                            {archivingWorkflowId === selected.workflow_id
                              ? "Removing..."
                              : "Reject"}
                          </button>
                        </div>
                      </SettingsGroup>
                    );
                  })()
                : null}

              {shouldShowDataSelection(selected) ? (
                <SettingsGroup
                  embedded
                  title="Information One can use"
                  description={
                    selectedAccessApproved
                      ? "Review the information for this reply. Change it if One picked the wrong section."
                      : "One picked this from the request. Change it if the match looks wrong."
                  }
                >
                  {selectedAccessApproved && !selectedScopeSelectionChanged ? (
                    <SettingsRow
                      icon={CheckCircle2}
                      title="Access ready"
                      description="One can use the selected information for this reply."
                      trailing={<Badge variant="secondary">Approved</Badge>}
                      stackTrailingOnMobile
                    />
                  ) : null}
                  {scopeCandidates(selected).map((candidate) => {
                    const checked = selectedScopeSelection.includes(
                      candidate.scope,
                    );
                    const candidateLabel = dataLabelForCandidate(candidate);
                    return (
                      <SettingsRow
                        key={candidate.scope}
                        icon={
                          candidate.domain === "financial"
                            ? BriefcaseBusiness
                            : ShieldCheck
                        }
                        title={candidateLabel}
                        description={scopeCandidateDescription(candidate)}
                        trailing={
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                void previewScopeCandidate(candidate);
                              }}
                              aria-label={`View ${candidateLabel}`}
                            >
                              <Eye className="size-4" />
                            </Button>
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              aria-label={`Select ${candidateLabel}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleScope(selected, candidate.scope);
                              }}
                              className="flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-1"
                            >
                              <span
                                className={cn(
                                  SELECT_CIRCLE_BASE,
                                  checked
                                    ? SELECT_CIRCLE_ON
                                    : SELECT_CIRCLE_OFF,
                                )}
                              >
                                {checked ? (
                                  <Check
                                    className="h-3.5 w-3.5"
                                    strokeWidth={3}
                                  />
                                ) : null}
                              </span>
                            </button>
                          </div>
                        }
                        onClick={() => toggleScope(selected, candidate.scope)}
                        stackTrailingOnMobile
                      />
                    );
                  })}
                  <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    {selectedScopeSelectionChanged ? (
                      <button
                        type="button"
                        className={cn(BTN_PRIMARY)}
                        onClick={() => void applyScopeSelection(selected)}
                        disabled={
                          Boolean(busy) || selectedScopeSelection.length === 0
                        }
                      >
                        {busy === "refresh" ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                        {busy === "refresh" ? "Updating..." : "Update draft"}
                      </button>
                    ) : selectedNeedsAccessApproval ? (
                      <>
                        <button
                          type="button"
                          className={cn(BTN_PRIMARY)}
                          onClick={() => void approveWorkflowConsent(selected)}
                          disabled={
                            Boolean(busy) ||
                            selectedScopesForWorkflow(
                              selected,
                              selectedScopesByWorkflow,
                            ).length === 0
                          }
                          data-voice-control-id="one-kyc-approve-access"
                          data-voice-action-id="kyc.workflow.approve_access"
                        >
                          {busy === "consent-approve" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <ShieldCheck className="size-4" />
                          )}
                          {busy === "consent-approve"
                            ? "Approving..."
                            : "Approve access"}
                        </button>
                        <button
                          type="button"
                          className={cn(BTN_OUTLINE)}
                          onClick={() => void denyWorkflowConsent(selected)}
                          disabled={
                            Boolean(busy) ||
                            selectedScopesForWorkflow(
                              selected,
                              selectedScopesByWorkflow,
                            ).length === 0
                          }
                          data-voice-control-id="one-kyc-deny-access"
                          data-voice-action-id="kyc.workflow.deny_access"
                        >
                          {busy === "consent-deny" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <XCircle className="size-4" />
                          )}
                          {busy === "consent-deny" ? "Denying..." : "Deny"}
                        </button>
                      </>
                    ) : selectedAccessApproved &&
                      selected.status === "needs_scope" ? (
                      <button
                        type="button"
                        className={cn(BTN_PRIMARY)}
                        onClick={() => void runAction("refresh", selected)}
                        disabled={Boolean(busy)}
                        data-voice-control-id="one-kyc-sync-status"
                        data-voice-action-id="kyc.workflow.sync_status"
                      >
                        <RefreshCw
                          className={
                            busy === "refresh"
                              ? "size-4 animate-spin"
                              : "size-4"
                          }
                        />
                        {busy === "refresh" ? "Preparing..." : "Prepare draft"}
                      </button>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        The draft will use the selected data.
                      </span>
                    )}
                  </div>
                </SettingsGroup>
              ) : null}

              {selected.metadata?.reply_thread ? (
                <SettingsGroup embedded title="Reply recipients">
                  <SettingsRow
                    icon={Send}
                    title="To"
                    description={
                      replyThreadValue(selected, "reply_all_to") ||
                      selected.sender_email ||
                      "-"
                    }
                  />
                  <SettingsRow
                    icon={MailPlus}
                    title="Cc"
                    description={
                      replyThreadValue(selected, "reply_all_cc") || "-"
                    }
                  />
                </SettingsGroup>
              ) : null}

              {selectedDraft && !selectedIsSent ? (
                <SettingsGroup embedded title="Draft reply">
                  <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    <DraftReplyPreview
                      body={selectedDraft.body}
                      htmlBody={selectedDraft.htmlBody}
                    />
                    {selectedDraft.missingFields.length > 0 ? (
                      <p className="text-sm text-amber-700 dark:text-amber-200">
                        Approved export did not contain:{" "}
                        {selectedDraft.missingFields
                          .map((field) => field.replaceAll("_", " "))
                          .join(", ")}
                      </p>
                    ) : null}
                  </div>
                </SettingsGroup>
              ) : null}

              {selected.status === "needs_documents" ? (
                <SettingsGroup embedded title="Missing information">
                  <SettingsRow
                    icon={AlertTriangle}
                    title="Additional details needed"
                    description="Approve more details to continue."
                  />
                </SettingsGroup>
              ) : null}

              {selected.last_error_message ? (
                <SettingsGroup embedded title="Request issue">
                  <SettingsRow
                    icon={AlertTriangle}
                    title="Attention needed"
                    description={selected.last_error_message}
                  />
                </SettingsGroup>
              ) : null}

              {selectedCanReviewDraft ? (
                <SettingsGroup embedded title="Redraft">
                  <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    <Textarea
                      value={redraftInstructions}
                      onChange={(event) =>
                        setRedraftInstructions(event.target.value)
                      }
                      maxLength={1000}
                      placeholder="Make it shorter, more formal, or use a bullet list."
                      className="min-h-24"
                      data-voice-control-id="one-kyc-redraft-instructions"
                    />
                    <button
                      type="button"
                      className={cn(BTN_PRIMARY)}
                      onClick={() => void runAction("redraft", selected)}
                      disabled={
                        Boolean(busy) ||
                        !redraftInstructions.trim() ||
                        !selectedDraft
                      }
                      data-voice-control-id="one-kyc-redraft"
                      data-voice-action-id="kyc.draft.request_redraft"
                    >
                      {busy === "redraft" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <PenLine className="size-4" />
                      )}
                      {busy === "redraft" ? "Redrafting..." : "Redraft"}
                    </button>
                  </div>
                </SettingsGroup>
              ) : null}

              {selectedIsSent ? (
                <SettingsGroup embedded title="Sent reply">
                  <SettingsRow
                    icon={CheckCircle2}
                    title="Reply sent"
                    description={
                      selected.sent_at
                        ? `Sent ${new Date(selected.sent_at).toLocaleString()}`
                        : "One sent the approved reply in this thread."
                    }
                  />
                  {selectedSentReply ? (
                    <>
                      <SettingsRow
                        icon={Send}
                        title="To"
                        description={
                          selectedSentReply.to.length
                            ? selectedSentReply.to.join(", ")
                            : "-"
                        }
                      />
                      <SettingsRow
                        icon={MailPlus}
                        title="Cc"
                        description={
                          selectedSentReply.cc.length
                            ? selectedSentReply.cc.join(", ")
                            : "-"
                        }
                      />
                      <div className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                        <DraftReplyPreview
                          body={selectedSentReply.body}
                          htmlBody={selectedSentReply.html_body || undefined}
                        />
                      </div>
                    </>
                  ) : (
                    <SettingsRow
                      icon={FileText}
                      title="Approved reply"
                      description="The reply was sent before this device saved a local encrypted copy."
                    />
                  )}
                </SettingsGroup>
              ) : (
                <SettingsGroup embedded title="Actions">
                  <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    <button
                      type="button"
                      className={cn(BTN_OUTLINE)}
                      onClick={() => void runAction("refresh", selected)}
                      disabled={Boolean(busy)}
                      data-voice-control-id="one-kyc-sync-status"
                      data-voice-action-id="kyc.workflow.sync_status"
                    >
                      <RefreshCw
                        className={
                          busy === "refresh" ? "size-4 animate-spin" : "size-4"
                        }
                      />
                      {busy === "refresh" ? "Syncing..." : "Sync status"}
                    </button>
                    <button
                      type="button"
                      className={cn(BTN_PRIMARY)}
                      onClick={() => void runAction("approve", selected)}
                      disabled={Boolean(busy) || !selectedCanReviewDraft}
                      data-voice-control-id="one-kyc-approve-send"
                      data-voice-action-id="kyc.draft.approve_send"
                    >
                      {busy === "approve" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                      {busy === "approve" ? "Sending..." : "Approve send"}
                    </button>
                    <button
                      type="button"
                      className={cn(BTN_OUTLINE)}
                      onClick={() => void runAction("reject", selected)}
                      disabled={
                        Boolean(busy) || selected.status !== "waiting_on_user"
                      }
                      data-voice-control-id="one-kyc-reject"
                      data-voice-action-id="kyc.draft.reject"
                    >
                      {busy === "reject" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <XCircle className="size-4" />
                      )}
                      {busy === "reject" ? "Rejecting..." : "Reject"}
                    </button>
                  </div>
                </SettingsGroup>
              )}
            </div>
          )}
        </SettingsDetailPanel>

        <AlertDialog
          open={Boolean(archiveTarget)}
          onOpenChange={(open) => {
            if (!open && !archivingWorkflowId) setArchiveTarget(null);
          }}
        >
          <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-lg">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this request?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the request from your KYC list. It does not delete
                the source message or any saved information.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={Boolean(archivingWorkflowId)}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={Boolean(archivingWorkflowId)}
                onClick={(event) => {
                  event.preventDefault();
                  void archiveWorkflow();
                }}
              >
                {archivingWorkflowId ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Removing...
                  </span>
                ) : (
                  "Remove"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <SettingsDetailPanel
          open={scopePreview.open}
          onOpenChange={(open) =>
            setScopePreview((current) => ({ ...current, open }))
          }
          title={scopePreview.title}
          description={scopePreview.description}
          desktopMaxWidthClassName="sm:!max-w-[860px]"
          desktopMaxWidth="min(860px, calc(100vw - 3rem))"
        >
          {scopePreview.loading ? (
            <SettingsGroup embedded title="Loading saved information">
              <SettingsRow
                icon={RefreshCw}
                title="Checking your vault"
                description="Loading the saved values for this information section."
                trailing={
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                }
                stackTrailingOnMobile
              />
            </SettingsGroup>
          ) : scopePreview.error ? (
            <SettingsGroup embedded title="Preview unavailable">
              <SettingsRow
                icon={AlertTriangle}
                title="Could not load saved information"
                description={scopePreview.error}
              />
            </SettingsGroup>
          ) : scopePreview.presentation ? (
            <PkmSectionPreview presentation={scopePreview.presentation} />
          ) : (
            <SettingsGroup embedded title="Nothing saved yet">
              <SettingsRow
                icon={Eye}
                title="Nothing to preview yet"
                description="There are no saved values available for this section."
              />
            </SettingsGroup>
          )}
        </SettingsDetailPanel>

        <SettingsDetailPanel
          open={aliasPanelOpen}
          onOpenChange={setAliasPanelOpen}
          title="Verified addresses"
          description={
            isPrivateRelay
              ? "Apple Private Relay addresses cannot be used for verification."
              : "Add addresses people already use so One can match requests without extra work."
          }
        >
          <div className="space-y-4">
            <SettingsGroup embedded title="Ready to match">
              {verifiedAliases.length ? (
                verifiedAliases.map((alias) => (
                  <SettingsRow
                    key={alias.alias_id}
                    icon={BadgeCheck}
                    title={alias.email}
                    description={
                      alias.verified_at
                        ? `Verified ${new Date(alias.verified_at).toLocaleDateString()}`
                        : "Verified"
                    }
                    trailing={<Badge variant="secondary">Ready</Badge>}
                    stackTrailingOnMobile
                  />
                ))
              ) : (
                <SettingsRow
                  icon={MailPlus}
                  title="No verified addresses yet"
                  description="Add an address people already use for requests."
                />
              )}
            </SettingsGroup>

            {pendingAliases.length ? (
              <SettingsGroup embedded title="Waiting for code">
                {pendingAliases.map((alias) => (
                  <SettingsRow
                    key={alias.alias_id}
                    icon={Clock3}
                    title={alias.email}
                    description="Enter the code sent for this address."
                    trailing={<Badge variant="outline">Pending</Badge>}
                    stackTrailingOnMobile
                  />
                ))}
              </SettingsGroup>
            ) : null}

            <SettingsGroup
              embedded
              title={aliasChallenge ? "Enter code" : "Add an address"}
              description={
                aliasChallenge
                  ? `Use the code sent for ${aliasChallenge.email}.`
                  : "Use an address where people may send requests."
              }
            >
              <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                <Input
                  type="email"
                  value={aliasEmail}
                  onChange={(event) => setAliasEmail(event.target.value)}
                  placeholder="name@example.com"
                  autoComplete="email"
                />
                {aliasChallenge ? (
                  <Input
                    value={aliasCode}
                    onChange={(event) => setAliasCode(event.target.value)}
                    placeholder="Verification code"
                    inputMode="numeric"
                  />
                ) : null}
                {aliasChallenge?.reviewCode ? (
                  <p className="text-xs text-muted-foreground">
                    Code for this test session: {aliasChallenge.reviewCode}
                  </p>
                ) : null}
                <div className="grid gap-2 sm:flex sm:flex-wrap">
                  <button
                    type="button"
                    className={cn(BTN_OUTLINE, "w-full sm:w-auto")}
                    onClick={() => void startAliasVerification()}
                    disabled={Boolean(busy) || !aliasEmail.trim()}
                  >
                    {busy === "alias" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <MailPlus className="size-4" />
                    )}
                    {busy === "alias" ? "Sending..." : "Send code"}
                  </button>
                  <button
                    type="button"
                    className={cn(BTN_PRIMARY, "w-full sm:w-auto")}
                    onClick={() => void confirmAliasVerification()}
                    disabled={
                      Boolean(busy) || !aliasChallenge || !aliasCode.trim()
                    }
                  >
                    {busy === "alias" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <BadgeCheck className="size-4" />
                    )}
                    {busy === "alias" ? "Verifying..." : "Verify address"}
                  </button>
                </div>
              </div>
            </SettingsGroup>
          </div>
        </SettingsDetailPanel>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function DraftReplyPreview({
  body,
  htmlBody,
}: {
  body: string;
  htmlBody?: string;
}) {
  return (
    <article
      className="max-h-[32rem] max-w-full overflow-auto rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-background/80 p-2 text-sm shadow-sm sm:p-4"
      data-voice-control-id="one-kyc-draft-review"
    >
      {htmlBody ? (
        <div dangerouslySetInnerHTML={{ __html: htmlBody }} />
      ) : (
        <pre className="whitespace-pre-wrap text-sm leading-6">{body}</pre>
      )}
    </article>
  );
}

function replyThreadValue(
  workflow: OneKycWorkflow,
  key: "reply_all_to" | "reply_all_cc",
): string {
  return replyThreadList(workflow, key).join(", ");
}

function replyThreadList(
  workflow: OneKycWorkflow,
  key: "reply_all_to" | "reply_all_cc",
): string[] {
  const thread = workflow.metadata?.reply_thread;
  if (!thread || typeof thread !== "object") return [];
  const value = (thread as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function buildSentReplySnapshot(
  workflow: OneKycWorkflow,
  draft: KycDraftBuildResult,
): KycWorkflowSentReplySnapshot {
  return {
    workflow_id: workflow.workflow_id,
    subject:
      draft.subject || workflow.draft_subject || workflow.subject || null,
    body: draft.body,
    html_body: draft.htmlBody || null,
    to: replyThreadList(workflow, "reply_all_to").length
      ? replyThreadList(workflow, "reply_all_to")
      : workflow.sender_email
        ? [workflow.sender_email]
        : [],
    cc: replyThreadList(workflow, "reply_all_cc"),
    sent_at: new Date().toISOString(),
    draft_hash: draft.draftHash || null,
    schema_version: 1,
  };
}

function workflowDraftAttemptKey(workflow: OneKycWorkflow): string {
  const metadataRevision =
    workflow.metadata && typeof workflow.metadata.draft_revision === "number"
      ? workflow.metadata.draft_revision
      : "none";
  const exportRevisions = (workflow.consent_exports || [])
    .map((item) => `${item.scope || "scope"}:${item.export_revision || "none"}`)
    .join("|");
  return [
    workflow.workflow_id,
    workflow.status,
    workflow.draft_status || "draft",
    metadataRevision,
    exportRevisions || workflow.consent_export?.export_revision || "no-export",
  ].join(":");
}

function parseAttrScope(
  scope: string,
): { domain: string; topLevelScopePath: string | null } | null {
  const parts = scope
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts[0] !== "attr" || !parts[1]) return null;
  const pathParts = parts.slice(2).filter((part) => part !== "*");
  return {
    domain: parts[1],
    topLevelScopePath: pathParts[0] || null,
  };
}

function emptyKycCheck(): KycWorkflowCheck {
  return {
    status: "not_started",
    updated_at: null,
    method: null,
    source_domain: null,
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Unknown error";
}

function oneKycErrorMessage(value: unknown, fallback: string): string {
  const code = apiErrorCode(value);
  if (code === "ONE_KYC_EXPORT_SCOPE_MISMATCH") {
    return "One is refreshing the approved information for this request. Sync again in a moment.";
  }
  if (
    code === "ONE_KYC_EXPORT_NOT_CURRENT" ||
    code === "ONE_KYC_EXPORT_UNAVAILABLE"
  ) {
    return "The approved information is still being prepared. Sync this request again in a moment.";
  }
  return value instanceof Error && value.message ? value.message : fallback;
}

function apiErrorCode(value: unknown): string | null {
  if (!(value instanceof ApiError)) return null;
  const payload = value.payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const detail = record.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code = (detail as Record<string, unknown>).code;
    return typeof code === "string" && code.trim() ? code.trim() : null;
  }
  const code = record.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}
