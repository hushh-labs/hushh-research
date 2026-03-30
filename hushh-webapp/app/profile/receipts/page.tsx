"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  GmailReceiptsService,
  type GmailConnectionStatus,
  type GmailSyncRun,
  type ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatAmount(currency?: string | null, amount?: number | null): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "—";
  const normalized = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalized,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${normalized} ${amount.toFixed(2)}`;
  }
}

function statusBadge(status: GmailConnectionStatus | null): string {
  if (!status) return "Loading";
  if (!status.configured) return "Not configured";
  if (!status.connected) return "Disconnected";
  if (status.last_sync_status === "running") return "Syncing";
  if (status.last_sync_status === "failed") return "Needs attention";
  return "Connected";
}

function computeSyncProgressPercent(run: GmailSyncRun | null): number {
  if (!run) return 0;
  if (run.status === "queued") return 8;
  if (run.status === "running") {
    const listed = Math.max(1, run.listed_count || 0);
    const pipelineWork = (run.filtered_count || 0) + (run.synced_count || 0) + (run.extracted_count || 0);
    const ratio = Math.max(0, Math.min(1, pipelineWork / (listed * 3)));
    return Math.max(12, Math.min(95, Math.round(ratio * 100)));
  }
  if (run.status === "completed") return 100;
  return 100;
}

export default function ProfileReceiptsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  const [receipts, setReceipts] = useState<ReceiptListItem[]>([]);
  const [syncRun, setSyncRun] = useState<GmailSyncRun | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const canLoad = Boolean(user?.uid);

  const loadStatus = useCallback(async () => {
    if (!user?.uid) return;
    const idToken = await user.getIdToken();
    const next = await GmailReceiptsService.getStatus({
      idToken,
      userId: user.uid,
    });
    setStatus(next);
    setSyncRun(next.latest_run || null);
  }, [user]);

  const loadReceipts = useCallback(
    async (nextPage: number) => {
      if (!user?.uid) return;
      setLoadingReceipts(true);
      try {
        const idToken = await user.getIdToken();
        const response = await GmailReceiptsService.listReceipts({
          idToken,
          userId: user.uid,
          page: nextPage,
          perPage: 20,
        });
        setReceipts((previous) =>
          nextPage > 1 ? [...previous, ...response.items] : response.items
        );
        setPage(response.page);
        setHasMore(response.has_more);
        setTotal(response.total);
      } finally {
        setLoadingReceipts(false);
      }
    },
    [user]
  );

  const pollSyncRun = useCallback(
    async (runId: string) => {
      if (!user?.uid) return;
      const idToken = await user.getIdToken();
      setSyncing(true);
      let latestRun: GmailSyncRun | null = null;
      try {
        for (let attempt = 0; attempt < 90; attempt += 1) {
          try {
            const payload = await GmailReceiptsService.getSyncRun({
              idToken,
              userId: user.uid,
              runId,
            });
            const run = payload.run;
            latestRun = run;
            setSyncRun(run);
            if (run.status === "completed" || run.status === "failed") {
              break;
            }
          } catch (error) {
            if (attempt >= 89) {
              throw error;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        await loadStatus();
        await loadReceipts(1);
        return latestRun;
      } finally {
        setSyncing(false);
      }
    },
    [loadReceipts, loadStatus, user]
  );

  const handleSyncNow = useCallback(async () => {
    if (!user?.uid) return;
    try {
      const idToken = await user.getIdToken();
      const queued = await GmailReceiptsService.syncNow({
        idToken,
        userId: user.uid,
      });
      const runId = queued.run?.run_id;
      if (!runId) {
        toast.message("Gmail sync is already running.");
        await loadStatus();
        return;
      }
      setSyncRun(queued.run || null);
      const latestRun = await pollSyncRun(runId);
      if (latestRun?.status === "completed") {
        toast.success("Receipt sync completed.");
      } else {
        toast.error(latestRun?.error_message || "Gmail sync failed.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start Gmail sync.");
    }
  }, [loadStatus, pollSyncRun, user]);

  useEffect(() => {
    if (loading || !canLoad) return;

    let mounted = true;
    void (async () => {
      try {
        setLoadingStatus(true);
        await loadStatus();
        await loadReceipts(1);
      } catch (error) {
        if (mounted) {
          toast.error(error instanceof Error ? error.message : "Failed to load Gmail receipts.");
        }
      } finally {
        if (mounted) {
          setLoadingStatus(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [canLoad, loadReceipts, loadStatus, loading]);

  const isConnected = Boolean(status?.configured && status?.connected);
  const progressPercent = useMemo(() => computeSyncProgressPercent(syncRun), [syncRun]);
  const latestRunMetrics = useMemo(() => {
    if (!syncRun) return null;
    const extractionSuccessPercent = Math.round((syncRun.extraction_success_rate || 0) * 100);
    return {
      listed: syncRun.listed_count || 0,
      filtered: syncRun.filtered_count || 0,
      synced: syncRun.synced_count || 0,
      extracted: syncRun.extracted_count || 0,
      duplicates: syncRun.duplicates_dropped || 0,
      extractionSuccessPercent,
    };
  }, [syncRun]);
  const pageTitle = useMemo(
    () => (status?.google_email ? `Synced from ${status.google_email}` : "Your Gmail receipts"),
    [status?.google_email]
  );

  return (
    <AppPageShell
      as="div"
      width="profile"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Profile"
          title="Receipts"
          description={pageTitle}
          actions={
            <Button
              onClick={() => void handleSyncNow()}
              disabled={!isConnected || syncing}
              className="min-w-[140px]"
            >
              {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Sync now
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <SurfaceInset className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <p className="text-muted-foreground">Connector status</p>
              <p className="font-medium text-foreground">{statusBadge(status)}</p>
            </div>
            <Badge variant="secondary">{total} receipts</Badge>
          </SurfaceInset>

          {syncRun ? (
            <SurfaceInset className="space-y-1 px-4 py-3 text-sm">
              <p className="font-medium text-foreground">Latest sync</p>
              <p className="text-muted-foreground">Run: {syncRun.run_id}</p>
              <p className="text-muted-foreground">Status: {syncRun.status}</p>
              <p className="text-muted-foreground">
                Synced {syncRun.synced_count} / Filtered {syncRun.filtered_count} / Extracted {syncRun.extracted_count}
              </p>
              {latestRunMetrics ? (
                <div className="space-y-2 pt-1">
                  <Progress value={progressPercent} className="h-2" />
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <span>Scanned: {latestRunMetrics.listed}</span>
                    <span>Matched: {latestRunMetrics.filtered}</span>
                    <span>Stored: {latestRunMetrics.synced}</span>
                    <span>Extracted: {latestRunMetrics.extracted}</span>
                    <span>Duplicates: {latestRunMetrics.duplicates}</span>
                    <span>Extract %: {latestRunMetrics.extractionSuccessPercent}%</span>
                  </div>
                </div>
              ) : null}
              {syncRun.error_message ? (
                <p className="text-destructive">{syncRun.error_message}</p>
              ) : null}
            </SurfaceInset>
          ) : null}

          {!isConnected ? (
            <SurfaceInset className="flex flex-col items-start gap-3 px-4 py-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Mail className="h-4 w-4" />
                Connect Gmail from Profile to start syncing receipts.
              </div>
              <Button onClick={() => router.push(`${ROUTES.PROFILE}?tab=account&panel=gmail`)}>
                Open Gmail connector
              </Button>
            </SurfaceInset>
          ) : null}

          {isConnected && loadingReceipts ? (
            <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading receipts...
            </SurfaceInset>
          ) : null}

          {isConnected && !loadingReceipts && receipts.length === 0 ? (
            <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground">
              {syncRun?.synced_count
                ? "Sync reported stored receipts, but none are visible yet. Click Sync now once more to refresh from the latest DB state."
                : "No receipts synced yet. Run a manual sync to fetch your latest purchases."}
            </SurfaceInset>
          ) : null}

          {isConnected && receipts.length > 0
            ? receipts.map((item) => (
                <SurfaceInset key={item.id} className="space-y-2 px-4 py-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{item.merchant_name || item.from_name || "Unknown merchant"}</p>
                      <p className="text-muted-foreground">{item.subject || "No subject"}</p>
                    </div>
                    <Badge variant="secondary">{formatAmount(item.currency, item.amount)}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Order: {item.order_id || "—"}</span>
                    <span>Receipt date: {formatDate(item.receipt_date || item.gmail_internal_date)}</span>
                    <span>Source: {item.classification_source || "deterministic"}</span>
                  </div>
                </SurfaceInset>
              ))
            : null}

          {isConnected && hasMore ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="none"
                effect="fade"
                onClick={() => void loadReceipts(page + 1)}
                disabled={loadingReceipts}
              >
                Load older receipts
              </Button>
            </div>
          ) : null}

          {status?.last_sync_error ? (
            <p className="text-center text-xs text-destructive">{status.last_sync_error}</p>
          ) : null}

          {loadingStatus ? (
            <p className="text-center text-xs text-muted-foreground">Loading Gmail connector status...</p>
          ) : null}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
