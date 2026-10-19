"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { User } from "firebase/auth";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PRIVATE_TEXT_DISCLOSURE } from "@/lib/legal/private-text-disclosure";
import { resolveAppEnvironment } from "@/lib/app-env";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { PrivateTextApprovalService, isPrivateTextApprovalConflict, type PrivateTextApproval } from "@/lib/services/private-text-approval-service";

type Owner = Pick<User, "uid" | "getIdToken">;

/** Owner changes remount the approval state; no receipt lives in browser storage. */
export function PrivateTextApprovalControl({ user }: { user: Owner }) {
  if (resolveAppEnvironment() !== "uat") return null;
  return <OwnerPrivateTextApproval key={user.uid} user={user} />;
}

function OwnerPrivateTextApproval({ user }: { user: Owner }) {
  const pathname = usePathname();
  const checkboxId = useId();
  const owner = useRef(user);
  owner.current = user;
  const current = useRef(false);
  const busyRef = useRef(false);
  const toastHandle = useRef<ReturnType<typeof morphyToast.promise>>(undefined);
  const [approval, setApproval] = useState<PrivateTextApproval | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const idToken = await owner.current.getIdToken();
      if (!current.current) return;
      const saved = await PrivateTextApprovalService.get(idToken);
      if (current.current) setApproval(saved);
    } catch {
      if (current.current) setLoadFailed(true);
    } finally {
      if (current.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    current.current = true;
    void load();
    return () => {
      current.current = false;
      const handle = toastHandle.current;
      if (typeof handle === "string" || typeof handle === "number") morphyToast.dismiss(handle);
    };
  }, [load]);

  const close = () => {
    if (busyRef.current) return;
    setOpen(false);
    setAcknowledged(false);
  };
  useBackLayer(pathname, open ? 2 : 0, () => { close(); return true; });

  const save = async (enabled: boolean) => {
    if (busyRef.current || !current.current || !approval || enabled && !acknowledged) return;
    busyRef.current = true;
    setBusy(true);
    const operation = (async () => {
      const idToken = await owner.current.getIdToken();
      if (!current.current) throw new Error("Approval session ended");
      return PrivateTextApprovalService.set(idToken, enabled, approval.generation);
    })();
    toastHandle.current = morphyToast.promise(operation, {
      loading: enabled ? "Saving approval…" : "Revoking approval…",
      success: enabled ? "Azure text approval saved." : "Azure text approval revoked.",
      error: "Couldn’t save your choice. Try again.",
      isCurrent: () => current.current,
    });
    try {
      const saved = await operation;
      if (!current.current) return;
      setApproval(saved);
      setOpen(false);
      setAcknowledged(false);
    } catch (error) {
      // A stale view cannot replay approval over a newer revocation.
      if (current.current && isPrivateTextApprovalConflict(error)) {
        setOpen(false);
        setAcknowledged(false);
        await load();
      }
      // The owner-fenced promise toast owns feedback. Never assume approval.
    } finally {
      busyRef.current = false;
      if (current.current) setBusy(false);
    }
  };

  if (loading || !approval && !loadFailed) return null;
  return <div className="px-[var(--page-inline-gutter-standard)] pb-3">
    {loadFailed ? <Button variant="outline" className="min-h-11 w-full" onClick={() => void load()}>
      Retry model privacy settings
    </Button> : <Button variant="outline" className="min-h-11 w-full justify-between"
      aria-label="Review Azure text pilot" onClick={() => setOpen(true)}>
      <span>Azure text pilot</span><span className="text-muted-foreground">{approval?.enabled ? "Approved" : "Review"}</span>
    </Button>}
    <Dialog modal open={open} onOpenChange={next => { if (next) setOpen(true); else close(); }}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Azure text pilot · UAT only</DialogTitle>
          <DialogDescription>Review who may process your private text before approving.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm leading-relaxed">
          {PRIVATE_TEXT_DISCLOSURE.map(text => <p key={text}>{text}</p>)}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Read the Privacy Policy</a>
        </div>
        {approval?.enabled ? <p role="status" className="text-sm">Approval is saved. UAT requests may use Azure when the pilot is enabled.</p> :
          <label htmlFor={checkboxId} className="flex min-h-11 items-start gap-3 text-sm leading-relaxed">
            <Checkbox id={checkboxId} checked={acknowledged} disabled={busy}
              onCheckedChange={value => setAcknowledged(value === true)} className="mt-1" />
            I approve Microsoft Azure AI processing the private text described above in UAT.
          </label>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}>Close</Button>
          {approval?.enabled ? <Button variant="outline" disabled={busy} onClick={() => void save(false)}>Revoke approval</Button> :
            <Button disabled={busy || !acknowledged} onClick={() => void save(true)}>Approve private text processing</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
