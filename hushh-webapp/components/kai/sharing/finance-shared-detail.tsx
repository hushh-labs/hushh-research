"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { FinanceSharingService } from "@/lib/services/finance-sharing-service";
import type { FinanceGrant, FinanceProjection } from "@/lib/finance-sharing/contract";
import { SafeMarkdown } from "@/components/profile/safe-markdown";
import { FinanceSharingPreview } from "./finance-sharing-preview";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";

export function FinanceSharedDetail({ grantId, onClose }: { grantId: string | null; onClose: () => void }) {
  const { capture, session, ready } = useFinanceShareContext();
  const [state, setState] = useState<{ grantId: string; session: string; grant: FinanceGrant; projection: FinanceProjection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [review, setReview] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewController = useRef<AbortController | null>(null);
  const pathname = usePathname();
  useBackLayer(pathname, grantId ? 1 : 0, () => { onClose(); return true; });
  useEffect(() => {
    setState(null); setError(null); setReview(null); setReviewBusy(false); setReviewError(null); reviewController.current?.abort();
    if (!grantId || !ready) return;
    const context = capture(); if (!context) return;
    let disposed = false, loading = false, ended = false, currentHash: string | null = null;
    let deadline: number | null = null;
    const clear = (message: string) => { setState(null); setReview(null); setReviewBusy(false); setReviewError(null); reviewController.current?.abort(); currentHash = null; setError(message); };
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
          setState(null); setReview(null); setReviewBusy(false); reviewController.current?.abort();
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
    return () => { disposed = true; reviewController.current?.abort(); window.clearInterval(timer); window.clearInterval(expiry); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("finance-sharing-changed", read); };
  }, [capture, grantId, ready, retry, session]);
  const visible = state?.session === session && state.grantId === grantId && ready ? state : null;
  const ask = async () => {
    const context = capture(); if (!context || !visible) return;
    const controller = new AbortController();
    reviewController.current?.abort(); reviewController.current = controller;
    setReviewBusy(true); setReviewError(null); setReview(null);
    try {
      const text = await FinanceSharingService.review(context, visible.grant, visible.projection, controller.signal);
      if (context.isCurrent() && !controller.signal.aborted) setReview(text);
    } catch (e) { if (context.isCurrent() && !controller.signal.aborted) setReviewError(e instanceof Error ? e.message : "Review is unavailable."); }
    finally { if (context.isCurrent() && !controller.signal.aborted) setReviewBusy(false); }
  };
  return <KaiControlSurface open={Boolean(grantId)} onOpenChange={value => { if (!value) onClose(); }} title={visible ? `${visible.grant.direction === "received" ? visible.grant.senderName : visible.grant.recipientName} · Finance` : "Shared Finance"}
    description={visible ? `${visible.grant.policy.mode === "snapshot" ? "Snapshot" : "Real time"} · Last shared ${new Date(visible.grant.updatedAt).toLocaleString()}` : "Recipient-encrypted information"}
    desktopMaxWidthClassName="sm:!max-w-[min(1040px,calc(100vw-4.5rem))]"
    surfaceClassName={`${finance.detail} ${styles.surface}`}>
    {visible ? <div className={styles.layout}><FinanceSharingPreview projection={visible.projection} /><div className={styles.section}>
      <section className={styles.group}><h2 className={styles.heading}>Your access</h2><p className="mt-3 text-sm">{visible.grant.expiresAt ? `Ends ${new Date(visible.grant.expiresAt).toLocaleString()}` : "Until the owner stops sharing"}</p><p className={`${styles.caption} mt-3`}>{visible.grant.policy.mode === "snapshot" ? "This is a fixed snapshot." : "This follows approved saved updates while the owner’s vault is unlocked."}</p><p className={`${styles.caption} mt-3`}>Agent One review {visible.grant.policy.model_processing.allowed ? "is allowed for these sections." : "has not been allowed by the owner."}</p></section>
      {visible.grant.direction === "received" && visible.grant.policy.version === 2 ? <p className={styles.privacy}>Review the snapshot and reply to the owner in your connection conversation.</p> : null}
      {visible.grant.direction === "received" && visible.grant.policy.model_processing.allowed ? <section className={styles.group}><h2 className={styles.heading}>Review with Agent One</h2><p className={`${styles.caption} my-3`}>Only this approved view is provided for this review. Agent One cannot save it or take actions from this turn.</p><ShellActionSurface variant="pill" disabled={reviewBusy} onClick={() => void ask()}>{reviewBusy ? "Reviewing…" : "Review with Agent One"}</ShellActionSurface>{reviewError ? <p role="alert" className="mt-3 text-sm text-destructive">{reviewError}</p> : null}{review ? <div className="mt-4 text-sm leading-[21px] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_p]:mt-2 [&_strong]:font-semibold"><SafeMarkdown markdown={review} linkPolicy="internal" /></div> : null}</section> : null}
    </div></div> : <div className="py-6"><p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{!ready ? "Unlock your vault to open shared Finance." : error || "Checking access and opening the encrypted view…"}</p>{error ? <ShellActionSurface variant="pill" className="mt-4" onClick={() => setRetry(n => n + 1)}>Check access again</ShellActionSurface> : null}</div>}
  </KaiControlSurface>;
}
