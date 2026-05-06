"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Inbox, RefreshCw, Send, ShieldCheck, Wand2, XCircle } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useRequireAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  KycWorkflowPkmService,
  type KycWorkflowCheck,
  type KycWorkflowCheckKey,
  type KycWorkflowStatus,
} from "@/lib/services/kyc-pkm-write-service";
import { OneKycClientZkService, sha256Hex, type KycDraftBuildResult } from "@/lib/services/one-kyc-client-zk-service";
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
  const [connectorReady, setConnectorReady] = useState(false);

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
        const exportPackage = await OneKycService.getWorkflowConsentExport({
          userId: auth.userId,
          vaultOwnerToken,
          workflowId: selected.workflow_id,
        });
        const exportPayload = await OneKycClientZkService.decryptScopedExport({
          exportPackage,
          connector,
        });
        const draft = await OneKycClientZkService.buildDraft({
          workflow: selected,
          exportPayload,
        });
        if (!cancelled) {
          setLocalDrafts((current) => ({ ...current, [selected.workflow_id]: draft }));
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
          const body = `${localDraft.body}

---
User requested adjustment: ${redraftInstructions.trim()}`.slice(0, 6000);
          setLocalDrafts((current) => ({
            ...current,
            [workflow.workflow_id]: {
              ...localDraft,
              body,
              draftHash: "",
            },
          }));
          const draftHash = await sha256Hex(body);
          setLocalDrafts((current) => ({
            ...current,
            [workflow.workflow_id]: {
              ...localDraft,
              body,
              draftHash,
            },
          }));
          const next = await OneKycService.redraft({
            ...input,
            instructions: redraftInstructions.trim(),
            source: "text",
          });
          updateWorkflow(next);
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
          const artifact = {
            checks,
            overall_status: overallStatus,
            counterparty: workflow.counterparty_label || workflow.sender_email || null,
            request_summary: workflow.subject || null,
            pending_requirements: localDraft.missingFields,
            completed_requirements: workflow.required_fields.filter(
              (field) => !localDraft.missingFields.includes(field)
            ),
          };
          const artifactHash = await sha256Hex(JSON.stringify(artifact));
          next = await OneKycService.sendApprovedReply({
            ...input,
            approvedSubject: localDraft.subject || workflow.draft_subject,
            approvedBody: localDraft.body,
            clientDraftHash: localDraft.draftHash,
            consentExportRevision:
              typeof workflow.consent_export?.export_revision === "number"
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
      localDrafts,
      redraftInstructions,
      updateWorkflow,
      vaultKey,
      vaultOwnerToken,
    ]
  );

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
                  <Info label="Scope" value={selected.requested_scope || "-"} />
                  <Info label="Updated" value={selected.updated_at ? new Date(selected.updated_at).toLocaleString() : "-"} />
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

                {selected.status === "needs_scope" && selected.consent_request_url ? (
                  <Button asChild>
                    <a href={selected.consent_request_url} data-voice-control-id="one-kyc-open-consent">
                      <ShieldCheck className="size-4" />
                      Review consent
                    </a>
                  </Button>
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
                        Missing approved fields: {selectedDraft.missingFields.map((field) => field.replaceAll("_", " ")).join(", ")}
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
