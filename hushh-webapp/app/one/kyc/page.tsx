"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Inbox, MailPlus, RefreshCw, Send, ShieldCheck, Wand2, XCircle } from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useRequireAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  AccountService,
  type AccountEmailAlias,
} from "@/lib/services/account-service";
import {
  buildKycWorkflowArtifact,
  hashKycWorkflowArtifact,
  KycWorkflowPkmService,
  type KycWorkflowCheck,
  type KycWorkflowCheckKey,
  type KycWorkflowStatus,
} from "@/lib/services/kyc-pkm-write-service";
import { OneKycClientZkService, type KycDraftBuildResult } from "@/lib/services/one-kyc-client-zk-service";
import {
  OneKycService,
  type OneKycScopeCandidate,
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

function statusVariant(status: OneKycWorkflowStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "blocked") return "destructive";
  if (status === "waiting_on_user" || status === "needs_scope") return "default";
  if (status === "completed" || status === "waiting_on_counterparty") return "secondary";
  return "outline";
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
  const [workflows, setWorkflows] = useState<OneKycWorkflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redraftInstructions, setRedraftInstructions] = useState("");
  const [localDrafts, setLocalDrafts] = useState<Record<string, KycDraftBuildResult>>({});
  const [localExportPayloads, setLocalExportPayloads] = useState<
    Record<string, Array<{ scope?: string | null; payload: Record<string, unknown> }>>
  >({});
  const [selectedScopesByWorkflow, setSelectedScopesByWorkflow] = useState<Record<string, string[]>>({});
  const [connectorReady, setConnectorReady] = useState(false);
  const [emailAliases, setEmailAliases] = useState<AccountEmailAlias[]>([]);
  const [aliasEmail, setAliasEmail] = useState("");
  const [aliasCode, setAliasCode] = useState("");
  const [aliasChallenge, setAliasChallenge] = useState<{
    email: string;
    reviewCode?: string | null;
  } | null>(null);

  const selected = useMemo(
    () => workflows.find((workflow) => workflow.workflow_id === selectedId) || workflows[0] || null,
    [selectedId, workflows]
  );
  const selectedDraft = selected ? localDrafts[selected.workflow_id] || null : null;
  const voiceSurfaceMetadata = useMemo(
    () => ({
      screenId: "one_kyc",
      title: "One KYC Workflows",
      purpose: "Approval-gated broker KYC workflow review for one@hushh.ai.",
      sections: [
        {
          id: "one_kyc_inbox",
          title: "KYC workflow inbox",
        },
        {
          id: "one_kyc_detail",
          title: "Selected KYC workflow",
        },
      ],
      controls: [
        {
          id: "one-kyc-open",
          label: "Open KYC workflows",
          type: "route",
          actionId: "route.one_kyc",
        },
        {
          id: "one-kyc-sync-status",
          label: "Sync status",
          type: "button",
          actionId: "kyc.workflow.sync_status",
          state: selected ? selected.status : "empty",
        },
        {
          id: "one-kyc-draft-review",
          label: "Review draft",
          type: "region",
          actionId: "kyc.draft.review",
          state: selected ? (localDrafts[selected.workflow_id] ? "available" : "empty") : "empty",
        },
        {
          id: "one-kyc-redraft",
          label: "Redraft",
          type: "button",
          actionId: "kyc.draft.request_redraft",
          state: selected?.status === "waiting_on_user" ? "available" : "disabled",
        },
        {
          id: "one-kyc-approve-send",
          label: "Approve send",
          type: "button",
          actionId: "kyc.draft.approve_send",
          state: selected?.status === "waiting_on_user" ? "available" : "disabled",
        },
        {
          id: "one-kyc-reject",
          label: "Reject draft",
          type: "button",
          actionId: "kyc.draft.reject",
          state: selected?.status === "waiting_on_user" ? "available" : "disabled",
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
    [connectorReady, isVaultUnlocked, loading, localDrafts, selected, vaultKey, vaultOwnerToken, workflows.length]
  );
  usePublishVoiceSurfaceMetadata(voiceSurfaceMetadata);

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
      const aliasResponse = await AccountService.listEmailAliases(vaultOwnerToken).catch(() => null);
      if (aliasResponse) {
        setEmailAliases(aliasResponse.aliases);
      }
      setWorkflows(response.workflows);
      const initialId = new URLSearchParams(window.location.search).get("workflowId");
      setSelectedId((current) => current || initialId || response.workflows[0]?.workflow_id || null);
    } catch (err) {
      setConnectorReady(false);
      setError(err instanceof Error ? err.message : "Unable to load KYC workflows.");
    } finally {
      setLoading(false);
    }
  }, [auth.user, auth.userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    async function prepareClientDraft() {
      if (!auth.userId || !vaultKey || !vaultOwnerToken || !selected) return;
      if (selected.status !== "waiting_on_user" || selected.draft_status !== "ready") return;
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
          }))
        );
        const draft = await OneKycClientZkService.buildDraft({
          workflow: selected,
          exportPayloads,
        });
        if (!cancelled) {
          setLocalDrafts((current) => ({ ...current, [selected.workflow_id]: draft }));
          setLocalExportPayloads((current) => ({
            ...current,
            [selected.workflow_id]: exportPayloads,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to prepare the KYC draft.");
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

  const updateWorkflow = useCallback((next: OneKycWorkflow) => {
    setWorkflows((current) => {
      const index = current.findIndex((workflow) => workflow.workflow_id === next.workflow_id);
      if (index === -1) return [next, ...current];
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
    setSelectedId(next.workflow_id);
  }, []);

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
        aliasEmail.trim()
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
      setError(err instanceof Error ? err.message : "Email alias verification failed.");
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
        aliasCode.trim()
      );
      await refreshAliases();
      setAliasEmail("");
      setAliasCode("");
      setAliasChallenge(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Email alias confirmation failed.");
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
        setError("Add redraft instructions before asking One to revise this draft.");
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
            const exportPayloads = localExportPayloads[workflow.workflow_id] || [];
            const draft = await OneKycClientZkService.buildDraft({
              workflow: next,
              exportPayloads,
              instructions: redraftInstructions.trim(),
            });
            setLocalDrafts((current) => ({ ...current, [workflow.workflow_id]: draft }));
          } else {
            setLocalDrafts((current) => {
              const nextDrafts = { ...current };
              delete nextDrafts[workflow.workflow_id];
              return nextDrafts;
            });
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
              status: localDraft.missingFields.length === 0 ? "verified" : "pending",
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
            counterparty: workflow.counterparty_label || workflow.sender_email || null,
            request_summary: workflow.subject || null,
            pending_requirements: localDraft.missingFields,
            completed_requirements: workflow.required_fields.filter(
              (field) => !localDraft.missingFields.includes(field)
            ),
          });
          const artifactHash = await hashKycWorkflowArtifact(artifact);
          next = await OneKycService.sendApprovedReply({
            ...input,
            approvedSubject: localDraft.subject || workflow.draft_subject,
            approvedBody: localDraft.body,
            clientDraftHash: localDraft.draftHash,
            consentExportRevision:
              Array.isArray(workflow.consent_exports) && workflow.consent_exports.length > 1
                ? null
                : typeof workflow.consent_export?.export_revision === "number"
                ? workflow.consent_export.export_revision
                : typeof workflow.metadata?.consent_export === "object" &&
                    workflow.metadata.consent_export !== null &&
                    typeof (workflow.metadata.consent_export as Record<string, unknown>).export_revision === "number"
                  ? ((workflow.metadata.consent_export as Record<string, unknown>).export_revision as number)
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
            setError(`Approved reply sent, but encrypted PKM writeback failed: ${message}`);
            return;
          }

          next = await OneKycService.writebackComplete({
            ...input,
            artifactHash,
            status: writeback.success ? "succeeded" : "failed",
            errorMessage: writeback.success ? null : writeback.message || "PKM writeback failed.",
          });
          if (!writeback.success) {
            updateWorkflow(next);
            setError(
              `Approved reply sent, but encrypted PKM writeback failed: ${
                writeback.message || "PKM writeback failed."
              }`
            );
            return;
          }
        } else if (action === "reject") {
          next = await OneKycService.rejectDraft({ ...input, reason: "Rejected from One KYC." });
        } else {
          next = await OneKycService.refreshWorkflow(input);
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
      localExportPayloads,
      localDrafts,
      redraftInstructions,
      updateWorkflow,
      vaultKey,
      vaultOwnerToken,
    ]
  );

  const submitScopeSelection = useCallback(
    async (workflow: OneKycWorkflow) => {
      if (!auth.userId || !vaultOwnerToken) return;
      const selectedScopes = selectedScopesForWorkflow(workflow, selectedScopesByWorkflow);
      if (!selectedScopes.length) {
        setError("Select at least one scope before requesting consent.");
        return;
      }
      setBusy("scope");
      setError(null);
      try {
        const next = await OneKycService.selectScopes({
          userId: auth.userId,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
          selectedScopes,
        });
        updateWorkflow(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Scope selection failed.");
      } finally {
        setBusy(null);
      }
    },
    [auth.userId, selectedScopesByWorkflow, updateWorkflow, vaultOwnerToken]
  );

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
          title="KYC workflows"
          description="Review broker KYC requests, consent status, and approval-gated drafts from one@hushh.ai."
          icon={ShieldCheck}
          accent="consent"
          actions={
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="grid gap-4 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
        <div className="space-y-4">
          <SurfaceCard>
            <SurfaceCardHeader>
              <SurfaceCardTitle>Inbox</SurfaceCardTitle>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-2">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading workflows.</p>
              ) : workflows.length === 0 ? (
                <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  <Inbox className="mt-0.5 size-4 shrink-0" />
                  <span>No KYC emails have been matched to this account yet.</span>
                </div>
              ) : (
                workflows.map((workflow) => (
                  <button
                    key={workflow.workflow_id}
                    type="button"
                    onClick={() => setSelectedId(workflow.workflow_id)}
                    className={`w-full rounded-md border p-3 text-left transition hover:bg-muted/60 ${
                      selected?.workflow_id === workflow.workflow_id
                        ? "border-foreground/30 bg-muted"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm font-medium">
                        {workflow.subject || "KYC request"}
                      </p>
                      <Badge variant={statusVariant(workflow.status)}>
                        {STATUS_LABELS[workflow.status] || workflow.status}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {workflow.counterparty_label || workflow.sender_email || "Counterparty"}
                    </p>
                  </button>
                ))
              )}
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceCard>
            <SurfaceCardHeader>
              <SurfaceCardTitle>Email aliases</SurfaceCardTitle>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {emailAliases
                  .filter((alias) => alias.verification_status === "verified")
                  .map((alias) => (
                    <Badge key={alias.alias_id || alias.email_normalized} variant="secondary">
                      {alias.email}
                    </Badge>
                  ))}
                {emailAliases.filter((alias) => alias.verification_status === "verified").length === 0 ? (
                  <span className="text-sm text-muted-foreground">No verified aliases.</span>
                ) : null}
              </div>
              <Input
                type="email"
                value={aliasEmail}
                onChange={(event) => setAliasEmail(event.target.value)}
                placeholder="original@example.com"
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
                  UAT code: {aliasChallenge.reviewCode}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void startAliasVerification()}
                  disabled={Boolean(busy) || !aliasEmail.trim()}
                >
                  <MailPlus className="size-4" />
                  Register alias
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void confirmAliasVerification()}
                  disabled={Boolean(busy) || !aliasChallenge || !aliasCode.trim()}
                >
                  Verify
                </Button>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>
        </div>

        <SurfaceCard>
          <SurfaceCardHeader>
            <SurfaceCardTitle>{selected?.subject || "Workflow details"}</SurfaceCardTitle>
          </SurfaceCardHeader>
          <SurfaceCardContent className="space-y-5">
            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {!selected ? (
              <p className="text-sm text-muted-foreground">Select a workflow to review.</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Info label="Status" value={STATUS_LABELS[selected.status] || selected.status} />
                  <Info label="Counterparty" value={selected.counterparty_label || selected.sender_email || "-"} />
                  <Info label="Intent" value={detectedDomains(selected).join(", ") || "-"} />
                  <Info label="Scopes" value={selectedScopeLabels(selected).join(", ") || selected.requested_scope || "-"} />
                  <Info label="Updated" value={selected.updated_at ? new Date(selected.updated_at).toLocaleString() : "-"} />
                  <Info label="Thread" value={threadStatusLabel(selected)} />
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Required fields</p>
                  <div className="flex flex-wrap gap-2">
                    {(selected.required_fields.length ? selected.required_fields : ["identity_profile"]).map((field) => (
                      <Badge key={field} variant="outline">
                        {field.replaceAll("_", " ")}
                      </Badge>
                    ))}
                  </div>
                </div>

                {selected.status === "needs_client_connector" ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
                    Unlock completed. Sync this workflow so One can request scoped consent with your client-held KYC connector.
                  </div>
                ) : null}

                {selected.status === "needs_scope" ? (
                  <div className="space-y-3 rounded-md border bg-background/60 p-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Recommended scopes</p>
                      <p className="text-xs text-muted-foreground">
                        Confirm the scopes One should request before any encrypted export is prepared.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {scopeCandidates(selected).map((candidate) => {
                        const checked = selectedScopesForWorkflow(
                          selected,
                          selectedScopesByWorkflow
                        ).includes(candidate.scope);
                        return (
                          <label
                            key={candidate.scope}
                            className="flex items-start gap-3 rounded-md border p-3 text-sm"
                          >
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={checked}
                              onChange={() => toggleScope(selected, candidate.scope)}
                              disabled={Boolean(selected.consent_request_url)}
                            />
                            <span className="space-y-1">
                              <span className="block font-medium">
                                {candidate.label || candidate.scope}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {candidate.description || candidate.scope}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {candidate.reason || "Detected from the email text."}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!selected.consent_request_url ? (
                        <Button
                          type="button"
                          onClick={() => void submitScopeSelection(selected)}
                          disabled={
                            Boolean(busy) ||
                            selectedScopesForWorkflow(selected, selectedScopesByWorkflow).length === 0
                          }
                        >
                          <ShieldCheck className="size-4" />
                          Request consent
                        </Button>
                      ) : (
                        <Button asChild>
                          <a href={selected.consent_request_url} data-voice-control-id="one-kyc-open-consent">
                            <ShieldCheck className="size-4" />
                            Review consent
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                ) : null}

                {selected.metadata?.reply_thread ? (
                  <div className="space-y-2 rounded-md border bg-background/60 p-3">
                    <p className="text-sm font-medium">Reply preview</p>
                    <Info
                      label="To"
                      value={replyThreadValue(selected, "reply_all_to") || selected.sender_email || "-"}
                    />
                    <Info label="Cc" value={replyThreadValue(selected, "reply_all_cc") || "-"} />
                  </div>
                ) : null}

                {selectedDraft ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Draft reply</p>
                    <pre
                      className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-4 text-sm leading-6"
                      data-voice-control-id="one-kyc-draft-review"
                    >
                      {selectedDraft.body}
                    </pre>
                    {selectedDraft.missingFields.length > 0 ? (
                      <p className="text-sm text-amber-700 dark:text-amber-200">
                        Approved export did not contain: {selectedDraft.missingFields.map((field) => field.replaceAll("_", " ")).join(", ")}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {selected.status === "needs_documents" ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
                    One needs additional approved identity details before it can prepare a complete KYC reply.
                  </div>
                ) : null}

                {selected.last_error_message ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
                    {selected.last_error_message}
                  </div>
                ) : null}

                {selected.status === "waiting_on_user" ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Redraft instructions</p>
                    <Textarea
                      value={redraftInstructions}
                      onChange={(event) => setRedraftInstructions(event.target.value)}
                      maxLength={1000}
                      placeholder="Example: make it shorter, make it more formal, or mention that more documents can be provided on request."
                      className="min-h-24"
                      data-voice-control-id="one-kyc-redraft-instructions"
                    />
                    <Button
                      variant="outline"
                      onClick={() => void runAction("redraft", selected)}
                      disabled={Boolean(busy) || !redraftInstructions.trim() || !selectedDraft}
                      data-voice-control-id="one-kyc-redraft"
                      data-voice-action-id="kyc.draft.request_redraft"
                    >
                      <Wand2 className="size-4" />
                      Redraft
                    </Button>
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
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
                    disabled={Boolean(busy) || selected.status !== "waiting_on_user" || !selectedDraft}
                    data-voice-control-id="one-kyc-approve-send"
                    data-voice-action-id="kyc.draft.approve_send"
                  >
                    <Send className="size-4" />
                    Approve send
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void runAction("reject", selected)}
                    disabled={Boolean(busy) || selected.status !== "waiting_on_user"}
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
              </>
            )}

            <Button asChild variant="ghost" size="sm">
              <Link href={ROUTES.CONSENTS}>Open Consent Center</Link>
            </Button>
          </SurfaceCardContent>
        </SurfaceCard>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background/60 p-3">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm">{value}</p>
    </div>
  );
}

function scopeCandidates(workflow: OneKycWorkflow): OneKycScopeCandidate[] {
  const direct = workflow.candidate_scopes;
  if (Array.isArray(direct) && direct.length) return direct;
  const metadataCandidates = workflow.metadata?.candidate_scopes;
  if (Array.isArray(metadataCandidates)) {
    return metadataCandidates.filter(
      (candidate): candidate is OneKycScopeCandidate =>
        Boolean(candidate && typeof candidate === "object" && "scope" in candidate)
    );
  }
  return workflow.requested_scope
    ? [
        {
          scope: workflow.requested_scope,
          domain: workflow.requested_scope.includes("financial") ? "financial" : "identity",
          label: workflow.requested_scope,
        },
      ]
    : [];
}

function selectedScopesForWorkflow(
  workflow: OneKycWorkflow,
  localSelections: Record<string, string[]>
): string[] {
  const local = localSelections[workflow.workflow_id];
  if (local) return local;
  if (Array.isArray(workflow.selected_scopes) && workflow.selected_scopes.length) {
    return workflow.selected_scopes;
  }
  if (Array.isArray(workflow.requested_scopes) && workflow.requested_scopes.length) {
    return workflow.requested_scopes;
  }
  const recommended = scopeCandidates(workflow)
    .filter((candidate) => candidate.recommended !== false)
    .map((candidate) => candidate.scope);
  if (recommended.length) return recommended;
  return workflow.requested_scope ? [workflow.requested_scope] : [];
}

function selectedScopeLabels(workflow: OneKycWorkflow): string[] {
  const selectedScopes = new Set(selectedScopesForWorkflow(workflow, {}));
  return scopeCandidates(workflow)
    .filter((candidate) => selectedScopes.has(candidate.scope))
    .map((candidate) => candidate.label || candidate.scope);
}

function detectedDomains(workflow: OneKycWorkflow): string[] {
  const fromCandidates = scopeCandidates(workflow)
    .map((candidate) => candidate.domain)
    .filter(Boolean);
  if (fromCandidates.length) return Array.from(new Set(fromCandidates));
  const metadata = workflow.metadata?.detected_domains;
  return Array.isArray(metadata) ? metadata.map(String) : [];
}

function replyThreadValue(workflow: OneKycWorkflow, key: "reply_all_to" | "reply_all_cc"): string {
  const thread = workflow.metadata?.reply_thread;
  if (!thread || typeof thread !== "object") return "";
  const value = (thread as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

function threadStatusLabel(workflow: OneKycWorkflow): string {
  if (workflow.thread_match_status === "matched") return "Reply threaded";
  if (workflow.thread_match_status === "mismatched") return "Sent in new thread";
  if (workflow.thread_match_status === "unknown") return "Thread verification pending";
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
