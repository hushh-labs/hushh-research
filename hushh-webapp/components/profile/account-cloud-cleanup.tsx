"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertDialogAction,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { resolveDeleteAccountAuth } from "@/lib/flows/delete-account";
import {
  isAzureSignInAvailable,
  captureSignInPopupOwner,
  openSignInPopup,
} from "@/lib/one/azure-sign-in";
import {
  cloudCleanupErrorMessage,
  cloudCleanupAttentionMessage,
  approveCloudCleanup,
  beginCloudCleanup,
  readCloudCleanup,
  finishCloudRemoval,
  type CloudCleanupPurpose,
  type CloudCleanupView,
} from "@/lib/services/account-cloud-cleanup";
import { useCloudCleanupObservation } from "./use-cloud-cleanup-observation";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

type Props = {
  userId: string;
  token: string | null;
  onUnlock: () => void;
  onFinish: () => Promise<unknown>;
  purpose?: CloudCleanupPurpose;
  provider?: "gcp" | "azure";
};
type Action = "inspect" | "refresh" | "approve" | "execute";

async function prepareCleanupAction(props: Props, action: Action, view: CloudCleanupView | null, group: string, isCurrent: () => boolean) {
  const auth = await resolveDeleteAccountAuth({ userId: props.userId, existingVaultOwnerToken: props.token });
  if (!isCurrent()) throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
  if (auth.kind === "needs_unlock") {
    props.onUnlock();
    throw new Error("Unlock your vault to continue.");
  }
  if (action === "refresh") return { kind: "view" as const, view: await readCloudCleanup(auth.token, undefined, props.purpose) };
  if (action === "approve") {
    if (!view) throw new Error("Review cloud cleanup first.");
    return { kind: "view" as const, view: await approveCloudCleanup(auth.token, view, group, props.purpose) };
  }
  const begun = await beginCloudCleanup(auth.token, action, props.purpose, view);
  return begun.kind === "view" ? begun : { kind: "authorize" as const, authorization: begun, action };
}

function useCloudCleanup(props: Props) {
  const [observed, setObserved] = useState<{ view: CloudCleanupView; isCurrent: () => boolean } | null>(null);
  const view = observed?.isCurrent() ? observed.view : null;
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const observation = useCloudCleanupObservation({
    owner: props, mounted: active, busy,
    onView: (value, isCurrent) => setObserved({ view: value, isCurrent }),
  });
  const run = async (action: Action, group = "") => {
    if (running.current) return;
    const isCurrent = observation.capture();
    if (!isCurrent()) return;
    observation.pause();
    const popup =
      (action === "inspect" || action === "execute") && props.provider !== "gcp" ? openSignInPopup() : null;
    const ownsPopup = captureSignInPopupOwner(popup);
    running.current = true;
    setBusy(true);
    try {
      await morphyToast
        .promise(
          (async () => {
            const result = await prepareCleanupAction(props, action, view, group, () => isCurrent() && !popup?.closed && ownsPopup());
            if (!isCurrent() || popup?.closed || !ownsPopup()) throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
            if (result.kind === "view") {
              const updated = result.view;
              setObserved({ view: updated, isCurrent });
              if (updated.inProgress) observation.startFollow(updated.operationId, isCurrent);
            } else {
              const begun = result.authorization;
              observation.watchReturn(begun.operationId, result.action, isCurrent);
              if (popup) {
                if (popup.closed) throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
                popup.location.assign(begun.authorizationUrl);
              } else assignWindowLocation(begun.authorizationUrl);
            }
          })(),
          {
            loading: "Checking cloud cleanup…",
            success: () => isCurrent() ? "Cloud cleanup status updated." : null,
            error: (error) => isCurrent() ? cloudCleanupErrorMessage(error) : null,
          },
        )
        .unwrap();
    } catch {
      if (ownsPopup()) popup?.close();
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { view, busy, run, capture: observation.capture };
}

function CleanupTerms({ view, busy, approve }: { view: CloudCleanupView; busy: boolean; approve: (group: string) => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [contents, setContents] = useState(false);
  const [retention, setRetention] = useState(false);
  const group = view.confirmation ?? view.resources.find((resource) => resource.scope === "whole_group")?.id ?? "";
  const groupName = group.split("/").at(-1) ?? "";
  const accepted = Boolean(view.planDigest && groupName && confirmation === groupName && contents && retention);
  return <div className="space-y-3">
    <p className="text-sm">This removes the listed resources and their contents, including stored files. Your cloud provider may retain protected copies under its policies.</p>
    <label className="flex min-h-11 items-center gap-3 text-sm"><Checkbox checked={contents} onCheckedChange={(value) => setContents(value === true)} />Delete these resources and everything in them.</label>
    <label className="flex min-h-11 items-center gap-3 text-sm"><Checkbox checked={retention} onCheckedChange={(value) => setRetention(value === true)} />I understand protected copies may remain under my cloud provider’s policies.</label>
    <label className="grid gap-[var(--app-form-field-gap)] text-sm">Type {groupName} to confirm<Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
    <AlertDialogAction className="min-h-11" variant="destructive" disabled={busy || !accepted} data-testid="cloud-cleanup-approve" onClick={(event) => {
      event.preventDefault(); if (accepted) approve(group);
    }}>Approve cleanup</AlertDialogAction>
  </div>;
}

export function AccountCloudCleanup(props: Props) {
  const { view, busy, run, capture } = useCloudCleanup(props);
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);
  const finish = async () => {
    if (finishingRef.current) return;
    finishingRef.current = true; setFinishing(true);
    const isCurrent = capture();
    try {
      if (!isCurrent()) return;
      if (props.purpose === "remove_cloud") {
        const auth = await resolveDeleteAccountAuth({ userId: props.userId, existingVaultOwnerToken: props.token });
        if (!isCurrent()) return;
        if (auth.kind === "needs_unlock") { props.onUnlock(); return; }
        if (!view) return;
        await morphyToast.promise(finishCloudRemoval(auth.token, view), {
          loading: "Finishing cloud removal…", success: () => isCurrent() ? "Cloud removed. Your Hussh account is kept." : null,
          error: (error) => isCurrent() ? cloudCleanupErrorMessage(error) : null,
        }).unwrap();
      }
      if (isCurrent()) await props.onFinish();
    } catch { /* The operation toast owns failure; its recovery state is retained. */ }
    finally { finishingRef.current = false; setFinishing(false); }
  };
  if (!isAzureSignInAvailable()) return <p className="text-sm text-muted-foreground">Continue cloud cleanup on the Hussh website.</p>;
  const keepAccount = props.purpose === "remove_cloud";
  const gcp = props.provider === "gcp" || view?.provider === "gcp";
  const executing = !!view?.inProgress && !view.needsAttention && !view.canFinalize;
  return <div className="space-y-4" data-testid="account-cloud-cleanup">
    <p className="text-sm text-muted-foreground">{keepAccount ? "Your Hussh account and vault stay. Files and agent history stored only in this cloud are removed. You’ll choose hosting again afterward." : "Review your agent’s Azure resources before deleting your account."} Inspection pauses new agent work; it does not delete files or keys.</p>
    {view?.canFinalize ? <p role="status" className="text-sm">{keepAccount ? "Cloud cleanup is verified. Finish removal to choose hosting again." : "Cloud cleanup is verified. You can now finish deleting your account."}</p>
      : view?.planDigest ? <>
        <p role="status" className="text-sm">{view.needsAttention ? cloudCleanupAttentionMessage(view.attentionCode) : view.progressKnown === false ? "Cleanup is not yet verified. Refresh status or resume the reviewed request." : `${view.removed} of ${view.total} cloud resources verified removed.`}</p>
        <details className="text-sm"><summary className="min-h-11 cursor-pointer content-center">Review affected resources</summary>
          <ul className="max-h-40 space-y-1 overflow-auto break-words text-muted-foreground">{view.resources.map((resource) => <li key={resource.id}>{resource.id.split("/").slice(-2).join(" / ")}</li>)}</ul>
        </details>
        {view.approvalRequired ? <CleanupTerms key={`${view.operationId}:${view.planDigest}`} view={view} busy={busy} approve={(group) => void run("approve", group)} />
          : <p className="text-sm text-muted-foreground">{gcp ? "Your reviewed request can be performed or resumed." : "Your exact cleanup plan is approved. Continue with Microsoft to perform or resume it."}</p>}
      </> : <p className="text-sm text-muted-foreground">{gcp ? "Inspect the resources recorded for your agent, then review what will be removed." : "Sign in to Microsoft for a read-only inspection, then return here to review."}</p>}
    <AlertDialogFooter className="flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" disabled={busy || finishing} onClick={() => void run("refresh")} data-testid="cloud-cleanup-refresh">Refresh status</Button>
      {!view?.planDigest || !view.approvalRequired || view.canFinalize ? <AlertDialogAction className="min-h-11" variant={view?.planDigest ? "destructive" : "default"}
        disabled={busy || finishing || executing} data-testid="cloud-cleanup-continue" onClick={(event) => {
          event.preventDefault();
          if (executing) return;
          if (view?.canFinalize) void finish();
          else void run(!view?.planDigest ? "inspect" : "execute");
        }}>
        {busy || finishing ? "Checking…" : executing ? "Cleanup in progress" : view?.canFinalize ? keepAccount ? "Finish cloud removal" : "Finish account deletion" : !view?.planDigest ? "Review cloud cleanup" : gcp ? "Remove listed resources" : "Continue with Microsoft"}
      </AlertDialogAction> : null}
    </AlertDialogFooter>
  </div>;
}
