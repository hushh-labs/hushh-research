"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mail, MailCheck, RefreshCw } from "@/components/icons";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import {
  isExactGmailInformationRequestCandidate,
  prepareScopedGmailInformationRequestDraft,
} from "@/lib/services/gmail-information-request-draft-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import {
  GmailInformationRequestsService,
  type GmailInformationRequestCandidateScope,
  type GmailInformationRequestPreference,
  type GmailInformationRequestScan,
  type GmailInformationRequestWorkflow,
} from "@/lib/services/gmail-information-requests-service";
import { apiErrorCode } from "@/lib/services/api-client";

type Props = {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isConnected: boolean;
  idTokenProvider: (() => Promise<string>) | null;
  onRequestVaultUnlock: () => void;
  onEnableGmailSend?: () => void;
};

function needsGmailSendPermission(error: unknown): boolean {
  const code = apiErrorCode(error);
  return (
    code === "GMAIL_SEND_PERMISSION_REQUIRED" || code === "GMAIL_SEND_DISABLED"
  );
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;
}

function fieldLabels(workflow: GmailInformationRequestWorkflow): string {
  return (
    workflow.requested_field_labels
      .slice(0, 3)
      .map((label) => {
        const readable = label
          .replace(/[_-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return readable
          ? `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`
          : "";
      })
      .filter(Boolean)
      .join(", ") ||
    "Personal information"
  );
}

function newestRequestsFirst(
  left: GmailInformationRequestWorkflow,
  right: GmailInformationRequestWorkflow,
): number {
  const timestamp = (workflow: GmailInformationRequestWorkflow) => {
    const value = workflow.received_at || workflow.created_at;
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return timestamp(right) - timestamp(left) || right.workflow_id.localeCompare(left.workflow_id);
}

function mergeWorkflow(
  current: GmailInformationRequestWorkflow[],
  workflow: GmailInformationRequestWorkflow,
): GmailInformationRequestWorkflow[] {
  const withoutExisting = current.filter(
    (item) => item.workflow_id !== workflow.workflow_id,
  );
  return [...withoutExisting, workflow].sort(newestRequestsFirst);
}

function KycRequestListSkeleton({
  label = "KYC requests",
}: {
  label?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={`Loading ${label}`}
      className="space-y-2"
      role="status"
    >
      <p className="sr-only">Loading {label}. Gmail remains available.</p>
      {Array.from({ length: 2 }, (_, index) => (
        <div
          aria-hidden="true"
          className="space-y-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3"
          key={index}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-10 w-24 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

function KycWorkspaceLoadingSkeleton() {
  return (
    <>
      <div
        aria-busy="true"
        aria-label="Loading KYC workspace"
        className="flex flex-col gap-3 rounded-[var(--app-card-radius-sm)] border border-primary/15 bg-primary/[0.045] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-11 w-full sm:w-28" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
      <KycRequestListSkeleton />
    </>
  );
}

export function isExactDraftCandidate(
  candidate: GmailInformationRequestCandidateScope,
): boolean {
  return isExactGmailInformationRequestCandidate(candidate);
}

function validCandidates(workflow: GmailInformationRequestWorkflow) {
  return workflow.candidate_scopes.filter(isExactDraftCandidate);
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
          <p className="text-sm font-semibold text-foreground">
            Information requested
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {fieldLabels(workflow)}
          </p>
          {workflow.received_at ? (
            <p className="text-xs text-muted-foreground">
              Received{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
              }).format(new Date(workflow.received_at))}
            </p>
          ) : null}
          {workflow.attachment_review_required ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              This mail has attachments. Review them in Mail; attachments are
              not read automatically.
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
                  {selectedScopes.includes(scope.scope)
                    ? "Selected: "
                    : "Available: "}
                  {scope.label}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No matching private information is available for an automatic
              draft.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {workflow.gmail_thread_id ? (
            <Button
              type="button"
              variant="muted"
              size="sm"
              className="min-h-11"
              onClick={() =>
                openExternalUrl(gmailThreadUrl(workflow.gmail_thread_id!))
              }
            >
              Open mail
            </Button>
          ) : null}
          <Button
            type="button"
            variant="muted"
            size="sm"
            className="min-h-11"
            disabled={busy}
            onClick={onIgnore}
          >
            Ignore
          </Button>
          {candidates.length ? (
            <Button
              type="button"
              variant="muted"
              size="sm"
              className="min-h-11"
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
              <p>
                <span className="font-medium text-foreground">To:</span>{" "}
                {draft.preview.to.join(", ")}
              </p>
              {draft.preview.cc.length ? (
                <p>
                  <span className="font-medium text-foreground">Cc:</span>{" "}
                  {draft.preview.cc.join(", ")}
                </p>
              ) : null}
              <p>
                <span className="font-medium text-foreground">Subject:</span>{" "}
                {draft.preview.subject}
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {draft.actionId ? (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                disabled={busy}
                onClick={onSend}
              >
                {busy ? "Sending…" : "Send approved reply"}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
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

function WorkflowQueueCard({
  workflow,
  onReview,
  onDraftWithOne,
}: {
  workflow: GmailInformationRequestWorkflow;
  onReview: () => void;
  onDraftWithOne: () => void;
}) {
  return (
    <div className="rounded-[var(--app-card-radius-md)] border border-[color:var(--app-card-border-standard)] bg-background/60 px-4 py-4 transition-colors hover:border-primary/25 hover:bg-primary/[0.025]">
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
            <MailCheck className="h-[18px] w-[18px]" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Information requested
            </p>
            <p className="line-clamp-2 text-xs leading-5 text-muted-foreground sm:truncate sm:leading-normal">
              {fieldLabels(workflow)}
            </p>
            <p className="text-xs text-muted-foreground">
              {workflow.received_at
                ? `Received ${new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                  }).format(new Date(workflow.received_at))}`
                : "New request"}
              {workflow.attachment_review_required
                ? " · Attachment included"
                : ""}
            </p>
          </div>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:w-[19.5rem] sm:shrink-0 sm:grid-cols-[minmax(0,1fr)_8.25rem]">
          <Button
            type="button"
            size="sm"
            className="min-h-11 min-w-0 justify-center"
            onClick={onDraftWithOne}
          >
            Draft with One
          </Button>
          <Button
            type="button"
            variant="muted"
            size="sm"
            className="min-h-11 min-w-0 justify-center"
            onClick={onReview}
          >
            Review
          </Button>
        </div>
      </div>
    </div>
  );
}

function ActivityCard({
  workflow,
}: {
  workflow: GmailInformationRequestWorkflow;
}) {
  const label =
    workflow.status === "sent"
      ? "Reply sent"
      : workflow.status === "ignored"
        ? "Request ignored"
        : workflow.status === "blocked"
          ? "Request blocked"
          : "Needs attention";
  const timestamp =
    workflow.updated_at || workflow.received_at || workflow.created_at;

  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {fieldLabels(workflow)}
        </p>
        {timestamp ? (
          <p className="text-xs text-muted-foreground">
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(timestamp))}
          </p>
        ) : null}
      </div>
      {workflow.gmail_thread_id ? (
        <Button
          type="button"
          variant="muted"
          size="sm"
          className="shrink-0"
          onClick={() =>
            openExternalUrl(gmailThreadUrl(workflow.gmail_thread_id!))
          }
        >
          Open Mail
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The owner-facing personal-Gmail opt-in and metadata-only KYC request queue.
 * It stays inside the Gmail agent; the legacy platform-mailbox KYC surface is
 * intentionally not used by this workflow.
 */
export default function GmailInformationRequestsSection({
  userId,
  vaultKey,
  vaultOwnerToken,
  isConnected,
  idTokenProvider,
  onRequestVaultUnlock,
  onEnableGmailSend,
}: Props) {
  const createHandoff = useOneConversationSession(
    (state) => state.createHandoff,
  );
  const [preference, setPreference] =
    useState<GmailInformationRequestPreference | null>(null);
  const [workflows, setWorkflows] = useState<GmailInformationRequestWorkflow[]>(
    [],
  );
  const [activityWorkflows, setActivityWorkflows] = useState<
    GmailInformationRequestWorkflow[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGmailSend, setNeedsGmailSend] = useState(false);
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
  const [listView, setListView] = useState<"requests" | "activity">("requests");
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityNextOffset, setActivityNextOffset] = useState<number | null>(
    null,
  );
  const [activityTotalCount, setActivityTotalCount] = useState(0);
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [scanSummary, setScanSummary] =
    useState<GmailInformationRequestScan | null>(null);
  const [scanningInbox, setScanningInbox] = useState(false);
  const [scannedCount, setScannedCount] = useState<number | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null,
  );
  const idTokenProviderRef = useRef(idTokenProvider);
  const activityLoadingRef = useRef(false);
  const scanInFlightRef = useRef(false);
  const scanAbortControllerRef = useRef<AbortController | null>(null);
  const automaticScanSessionRef = useRef<string | null>(null);
  const requestListVersionRef = useRef(0);

  useEffect(() => {
    idTokenProviderRef.current = idTokenProvider;
  }, [idTokenProvider]);

  useEffect(
    () => () => {
      scanAbortControllerRef.current?.abort();
    },
    [],
  );

  const load = useCallback(async () => {
    const tokenProvider = idTokenProviderRef.current;
    if (!isConnected || !userId || !tokenProvider) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const requestListVersion = requestListVersionRef.current;
    try {
      const firebaseIdToken = await tokenProvider();
      const nextPreference =
        await GmailInformationRequestsService.getPreference({
          userId,
          firebaseIdToken,
        });
      setPreference(nextPreference);
      if (nextPreference.monitoring_enabled && vaultOwnerToken) {
        const [requests, activity] = await Promise.all([
          GmailInformationRequestsService.list({
            firebaseIdToken,
            vaultOwnerToken,
            limit: 100,
          }),
          GmailInformationRequestsService.list({
            firebaseIdToken,
            vaultOwnerToken,
            limit: 100,
            view: "activity",
          }),
        ]);
        if (requestListVersion === requestListVersionRef.current) {
          setWorkflows(requests.workflows);
          setNextOffset(requests.next_offset);
          setTotalCount(requests.total_count);
        }
        setActivityWorkflows(activity.workflows);
        setActivityNextOffset(activity.next_offset);
        setActivityTotalCount(activity.total_count);
        setActivityLoaded(true);
      } else {
        setWorkflows([]);
        setNextOffset(null);
        setTotalCount(0);
        setActivityWorkflows([]);
        setActivityNextOffset(null);
        setActivityTotalCount(0);
        setActivityLoaded(false);
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Personal information-request monitoring is unavailable right now.",
      );
    } finally {
      setLoading(false);
    }
  }, [isConnected, userId, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isConnected || !userId || !vaultOwnerToken) return;
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [isConnected, load, userId, vaultOwnerToken]);

  const scanInbox = useCallback(async () => {
    if (!vaultOwnerToken || !idTokenProvider || scanInFlightRef.current) {
      return false;
    }
    scanInFlightRef.current = true;
    setLoading(true);
    setScanningInbox(true);
    setScannedCount(0);
    setError(null);
    setNeedsGmailSend(false);
    const controller = new AbortController();
    scanAbortControllerRef.current = controller;
    try {
      const firebaseIdToken = await idTokenProvider();
      const scan = await GmailInformationRequestsService.scanStream({
        firebaseIdToken,
        vaultOwnerToken,
        maxResults: 30,
        signal: controller.signal,
        handlers: {
          onProgress: setScannedCount,
          onRequest: (workflow) => {
            requestListVersionRef.current += 1;
            setWorkflows((current) => mergeWorkflow(current, workflow));
          },
        },
      });
      setScanSummary(scan);
      const [requests, activity] = await Promise.all([
        GmailInformationRequestsService.list({
          firebaseIdToken,
          vaultOwnerToken,
          limit: 100,
        }),
        GmailInformationRequestsService.list({
          firebaseIdToken,
          vaultOwnerToken,
          limit: 100,
          view: "activity",
        }),
      ]);
      setWorkflows(requests.workflows);
      setNextOffset(requests.next_offset);
      setTotalCount(requests.total_count);
      setActivityWorkflows(activity.workflows);
      setActivityNextOffset(activity.next_offset);
      setActivityTotalCount(activity.total_count);
      setActivityLoaded(true);
      return true;
    } catch (scanError) {
      setError(
        scanError instanceof Error
          ? scanError.message
          : "We couldn’t check Gmail right now. Try again.",
      );
      return false;
    } finally {
      scanInFlightRef.current = false;
      if (scanAbortControllerRef.current === controller) {
        scanAbortControllerRef.current = null;
      }
      setScanningInbox(false);
      setScannedCount(null);
      setLoading(false);
    }
  }, [idTokenProvider, vaultOwnerToken]);

  useEffect(() => {
    if (!preference?.monitoring_enabled || !userId || !vaultOwnerToken) {
      automaticScanSessionRef.current = null;
      return;
    }
    const sessionKey = `${userId}:${vaultOwnerToken}`;
    if (automaticScanSessionRef.current === sessionKey) return;
    automaticScanSessionRef.current = sessionKey;
    void scanInbox();
  }, [preference?.monitoring_enabled, scanInbox, userId, vaultOwnerToken]);

  const setMonitoring = useCallback(
    async (enabled: boolean) => {
      if (!userId || !idTokenProvider) return false;
      if (!vaultOwnerToken || (enabled && !vaultKey)) {
        setError(
          "Open your private vault before changing KYC monitoring. This keeps request history and any future drafts owner-controlled.",
        );
        onRequestVaultUnlock();
        return false;
      }
      setUpdating(true);
      setError(null);
      setNeedsGmailSend(false);
      try {
        const firebaseIdToken = await idTokenProvider();
        const next = await GmailInformationRequestsService.setPreference({
          userId,
          firebaseIdToken,
          vaultOwnerToken,
          enabled,
        });
        setPreference(next);
        if (!enabled) {
          setWorkflows([]);
          setActivityWorkflows([]);
          setSelectedScopes({});
          setDrafts({});
          setNextOffset(null);
          setTotalCount(0);
          setActivityLoaded(false);
          setActivityLoading(false);
          setActivityNextOffset(null);
          setActivityTotalCount(0);
          activityLoadingRef.current = false;
          setListView("requests");
          setSelectedWorkflowId(null);
          setScanSummary(null);
        } else {
          const scanned = await scanInbox();
          return scanned;
        }
        return true;
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : "We could not update KYC monitoring.",
        );
        return false;
      } finally {
        setUpdating(false);
      }
    },
    [
      idTokenProvider,
      onRequestVaultUnlock,
      scanInbox,
      userId,
      vaultKey,
      vaultOwnerToken,
    ],
  );

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

  const loadActivity = useCallback(
    async (append = false) => {
      if (
        !vaultOwnerToken ||
        !idTokenProvider ||
        activityLoadingRef.current ||
        (append && activityNextOffset === null)
      ) {
        return;
      }
      activityLoadingRef.current = true;
      setActivityLoading(true);
      setError(null);
      try {
        const firebaseIdToken = await idTokenProvider();
        const response = await GmailInformationRequestsService.list({
          firebaseIdToken,
          vaultOwnerToken,
          limit: 25,
          offset: append ? activityNextOffset || 0 : 0,
          view: "activity",
        });
        setActivityWorkflows((current) =>
          append ? [...current, ...response.workflows] : response.workflows,
        );
        setActivityNextOffset(response.next_offset);
        setActivityTotalCount(response.total_count);
        setActivityLoaded(true);
      } catch {
        setError("We could not load KYC activity.");
      } finally {
        activityLoadingRef.current = false;
        setActivityLoading(false);
      }
    },
    [activityNextOffset, idTokenProvider, vaultOwnerToken],
  );

  const changeListView = useCallback(
    (next: "requests" | "activity") => {
      setListView(next);
      if (
        next === "activity" &&
        !activityLoaded &&
        !activityLoadingRef.current
      ) {
        void loadActivity();
      }
    },
    [activityLoaded, loadActivity],
  );

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

  const draftWithOne = useCallback(
    (workflow: GmailInformationRequestWorkflow) => {
      const createdAtMs = Date.now();
      createHandoff({
        id: `gmail-kyc-reply-${workflow.workflow_id}-${createdAtMs}`,
        reason: "user_requested",
        gmailInformationRequest: {
          workflow_id: workflow.workflow_id,
          requested_field_labels: workflow.requested_field_labels,
          candidate_scopes: workflow.candidate_scopes,
          attachment_review_required: workflow.attachment_review_required,
        },
        createdAtMs,
      });
      setSelectedWorkflowId(null);
      navigateToAgentChat();
    },
    [createHandoff],
  );

  const prepareDraft = useCallback(
    async (workflow: GmailInformationRequestWorkflow) => {
      if (!userId || !vaultKey || !vaultOwnerToken) return;
      const selected = selectedScopes[workflow.workflow_id] || [];
      if (!selected.length) return;
      setBusyWorkflowId(workflow.workflow_id);
      setError(null);
      setNeedsGmailSend(false);
      try {
        const prepared = await prepareScopedGmailInformationRequestDraft({
          workflow,
          userId,
          vaultKey,
          vaultOwnerToken,
          scopes: selected,
        });
        if (!prepared.body) {
          throw new Error(
            "No approved private details were available for these fields.",
          );
        }
        const body = prepared.body;
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
      setNeedsGmailSend(false);
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
      } catch (prepareError) {
        if (needsGmailSendPermission(prepareError)) {
          setNeedsGmailSend(true);
          setError(
            "Enable Mail sending before you review this reply for delivery.",
          );
        } else {
          setError(
            "We could not prepare this reply for sending. Review the original mail and try again.",
          );
        }
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
      setNeedsGmailSend(false);
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
            const { [workflow.workflow_id]: _discarded, ...remaining } =
              current;
            return remaining;
          });
          setTotalCount((current) => Math.max(0, current - 1));
          setSelectedWorkflowId(null);
          setActivityWorkflows((current) => [
            {
              ...workflow,
              status: "sent",
              updated_at: new Date().toISOString(),
            },
            ...current.filter(
              (item) => item.workflow_id !== workflow.workflow_id,
            ),
          ]);
        } else {
          setError(
            "Mail did not confirm delivery. Check Sent Mail before trying again.",
          );
        }
      } catch (sendError) {
        if (needsGmailSendPermission(sendError)) {
          setNeedsGmailSend(true);
          setError(
            "Enable Mail sending before you review this reply for delivery.",
          );
        } else {
          setError(
            "We could not send this reply. Check Sent Mail before trying again.",
          );
        }
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
        setSelectedWorkflowId(null);
        setActivityWorkflows((current) => [
          {
            ...workflow,
            status: "ignored",
            updated_at: new Date().toISOString(),
          },
          ...current.filter(
            (item) => item.workflow_id !== workflow.workflow_id,
          ),
        ]);
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
  const isInitialWorkspaceLoading = preference === null && loading;
  const visibleRequestCount = Math.max(totalCount, workflows.length);
  const selectedWorkflow = workflows.find(
    (workflow) => workflow.workflow_id === selectedWorkflowId,
  );
  const monitoringActions = enabled ? (
    <>
      <Button
        type="button"
        size="sm"
        className="min-h-11 w-full sm:w-auto"
        variant="muted"
        disabled={loading || scanningInbox}
        onClick={() =>
          vaultOwnerToken ? void scanInbox() : onRequestVaultUnlock()
        }
      >
        {scanningInbox || loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        {scanningInbox || loading
          ? "Looking…"
          : vaultOwnerToken
            ? "Check now"
            : "Unlock to check"}
      </Button>
      <Button
        type="button"
        size="sm"
        className="min-h-11 w-full text-muted-foreground hover:text-destructive sm:w-auto"
        variant="muted"
        disabled={updating || loading || scanningInbox}
        onClick={() => setShowDisableConfirm(true)}
      >
        Turn off
      </Button>
    </>
  ) : (
    <Button
      type="button"
      size="sm"
      className="min-h-11 w-full sm:w-auto"
      variant="blue-gradient"
      disabled={updating || loading || scanningInbox}
      onClick={() => {
        if (vaultKey && vaultOwnerToken) {
          setShowEnableConfirm(true);
          return;
        }
        void setMonitoring(true);
      }}
    >
      {updating ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <Mail className="mr-2 h-4 w-4" />
      )}
      {vaultKey && vaultOwnerToken
        ? "Start monitoring"
        : "Unlock to start"}
    </Button>
  );
  return (
    <SurfaceInset className="space-y-4 border px-4 py-4 text-sm sm:px-5 sm:py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">KYC requests</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Review requests and approve every reply before it sends.
          </p>
        </div>
        {enabled ? (
          <Badge variant="secondary" className="shrink-0 gap-1.5">
            <span
              className="size-1.5 rounded-full bg-emerald-500"
              aria-hidden="true"
            />
            On
          </Badge>
        ) : null}
      </div>

      {isInitialWorkspaceLoading ? (
        <KycWorkspaceLoadingSkeleton />
      ) : (
        <>
      {enabled ? (
        <div className="flex flex-col gap-3 rounded-[var(--app-card-radius-sm)] border border-primary/15 bg-primary/[0.045] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {scanningInbox ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <MailCheck className="h-4 w-4" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0" aria-live="polite">
              <p className="font-medium text-foreground">
                {scanningInbox
                  ? `Scanning emails: ${scannedCount ?? 0}`
                  : "Gmail monitoring is on"}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {scanningInbox
                  ? "New KYC requests appear here as we find them."
                  : "We’ll show you new requests here when they arrive."}
              </p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            {monitoringActions}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-[var(--app-card-radius-sm)] border border-border/60 bg-background/60 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Mail className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <p className="font-medium text-foreground">Find KYC requests in Gmail</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Nothing is shared without your approval.
              </p>
            </div>
          </div>
          <div className="w-full sm:w-auto">{monitoringActions}</div>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}{" "}
          {needsGmailSend && onEnableGmailSend ? (
            <button
              className="font-medium underline"
              onClick={onEnableGmailSend}
              type="button"
            >
              Enable Mail sending
            </button>
          ) : null}
        </p>
      ) : null}
      {enabled && scanSummary ? (
        <div
          aria-live="polite"
          className="grid grid-cols-2 gap-3 rounded-[var(--app-card-radius-sm)] border border-border/60 bg-background/60 px-3.5 py-3"
        >
          <div>
            <p className="text-xs text-muted-foreground">Emails checked</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {scanSummary.scanned_count}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">KYC requests found</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {scanSummary.matched_count}
            </p>
          </div>
        </div>
      ) : null}

      {enabled && !vaultOwnerToken ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            Unlock your private vault to view KYC requests, check Gmail, or
            prepare a draft.
          </p>
          <Button
            type="button"
            size="sm"
            variant="muted"
            onClick={onRequestVaultUnlock}
          >
            Unlock private vault
          </Button>
        </div>
      ) : null}

      {enabled && vaultOwnerToken ? (
        <SegmentedTabs
          value={listView}
          onValueChange={(next) =>
            changeListView(next as "requests" | "activity")
          }
          options={[
            {
              value: "requests",
              label: `Active requests${visibleRequestCount ? ` (${visibleRequestCount})` : ""}`,
            },
            {
              value: "activity",
              label: `Activity${activityTotalCount ? ` (${activityTotalCount})` : ""}`,
            },
          ]}
          mobileColumns={2}
          ariaLabel="KYC request views"
        />
      ) : null}

      {enabled && listView === "requests" && workflows.length ? (
        <div className="space-y-2" role="tabpanel" aria-label="KYC requests">
          <p className="text-xs text-muted-foreground">
            Showing {workflows.length} of {visibleRequestCount} requests
          </p>
          {workflows.map((workflow) => (
            <WorkflowQueueCard
              key={workflow.workflow_id}
              workflow={workflow}
              onReview={() => setSelectedWorkflowId(workflow.workflow_id)}
              onDraftWithOne={() => draftWithOne(workflow)}
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
      ) : enabled && listView === "requests" && vaultOwnerToken && loading ? (
        <KycRequestListSkeleton />
      ) : enabled && listView === "requests" && vaultOwnerToken && !loading ? (
        <p className="text-xs text-muted-foreground">
          No KYC requests found yet.
        </p>
      ) : null}

      {enabled && listView === "activity" && activityWorkflows.length ? (
        <div className="space-y-2" role="tabpanel" aria-label="KYC activity">
          <p className="text-xs text-muted-foreground">
            Showing {activityWorkflows.length} of {activityTotalCount} past
            decisions
          </p>
          {activityWorkflows.map((workflow) => (
            <ActivityCard key={workflow.workflow_id} workflow={workflow} />
          ))}
          {activityNextOffset !== null ? (
            <Button
              type="button"
              variant="muted"
              size="sm"
              className="min-h-11"
              disabled={activityLoading}
              onClick={() => void loadActivity(true)}
            >
              {activityLoading ? "Loading activity…" : "Load more activity"}
            </Button>
          ) : null}
        </div>
      ) : enabled && listView === "activity" && (activityLoading || loading) ? (
        <KycRequestListSkeleton label="KYC activity" />
      ) : enabled && listView === "activity" && activityLoaded ? (
        <p className="text-xs text-muted-foreground">
          No KYC activity yet. Sent messages remain available in Gmail.
        </p>
      ) : null}
        </>
      )}

      <AdaptiveDetailSurface
        open={Boolean(selectedWorkflow)}
        onOpenChange={(open) => {
          if (!open) setSelectedWorkflowId(null);
        }}
        eyebrow="KYC request"
        title="Review request"
        description="Choose the exact private details to include, then review the reply before sending."
        mobilePresentation="fullscreen"
        bodyClassName="py-4"
      >
        {selectedWorkflow ? (
          <WorkflowCard
            workflow={selectedWorkflow}
            selectedScopes={selectedScopes[selectedWorkflow.workflow_id] || []}
            onToggleScope={(scope) =>
              toggleScope(selectedWorkflow.workflow_id, scope)
            }
            draft={drafts[selectedWorkflow.workflow_id]}
            busy={busyWorkflowId === selectedWorkflow.workflow_id}
            onPrepareDraft={() => void prepareDraft(selectedWorkflow)}
            onPrepareSend={() => void prepareSend(selectedWorkflow)}
            onSend={() => void sendReply(selectedWorkflow)}
            onIgnore={() => void ignoreWorkflow(selectedWorkflow)}
            onDraftChange={(body) =>
              setDrafts((current) => ({
                ...current,
                [selectedWorkflow.workflow_id]: { body },
              }))
            }
          />
        ) : null}
      </AdaptiveDetailSurface>
      <AlertDialog
        open={showEnableConfirm}
        onOpenChange={(open) => setShowEnableConfirm(open)}
      >
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Start monitoring?</AlertDialogTitle>
            <AlertDialogDescription>
              We’ll look through recent Gmail emails for KYC requests. Nothing
              is shared or sent without your approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel disabled={updating}>Not now</AlertDialogCancel>
            <AlertDialogAction
              disabled={updating}
              onClick={(event) => {
                event.preventDefault();
                void setMonitoring(true).finally(() =>
                  setShowEnableConfirm(false),
                );
              }}
            >
              {updating ? "Starting…" : "Start monitoring"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={showDisableConfirm}
        onOpenChange={(open) => setShowDisableConfirm(open)}
      >
        <AlertDialogContent className="w-[calc(100%-1rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off monitoring?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops checking new Gmail emails and clears the requests
              shown here. Your Gmail emails are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel disabled={updating}>
              Keep monitoring on
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updating}
              onClick={(event) => {
                event.preventDefault();
                void setMonitoring(false).then((updated) => {
                  if (updated) setShowDisableConfirm(false);
                });
              }}
            >
              {updating ? "Turning off…" : "Turn off and delete activity"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SurfaceInset>
  );
}
