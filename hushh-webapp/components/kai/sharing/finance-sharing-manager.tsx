"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import type { FinanceGrant } from "@/lib/finance-sharing/contract";
import { FinanceSharingService } from "@/lib/services/finance-sharing-service";
import { financePublicationState, financePublicationRevision, subscribeFinancePublication } from "@/lib/finance-sharing/publication-state";
import { FinanceSharedDetail } from "./finance-shared-detail";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";

export function FinanceSharingManager({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { capture, session, ready } = useFinanceShareContext();
  const [items, setItems] = useState<FinanceGrant[]>([]);
  const [direction, setDirection] = useState<"outgoing" | "received">("outgoing");
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [stopping, setStopping] = useState<FinanceGrant | null>(null);
  const visit = useMemo(() => ({ open, direction, session }), [open, direction, session]);
  const currentVisit = useRef(visit); currentVisit.current = visit;
  useSyncExternalStore(subscribeFinancePublication, financePublicationRevision, () => 0);
  const owner = capture()?.userId;
  const pathname = usePathname();
  useBackLayer(pathname, open ? 1 : 0, () => { onOpenChange(false); return true; });
  useEffect(() => { setItems([]); setSelected(null); setStopping(null); setCursor(null); setError(null); }, [open, session, direction]);
  useEffect(() => {
    if (!open) return;
    const resume = () => { if (!document.hidden) setReload(n => n + 1); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("finance-sharing-changed", resume);
    return () => { document.removeEventListener("visibilitychange", resume); window.removeEventListener("finance-sharing-changed", resume); };
  }, [open]);
  useEffect(() => {
    if (!open || !ready) return;
    const context = capture(); if (!context) return;
    let disposed = false;
    setBusy(true);
    void FinanceSharingService.history(context, direction).then(result => {
      if (!disposed && context.isCurrent()) { setItems(result.items); setCursor(result.nextCursor); setError(null); }
    }).catch(e => { if (!disposed && context.isCurrent()) setError(e instanceof Error ? e.message : "Sharing history is unavailable."); })
      .finally(() => { if (!disposed && context.isCurrent()) setBusy(false); });
    return () => { disposed = true; };
  }, [capture, open, direction, ready, session, reload]);
  const loadMore = async () => {
    const context = capture(); if (!context || !cursor) return;
    const started = currentVisit.current;
    setBusy(true);
    try { const result = await FinanceSharingService.history(context, direction, cursor); if (context.isCurrent() && currentVisit.current === started) { setItems(p => [...p, ...result.items.filter(item => !p.some(existing => existing.id === item.id))]); setCursor(result.nextCursor); } }
    catch (e) { if (context.isCurrent() && currentVisit.current === started) setError(e instanceof Error ? e.message : "Sharing history is unavailable."); }
    finally { if (context.isCurrent() && currentVisit.current === started) setBusy(false); }
  };
  const stop = async () => {
    const context = capture(); if (!context || !stopping) return;
    setBusy(true); setError(null);
    try {
      await FinanceSharingService.stop(context, stopping.id);
      if (!context.isCurrent()) return;
      setStopping(null); setReload(n => n + 1); window.dispatchEvent(new Event("finance-sharing-changed"));
    } catch (e) { if (context.isCurrent()) setError(e instanceof Error ? e.message : "Stopping access could not be confirmed."); }
    finally { if (context.isCurrent()) setBusy(false); }
  };
  return <>
    <KaiControlSurface open={open} onOpenChange={onOpenChange} title="Finance sharing" description="Review access person by person." surfaceClassName={finance.detail}>
      <div className={styles.mode} role="group" aria-label="Sharing direction"><button aria-pressed={direction === "outgoing"} onClick={() => setDirection("outgoing")}>Shared by you</button><button aria-pressed={direction === "received"} onClick={() => setDirection("received")}>Shared with you</button></div>
      {error ? <div role="alert" className="my-4 text-sm text-destructive"><p>{error}</p><ShellActionSurface variant="pill" onClick={() => setReload(n => n + 1)}>Retry</ShellActionSurface></div> : null}
      {busy && !items.length ? <p role="status" className="py-8 text-sm">Checking access…</p> : null}
      {!busy && !items.length && !error ? <p className="py-8 text-sm text-muted-foreground">{ready ? "No Finance shares yet." : "Unlock your vault to manage sharing."}</p> : null}
      {items.map(item => <article key={item.id} className="mt-4 rounded-[18px] border border-border p-[18px]">
        <div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-semibold">{direction === "outgoing" ? item.recipientName : item.senderName}</h3><p className={styles.caption}>{item.policy.mode === "snapshot" ? "Snapshot" : "Ongoing access"}</p></div><span className={styles.chip}>{item.status === "stopped" ? "Stopped" : item.status === "expired" ? "Expired" : "Active"}</span></div>
        <p className="mt-3 text-sm capitalize">{item.policy.sections.join(" · ")}</p>
        <p className={`${styles.caption} mt-2`}>Dollar amounts {item.policy.showAmounts ? "included" : "hidden"} · Private-agent review {item.policy.model_processing.allowed ? "allowed" : "off"}</p>
        <p className={`${styles.caption} mt-1`}>{item.expiresAt ? `Access ends ${new Date(item.expiresAt).toLocaleString()}` : direction === "outgoing" ? "Until you stop sharing" : "Until the owner stops sharing"}</p>
        <p className={`${styles.caption} mt-1`}>Last shared {new Date(item.updatedAt).toLocaleString()}</p>
        {direction === "outgoing" && item.status === "active" && item.policy.mode === "ongoing" && owner ? <div className="mt-2"><p className={styles.caption}>{financePublicationState(owner, item.id) === "source_changed" ? "Updates paused: the portfolio account/source roster changed. Review and share a new view." : financePublicationState(owner, item.id) === "unavailable" ? "The latest update could not be published. No new information has been shared." : "Updates from approved saved information while One is open and unlocked."}</p>{financePublicationState(owner, item.id) === "unavailable" ? <ShellActionSurface variant="pill" onClick={() => window.dispatchEvent(new Event("finance-sharing-changed"))}>Retry saved update</ShellActionSurface> : null}</div> : null}
        {item.status === "active" ? <div className={`${styles.toolbar} mt-3`}><ShellActionSurface variant="pill" onClick={() => setSelected(item.id)}>View</ShellActionSurface>{direction === "outgoing" ? <ShellActionSurface variant="pill" onClick={() => setStopping(item)}>Stop sharing</ShellActionSurface> : null}</div> : null}
      </article>)}
      {cursor ? <div className="mt-4"><ShellActionSurface variant="pill" disabled={busy} onClick={() => void loadMore()}>More shares</ShellActionSurface></div> : null}
    </KaiControlSurface>
    <FinanceSharedDetail grantId={selected} onClose={() => setSelected(null)} />
    <KaiControlSurface open={Boolean(stopping)} onOpenChange={value => { if (!value) setStopping(null); }} title={`Stop sharing with ${stopping?.recipientName || "this person"}?`}
      description="Their access and private-agent review will end." surfaceClassName={finance.detail}
      footer={<div className={styles.toolbar}><ShellActionSurface variant="pill" disabled={busy} onClick={() => setStopping(null)}>Keep sharing</ShellActionSurface><ShellActionSurface variant="pill" disabled={busy} onClick={() => void stop()}>{busy ? "Stopping…" : "Stop sharing"}</ShellActionSurface></div>}>
      <p className="text-sm leading-[21px]">Other recipients keep their own access. Information already copied or saved cannot be recalled.</p>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    </KaiControlSurface>
  </>;
}
