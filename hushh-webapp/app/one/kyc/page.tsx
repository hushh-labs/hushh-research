"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  FileText,
  Inbox,
  MailPlus,
  RefreshCw,
  Send,
  ShieldCheck,
  UserRound,
  Wand2,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useRequireAuth } from "@/hooks/use-auth";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import { resolveConsentRequestHref } from "@/lib/consent/consent-sheet-route";
import { useConsentActions, type PendingConsent } from "@/lib/consent";
import { ROUTES } from "@/lib/navigation/routes";
import {
  detectedDomains,
  isKycClientDraftReady,
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
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  buildKycWorkflowArtifact,
  hashKycWorkflowArtifact,
  KycWorkflowPkmService,
  type KycWorkflowCheck,
  type KycWorkflowCheckKey,
  type KycWorkflowStatus,
} from "@/lib/services/kyc-pkm-write-service";
import {
  OneKycClientZkService,
  type KycDraftBuildResult,
} from "@/lib/services/one-kyc-client-zk-service";
import {
  OneKycService,
  type OneKycWorkflow,
  type OneKycWorkflowStatus,
} from "@/lib/services/one-kyc-service";
import { useVault } from "@/lib/vault/vault-context";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const STATUS_LABELS: Record<OneKycWorkflowStatus, string> = {
  needs_client_connector: "Needs vault setup",
  needs_scope: "Needs consent",
  needs_documents: "Needs documents",
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
  if (status === "waiting_on_user" || status === "needs_scope")
    return "default";
  if (status === "completed" || status === "waiting_on_counterparty")
    return "secondary";
  return "outline";
}

function statusIcon(status: OneKycWorkflowStatus): LucideIcon {
  if (status === "blocked") return Ban;
  if (status === "completed" || status === "waiting_on_counterparty")
    return BadgeCheck;
  if (status === "needs_scope" || status === "needs_client_connector")
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

function consentCenterHrefForWorkflow(workflow: OneKycWorkflow): string {
  return resolveConsentRequestHref(workflow.consent_request_url, "pending", {
    requestId: workflowConsentRequestIds(workflow)[0],
    bundleId: workflow.consent_bundle_id || undefined,
    actor: "investor",
    managerView: "incoming",
    from: ROUTES.ONE_KYC,
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

function consentEntryToPendingConsent(
  entry: ConsentCenterEntry,
): PendingConsent {
  const issuedAt = consentEntryTimestamp(entry.issued_at) || Date.now();
  const approvalTimeoutAt =
    consentEntryTimestamp(entry.approval_timeout_at) ||
    consentEntryTimestamp(entry.expires_at);
  return {
    id: entry.request_id || entry.id,
    developer:
      entry.counterpart_label ||
      entry.counterpart_email ||
      entry.counterpart_secondary_label ||
      entry.counterpart_id ||
      "One",
    developerImageUrl: entry.counterpart_image_url || undefined,
    developerWebsiteUrl: entry.counterpart_website_url || undefined,
    scope: entry.scope || "",
    scopeDescription: entry.scope_description || undefined,
    requestedAt: issuedAt,
    approvalTimeoutAt,
    requestUrl: entry.request_url || undefined,
    reason: entry.reason || undefined,
    isScopeUpgrade: Boolean(entry.is_scope_upgrade),
    existingGrantedScopes: entry.existing_granted_scopes || undefined,
    additionalAccessSummary: entry.additional_access_summary || undefined,
    metadata: entry.metadata || undefined,
  };
}

export default function OneKycPage() {
  return (
    <VaultLockGuard>
      <OneKycWorkspace />
    </VaultLockGuard>
  );
}

function OneKycWorkspace() {
  const auth = useRequireAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const { handleApprove, handleApproveBundle, handleDeny, handleDenyBundle } =
    useConsentActions({ userId: auth.userId });
  const [workflows, setWorkflows] = useState<OneKycWorkflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [aliasPanelOpen, setAliasPanelOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redraftInstructions, setRedraftInstructions] = useState("");
  const [localDrafts, setLocalDrafts] = useState<
    Record<string, KycDraftBuildResult>
  >({});
  const [localExportPayloads, setLocalExportPayloads] = useState<
    Record<
      string,
      Array<{ scope?: string | null; payload: Record<string, unknown> }>
    >
  >({});
  const [selectedScopesByWorkflow, setSelectedScopesByWorkflow] = useState<
    Record<string, string[]>
  >({});
  const [connectorReady, setConnectorReady] = useState(false);
  const [emailAliases, setEmailAliases] = useState<AccountEmailAlias[]>([]);
  const [aliasEmail, setAliasEmail] = useState("");
  const [aliasCode, setAliasCode] = useState("");
  const [aliasChallenge, setAliasChallenge] = useState<{
    email: string;
    reviewCode?: string | null;
  } | null>(null);

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
  const verifiedAliases = useMemo(
    () =>
      emailAliases.filter((alias) => alias.verification_status === "verified"),
    [emailAliases],
  );
  const pendingAliases = useMemo(
    () =>
      emailAliases.filter((alias) => alias.verification_status === "pending"),
    [emailAliases],
  );
  const voiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "one_kyc",
      title: "Email",
      purpose: "Approval-gated email request review for one@hushh.ai.",
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
          title: "Verified email addresses",
        },
      ],
      controls: [
        {
          id: "one-kyc-open",
          label: "Open Email",
          type: "route",
          actionId: "route.one_kyc",
        },
        {
          id: "one-kyc-aliases",
          label: "Manage verified emails",
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
          state: selected?.status === "needs_scope" ? "available" : "disabled",
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
          state:
            selected?.status === "waiting_on_user" ? "available" : "disabled",
        },
        {
          id: "one-kyc-approve-send",
          label: "Approve send",
          type: "button",
          actionId: "kyc.draft.approve_send",
          state:
            selected?.status === "waiting_on_user" ? "available" : "disabled",
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
        loading,
      },
    }),
    [
      aliasPanelOpen,
      connectorReady,
      isVaultUnlocked,
      loading,
      localDrafts,
      selected,
      vaultKey,
      vaultOwnerToken,
      workflows.length,
    ],
  );
  usePublishVoiceSurfaceMetadata(voiceSurfaceMetadata);

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

  const load = useCallback(async () => {
    if (!auth.user || !auth.userId || !vaultKey || !vaultOwnerToken) return;
    setLoading(true);
    setError(null);
    try {
      await OneKycClientZkService.ensureConnector({
        userId: auth.userId,
        vaultKey,
        vaultOwnerToken,
      });
      setConnectorReady(true);
      const response = await OneKycService.listWorkflows({
        userId: auth.userId,
        vaultOwnerToken,
      });
      const aliasResponse = await AccountService.listEmailAliases(
        vaultOwnerToken,
      ).catch(() => null);
      if (aliasResponse) {
        setEmailAliases(aliasResponse.aliases);
      }
      setWorkflows(response.workflows);
      retainReadyLocalWorkflowState(response.workflows);
      const initialId = new URLSearchParams(window.location.search).get(
        "workflowId",
      );
      setSelectedId(
        (current) =>
          current || initialId || response.workflows[0]?.workflow_id || null,
      );
    } catch (err) {
      setConnectorReady(false);
      setError(
        err instanceof Error ? err.message : "Unable to load email requests.",
      );
    } finally {
      setLoading(false);
    }
  }, [
    auth.user,
    auth.userId,
    retainReadyLocalWorkflowState,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    async function prepareClientDraft() {
      if (!auth.userId || !vaultKey || !vaultOwnerToken || !selected) return;
      if (
        selected.status !== "waiting_on_user" ||
        selected.draft_status !== "ready"
      )
        return;
      if (localDrafts[selected.workflow_id]) return;
      try {
        setBusy((current) => current || "draft");
        const connector = await OneKycClientZkService.ensureConnector({
          userId: auth.userId,
          vaultKey,
          vaultOwnerToken,
        });
        const exportResponse = await OneKycService.getWorkflowConsentExports({
          userId: auth.userId,
          vaultOwnerToken,
          workflowId: selected.workflow_id,
        });
        const exportPayloads = await Promise.all(
          exportResponse.exports.map(async (exportPackage) => ({
            scope: exportPackage.scope,
            payload: await OneKycClientZkService.decryptScopedExport({
              exportPackage,
              connector,
            }),
          })),
        );
        const draft = await OneKycClientZkService.buildDraft({
          workflow: selected,
          exportPayloads,
        });
        if (!cancelled) {
          setLocalDrafts((current) => ({
            ...current,
            [selected.workflow_id]: draft,
          }));
          setLocalExportPayloads((current) => ({
            ...current,
            [selected.workflow_id]: exportPayloads,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to prepare the KYC draft.",
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
    };
  }, [auth.userId, localDrafts, selected, vaultKey, vaultOwnerToken]);

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
        setError("Prepare the KYC draft before approving send.");
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
            setError("Prepare the KYC draft before revising it.");
            return;
          }
          const next = await OneKycService.redraft({
            ...input,
            instructions: redraftInstructions.trim(),
            source: "text",
          });
          updateWorkflow(next);
          if (next.status === "waiting_on_user") {
            const exportPayloads =
              localExportPayloads[workflow.workflow_id] || [];
            const draft = await OneKycClientZkService.buildDraft({
              workflow: next,
              exportPayloads,
              instructions: redraftInstructions.trim(),
            });
            setLocalDrafts((current) => ({
              ...current,
              [workflow.workflow_id]: draft,
            }));
          } else {
            clearLocalWorkflowState(workflow.workflow_id);
          }
          setRedraftInstructions("");
          return;
        }

        let next: OneKycWorkflow;
        if (action === "approve") {
          if (!localDraft) {
            setError("Prepare the KYC draft before approving send.");
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
          const artifact = buildKycWorkflowArtifact({
            checks,
            overall_status: overallStatus,
            counterparty:
              workflow.counterparty_label || workflow.sender_email || null,
            request_summary: workflow.subject || null,
            pending_requirements: localDraft.missingFields,
            completed_requirements: workflow.required_fields.filter(
              (field) => !localDraft.missingFields.includes(field),
            ),
          });
          const artifactHash = await hashKycWorkflowArtifact(artifact);
          next = await OneKycService.sendApprovedReply({
            ...input,
            approvedSubject: localDraft.subject || workflow.draft_subject,
            approvedBody: localDraft.body,
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
            reason: "Rejected from Email.",
          });
        } else {
          next = await refreshWorkflowState(workflow);
        }
        updateWorkflow(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "KYC action failed.");
      } finally {
        setBusy(null);
      }
    },
    [
      auth.user,
      auth.userId,
      clearLocalWorkflowState,
      localExportPayloads,
      localDrafts,
      redraftInstructions,
      refreshWorkflowState,
      updateWorkflow,
      vaultKey,
      vaultOwnerToken,
    ],
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
          "Choose at least one data type before approving access.",
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

  const loadConsentEntriesForWorkflow = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (!auth.user || !auth.userId) {
        throw new Error("Sign in again to approve access.");
      }
      const requestIds = new Set(workflowConsentRequestIds(workflow));
      if (requestIds.size === 0) {
        throw new Error("No consent request is ready for this email yet.");
      }
      const idToken = await auth.user.getIdToken();
      const center = await ConsentCenterService.getCenter({
        idToken,
        userId: auth.userId,
        actor: "investor",
        view: "incoming",
        force: true,
      });
      const entries = center.incoming_requests.filter((entry) =>
        requestIds.has(entry.request_id || entry.id),
      );
      if (entries.length !== requestIds.size) {
        throw new Error(
          "One is still preparing the access request. Try sync once more.",
        );
      }
      return entries;
    },
    [auth.user, auth.userId],
  );

  const approveWorkflowConsent = useCallback(
    async (workflow: OneKycWorkflow) => {
      setBusy("consent-approve");
      setError(null);
      try {
        const withRequests = await ensureConsentRequestsForWorkflow(workflow);
        const entries = await loadConsentEntriesForWorkflow(withRequests);
        const consents = entries.map(consentEntryToPendingConsent);
        if (consents.length === 1) {
          const consent = consents[0];
          if (!consent) {
            throw new Error("No consent request is ready for this email yet.");
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
            "Access approved. More data is needed before One can draft.",
          );
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to approve access.",
        );
      } finally {
        setBusy(null);
      }
    },
    [
      ensureConsentRequestsForWorkflow,
      handleApprove,
      handleApproveBundle,
      loadConsentEntriesForWorkflow,
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
            throw new Error("No consent request is ready for this email yet.");
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

  return (
    <AppPageShell
      width="content"
      className="space-y-6 px-4 py-6 sm:px-6 lg:px-8"
      nativeTest={{
        routeId: ROUTES.ONE_KYC,
        marker: "native-route-one-kyc",
        authState: auth.user ? "authenticated" : "pending",
        dataState: loading ? "loading" : error ? "error" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One"
          title="Email"
          description="Review emails that ask for your data, choose what to share, and send replies only after you approve."
          icon={ShieldCheck}
          accent="neutral"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mx-auto grid w-full max-w-5xl items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        {error ? (
          <div className="lg:col-span-2 rounded-[var(--app-card-radius-standard)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="space-y-4">
          <SettingsGroup title="Requests">
            {loading ? (
              <div className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                <HushhLoader variant="inline" label="Loading workflows." />
              </div>
            ) : workflows.length === 0 ? (
              <SettingsRow
                icon={Inbox}
                title="No matched requests"
                description="New emails appear here after One matches them to one of your verified addresses."
              />
            ) : (
              workflows.map((workflow) => (
                <SettingsRow
                  key={workflow.workflow_id}
                  icon={statusIcon(workflow.status)}
                  title={workflow.subject || "Email request"}
                  description={[
                    workflow.counterparty_label ||
                      workflow.sender_email ||
                      "Counterparty",
                    selectedScopeLabels(workflow).join(", ") ||
                      workflow.requested_scope ||
                      "Scope pending",
                  ].join(" / ")}
                  trailing={
                    <Badge variant={statusVariant(workflow.status)}>
                      {STATUS_LABELS[workflow.status] || workflow.status}
                    </Badge>
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
        </div>

        <div className="space-y-4">
          <SettingsGroup title="Matching emails">
            <SettingsRow
              icon={MailPlus}
              title="Verified email addresses"
              description={
                verifiedAliases.length
                  ? verifiedAliases.map((alias) => alias.email).join(", ")
                  : "Add an address people already use for you."
              }
              trailing={
                <Badge variant="secondary">{verifiedAliases.length}</Badge>
              }
              chevron
              onClick={() => setAliasPanelOpen(true)}
              stackTrailingOnMobile
              voiceControlId="one-kyc-aliases"
              voiceActionId="kyc.aliases.manage"
            />
          </SettingsGroup>
        </div>

        <SettingsDetailPanel
          open={detailOpen && Boolean(selected)}
          onOpenChange={setDetailOpen}
          title={selected?.subject || "Email request"}
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
              <SettingsGroup embedded title="Request">
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
                  title="Counterparty"
                  description={
                    selected.counterparty_label || selected.sender_email || "-"
                  }
                />
                <SettingsRow
                  icon={UserRound}
                  title="Intent"
                  description={detectedDomains(selected).join(", ") || "-"}
                />
                <SettingsRow
                  icon={ShieldCheck}
                  title="Data to share"
                  description={
                    selectedScopeLabels(selected).join(", ") ||
                    selected.requested_scope ||
                    "-"
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
                <SettingsRow
                  icon={FileText}
                  title="Thread"
                  description={threadStatusLabel(selected)}
                />
              </SettingsGroup>

              <SettingsGroup embedded title="Required fields">
                <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                  {(selected.required_fields.length
                    ? selected.required_fields
                    : ["identity_profile"]
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
                    description="Unlock completed. Sync this workflow so One can request scoped consent with your client-held KYC connector."
                  />
                </SettingsGroup>
              ) : null}

              {selected.status === "needs_scope" ? (
                <SettingsGroup
                  embedded
                  title="Recommended data"
                  description="Confirm what One should request before any encrypted export is prepared."
                >
                  {scopeCandidates(selected).map((candidate) => {
                    const checked = selectedScopesForWorkflow(
                      selected,
                      selectedScopesByWorkflow,
                    ).includes(candidate.scope);
                    return (
                      <SettingsRow
                        key={candidate.scope}
                        icon={
                          candidate.domain === "financial"
                            ? BriefcaseBusiness
                            : ShieldCheck
                        }
                        title={candidate.label || candidate.scope}
                        description={[
                          candidate.description || candidate.scope,
                          candidate.reason || "Detected from the email text.",
                        ].join(" / ")}
                        trailing={
                          <input
                            type="checkbox"
                            className="size-4 accent-foreground"
                            checked={checked}
                            onChange={() =>
                              toggleScope(selected, candidate.scope)
                            }
                            disabled={Boolean(selected.consent_request_url)}
                            aria-label={`Select ${candidate.label || candidate.scope}`}
                          />
                        }
                        onClick={() => {
                          if (!selected.consent_request_url)
                            toggleScope(selected, candidate.scope);
                        }}
                        disabled={Boolean(selected.consent_request_url)}
                        stackTrailingOnMobile
                      />
                    );
                  })}
                  <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    <Button
                      type="button"
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
                      <ShieldCheck className="size-4" />
                      Approve access
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
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
                      <XCircle className="size-4" />
                      Deny
                    </Button>
                    {workflowConsentRequestIds(selected).length > 0 ? (
                      <Button asChild variant="ghost">
                        <Link
                          href={consentCenterHrefForWorkflow(selected)}
                          data-voice-control-id="one-kyc-open-consent"
                        >
                          View in Access Center
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </SettingsGroup>
              ) : null}

              {selected.metadata?.reply_thread ? (
                <SettingsGroup embedded title="Reply thread">
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

              {selectedDraft ? (
                <SettingsGroup embedded title="Draft reply">
                  <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    <pre
                      className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-muted/40 p-4 text-sm leading-6"
                      data-voice-control-id="one-kyc-draft-review"
                    >
                      {selectedDraft.body}
                    </pre>
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
                <SettingsGroup embedded title="Missing data">
                  <SettingsRow
                    icon={AlertTriangle}
                    title="Additional details needed"
                    description="One needs additional approved identity details before it can prepare a complete KYC reply."
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

              {selected.status === "waiting_on_user" ? (
                <SettingsGroup embedded title="Redraft">
                  <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                    <Textarea
                      value={redraftInstructions}
                      onChange={(event) =>
                        setRedraftInstructions(event.target.value)
                      }
                      maxLength={1000}
                      placeholder="Make it shorter, more formal, or mention that more documents can be provided on request."
                      className="min-h-24"
                      data-voice-control-id="one-kyc-redraft-instructions"
                    />
                    <Button
                      variant="outline"
                      onClick={() => void runAction("redraft", selected)}
                      disabled={
                        Boolean(busy) ||
                        !redraftInstructions.trim() ||
                        !selectedDraft
                      }
                      data-voice-control-id="one-kyc-redraft"
                      data-voice-action-id="kyc.draft.request_redraft"
                    >
                      <Wand2 className="size-4" />
                      Redraft
                    </Button>
                  </div>
                </SettingsGroup>
              ) : null}

              <SettingsGroup embedded title="Actions">
                <div className="flex flex-wrap gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                  <Button
                    variant="outline"
                    onClick={() => void runAction("refresh", selected)}
                    disabled={Boolean(busy)}
                    data-voice-control-id="one-kyc-sync-status"
                    data-voice-action-id="kyc.workflow.sync_status"
                  >
                    <RefreshCw className="size-4" />
                    Sync status
                  </Button>
                  <Button
                    onClick={() => void runAction("approve", selected)}
                    disabled={
                      Boolean(busy) ||
                      selected.status !== "waiting_on_user" ||
                      !selectedDraft
                    }
                    data-voice-control-id="one-kyc-approve-send"
                    data-voice-action-id="kyc.draft.approve_send"
                  >
                    <Send className="size-4" />
                    Approve send
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void runAction("reject", selected)}
                    disabled={
                      Boolean(busy) || selected.status !== "waiting_on_user"
                    }
                    data-voice-control-id="one-kyc-reject"
                    data-voice-action-id="kyc.draft.reject"
                  >
                    <XCircle className="size-4" />
                    Reject
                  </Button>
                  {selected.status === "waiting_on_counterparty" ? (
                    <Badge variant="secondary">
                      <CheckCircle2 className="size-3" />
                      Reply sent
                    </Badge>
                  ) : null}
                </div>
              </SettingsGroup>

              {selected.status === "needs_scope" &&
              workflowConsentRequestIds(selected).length > 0 ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={consentCenterHrefForWorkflow(selected)}>
                    Open Access Center
                  </Link>
                </Button>
              ) : null}
            </div>
          )}
        </SettingsDetailPanel>

        <SettingsDetailPanel
          open={aliasPanelOpen}
          onOpenChange={setAliasPanelOpen}
          title="Verified emails"
          description="Add addresses people already use so One can match requests without extra work."
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
                  title="No verified emails yet"
                  description="Add the email address people already use for requests."
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
              title={aliasChallenge ? "Enter code" : "Add an email"}
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void startAliasVerification()}
                    disabled={Boolean(busy) || !aliasEmail.trim()}
                    className="w-full sm:w-auto"
                  >
                    <MailPlus className="size-4" />
                    Send code
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void confirmAliasVerification()}
                    disabled={
                      Boolean(busy) || !aliasChallenge || !aliasCode.trim()
                    }
                    className="w-full sm:w-auto"
                  >
                    <BadgeCheck className="size-4" />
                    Verify email
                  </Button>
                </div>
              </div>
            </SettingsGroup>
          </div>
        </SettingsDetailPanel>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function replyThreadValue(
  workflow: OneKycWorkflow,
  key: "reply_all_to" | "reply_all_cc",
): string {
  const thread = workflow.metadata?.reply_thread;
  if (!thread || typeof thread !== "object") return "";
  const value = (thread as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

function threadStatusLabel(workflow: OneKycWorkflow): string {
  if (workflow.thread_match_status === "matched") return "Reply threaded";
  if (workflow.thread_match_status === "mismatched")
    return "Sent in new thread";
  if (workflow.thread_match_status === "unknown")
    return "Thread verification pending";
  return workflow.gmail_thread_id || "-";
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
