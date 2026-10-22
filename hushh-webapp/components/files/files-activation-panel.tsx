"use client";

import { useRef, useState } from "react";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";

type Offer = Awaited<ReturnType<typeof ApiService.getPersonalAgentFilesPlan>>;

export function FilesActivationPanel({ disabled, onScheduled }: {
  disabled: boolean; onScheduled: () => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const approval = useRef<{ release: string; key: string } | null>(null);

  async function review() {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const request = ApiService.getPersonalAgentFilesPlan();
      await morphyToast.promise(request, {
        loading: "Checking your cloud setup…",
        success: "Files setup is ready to review.",
        error: (cause: unknown) => cause instanceof Error && cause.message === "FILES_ACTIVATION_UNAVAILABLE:409"
          ? "Files setup isn't ready for this pod yet. Your pod has not changed."
          : "Files setup could not be verified. Your pod has not changed.",
      }).unwrap();
      setOffer(await request);
    } catch {
      // The toast owns this transient error; never infer approval from a plan.
    } finally { pending.current = false; setBusy(false); }
  }

  async function enable() {
    if (!offer || disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    if (approval.current?.release !== offer.releaseId) {
      approval.current = { release: offer.releaseId, key: crypto.randomUUID() };
    }
    try {
      await morphyToast.promise(ApiService.approvePersonalAgentUpdate({
        releaseId: offer.releaseId, capabilityPlanDigest: offer.capabilityPlanDigest,
        idempotencyKey: approval.current.key,
      }), {
        loading: "Scheduling Files setup…", success: "Files setup scheduled. Your pod will finish active work first.",
        error: "Setup could not be confirmed. Check update status before trying again.",
      }).unwrap();
      setOffer(null);
      dispatchFeedStateChanged();
      onScheduled();
    } catch {
      // Preserve the exact operation key for a retry after a lost response.
    } finally { pending.current = false; setBusy(false); }
  }

  return <section className="space-y-3 text-sm" aria-label="Enable Files">
    <h3 className="font-medium">Your private Files library</h3>
    {offer ? <>
      <p className="text-muted-foreground">{offer.summary}</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {offer.changes.map(change => <li key={change}>{change}</li>)}
      </ul>
      <p className="text-muted-foreground">{offer.modelProcessing}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || busy} onClick={() => void enable()}>Approve Files setup</Button>
        <Button variant="muted" disabled={busy} onClick={() => setOffer(null)}>Not now</Button>
      </div>
    </> : <>
      <p className="text-muted-foreground">Store encrypted files in your cloud. Review the required resources before enabling it.</p>
      <Button variant="muted" disabled={disabled || busy} onClick={() => void review()}>Review Files setup</Button>
    </>}
  </section>;
}
