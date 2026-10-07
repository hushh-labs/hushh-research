"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ReleaseNotice } from "@/lib/agent/managed-app-release";

export function ReleaseNoticeDialog({ notice, onPresented, onClose }: {
  notice: ReleaseNotice | null;
  onPresented: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog modal open={notice !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
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
