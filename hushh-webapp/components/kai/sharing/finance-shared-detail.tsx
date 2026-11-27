"use client";

import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { FinanceSharingService } from "@/lib/services/finance-sharing-service";
import type { FinanceGrant, FinanceProjection } from "@/lib/finance-sharing/contract";
import { FinanceSharingPreview } from "./finance-sharing-preview";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";

const pages = [
  { value: "portfolio", label: "Portfolio" },
  { value: "allocation", label: "Allocation" },
  { value: "stocks", label: "Stocks" },
];

export function FinanceSharedDetail({ grantId, onClose }: { grantId: string | null; onClose: () => void }) {
  const { capture, session, ready } = useFinanceShareContext();
  const [state, setState] = useState<{ grantId: string; session: string; grant: FinanceGrant; projection: FinanceProjection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState("portfolio");
  const tabSetId = `shared-finance-${useId()}`;
  const pathname = usePathname();
  useBackLayer(pathname, grantId ? 1 : 0, () => { onClose(); return true; });
  useBackLayer(pathname, grantId && page !== "portfolio" ? 2 : 0, () => {
    setPage("portfolio");
    return true;
  });
  useEffect(() => {
    setPage("portfolio");
    setState(null); setError(null);
    if (!grantId || !ready) return;
    const context = capture(); if (!context) return;
    let disposed = false, loading = false, ended = false, currentHash: string | null = null;
    let deadline: number | null = null;
    const clear = (message: string) => { setState(null); currentHash = null; setError(message); };
    const read = async () => {
      if (disposed || ended || loading || document.hidden || !context.isCurrent()) return;
      loading = true;
      try {
        const started = performance.now();
        const grant = await FinanceSharingService.view(context, grantId);
        if (disposed || !context.isCurrent() || document.hidden) return;
        deadline = grant.expiresAt ? started + Math.max(0, Date.parse(grant.expiresAt) - Date.parse(grant.serverNow)) : null;
        if (grant.status !== "active") { ended = true; clear(grant.status === "stopped" ? "The owner stopped sharing this information." : "This share has expired."); return; }
        if (grant.contentHash !== currentHash) {
          setState(null);
          const projection = await FinanceSharingService.decrypt(context, grant);
          if (disposed || !context.isCurrent() || document.hidden || (deadline !== null && performance.now() >= deadline)) return;
          currentHash = grant.contentHash; setState({ grantId, session, grant, projection }); setError(null);
        }
      } catch (e) { if (!disposed && context.isCurrent()) { ended = true; clear(e instanceof Error ? e.message : "Access could not be checked."); } }
      finally { loading = false; }
    };
    const visibility = () => { if (document.hidden) clear("Shared information is hidden while One is in the background."); else void read(); };
    const timer = window.setInterval(() => {
      if (deadline !== null && performance.now() >= deadline) { ended = true; clear("This share has expired."); return; }
      void read();
    }, 2000);
    const expiry = window.setInterval(() => { if (!ended && deadline !== null && performance.now() >= deadline) { ended = true; clear("This share has expired."); } }, 250);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("finance-sharing-changed", read);
    void read();
    return () => { disposed = true; window.clearInterval(timer); window.clearInterval(expiry); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("finance-sharing-changed", read); };
  }, [capture, grantId, ready, retry, session]);
  const visible = state?.session === session && state.grantId === grantId && ready ? state : null;
  return <KaiControlSurface open={Boolean(grantId)} onOpenChange={value => { if (!value) onClose(); }} title={visible ? `${visible.grant.direction === "received" ? visible.grant.senderName : visible.grant.recipientName} · Finance` : "Shared Finance"}
    description={visible ? `${visible.grant.policy.mode === "snapshot" ? "Snapshot" : "Real time"}${visible.grant.expiresAt ? ` · Ends ${new Date(visible.grant.expiresAt).toLocaleDateString()}` : ""}` : "Recipient-encrypted information"}
    presentation="sheet"
    surfaceClassName={`${finance.detail} ${styles.sharedSheet}`}
    bodyClassName={visible ? styles.sharedBody : undefined}>
    {visible ? <div className={styles.sharedLayout}>
      <SegmentedTabs value={page} options={pages} tabSetId={tabSetId} ariaLabel="Shared Finance sections"
        onValueChange={setPage} />
      <SwipeViews activeValue={page} options={pages} tabSetId={tabSetId}
        onSelectionChange={setPage} viewportMinHeight="0px" className={styles.sharedPager}
        preserveControlActivationAfterSwipe>
      <div className={styles.section}>
      <FinanceSharingPreview projection={visible.projection} section="portfolio" />
      </div>
      <FinanceSharingPreview projection={visible.projection} section="allocation" />
      <FinanceSharingPreview projection={visible.projection} section="stocks" />
      </SwipeViews>
    </div> : <div className="py-6"><p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{!ready ? "Unlock your vault to open shared Finance." : error || "Opening…"}</p>{error ? <ShellActionSurface variant="pill" className="mt-4" onClick={() => setRetry(n => n + 1)}>Try again</ShellActionSurface> : null}</div>}
  </KaiControlSurface>;
}
