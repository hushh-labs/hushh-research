"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { SurfaceCard, SurfaceCardContent, SurfaceInset } from "@/components/app-ui/surfaces";
import { CardTitle, MediumRowLabel, RowDescription } from "@/components/app-ui/typography";
import { ChevronDown } from "@/components/icons";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { AnalysisSummaryView } from "@/components/kai/views/analysis-summary-view";
import { HistoryDebateReplay } from "@/components/kai/views/history-debate-replay";
import { HistoryDetailView } from "@/components/kai/views/history-detail-view";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { prepareStockDebate } from "@/lib/kai/prepare-stock-debate";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import { useStockPreview } from "@/lib/kai/use-stock-preview";
import { Button } from "@/lib/morphy-ux/button";
import type { KaiStockPreviewResponse } from "@/lib/services/api-service";
import { DebateRunManagerService, type DebateRunTask } from "@/lib/services/debate-run-manager";
import { useVault } from "@/lib/vault/vault-context";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

const RESEARCH_STEPS: Record<string, string> = {
  start: "Starting research…",
  round_start: "Research round underway…",
  debate_round: "Debate round underway…",
  agent_start: "A research specialist is working…",
  agent_complete: "A research specialist finished.",
  insight_extracted: "Reviewing research findings…",
};

function AnalysisDetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible className="rounded-xl bg-card">
      <CollapsibleTrigger className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-[inherit] px-4 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {title}
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function FinanceDebateResult({
  runId, userId, vaultOwnerToken, vaultKey,
}: { runId: string; userId: string; vaultOwnerToken: string; vaultKey: string }) {
  const [task, setTask] = useState<DebateRunTask | null>(null);
  const [progress, setProgress] = useState("Starting research…");
  const [detailOpen, setDetailOpen] = useState(false);
  const openAnalysisRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unsubscribeState = DebateRunManagerService.subscribe(state => {
      setTask(state.tasks.find(item => item.runId === runId && item.userId === userId) ?? null);
    });
    const unsubscribeEvents = DebateRunManagerService.subscribeRunEvents(runId, envelope => {
      const label = RESEARCH_STEPS[envelope.event];
      if (typeof label === "string") setProgress(label);
    });
    return () => { unsubscribeState(); unsubscribeEvents(); };
  }, [runId, userId]);

  if (!task) return <p role="status">Loading debate…</p>;
  if (task.status === "running") {
    return (
      <div className="space-y-2">
        <p role="status">
          {task.streamState === "paused" ? "Live updates paused."
            : task.streamState === "reconnecting" ? "Reconnecting to this debate…" : progress}
        </p>
        {task.streamState === "paused" ? (
          <Button size="sm" onClick={() => void DebateRunManagerService.reconnectRun({
            runId, userId, vaultOwnerToken, vaultKey,
          })}>Reconnect</Button>
        ) : null}
      </div>
    );
  }
  if (task.status !== "completed") {
    return <p role="status">{task.status === "canceled" ? "Debate cancelled." : "Debate could not finish."}</p>;
  }

  const result = DebateRunManagerService.getResultForRun(runId, userId);
  return (
    <div className="space-y-2">
      {result ? (
        <>
          <AnalysisSummaryView entry={result} compact embedded showHeader={false} userId={userId} />
          <Button ref={openAnalysisRef} type="button" size="sm" aria-haspopup="dialog" onClick={() => setDetailOpen(true)}>
            Open analysis
          </Button>
          <AdaptiveDetailSurface
            open={detailOpen}
            onOpenChange={setDetailOpen}
            onCloseAutoFocus={event => {
              event.preventDefault();
              openAnalysisRef.current?.focus();
            }}
            title={`${result.ticker} analysis`}
            mobilePresentation="sheet"
            surfaceClassName={financeStyles.detail}
          >
            {detailOpen ? (
              <div className="min-w-0 space-y-4">
                <AnalysisSummaryView entry={result} embedded showHeader={false} userId={userId} />
                <AnalysisDetailSection title="Full debate and research">
                  <HistoryDebateReplay entry={result} />
                </AnalysisDetailSection>
                <AnalysisDetailSection title="Detailed record and sources">
                  <HistoryDetailView entry={result} embedded showHeader={false} userId={userId} />
                </AnalysisDetailSection>
              </div>
            ) : null}
          </AdaptiveDetailSurface>
        </>
      ) : (
        <p role="status" className="ui-text-row-description">Analysis details are unavailable.</p>
      )}
      {task.persistenceState === "saved" ? <p className="ui-text-row-description text-muted-foreground">Saved to Finance history.</p> : null}
      {task.persistenceState === "pending" ? <p role="status" className="ui-text-row-description text-muted-foreground">Saving to Finance history…</p> : null}
      {task.persistenceState === "failed" ? (
        <div className="space-y-2">
          <p role="status">The result is ready. It could not be saved to Finance history.</p>
          <Button size="sm" onClick={() => void DebateRunManagerService.retryTaskPersistence(
            runId, { userId, vaultKey },
          )}>
            Retry saving
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FinanceStockReview({ preview }: { preview: KaiStockPreviewResponse }) {
  useMarketCurrency();
  const quote = preview.quote;
  const company = quote?.company_name?.trim();
  const source = preview.pick_sources?.find(item => item.id === preview.active_pick_source)?.label ||
    preview.list_match?.label;
  return (
    <SurfaceInset className="space-y-2 px-3 py-2.5">
      {company && company !== preview.symbol ? <MediumRowLabel as="p">{company}</MediumRowLabel> : null}
      <dl className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <RowDescription as="dt">Debate source</RowDescription>
          <MediumRowLabel as="dd" className="break-words">{source || "Unavailable"}</MediumRowLabel>
        </div>
        <div className="min-w-0 text-right">
          <RowDescription as="dt">Market quote</RowDescription>
          <MediumRowLabel as="dd" className="tabular-nums">
            {quote?.price != null && quote.price > 0 ? formatCurrency(quote.price) : "Unavailable"}
          </MediumRowLabel>
        </div>
      </dl>
    </SurfaceInset>
  );
}

export function FinanceStockPreviewCard({ ticker, allowStart = false, onConfirm }: { ticker: string; allowStart?: boolean; onConfirm?: (confirmation: string) => Promise<void> }) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken, vaultKey } = useVault();
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<{ runId: string; userId: string; ticker: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [startAttempted, setStartAttempted] = useState(false);
  const [notice, setNotice] = useState("");
  const operation = useRef<AbortController | null>(null);
  const pendingConfirmation = useRef<string | null>(null);
  const ownerToken = isVaultUnlocked && vaultKey ? vaultOwnerToken : null;
  const currentRun = run?.userId === userId && run.ticker === ticker ? run : null;
  const { preview, loading, error } = useStockPreview({
    userId,
    vaultOwnerToken: ownerToken,
    ticker: allowStart && open && !currentRun ? ticker : "",
    pickSource: "default",
  });
  const canConfirm = Boolean(allowStart && open && userId && ownerToken && vaultKey &&
    !currentRun && !pending && !startAttempted && preview?.symbol === ticker);
  const actionMetadata = useMemo(() => canConfirm ? {
    actions: [{ id: "analysis.confirm_preview", actionId: "analysis.confirm_preview", label: "Start analysis debate" }],
    controls: [{ id: "analysis_start_preview", actionId: "analysis.confirm_preview", label: "Start analysis debate", role: "button" }],
  } : null, [canConfirm]);
  usePublishVoiceSurfaceMetadata(actionMetadata, { role: "chrome" });
  useLocalOnboardingActionHandler("analysis.confirm_preview", async (_slots, context) => {
    if (!canConfirm || context?.signal?.aborted || !pendingConfirmation.current ||
        context?.humanConfirmationToken !== pendingConfirmation.current)
      return { status: "blocked", summary: "Confirm the current preview first." };
    pendingConfirmation.current = null;
    const started = await operate("start");
    return started ? { status: "succeeded", summary: "Analysis started." }
      : { status: "blocked", summary: "Analysis did not start. Check the card for details." };
  }, { enabled: canConfirm });

  useLayoutEffect(() => {
    setPending(false);
    setNotice("");
    return () => {
      operation.current?.abort();
      operation.current = null;
      pendingConfirmation.current = null;
    };
  }, [ticker, userId, ownerToken, vaultKey]);

  async function operate(mode: "start" | "resume") {
    if (!allowStart || !userId || !ownerToken || !vaultKey || operation.current || currentRun) return false;
    if (mode === "start" && (!allowStart || !open || startAttempted || preview?.symbol !== ticker)) return false;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setNotice("");
    const credentials = { userId, vaultOwnerToken: ownerToken, vaultKey };
    const bindRun = (task: DebateRunTask) => {
      if (!controller.signal.aborted && task.userId === userId && task.ticker === ticker) {
        setRun({ runId: task.runId, userId, ticker });
      }
    };
    try {
      if (mode === "resume") {
        const existing = await DebateRunManagerService.resumeActiveRun({
          ...credentials, expectedTicker: ticker, signal: controller.signal, onRunFound: bindRun,
        });
        if (!controller.signal.aborted && !existing) setNotice(`No active ${ticker} debate.`);
        return Boolean(existing);
      }
      setStartAttempted(true);
      const pickSource = preview?.active_pick_source || "default";
      const { context, effectiveRiskProfile } = await prepareStockDebate(credentials);
      if (controller.signal.aborted) return false;
      const result = await DebateRunManagerService.ensureRun({
        ...credentials, ticker, pickSource, riskProfile: effectiveRiskProfile, userContext: context,
      });
      if (controller.signal.aborted) return false;
      if (result.kind === "blocked") {
        setNotice("A debate is already running. Choose Resume debate to check.");
        return false;
      }
      bindRun(result.task);
      return true;
    } catch {
      if (!controller.signal.aborted) setNotice(
        mode === "start" ? "Could not confirm the start. Check for an active debate before trying again."
          : "Could not check for an active debate.",
      );
      return false;
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setPending(false);
      }
    }
  }

  if (!allowStart && !currentRun) {
    return (
      <p className="rounded-xl border border-border p-3 text-sm">
        {ticker} stock analysis preview
      </p>
    );
  }

  return (
    <SurfaceCard>
      <details className="group" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-[var(--surface-card-content-px)] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <CardTitle as="span">{ticker} stock analysis</CardTitle>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
        </summary>
        {open ? (
          <SurfaceCardContent className="space-y-3">
            {!userId || !ownerToken || !vaultKey ? (
              <p className="text-sm text-muted-foreground">Sign in and unlock your vault to view the analysis.</p>
            ) : currentRun ? (
              <FinanceDebateResult key={currentRun.runId} runId={currentRun.runId} userId={userId}
                vaultOwnerToken={ownerToken} vaultKey={vaultKey} />
            ) : (
              <>
                {loading ? <p role="status" className="ui-text-row-description">Loading stock preview…</p> : null}
                {error ? <p role="status" className="ui-text-row-description">Could not load the preview. Close and reopen to retry.</p> : null}
                {preview ? <FinanceStockReview preview={preview} /> : null}
                <div className="flex flex-wrap items-center gap-2">
                  {!startAttempted ? (
                    <Button type="button" size="sm" data-voice-control-id="analysis_start_preview" disabled={!canConfirm || !onConfirm}
                      onClick={() => {
                        const confirmation = crypto.randomUUID();
                        pendingConfirmation.current = confirmation;
                        void onConfirm?.(confirmation).finally(() => {
                          if (pendingConfirmation.current === confirmation) pendingConfirmation.current = null;
                        });
                      }}>Start debate</Button>
                  ) : null}
                  <Button type="button" size="sm" variant="plain"
                    disabled={pending} onClick={() => void operate("resume")}>
                    Resume debate
                  </Button>
                </div>
                {pending || notice ? <RowDescription as="p" role="status">{pending ? "Connecting to Finance…" : notice}</RowDescription> : null}
              </>
            )}
          </SurfaceCardContent>
        ) : null}
      </details>
    </SurfaceCard>
  );
}
