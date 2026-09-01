"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail } from "lucide-react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import {
  GmailInformationRequestsService,
  type GmailInformationRequestCandidateScope,
  type GmailInformationRequestPreference,
  type GmailInformationRequestWorkflow,
} from "@/lib/services/gmail-information-requests-service";

type Props = {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isConnected: boolean;
  idTokenProvider: (() => Promise<string>) | null;
  onRequestVaultUnlock: () => void;
};

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;
}

function fieldLabels(workflow: GmailInformationRequestWorkflow): string {
  return (
    workflow.requested_field_labels.slice(0, 3).join(", ") ||
    "Personal information"
  );
}

export function isExactDraftCandidate(
  candidate: GmailInformationRequestCandidateScope,
): boolean {
  const domain = candidate.domain.trim().toLowerCase();
  const scope = candidate.scope.trim().toLowerCase();
  const prefix = `attr.${domain}.`;
  const path = scope.startsWith(prefix) ? scope.slice(prefix.length) : "";
  return (
    Boolean(domain) &&
    /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(path) &&
    !path.includes("*") &&
    candidate.segment_ids.length === 1 &&
    /^[a-z0-9_]{1,64}$/.test(candidate.segment_ids[0]?.trim().toLowerCase() || "")
  );
}

function validCandidates(workflow: GmailInformationRequestWorkflow) {
  return workflow.candidate_scopes.filter(isExactDraftCandidate);
}

function valuesForDraft(value: unknown, label: string, depth = 0): string[] {
  if (value === null || value === undefined || depth > 2) return [];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const text = String(value).trim();
    return text ? [`${label}: ${text}`] : [];
  }
  if (Array.isArray(value)) {
    const scalarValues = value
      .filter((item) => ["string", "number", "boolean"].includes(typeof item))
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 8);
    return scalarValues.length ? [`${label}: ${scalarValues.join(", ")}`] : [];
  }
  if (typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, nested]) =>
      valuesForDraft(
        nested,
        `${label} · ${key.replaceAll("_", " ")}`,
        depth + 1,
      ),
    )
    .slice(0, 20);
}

function WorkflowCard({
  workflow,
  selectedScopes,
  onToggleScope,
  draft,
  busy,
  onPrepareDraft,
  onPrepareSend,
  onSend,
  onIgnore,
  onDraftChange,
}: {
  workflow: GmailInformationRequestWorkflow;
  selectedScopes: string[];
  onToggleScope: (scope: string) => void;
  draft:
    | {
        body: string;
        actionId?: string;
        preview?: {
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          gmailThreadId: string;
        };
      }
    | undefined;
  busy: boolean;
  onPrepareDraft: () => void;
  onPrepareSend: () => void;
  onSend: () => void;
  onIgnore: () => void;
  onDraftChange: (body: string) => void;
}) {
  const candidates = validCandidates(workflow);
  return (
    <div className="space-y-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-foreground">Information requested</p>
          <p className="truncate text-xs text-muted-foreground">{fieldLabels(workflow)}</p>
          {workflow.received_at ? (
            <p className="text-xs text-muted-foreground">
              Received {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(workflow.received_at))}
            </p>
          ) : null}
          {workflow.attachment_review_required ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              This email has attachments. Review them in Gmail; attachments are not read automatically.
            </p>
          ) : null}
          {candidates.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {candidates.map((scope) => (
                <Button
                  key={scope.scope}
                  type="button"
                  variant="muted"
                  size="sm"
                  className="min-h-8 text-[11px]"
                  aria-pressed={selectedScopes.includes(scope.scope)}
                  onClick={() => onToggleScope(scope.scope)}
                >
                  {selectedScopes.includes(scope.scope) ? "Selected: " : "Available: "}
                  {scope.label}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No matching private information is available for an automatic draft.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {workflow.gmail_thread_id ? (
            <Button
              type="button"
              variant="muted"
              size="sm"
              onClick={() => openExternalUrl(gmailThreadUrl(workflow.gmail_thread_id!))}
            >
              Open email
            </Button>
          ) : null}
          <Button type="button" variant="muted" size="sm" disabled={busy} onClick={onIgnore}>
            Ignore
          </Button>
          {candidates.length ? (
            <Button
              type="button"
              variant="muted"
              size="sm"
              disabled={busy || !selectedScopes.length}
              onClick={onPrepareDraft}
            >
              {busy && !draft ? "Preparing…" : "Prepare private draft"}
            </Button>
          ) : null}
        </div>
      </div>
      {draft ? (
        <div className="space-y-2 border-t border-border/60 pt-3">
          <textarea
            value={draft.body}
            onChange={(event) => onDraftChange(event.target.value)}
            className="min-h-36 w-full rounded-lg border border-border bg-background p-3 text-sm text-foreground"
            aria-label="Private information reply draft"
          />
          {draft.preview ? (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <p><span className="font-medium text-foreground">To:</span> {draft.preview.to.join(", ")}</p>
              {draft.preview.cc.length ? <p><span className="font-medium text-foreground">Cc:</span> {draft.preview.cc.join(", ")}</p> : null}
              <p><span className="font-medium text-foreground">Subject:</span> {draft.preview.subject}</p>
              <p className="pt-1">This reply stays in the original Gmail thread.</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {draft.actionId ? (
              <Button type="button" size="sm" disabled={busy} onClick={onSend}>
                {busy ? "Sending…" : "Send approved reply"}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy || !draft.body.trim()}
                onClick={onPrepareSend}
              >
                {busy ? "Preparing…" : "Review send"}
              </Button>
            )}
            <p className="self-center text-xs text-muted-foreground">
              {draft.preview
                ? "Confirm this exact recipient and subject before sending."
                : "Review the recipient and subject before the final send approval."}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The owner-facing personal-Gmail opt-in and metadata-only request queue. It
 * stays beside Gmail's existing receipt and nudge features, while platform
 * mailbox KYC remains available at /one/kyc during migration.
 */
export default function GmailInformationRequestsSection({
  userId,
  vaultKey,
  vaultOwnerToken,
  isConnected,
  idTokenProvider,
  onRequestVaultUnlock,
}: Props) {
  const [preference, setPreference] =
    useState<GmailInformationRequestPreference | null>(null);
  const [workflows, setWorkflows] = useState<GmailInformationRequestWorkflow[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<
    Record<string, string[]>
  >({});
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        body: string;
        actionId?: string;
        preview?: {
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          gmailThreadId: string;
        };
      }
    >
  >({});
  const [busyWorkflowId, setBusyWorkflowId] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  const load = useCallback(async () => {
    if (!isConnected || !userId || !idTokenProvider) return;
    setLoading(true);
    setError(null);
    try {
      const firebaseIdToken = await idTokenProvider();
      const nextPreference =
        await GmailInformationRequestsService.getPreference({
          userId,
          firebaseIdToken,
        });
      setPreference(nextPreference);
      if (nextPreference.monitoring_enabled && vaultOwnerToken) {
        const response = await GmailInformationRequestsService.list({
          firebaseIdToken,
          vaultOwnerToken,
          limit: 25,
        });
        setWorkflows(response.workflows);
        setNextOffset(response.next_offset);
        setTotalCount(response.total_count);
      } else {
        setWorkflows([]);
        setNextOffset(null);
        setTotalCount(0);
      }
    } catch {
      setError(
        "Personal information-request monitoring is unavailable right now.",
      );
    } finally {
      setLoading(false);
    }
  }, [idTokenProvider, isConnected, userId, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const setMonitoring = useCallback(
    async (enabled: boolean) => {
      if (!userId || !idTokenProvider) return;
      setUpdating(true);
      setError(null);
      try {
        const firebaseIdToken = await idTokenProvider();
        const next = await GmailInformationRequestsService.setPreference({
          userId,
          firebaseIdToken,
          enabled,
        });
        setPreference(next);
        if (!enabled) {
          setWorkflows([]);
          setSelectedScopes({});
          setDrafts({});
          setNextOffset(null);
          setTotalCount(0);
        } else if (vaultOwnerToken) {
          const response = await GmailInformationRequestsService.list({
            firebaseIdToken,
            vaultOwnerToken,
            limit: 25,
          });
          setWorkflows(response.workflows);
          setNextOffset(response.next_offset);
          setTotalCount(response.total_count);
        }
      } catch {
        setError(
          "We could not update personal information-request monitoring.",
        );
      } finally {
        setUpdating(false);
      }
    },
    [idTokenProvider, userId, vaultOwnerToken],
  );

  const scan = useCallback(async () => {
    if (!vaultOwnerToken || !idTokenProvider) return;
    setLoading(true);
    setError(null);
    try {
      const firebaseIdToken = await idTokenProvider();
      await GmailInformationRequestsService.scan({
        firebaseIdToken,
        vaultOwnerToken,
      });
      const response = await GmailInformationRequestsService.list({
        firebaseIdToken,
        vaultOwnerToken,
        limit: 25,
      });
      setWorkflows(response.workflows);
      setNextOffset(response.next_offset);
      setTotalCount(response.total_count);
    } catch {
      setError("We could not check your inbox for information requests.");
    } finally {
      setLoading(false);
    }
  }, [idTokenProvider, vaultOwnerToken]);

  const loadMore = useCallback(async () => {
    if (!vaultOwnerToken || !idTokenProvider || nextOffset === null) return;
    setLoading(true);
    setError(null);
    try {
      const firebaseIdToken = await idTokenProvider();
      const response = await GmailInformationRequestsService.list({
        firebaseIdToken,
        vaultOwnerToken,
        limit: 25,
        offset: nextOffset,
      });
      setWorkflows((current) => [...current, ...response.workflows]);
      setNextOffset(response.next_offset);
      setTotalCount(response.total_count);
    } catch {
      setError("We could not load more information requests.");
    } finally {
      setLoading(false);
    }
  }, [idTokenProvider, nextOffset, vaultOwnerToken]);

  const toggleScope = useCallback((workflowId: string, scope: string) => {
    setSelectedScopes((current) => {
      const selected = current[workflowId] || [];
      return {
        ...current,
        [workflowId]: selected.includes(scope)
          ? selected.filter((item) => item !== scope)
          : [...selected, scope],
      };
    });
    setDrafts((current) => {
      const { [workflowId]: _discarded, ...remaining } = current;
      return remaining;
    });
  }, []);

  const prepareDraft = useCallback(
    async (workflow: GmailInformationRequestWorkflow) => {
      if (!userId || !vaultKey || !vaultOwnerToken) return;
      const selected = selectedScopes[workflow.workflow_id] || [];
      if (!selected.length) return;
      setBusyWorkflowId(workflow.workflow_id);
      setError(null);
      try {
        const candidateByScope = new Map(
          validCandidates(workflow).map((candidate) => [
            candidate.scope,
            candidate,
          ]),
        );
        const lines: string[] = [];
        for (const scope of selected) {
          const candidate = candidateByScope.get(scope);
          if (!candidate || !isExactDraftCandidate(candidate)) continue;
          const snapshot = await PkmDomainResourceService.getStaleFirst({
            userId,
            domain: candidate.domain,
            segmentIds: candidate.segment_ids,
            vaultKey,
            vaultOwnerToken,
            backgroundRefresh: false,
          });
          const projection = projectDomainDataForScope({
            domain: candidate.domain,
            scope: candidate.scope,
            domainData: snapshot?.data || {},
            approvedPaths: [candidate.scope.slice(`attr.${candidate.domain}.`.length)],
          });
          lines.push(...valuesForDraft(projection[candidate.domain], candidate.label));
        }
        if (!lines.length) {
          throw new Error(
            "No approved private details were available for these fields.",
          );
        }
        const body = [
          "Hello,",
          "",
          "Here are the requested details:",
          "",
          ...lines,
          "",
          "Please let me know if you need anything else.",
        ].join("\n");
        setDrafts((current) => ({
          ...current,
          [workflow.workflow_id]: { body },
        }));
      } catch (draftError) {
        setError(
          draftError instanceof Error
            ? draftError.message
            : "We could not prepare your private reply draft.",
        );
      } finally {
        setBusyWorkflowId(null);
      }
    },
    [selectedScopes, userId, vaultKey, vaultOwnerToken],
  );

  const prepareSend = useCallback(
    async (workflow: GmailInformationRequestWorkflow) => {
      if (!vaultOwnerToken || !idTokenProvider) return;
      const draft = drafts[workflow.workflow_id];
      if (!draft?.body.trim()) return;
      setBusyWorkflowId(workflow.workflow_id);
      setError(null);
      try {
        const firebaseIdToken = await idTokenProvider();
        const prepared = await GmailInformationRequestsService.prepareReply({
          firebaseIdToken,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
          body: draft.body,
          idempotencyKey: crypto.randomUUID(),
        });
        setDrafts((current) => ({
          ...current,
          [workflow.workflow_id]: {
            ...draft,
            actionId: prepared.actionId,
            preview: prepared.preview,
          },
        }));
      } catch {
        setError(
          "We could not prepare this reply for sending. Review the original email and try again.",
        );
      } finally {
        setBusyWorkflowId(null);
      }
    },
    [drafts, idTokenProvider, vaultOwnerToken],
  );

  const sendReply = useCallback(
    async (workflow: GmailInformationRequestWorkflow) => {
      if (!vaultOwnerToken || !idTokenProvider) return;
      const draft = drafts[workflow.workflow_id];
      if (!draft?.actionId || !draft.body.trim()) return;
      setBusyWorkflowId(workflow.workflow_id);
      setError(null);
      try {
        const firebaseIdToken = await idTokenProvider();
        const result = await GmailInformationRequestsService.sendReply({
          firebaseIdToken,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
          actionId: draft.actionId,
          body: draft.body,
        });
        if (result.state === "sent") {
          setWorkflows((current) =>
            current.filter((item) => item.workflow_id !== workflow.workflow_id),
          );
          setDrafts((current) => {
            const { [workflow.workflow_id]: _discarded, ...remaining } =
              current;
            return remaining;
          });
          setSelectedScopes((current) => {
            const { [workflow.workflow_id]: _discarded, ...remaining } = current;
            return remaining;
          });
          setTotalCount((current) => Math.max(0, current - 1));
        } else {
          setError(
            "Gmail did not confirm delivery. Check Sent Mail before trying again.",
          );
        }
      } catch {
        setError(
          "We could not send this reply. Check Sent Mail before trying again.",
        );
      } finally {
        setBusyWorkflowId(null);
      }
    },
    [drafts, idTokenProvider, vaultOwnerToken],
  );

  const ignoreWorkflow = useCallback(
    async (workflow: GmailInformationRequestWorkflow) => {
      if (!vaultOwnerToken || !idTokenProvider) return;
      setBusyWorkflowId(workflow.workflow_id);
      setError(null);
      try {
        const firebaseIdToken = await idTokenProvider();
        await GmailInformationRequestsService.ignore({
          firebaseIdToken,
          vaultOwnerToken,
          workflowId: workflow.workflow_id,
        });
        setWorkflows((current) =>
          current.filter((item) => item.workflow_id !== workflow.workflow_id),
        );
        setSelectedScopes((current) => {
          const { [workflow.workflow_id]: _ignored, ...remaining } = current;
          return remaining;
        });
        setDrafts((current) => {
          const { [workflow.workflow_id]: _ignored, ...remaining } = current;
          return remaining;
        });
        setTotalCount((current) => Math.max(0, current - 1));
      } catch {
        setError("We could not ignore this information request.");
      } finally {
        setBusyWorkflowId(null);
      }
    },
    [idTokenProvider, vaultOwnerToken],
  );

  if (!isConnected) return null;

  const enabled = preference?.monitoring_enabled === true;
  return (
    <SurfaceInset className="space-y-3 px-4 py-4 text-sm sm:px-5 sm:py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium text-foreground">Information requests</p>
          <p className="text-sm leading-6 text-muted-foreground">
            Find verification and KYC-style requests in your personal Gmail.
            Every future disclosure still needs a scoped review and an explicit
            send approval.
          </p>
        </div>
        {enabled ? <Badge variant="secondary">Monitoring on</Badge> : null}
      </div>

      {enabled ? (
        <div className="rounded-xl border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground">
          <div className="flex items-start gap-2">
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <p>
              Hussh temporarily classifies recent inbox messages and retains
              only request metadata, never the email body, subject, addresses,
              or your private information.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground">
          Turn this on to allow server-side background classification of your
          recent personal Gmail messages. It does not grant permission to share
          private information or send email.
        </div>
      )}

      {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={enabled ? "muted" : "blue-gradient"}
          disabled={updating || loading}
          onClick={() => void setMonitoring(!enabled)}
        >
          {updating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Mail className="mr-2 h-4 w-4" />
          )}
          {enabled ? "Turn off monitoring" : "Turn on monitoring"}
        </Button>
        {enabled ? (
          <Button
            type="button"
            size="sm"
            variant="muted"
            disabled={loading}
            onClick={() => (vaultOwnerToken ? void scan() : onRequestVaultUnlock())}
          >
            {loading
              ? "Checking…"
              : vaultOwnerToken
                ? "Check recent inbox"
                : "Unlock to check inbox"}
          </Button>
        ) : null}
      </div>

      {enabled && !vaultOwnerToken ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Unlock your private vault to view requests, check Gmail, or prepare a draft.</p>
          <Button type="button" size="sm" variant="muted" onClick={onRequestVaultUnlock}>
            Unlock private vault
          </Button>
        </div>
      ) : null}

      {enabled && workflows.length ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Showing {workflows.length} of {totalCount} requests
          </p>
          {workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.workflow_id}
              workflow={workflow}
              selectedScopes={selectedScopes[workflow.workflow_id] || []}
              onToggleScope={(scope) =>
                toggleScope(workflow.workflow_id, scope)
              }
              draft={drafts[workflow.workflow_id]}
              busy={busyWorkflowId === workflow.workflow_id}
              onPrepareDraft={() => void prepareDraft(workflow)}
              onPrepareSend={() => void prepareSend(workflow)}
              onSend={() => void sendReply(workflow)}
              onIgnore={() => void ignoreWorkflow(workflow)}
              onDraftChange={(body) =>
                setDrafts((current) => ({
                  ...current,
                  [workflow.workflow_id]: { body },
                }))
              }
            />
          ))}
          {nextOffset !== null ? (
            <Button
              type="button"
              variant="muted"
              size="sm"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {loading ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      ) : enabled && vaultOwnerToken && !loading ? (
        <p className="text-xs text-muted-foreground">
          No information requests found yet.
        </p>
      ) : null}
    </SurfaceInset>
  );
}
