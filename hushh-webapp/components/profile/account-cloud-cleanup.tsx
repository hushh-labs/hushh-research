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
  openSignInPopup,
} from "@/lib/one/azure-sign-in";
import {
  cloudCleanupErrorMessage,
  approveCloudCleanup,
  beginCloudCleanup,
  readCloudCleanup,
  type CloudCleanupView,
} from "@/lib/services/account-cloud-cleanup";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

type Props = {
  userId: string;
  token: string | null;
  onUnlock: () => void;
  onFinish: () => Promise<unknown>;
};
type Action = "inspect" | "refresh" | "approve" | "execute";

function useCloudCleanup(props: Props) {
  const [view, setView] = useState<CloudCleanupView | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (action: Action, group = "") => {
    if (running.current) return;
    const popup =
      action === "inspect" || action === "execute" ? openSignInPopup() : null;
    running.current = true;
    setBusy(true);
    try {
      await morphyToast
        .promise(
          (async () => {
            const auth = await resolveDeleteAccountAuth({
              userId: props.userId,
              existingVaultOwnerToken: props.token,
            });
            if (!active.current || popup?.closed) throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
            if (auth.kind === "needs_unlock") {
              props.onUnlock();
              throw new Error("Unlock your vault to continue.");
            }
            if (action === "refresh" || action === "approve") {
              if (action === "approve" && !view) throw new Error("Review cloud cleanup first.");
              const updated = action === "refresh" ? await readCloudCleanup(auth.token)
                : await approveCloudCleanup(auth.token, view!, group);
              if (!active.current) throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
              setView(updated);
            } else {
              const result = await beginCloudCleanup(auth.token, action);
              if (!active.current) {
                popup?.close();
                throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
              }
              if (popup) {
                if (popup.closed) throw new Error("CLOUD_CLEANUP_VIEW_CLOSED");
                popup.location.assign(result.authorizationUrl);
              } else assignWindowLocation(result.authorizationUrl);
            }
          })(),
          {
            loading: "Checking cloud cleanup…",
            success: "Cloud cleanup status updated.",
            error: cloudCleanupErrorMessage,
          },
        )
        .unwrap();
    } catch {
      popup?.close();
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { view, busy, run };
}

function CleanupTerms({ view, busy, approve }: { view: CloudCleanupView; busy: boolean; approve: (group: string) => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [contents, setContents] = useState(false);
  const [retention, setRetention] = useState(false);
  const group = view.resources.find((resource) => resource.scope === "whole_group")?.id ?? "";
  const groupName = group.split("/").at(-1) ?? "";
  const accepted = Boolean(view.planDigest && groupName && confirmation === groupName && contents && retention);
  return <div className="space-y-3">
    <p className="text-sm">This removes the listed resources and all their contents, including stored files. Azure may retain protected copies under its policies.</p>
    <label className="flex min-h-11 items-center gap-3 text-sm"><Checkbox checked={contents} onCheckedChange={(value) => setContents(value === true)} />Delete these resources and everything in them.</label>
    <label className="flex min-h-11 items-center gap-3 text-sm"><Checkbox checked={retention} onCheckedChange={(value) => setRetention(value === true)} />I understand protected copies may remain until Azure permits removal.</label>
    <label className="grid gap-[var(--app-form-field-gap)] text-sm">Type {groupName} to confirm<Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
    <AlertDialogAction className="min-h-11" variant="destructive" disabled={busy || !accepted} data-testid="cloud-cleanup-approve" onClick={(event) => {
      event.preventDefault(); if (accepted) approve(group);
    }}>Approve cleanup</AlertDialogAction>
  </div>;
}

export function AccountCloudCleanup(props: Props) {
  const { view, busy, run } = useCloudCleanup(props);
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);
  const finish = async () => {
    if (finishingRef.current) return;
    finishingRef.current = true; setFinishing(true);
    try { await props.onFinish(); }
    finally { finishingRef.current = false; setFinishing(false); }
  };
  if (!isAzureSignInAvailable()) return <p className="text-sm text-muted-foreground">Continue cloud cleanup on the Hussh website.</p>;
  return <div className="space-y-4" data-testid="account-cloud-cleanup">
    <p className="text-sm text-muted-foreground">Review your agent’s Azure resources before deleting your account. Inspection pauses new agent work; it does not delete files or keys.</p>
    {view?.canFinalize ? <p role="status" className="text-sm">Cloud cleanup is verified. You can now finish deleting your account.</p>
      : view?.planDigest ? <>
        <p role="status" className="text-sm">{view.needsAttention ? "Cleanup paused. Review and retry." : `${view.removed} of ${view.total} cloud resources verified removed.`}</p>
        <details className="text-sm"><summary className="min-h-11 cursor-pointer content-center">Review affected resources</summary>
          <ul className="max-h-40 space-y-1 overflow-auto break-words text-muted-foreground">{view.resources.map((resource) => <li key={resource.id}>{resource.id.split("/").slice(-2).join(" / ")}</li>)}</ul>
        </details>
        {view.approvalRequired ? <CleanupTerms key={`${view.operationId}:${view.planDigest}`} view={view} busy={busy} approve={(group) => void run("approve", group)} />
          : <p className="text-sm text-muted-foreground">Your exact cleanup plan is approved. Continue with Microsoft to perform or resume it.</p>}
      </> : <p className="text-sm text-muted-foreground">Sign in to Microsoft for a read-only inspection, then return here to review.</p>}
    <AlertDialogFooter className="flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" disabled={busy || finishing} onClick={() => void run("refresh")} data-testid="cloud-cleanup-refresh">Refresh status</Button>
      {!view?.planDigest || !view.approvalRequired || view.canFinalize ? <AlertDialogAction className="min-h-11" variant={view?.planDigest ? "destructive" : "default"}
        disabled={busy || finishing} data-testid="cloud-cleanup-continue" onClick={(event) => {
          event.preventDefault();
          if (view?.canFinalize) void finish();
          else void run(!view?.planDigest ? "inspect" : "execute");
        }}>
        {busy || finishing ? "Checking…" : view?.canFinalize ? "Finish account deletion" : !view?.planDigest ? "Review cloud cleanup" : "Continue with Microsoft"}
      </AlertDialogAction> : null}
    </AlertDialogFooter>
  </div>;
}
