"use client";

import { useEffect, useRef, useState } from "react";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

type Offer = Awaited<ReturnType<typeof ApiService.getPersonalAgentBrowserPlan>>;
type Review = { offer: Offer; owner: AuthSessionOwnerSnapshot };

/** A configuration approval, separate from per-task website/action consent. */
export function BrowserActivationPanel({ userId, disabled, onScheduled }: {
  userId: string; disabled: boolean; onScheduled: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const approval = useRef<{ release: string; key: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const current = (owner: AuthSessionOwnerSnapshot) =>
    mounted.current && owner.userId === userId && isValidatedAuthSessionOwnerCurrent(owner);
  const closeReview = () => {
    if (!pending.current) setReview(null);
    return true;
  };
  useBackLayer(ROUTES.PROFILE_SOFTWARE_UPDATES, review ? 2 : 0, closeReview);
  useBackLayer(ROUTES.PROFILE, review ? 2 : 0, closeReview, { panel: "software-updates" });

  async function inspect() {
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || !current(owner) || disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const request = ApiService.getPersonalAgentBrowserPlan();
      await morphyToast.promise(request, {
        loading: "Checking Browser setup…",
        success: () => current(owner) ? "Browser setup is ready to review." : null,
        error: () => current(owner) ? "Browser setup isn't ready for this agent yet." : null,
      }).unwrap();
      const offer = await request;
      if (current(owner)) setReview({ offer, owner });
    } catch {
      // Refusal never changes the pod. The toast owns this transient outcome.
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function enable() {
    if (!review || !current(review.owner) || disabled || pending.current) return;
    const { offer, owner } = review;
    pending.current = true;
    setBusy(true);
    if (approval.current?.release !== offer.releaseId) {
      approval.current = { release: offer.releaseId, key: crypto.randomUUID() };
    }
    try {
      await morphyToast.promise(ApiService.approvePersonalAgentUpdate({
        releaseId: offer.releaseId, browserPlanDigest: offer.browserPlanDigest,
        idempotencyKey: approval.current.key,
      }), {
        loading: "Scheduling Browser setup…",
        success: () => current(owner) ? "Browser setup scheduled. Following your agent’s update." : null,
        error: () => current(owner) ? "Setup wasn't confirmed. Check update status before retrying." : null,
      }).unwrap();
      if (!current(owner)) return;
      setReview(null);
      dispatchFeedStateChanged();
      onScheduled();
    } catch {
      // Keep the exact key: a lost response must not create a second operation.
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="space-y-3 text-sm" aria-label="Browser setup">
    <h3 className="font-medium">Browser</h3>
    {review && current(review.owner) ? <>
      <p className="text-muted-foreground">{review.offer.summary}</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {review.offer.changes.map(change => <li key={change}>{change}</li>)}
      </ul>
      <p className="text-muted-foreground">Screen processing: {review.offer.model}</p>
      {!!review.offer.publicPolicy.interactive_origins?.length && <div className="space-y-2">
        <p className="font-medium">Sign-in and website actions</p>
        <ul className="space-y-1 break-all text-muted-foreground" aria-label="Interactive websites">
          {review.offer.publicPolicy.interactive_origins.map(origin => <li key={origin}>{origin}</li>)}
        </ul>
        <p className="text-muted-foreground">You handle sign-in. One asks before sharing information or submitting changes.</p>
      </div>}
      <details>
        <summary className="cursor-pointer font-medium">Allowed pages and assets</summary>
        <ul className="mt-2 space-y-1 break-all text-muted-foreground">
          {review.offer.publicPolicy.page_urls.map(url => <li key={`page:${url}`}>{url}</li>)}
          {review.offer.publicPolicy.static_prefixes.map(url => <li key={`asset:${url}`}>{url} (assets)</li>)}
        </ul>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || busy} onClick={() => void enable()}>Approve Browser setup</Button>
        <Button variant="muted" disabled={busy} onClick={closeReview}>Not now</Button>
      </div>
    </> : <>
      <p className="text-muted-foreground">Research public pages with your private agent. Review access before enabling.</p>
      <Button variant="muted" disabled={disabled || busy} onClick={() => void inspect()}>Review Browser setup</Button>
    </>}
  </section>;
}
