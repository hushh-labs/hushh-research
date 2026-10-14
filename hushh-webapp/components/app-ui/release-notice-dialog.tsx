"use client";

import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ReleaseNotice } from "@/lib/agent/managed-app-release";
import { resolveProfilePaneUrlState } from "@/lib/navigation/profile-pane";

export function ReleaseNoticeDialog({ notice, onPresented, onClose }: {
  notice: ReleaseNotice | null;
  onPresented: () => void;
  onClose: () => void;
}) {
  // Cosmetic notices yield to Profile. Otherwise a later-mounted Sheet can
  // disable the older Dialog's content while its higher overlay blocks both.
  // Keep the notice pending so normal presentation resumes after Profile closes.
  const profileOpen = resolveProfilePaneUrlState(useSearchParams()).open;
  return (
    <Dialog modal open={notice !== null && !profileOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={onPresented}>
        <DialogHeader className="text-left">
          <DialogTitle>{notice?.title}</DialogTitle>
          <DialogDescription>{notice?.description}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-3 pl-5 text-sm leading-relaxed">
          {notice?.changes.map((change) => <li key={change}>{change}</li>)}
        </ul>
        <Button className="w-full" onClick={onClose}>Got it</Button>
      </DialogContent>
    </Dialog>
  );
}
