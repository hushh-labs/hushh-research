"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { User } from "firebase/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DRIVE_AZURE_DEFAULT_DISCLOSURE } from "@/lib/legal/private-text-disclosure";
import { resolveAppEnvironment } from "@/lib/app-env";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { PrivateTextApprovalService, type PrivateTextApproval } from "@/lib/services/private-text-approval-service";

type Owner = Pick<User, "uid" | "getIdToken">;

/** Processing information, not a personal approval or model-selection control. */
export function PrivateTextApprovalControl({ user }: { user: Owner }) {
  if (resolveAppEnvironment() !== "uat") return null;
  return <ManagedProcessingInformation key={user.uid} user={user} />;
}

function ManagedProcessingInformation({ user }: { user: Owner }) {
  const pathname = usePathname();
  const [policy, setPolicy] = useState<PrivateTextApproval["processing_policy"]>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const token = await user.getIdToken();
        if (!current) return;
        const response = await PrivateTextApprovalService.get(token);
        if (current) { setPolicy(response?.processing_policy); setFailed(false); }
      } catch { if (current) setFailed(true); }
    })();
    return () => { current = false; };
  }, [attempt, user]);
  useBackLayer(pathname, open ? 2 : 0, () => { setOpen(false); return true; });
  if ((!policy?.enabled || policy.basis !== "uat_policy") && !failed) return null;
  return <div className="px-[var(--page-inline-gutter-standard)] pb-3">
    {failed ? <Button variant="outline" className="min-h-11 w-full" onClick={() => setAttempt(value => value + 1)}>Retry processing information</Button> :
      <Button variant="outline" className="min-h-11 w-full justify-between" onClick={() => setOpen(true)}>
        <span>AI processing in UAT</span><span className="text-muted-foreground">Managed by Hussh</span>
      </Button>}
    <Dialog modal open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader><DialogTitle>AI processing in UAT</DialogTitle>
          <DialogDescription>Azure is the primary processor for One text chat and document requests.</DialogDescription></DialogHeader>
        <div className="space-y-3 text-sm leading-relaxed">
          {DRIVE_AZURE_DEFAULT_DISCLOSURE.map(text => <p key={text}>{text}</p>)}
          <p role="status">Enabled under the UAT administrator policy. This is not a personal approval.</p>
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Read the Privacy Policy</a>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
